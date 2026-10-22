# Theoremis

The AI-native workspace for mathematics. Explore conjectures, develop proofs and test every step
with an AI collaborator that works inside your document. A desktop app built with
[Tauri](https://tauri.app); the collaborator runs on [Ollama](https://ollama.com) models on your
machine or on OpenAI's ChatGPT models.

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
- **Local-first.** Documents are JSON files on your machine. Your API key never reaches the
  interface.

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

The installers end up in `src-tauri/target/release/bundle/`. You can also push a tag like
`v0.1.0` (or run the **Release** workflow by hand) to have GitHub Actions build macOS, Windows
and Linux installers into a draft release. Those builds aren't code-signed yet, so macOS and
Windows will warn the first time you open them.

## Connecting models

### Ollama (local)

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Pull a model, for example `ollama pull qwen3:8b`.
3. Open Theoremis. Your models appear in the collaborator's model picker.

Theoremis talks to `http://127.0.0.1:11434` by default. It also honours `OLLAMA_HOST`, and you
can point it at another server in **Settings → Ollama → Server URL**. Reasoning models (Qwen 3,
DeepSeek-R1) show their thinking in a collapsible section.

### ChatGPT (OpenAI)

1. Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Paste it in **Settings → ChatGPT → API key**.

API usage is billed to your OpenAI Platform account, separately from a ChatGPT Plus or Pro
subscription. If `OPENAI_API_KEY` is set in the environment Theoremis was launched from, it's used
when no key is saved in the app. **API base URL** accepts any OpenAI-compatible endpoint
(OpenRouter, LM Studio, vLLM, …).

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
| Settings, including the API key | `settings.json` in the app config directory, readable only by your user on macOS and Linux |
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
  providers/ollama.rs       Ollama: /api/tags, streaming /api/chat (NDJSON)
  providers/openai.rs       OpenAI: /models, streaming /chat/completions (SSE)
  settings.rs               Settings persistence and API key handling
  storage.rs                Projects and document files
site/                       The landing page
```

All network calls happen in Rust. That avoids CORS entirely (Ollama rejects browser origins by
default) and keeps the API key out of the web view. Replies stream to the UI over a Tauri
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
