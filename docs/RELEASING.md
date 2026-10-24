# Releasing Theoremis

This document describes the release automation, update signing, and operating-system distribution setup. For installation and product information see the [README](../README.md); for local development see [DEVELOPMENT.md](DEVELOPMENT.md).

## Automated releases

Changes to the desktop app under `app/` pushed to `main`, after CI succeeds, trigger the Release workflow. The workflow builds macOS (Apple silicon and Intel), Windows, and Linux installers. Once platform builds complete it publishes release assets, signed update bundles, and `latest.json`. Documentation-only or website-only changes do not automatically create an app release. You can also run the workflow manually from GitHub Actions.

Major and minor versions come from `app/src-tauri/tauri.conf.json`. The patch is assigned using the release workflow run number. Increase the minor or major in the configuration when appropriate.

Installed apps check the latest release's `latest.json` shortly after launch and every six hours. A verified update is downloaded and the UI offers **Restart to update**, including in **Settings → Updates**. On Linux, AppImage installations can auto-update; `.deb` and `.rpm` users install a new download.

## Tauri update signing

The update public key is configured in `app/src-tauri/tauri.conf.json`. Only update bundles signed by the matching private key will be accepted.

Add these GitHub Actions repository secrets:

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the matching update-signing private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password, if one was set |

Keep a secure, offline backup of the private key. Losing it could prevent existing installations from trusting future updates. Do not commit private keys or credentials to the repository.

## macOS signing and notarization

Unless signed using an Apple Developer ID and notarized, macOS may warn that the developer cannot be verified. Beta users can use **System Settings → Privacy & Security → Open Anyway** after checking they downloaded the expected release.

To set up official signing:

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/).
2. Create a **Developer ID Application** certificate in Xcode and export it from Keychain Access as a password-protected `.p12` file.
3. At [account.apple.com](https://account.apple.com), create an app-specific password; find the team ID in the Apple Developer account.
4. Configure these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` file (e.g. `base64 -i DeveloperID.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Password of the exported certificate |
| `APPLE_ID` | Apple account email |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer team ID |

5. Push an app change or manually trigger the Release workflow, then check the signing and notarization output.

Windows installers are not currently code signed, so SmartScreen may prompt users to review the download.

## Download links

The [theoremis.com](https://theoremis.com) Download buttons detect the visitor's operating system and use the latest GitHub release assets. Check the installer names and `latest.json` after a release before promoting it.

The release workflow and CI definitions are in `.github/workflows/release.yml` and `.github/workflows/ci.yml`.
