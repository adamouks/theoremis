//! Lean 4 and Mathlib, for checking the collaborator's formalizations on the person's computer.
//!
//! Lean is installed with elan, the toolchain manager the Lean community recommends. Mathlib
//! lives in a Lake project in the app's data directory, created from Mathlib's own template and
//! filled from Mathlib's cache of prebuilt files, so nothing has to be compiled. A check writes
//! the code to a file in that project and runs `lake env lean --json` on it.

pub mod check;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use check::CheckResult;

/// The Lake package Theoremis keeps Mathlib in.
const PROJECT: &str = "TheoremisMath";
/// Resolves to the Lean version the latest Mathlib is built with.
const MATHLIB_TOOLCHAIN: &str = "leanprover-community/mathlib4:lean-toolchain";
/// The Windows process flag that runs a console program without opening a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ELAN_INIT_SH: &str = "https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh";
const ELAN_INIT_PS1: &str =
    "https://raw.githubusercontent.com/leanprover/elan/master/elan-init.ps1";
/// Loading Mathlib takes a while the first time after a restart; proofs rarely take minutes.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LeanStatus {
    /// Lean's toolchain manager (and with it `lake`) is installed.
    pub installed: bool,
    /// Mathlib is downloaded and ready to check against.
    pub ready: bool,
    /// The Lean version the Mathlib project uses, e.g. `v4.36.0`.
    pub lean_version: Option<String>,
    /// The Mathlib commit, abbreviated.
    pub mathlib_version: Option<String>,
    pub setting_up: bool,
    pub project_path: String,
}

/// Progress while Lean and Mathlib are being set up.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetupEvent {
    /// A new stage, in words.
    Step { text: String },
    /// A line of output from the tool doing the work.
    Line { text: String },
}

pub struct Lean {
    /// `<app data>/lean`; the Mathlib project is a directory inside it.
    root: PathBuf,
    home: PathBuf,
    http: reqwest::Client,
    setup: Mutex<Option<CancellationToken>>,
    /// Checks run one at a time: each loads Mathlib, which takes gigabytes of memory.
    checks: tokio::sync::Mutex<()>,
    next_file: AtomicU64,
}

impl Lean {
    pub fn new(root: PathBuf, home: PathBuf, http: reqwest::Client) -> Self {
        Self {
            root,
            home,
            http,
            setup: Mutex::new(None),
            checks: tokio::sync::Mutex::new(()),
            next_file: AtomicU64::new(0),
        }
    }

    fn project(&self) -> PathBuf {
        self.root.join(PROJECT)
    }

    pub fn status(&self) -> LeanStatus {
        let project = self.project();
        let toolchain = std::fs::read_to_string(project.join("lean-toolchain")).ok();
        LeanStatus {
            installed: self.lake().is_some(),
            ready: self.lake().is_some() && mathlib_built(&project),
            lean_version: toolchain
                .map(|t| t.trim().rsplit(':').next().unwrap_or_default().to_string())
                .filter(|v| !v.is_empty()),
            mathlib_version: mathlib_rev(&project),
            setting_up: self
                .setup
                .lock()
                .expect("lean setup lock poisoned")
                .is_some(),
            project_path: project.display().to_string(),
        }
    }

    /// Installs whatever is missing: elan, the Mathlib project, and Mathlib's prebuilt files.
    pub async fn set_up(&self, mut emit: impl FnMut(SetupEvent)) -> AppResult<LeanStatus> {
        let cancel = CancellationToken::new();
        {
            let mut current = self.setup.lock().expect("lean setup lock poisoned");
            if current.is_some() {
                return Err(AppError::msg("Lean is already being set up."));
            }
            *current = Some(cancel.clone());
        }
        let result = self.run_setup(&mut emit, &cancel).await;
        *self.setup.lock().expect("lean setup lock poisoned") = None;
        result.map(|()| self.status())
    }

    pub fn cancel_setup(&self) -> bool {
        let current = self.setup.lock().expect("lean setup lock poisoned");
        current.as_ref().map(CancellationToken::cancel).is_some()
    }

    async fn run_setup(
        &self,
        emit: &mut impl FnMut(SetupEvent),
        cancel: &CancellationToken,
    ) -> AppResult<()> {
        let step = |emit: &mut dyn FnMut(SetupEvent), text: &str| {
            emit(SetupEvent::Step { text: text.into() });
        };
        std::fs::create_dir_all(&self.root)?;

        if self.lake().is_none() {
            step(emit, "Installing Lean's toolchain manager (elan)…");
            self.install_elan(emit, cancel).await?;
            if self.lake().is_none() {
                return Err(AppError::msg(
                    "elan was installed, but Theoremis can't find Lean's tools. Restart Theoremis and try again.",
                ));
            }
        }
        let lake = self.lake().expect("checked above");

        if self.run_quiet("git", &["--version"]).await.is_err() {
            return Err(AppError::msg(if cfg!(target_os = "macos") {
                "Mathlib needs Git. Install Apple's command line tools with `xcode-select --install`, then try again."
            } else {
                "Mathlib needs Git. Install it from git-scm.com, then try again."
            }));
        }

        let project = self.project();
        if !project.join("lakefile.toml").is_file() && !project.join("lakefile.lean").is_file() {
            // A half-created project from an interrupted attempt would make `lake new` refuse.
            if project.exists() {
                std::fs::remove_dir_all(&project)?;
            }
            step(
                emit,
                "Creating a Mathlib project and installing the Lean version it needs…",
            );
            let toolchain = format!("+{MATHLIB_TOOLCHAIN}");
            let created = self
                .run(
                    &lake,
                    &[&toolchain, "new", PROJECT, "math"],
                    &self.root,
                    emit,
                    cancel,
                )
                .await;
            // `lake new` also tries to fetch Mathlib right away. If only that part failed, the
            // project is there and the download below fetches Mathlib anyway.
            if let Err(err) = created
                && (cancel.is_cancelled() || !project.join("lakefile.toml").is_file())
            {
                return Err(err);
            }
        }

        step(
            emit,
            "Downloading Mathlib's prebuilt library (several GB; this takes a while)…",
        );
        self.run(&lake, &["exe", "cache", "get"], &project, emit, cancel)
            .await?;
        if !mathlib_built(&project) {
            return Err(AppError::msg(
                "Mathlib's download finished without its library files. Check your connection and run setup again.",
            ));
        }
        step(emit, "Lean and Mathlib are ready.");
        Ok(())
    }

    async fn install_elan(
        &self,
        emit: &mut impl FnMut(SetupEvent),
        cancel: &CancellationToken,
    ) -> AppResult<()> {
        let (url, file) = if cfg!(windows) {
            (ELAN_INIT_PS1, "elan-init.ps1")
        } else {
            (ELAN_INIT_SH, "elan-init.sh")
        };
        let script = self
            .http
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| {
                AppError::msg("Couldn't download Lean's installer. Check your internet connection.")
            })?
            .bytes()
            .await?;
        let path = self.root.join(file);
        std::fs::write(&path, &script)?;
        let path_str = path.display().to_string();
        let result = if cfg!(windows) {
            let command = format!("& '{path_str}' -NoPrompt 1 -DefaultToolchain none");
            self.run(
                Path::new("powershell"),
                &[
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &command,
                ],
                &self.root,
                emit,
                cancel,
            )
            .await
        } else {
            self.run(
                Path::new("sh"),
                &[&path_str, "-y", "--default-toolchain", "none"],
                &self.root,
                emit,
                cancel,
            )
            .await
        };
        let _ = std::fs::remove_file(&path);
        result
    }

    /// Checks a Lean file against Mathlib.
    pub async fn check(&self, code: &str) -> AppResult<CheckResult> {
        if let Some(why) = check::refusal(code) {
            return Err(AppError::msg(format!(
                "Theoremis didn't run this file. {why}"
            )));
        }
        let Some(lake) = self.lake().filter(|_| mathlib_built(&self.project())) else {
            return Err(AppError::msg(
                "Set up Lean and Mathlib in Settings to check formalizations.",
            ));
        };
        let _one_at_a_time = self.checks.lock().await;

        let names = check::theorem_names(code);
        let code_lines = code.lines().count() as u32;
        let mut file = code.trim_end().to_string();
        file.push('\n');
        for name in &names {
            file.push_str(&format!("\n#print axioms {name}"));
        }
        file.push('\n');

        let dir = self.project().join(".theoremis");
        std::fs::create_dir_all(&dir)?;
        let n = self.next_file.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("Check{}_{n}.lean", std::process::id()));
        std::fs::write(&path, &file)?;

        let started = Instant::now();
        let output = tokio::time::timeout(
            CHECK_TIMEOUT,
            self.command(&lake)
                .args(["env", "lean", "--json"])
                .arg(&path)
                .current_dir(self.project())
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let _ = std::fs::remove_file(&path);
        let output = output
            .map_err(|_| {
                AppError::msg("Lean took more than ten minutes, so the check was stopped.")
            })?
            .map_err(|err| AppError::msg(format!("Couldn't start Lean: {err}")))?;

        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.status.success() {
            text.push('\n');
            text.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        Ok(check::interpret(
            &text,
            code_lines,
            &names,
            output.status.success(),
            started.elapsed().as_secs_f32(),
        ))
    }

    fn elan_bin(&self) -> PathBuf {
        std::env::var_os("ELAN_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".elan"))
            .join("bin")
    }

    /// Finds `lake`: in elan's directory first, since apps opened from the Dock or Start menu
    /// don't see the PATH a terminal sets up, then on the PATH.
    fn lake(&self) -> Option<PathBuf> {
        let name = if cfg!(windows) { "lake.exe" } else { "lake" };
        let in_elan = self.elan_bin().join(name);
        if in_elan.is_file() {
            return Some(in_elan);
        }
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        })
    }

    /// A command with elan's tools on its PATH, since Lake runs `lean` and `git` itself.
    fn command(&self, program: &Path) -> Command {
        let mut command = Command::new(program);
        // Theoremis has no console on Windows, so each program would otherwise open one.
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut paths = vec![self.elan_bin()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
        command
    }

    async fn run_quiet(&self, program: &str, args: &[&str]) -> AppResult<()> {
        let status = self
            .command(Path::new(program))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if status.success() {
            Ok(())
        } else {
            Err(AppError::msg(format!("{program} failed")))
        }
    }

    /// Runs a long command, passing on its output line by line, until it finishes or is cancelled.
    async fn run(
        &self,
        program: &Path,
        args: &[&str],
        cwd: &Path,
        emit: &mut impl FnMut(SetupEvent),
        cancel: &CancellationToken,
    ) -> AppResult<()> {
        let mut child = self
            .command(program)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| AppError::msg(format!("Couldn't start {}: {err}", program.display())))?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        if let Some(out) = child.stdout.take() {
            tokio::spawn(forward_lines(out, tx.clone()));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(forward_lines(err, tx.clone()));
        }
        drop(tx);

        // What to quote if it fails: the tool's own error lines, else its last words.
        let keep = |lines: &mut Vec<String>, text: &str| {
            lines.push(text.to_string());
            if lines.len() > 6 {
                lines.remove(0);
            }
        };
        let mut recent: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(text) => {
                        keep(&mut recent, &text);
                        if text.to_ascii_lowercase().starts_with("error") {
                            keep(&mut errors, &text);
                        }
                        emit(SetupEvent::Line { text });
                    }
                    None => break,
                },
                () = cancel.cancelled() => {
                    let _ = child.kill().await;
                    return Err(AppError::msg("Setup was cancelled."));
                }
            }
        }
        let status = tokio::select! {
            status = child.wait() => status?,
            () = cancel.cancelled() => {
                let _ = child.kill().await;
                return Err(AppError::msg("Setup was cancelled."));
            }
        };
        if status.success() {
            Ok(())
        } else {
            let tail = if errors.is_empty() { &recent } else { &errors }.join("\n");
            Err(AppError::msg(format!(
                "`{} {}` failed.{}",
                program.display(),
                args.join(" "),
                if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{tail}")
                }
            )))
        }
    }
}

/// Sends each line (split at `\n` or `\r`, so progress bars come through) to `tx`.
async fn forward_lines(
    mut reader: impl AsyncRead + Unpin,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        for &byte in &buf[..n] {
            if byte == b'\n' || byte == b'\r' {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                line.clear();
                if !text.is_empty() && tx.send(text).is_err() {
                    return;
                }
            } else {
                line.push(byte);
            }
        }
    }
    let text = String::from_utf8_lossy(&line).trim().to_string();
    if !text.is_empty() {
        let _ = tx.send(text);
    }
}

fn mathlib_built(project: &Path) -> bool {
    project
        .join(".lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean")
        .is_file()
}

fn mathlib_rev(project: &Path) -> Option<String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(project.join("lake-manifest.json")).ok()?).ok()?;
    manifest["packages"]
        .as_array()?
        .iter()
        .find(|p| p["name"] == "mathlib")?["rev"]
        .as_str()
        .map(|rev| rev.chars().take(7).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_status_from_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let lean = Lean::new(
            dir.path().join("lean"),
            home.clone(),
            reqwest::Client::new(),
        );
        let status = lean.status();
        assert!(!status.ready && !status.setting_up);
        assert!(status.lean_version.is_none());

        let project = dir.path().join("lean").join(PROJECT);
        let lib = project.join(".lake/packages/mathlib/.lake/build/lib/lean");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("Mathlib.olean"), b"").unwrap();
        std::fs::write(project.join("lean-toolchain"), "leanprover/lean4:v4.36.0\n").unwrap();
        std::fs::write(
            project.join("lake-manifest.json"),
            r#"{"packages":[{"name":"plausible","rev":"aaaa"},{"name":"mathlib","rev":"0123456789abcdef"}]}"#,
        )
        .unwrap();
        let status = lean.status();
        assert_eq!(status.lean_version.as_deref(), Some("v4.36.0"));
        assert_eq!(status.mathlib_version.as_deref(), Some("0123456"));
        // Not ready until Lean's tools are found as well.
        let bin = home.join(".elan/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            bin.join(if cfg!(windows) { "lake.exe" } else { "lake" }),
            b"",
        )
        .unwrap();
        assert!(lean.status().ready);
    }

    #[tokio::test]
    async fn refuses_before_running_anything() {
        let dir = tempfile::tempdir().unwrap();
        let lean = Lean::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            reqwest::Client::new(),
        );
        let err = lean.check("#eval 1").await.unwrap_err();
        assert!(
            err.to_string()
                .starts_with("Theoremis didn't run this file.")
        );
        let err = lean.check("theorem t : True := trivial").await.unwrap_err();
        assert!(err.to_string().contains("Set up Lean and Mathlib"));
    }

    /// Runs real Lean: `ELAN_HOME=<an elan with a default toolchain> cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn checks_files_with_real_lean() {
        assert!(std::env::var_os("ELAN_HOME").is_some(), "set ELAN_HOME");
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lean");
        std::fs::create_dir_all(&root).unwrap();
        let lean = Lean::new(
            root.clone(),
            dir.path().to_path_buf(),
            reqwest::Client::new(),
        );
        let lake = lean.lake().expect("lake in ELAN_HOME");
        // A project without Mathlib stands in for the real one, whose download is several GB.
        lean.run(
            &lake,
            &["new", PROJECT],
            &root,
            &mut |_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let lib = lean
            .project()
            .join(".lake/packages/mathlib/.lake/build/lib/lean");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("Mathlib.olean"), b"").unwrap();

        let proved = lean
            .check("namespace Odd\ntheorem two : 2 + 2 = 4 := by decide\nend Odd\n")
            .await
            .unwrap();
        assert_eq!(proved.outcome, check::Outcome::Proved, "{proved:?}");
        assert_eq!(proved.theorems[0].name, "Odd.two");
        assert!(proved.theorems[0].extra_axioms.is_empty());

        let incomplete = lean
            .check("theorem t (n : Nat) : n + 0 = n := by\n  sorry\n")
            .await
            .unwrap();
        assert_eq!(
            incomplete.outcome,
            check::Outcome::Incomplete,
            "{incomplete:?}"
        );
        assert_eq!(incomplete.theorems[0].extra_axioms, vec!["sorryAx"]);

        let failed = lean
            .check("theorem b (n : Nat) : n + 1 = n := by\n  simp\n")
            .await
            .unwrap();
        assert_eq!(failed.outcome, check::Outcome::Failed, "{failed:?}");
        assert!(failed.messages.iter().all(|m| m.line <= 2));

        let missing = lean
            .check("import Mathlib.Nope\ntheorem x : True := trivial\n")
            .await
            .unwrap();
        assert_eq!(missing.outcome, check::Outcome::Failed, "{missing:?}");
        // The scratch files are cleaned up.
        let left = std::fs::read_dir(lean.project().join(".theoremis"))
            .unwrap()
            .count();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn streams_command_output_and_reports_failure() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let lean = Lean::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            reqwest::Client::new(),
        );
        let mut events = Vec::new();
        lean.run(
            Path::new("sh"),
            &["-c", "printf 'one\\ntwo\\rthree\\n'; echo oops >&2"],
            dir.path(),
            &mut |e| events.push(e),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let lines: Vec<String> = events
            .into_iter()
            .map(|e| match e {
                SetupEvent::Line { text } | SetupEvent::Step { text } => text,
            })
            .collect();
        for expected in ["one", "two", "three", "oops"] {
            assert!(lines.iter().any(|l| l == expected), "{lines:?}");
        }

        let err = lean
            .run(
                Path::new("sh"),
                &["-c", "echo failing; exit 3"],
                dir.path(),
                &mut |_| {},
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("failing"), "{err}");

        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = lean
            .run(
                Path::new("sh"),
                &["-c", "sleep 30"],
                dir.path(),
                &mut |_| {},
                &cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Setup was cancelled.");
    }
}
