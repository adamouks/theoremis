# Theoremis

The AI-native workspace for mathematics. Explore conjectures, develop proofs and test every step
with an AI collaborator that works inside your document. A desktop app built with
[Tauri](https://tauri.app); the collaborator runs on your ChatGPT plan (Sign in with ChatGPT) or
on [Ollama](https://ollama.com) models on your machine.

**[Download Theoremis](https://theoremis.vercel.app)** for macOS, Windows or Linux, or grab an
installer from the [releases](https://github.com/adamouks/theoremis/releases/latest).

![The Theoremis workspace: a proof with numbered equations, and the collaborator reviewing a step](docs/screenshot.png)

## What it does

- **Typeset documents.** Write in Markdown with LaTeX. Display equations are numbered across the
  document like a paper, including each row of an `align`. Switch between the rendered page and
  the TeX source at any time.
- **A document that knows its own status.** Every statement carries its standing in the gutter:
  open, tested, draft, adopted, proved or verified. The sidebar shows how far each document has got.
- **A collaborator in the margins.** Select a step and ask, or use **Explore**, **Find gaps**,
  **Challenge** or **Formalize** (Lean 4). The selection travels with the question, findings come
  back pinned to the line they concern, and every reply is marked _not verified_.
- **Nothing lands without consent.** Proposed rewrites appear as an original/proposed comparison
  you accept, edit or reject. New material comes in as a dashed suggestion until you accept it.
  Every change can be undone.
- **Projects, threads and focus.** Group documents into projects, keep several threads per
  document, jump anywhere with `⌘K`, and hide everything but the proof with `⌘.`.
- **Local-first.** Documents are JSON files on your machine. Your ChatGPT sign-in is encrypted
  with your system keychain and never reaches the interface.

The interface follows the _Theoremis Workspace_ design from Claude Design: Geist and Literata
(bundled, so it works offline), the dark indigo palette and the status marks.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- The Tauri system dependencies for your OS: see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/).
  On Debian or Ubuntu:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

### Run in development

```sh
npm install
npm run tauri dev
```

The first launch opens an example project, _Figurate numbers_, to try the tools on.

### Build an installer

```sh
npm run tauri build
```

The installers end up in `src-tauri/target/release/bundle/`.

### Publish a release

Bump `version` in `src-tauri/tauri.conf.json` (and `package.json`), then push a tag like `v0.2.0`
or run the **Release** workflow from the Actions tab. It builds the macOS (Apple silicon and
Intel), Windows and Linux installers, attaches them to a release, and publishes it once every
platform has built. The landing page's Download buttons pick the right installer for each visitor
from the latest release.

### Signing the macOS app

macOS opens a downloaded app without asking only if it is signed with an Apple Developer ID and
notarized by Apple. Until the release workflow has those credentials, the macOS build is ad-hoc
signed and Gatekeeper says it "could not verify" Theoremis. People can still open it with **System
Settings → Privacy & Security → Open Anyway**.

To sign and notarize every release:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) (paid, yearly).
2. Create a **Developer ID Application** certificate (Xcode → Settings → Accounts → Manage
   Certificates → + → Developer ID Application), then export it from Keychain Access as a `.p12`
   file with a password.
3. Create an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In and
   Security → App-Specific Passwords, and find your Team ID under Membership details at
   [developer.apple.com/account](https://developer.apple.com/account).
4. In the repository's **Settings → Secrets and variables → Actions**, add:

   | Secret | Value |
   | --- | --- |
   | `APPLE_CERTIFICATE` | the output of `base64 -i DeveloperID.p12` |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` file's password |
   | `APPLE_ID` | your Apple Account email |
   | `APPLE_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | your Team ID |

5. Bump the version and run the **Release** workflow. The macOS builds are then signed, notarized
   and stapled, and open without a warning.

Windows builds aren't signed yet either, so SmartScreen may ask once (**More info → Run anyway**).

## Connecting models

### ChatGPT (your plan)

Open **Settings → ChatGPT → Sign in with ChatGPT**. Your browser opens OpenAI's sign-in page; once
you approve, the collaborator runs on your ChatGPT plan (such as Plus or Pro) and its models appear
in the model picker. Replies count toward your plan's limits. **Manage usage** opens
[your usage page](https://chatgpt.com/settings/usage), and **Sign out** revokes Theoremis's access.

How it works: Theoremis is a public OAuth client of OpenAI's [Sign in with
ChatGPT](https://developers.openai.com/siwc), so there is no API key or app secret anywhere in the
code. The first sign-in registers your copy of Theoremis with ChatGPT; sign-in uses PKCE with a
loopback redirect to `127.0.0.1`, the ID token is verified against OpenAI's published keys, and
access tokens are refreshed in the background. Requests go to the Responses API with
`store: false`. All of this happens in the Rust backend, and the tokens are stored encrypted with a
key held in your system keychain (Keychain on macOS, Credential Manager on Windows, the Secret
Service on Linux, e.g. GNOME Keyring or KWallet).

### Ollama (local)

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Pull a model, for example `ollama pull qwen3:8b`.
3. Open Theoremis. Your models appear in the collaborator's model picker.

Theoremis talks to `http://127.0.0.1:11434` by default. It also honours `OLLAMA_HOST`, and you
can point it at another server in **Settings → Ollama → Server URL**. Reasoning models (Qwen 3,
DeepSeek-R1) show their thinking in a collapsible section.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘K` | Search documents and commands |
| `⌘N` | New document |
| `⌘L` | Ask about the selected step |
| `⌘.` / `esc` | Focus mode on / off |
| `⌘\` | Show or hide the collaborator |
| `⌘↵` | Accept the next suggestion (or, while writing, start a new paragraph) |
| `⌘,` | Settings |

On Windows and Linux use `Ctrl` for `⌘`.

## Where your data lives

| What | Where |
| --- | --- |
| Settings | `settings.json` in the app config directory |
| ChatGPT sign-in | `chatgpt.json` in the app config directory, encrypted (AES-256-GCM) with a key in your system keychain |
| Projects | `workspace/projects.json` in the app data directory |
| Documents, with their collaborator threads | one JSON file each in `workspace/documents/` |

The directories follow each OS's conventions for the app id `app.theoremis.desktop`
(e.g. `~/Library/Application Support/app.theoremis.desktop` on macOS,
`~/.config/app.theoremis.desktop` and `~/.local/share/app.theoremis.desktop` on Linux,
`%APPDATA%\app.theoremis.desktop` on Windows).

## The landing page

![The Theoremis landing page](docs/landing.png)

`site/` holds the website, built from the _Theoremis Landing_ design: the markup converted from the
design file, its hover styles in `site/src/hover.css`, and the animated review in the hero ported
to `site/src/main.ts`.

```sh
npm run site:dev     # http://localhost:1430
npm run site:build   # static files in site/dist, ready for any static host
```

It's deployed on Vercel at [theoremis.vercel.app](https://theoremis.vercel.app): `vercel.json`
tells Vercel to build the site rather than the desktop app, and every push to the default branch
redeploys it.

The design's "Get updates" form needs somewhere to send addresses. Set `VITE_UPDATES_ENDPOINT` to a
form endpoint (Buttondown, Formspree, …) when building; without one, the page links to the GitHub
releases instead.

## How it's built

```
src/                        React + TypeScript app (Vite)
  components/               Sidebar, document, blocks, collaborator, settings, palette
  lib/doc.ts                Statuses, equation numbering, block labels, proposals
  lib/prompts.ts            Collaborator modes and the request sent to the model
  lib/useWorkspace.ts       Projects and documents, with autosave
  lib/useCollaborator.ts    Streaming replies into threads; revisions and suggestions
src-tauri/src/
  lib.rs                    Tauri commands and app state
  chatgpt/                  Sign in with ChatGPT
    oauth.rs                OIDC discovery, PKCE, loopback callback, token refresh, ID tokens
    vault.rs                Credentials encrypted with a key from the system keychain
    api.rs                  Model catalog and streaming Responses
  providers/ollama.rs       Ollama: /api/tags, streaming /api/chat (NDJSON)
  settings.rs               Settings persistence
  storage.rs                Projects and document files
site/                       The landing page
```

All network calls happen in Rust. That avoids CORS entirely (Ollama rejects browser origins by
default) and keeps every credential out of the web view. Replies stream to the UI over a Tauri
[channel](https://v2.tauri.app/develop/calling-frontend/#channels). Stopping a reply drops the
HTTP request, which also stops generation on the server.

### Checks

```sh
npm run typecheck && npm test                               # frontend
cd src-tauri && cargo clippy --all-targets && cargo test   # backend
```

CI runs both, and builds the site, on every push.

## Roadmap

- More providers: OpenRouter, Poe
- Checking formalizations with Lean
- Cross-references that renumber as the document changes
- Signed, auto-updating releases
