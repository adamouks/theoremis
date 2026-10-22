//! Encrypted storage for the ChatGPT connection.
//!
//! The connection (tokens, ID token, registration) is sealed with AES-256-GCM. The key lives in
//! the OS credential store — Keychain on macOS, Credential Manager on Windows, the Secret Service
//! on Linux — so the file on disk is useless without the signed-in user's keyring. There is
//! deliberately no plaintext fallback.

use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::settings::write_private;

const KEYRING_SERVICE: &str = "app.theoremis.desktop";
const KEYRING_USER: &str = "chatgpt-connection";
/// Binds the ciphertext to its purpose, so it can't be swapped for another sealed file.
const AAD: &[u8] = b"theoremis/chatgpt-connection/v1";

/// Where the encryption key is kept. Abstracted so tests never touch the real keyring.
pub trait KeyStore: Send + Sync {
    fn load(&self) -> AppResult<Option<Vec<u8>>>;
    fn save(&self, key: &[u8]) -> AppResult<()>;
}

/// The platform credential store.
pub struct OsKeyStore;

impl OsKeyStore {
    fn entry() -> AppResult<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(keyring_error)
    }
}

impl KeyStore for OsKeyStore {
    fn load(&self) -> AppResult<Option<Vec<u8>>> {
        match Self::entry()?.get_password() {
            Ok(encoded) => STANDARD
                .decode(encoded.trim())
                .map(Some)
                .map_err(|_| unreadable()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(keyring_error(err)),
        }
    }

    fn save(&self, key: &[u8]) -> AppResult<()> {
        Self::entry()?
            .set_password(&STANDARD.encode(key))
            .map_err(keyring_error)
    }
}

fn keyring_error(err: keyring::Error) -> AppError {
    AppError::msg(format!(
        "Theoremis couldn't use your system keychain, which keeps your ChatGPT sign-in encrypted ({err}). \
         On Linux, make sure a Secret Service provider such as GNOME Keyring or KWallet is running and unlocked."
    ))
}

fn unreadable() -> AppError {
    AppError::msg(
        "Your saved ChatGPT sign-in can't be decrypted on this system. Sign in again to replace it.",
    )
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    version: u32,
    nonce: String,
    data: String,
}

pub struct Vault {
    path: PathBuf,
    keys: Box<dyn KeyStore>,
    /// The key, once fetched, so the keychain is asked at most once per run.
    key: Mutex<Option<[u8; 32]>>,
}

impl Vault {
    pub fn new(path: PathBuf, keys: Box<dyn KeyStore>) -> Self {
        Self {
            path,
            keys,
            key: Mutex::new(None),
        }
    }

    /// Reads and decrypts the stored value. `None` when nothing has been saved yet.
    pub fn read<T: DeserializeOwned>(&self) -> AppResult<Option<T>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let sealed: Sealed = serde_json::from_slice(&bytes).map_err(|_| unreadable())?;
        if sealed.version != 1 {
            return Err(unreadable());
        }
        let key = self.key(false)?.ok_or_else(unreadable)?;
        let nonce = STANDARD.decode(&sealed.nonce).map_err(|_| unreadable())?;
        let data = STANDARD.decode(&sealed.data).map_err(|_| unreadable())?;
        if nonce.len() != 12 {
            return Err(unreadable());
        }
        let plain = cipher(&key)
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &data,
                    aad: AAD,
                },
            )
            .map_err(|_| unreadable())?;
        serde_json::from_slice(&plain)
            .map(Some)
            .map_err(|_| unreadable())
    }

    /// Encrypts and atomically replaces the stored value, creating the key on first use.
    pub fn write<T: Serialize>(&self, value: &T) -> AppResult<()> {
        let key = self.key(true)?.ok_or_else(unreadable)?;
        let mut nonce = [0u8; 12];
        fill_random(&mut nonce)?;
        let plain = serde_json::to_vec(value)?;
        let data = cipher(&key)
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: AAD,
                },
            )
            .map_err(|_| AppError::msg("Couldn't encrypt the ChatGPT sign-in."))?;
        let sealed = Sealed {
            version: 1,
            nonce: STANDARD.encode(nonce),
            data: STANDARD.encode(data),
        };
        write_private(&self.path, &serde_json::to_vec(&sealed)?)
    }

    fn key(&self, create: bool) -> AppResult<Option<[u8; 32]>> {
        let mut cached = self.key.lock().expect("vault key lock poisoned");
        if cached.is_some() {
            return Ok(*cached);
        }
        let key = match self.keys.load()? {
            Some(bytes) => Some(<[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| unreadable())?),
            None if create => {
                let mut key = [0u8; 32];
                fill_random(&mut key)?;
                self.keys.save(&key)?;
                Some(key)
            }
            None => None,
        };
        *cached = key;
        Ok(key)
    }
}

fn cipher(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

pub fn fill_random(buf: &mut [u8]) -> AppResult<()> {
    getrandom::fill(buf)
        .map_err(|err| AppError::msg(format!("No secure randomness available: {err}")))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Arc;

    /// An in-memory key store shared between vaults, like the real keychain is between runs.
    #[derive(Clone, Default)]
    pub struct MemoryKeys(pub Arc<Mutex<Option<Vec<u8>>>>);

    impl KeyStore for MemoryKeys {
        fn load(&self) -> AppResult<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, key: &[u8]) -> AppResult<()> {
            *self.0.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }
    }

    #[test]
    fn round_trips_and_encrypts_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chatgpt.json");
        let keys = MemoryKeys::default();
        let vault = Vault::new(path.clone(), Box::new(keys.clone()));
        assert_eq!(vault.read::<serde_json::Value>().unwrap(), None);

        let secret = serde_json::json!({ "refreshToken": "rt-very-secret" });
        vault.write(&secret).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("rt-very-secret"));

        // A fresh vault (a new app run) reads it back with the same keychain entry.
        let reopened = Vault::new(path.clone(), Box::new(keys));
        assert_eq!(reopened.read::<serde_json::Value>().unwrap(), Some(secret));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn refuses_without_the_key_or_with_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chatgpt.json");
        let vault = Vault::new(path.clone(), Box::new(MemoryKeys::default()));
        vault.write(&serde_json::json!({ "a": 1 })).unwrap();

        let other = Vault::new(path.clone(), Box::new(MemoryKeys::default()));
        assert!(other.read::<serde_json::Value>().is_err());

        let mut sealed: Sealed = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut data = STANDARD.decode(&sealed.data).unwrap();
        data[0] ^= 1;
        sealed.data = STANDARD.encode(data);
        std::fs::write(&path, serde_json::to_vec(&sealed).unwrap()).unwrap();
        assert!(vault.read::<serde_json::Value>().is_err());
    }
}
