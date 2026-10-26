# Developing Theoremis

This document is for contributors and developers who want to run, inspect, or modify Theoremis. For a product overview, see the [main README](../README.md). For distribution and code signing, see [RELEASING.md](RELEASING.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | Tauri desktop application |
| `app/src/` | React + TypeScript interface (Vite) |
| `app/src-tauri/` | Rust backend: authentication, model providers, Lean, settings, storage |
| `site/` | Static marketing and download site at [theoremis.com](https://theoremis.com) |
| `docs/` | Screenshots and project documentation |

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- Stable [Rust](https://www.rust-lang.org/tools/install)
- [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS

On Debian or Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Run the desktop application

```sh
cd app
npm install
npm run tauri dev
```

The first launch offers a beta introduction, connection to ChatGPT or Ollama, Lean 4 setup, and an example project (*Figurate numbers*) or a blank page. The example can also be added later from the command palette (`⌘K` → **Add the example project**).

To build local installers:

```sh
cd app
npm run tauri build
```

Build artifacts are placed under `app/src-tauri/target/release/bundle/`. See [RELEASING.md](RELEASING.md) for published releases, updates, and operating-system signing.

## Architecture

[architecture.md](../architecture.md) explains how the pieces fit together and why. The source layout:

```text
app/src/                      React + TypeScript interface
  components/                 Sidebar, document, blocks, collaborator, settings, palette, imports
  components/graph/           Graph blocks: the plane (canvas), space (three.js), expression list
  lib/doc.ts                  Statuses, equation numbering, block labels, proposals
  lib/prompts.ts              Collaborator modes and requests to the model
  lib/useWorkspace.ts         Projects, documents, autosave
  lib/useCollaborator.ts      Thread streaming, revisions, suggestions, Auto and Seminar runs
  lib/agent.ts                Auto mode's tools, block handles and Undo
  lib/agentLoop.ts            The loop of model and tools, shared by Auto and Seminar members
  lib/seminar.ts              Seminar mode: convening members, running them at once
  lib/latexExport.ts          A document as an amsart source; lib/exportDocument.ts saves it
  lib/zip.ts                  ZIP writing, for exports and shared documents
  lib/macros.ts, bibtex.ts    A document's macros and references; lib/citations.ts, its \cite
  lib/notation.ts             Both, read once for rendering, prompts and export
  lib/share.ts                A document as a .theoremis file to send a co-author
  lib/attachments.ts          Files sent with a question: page images and text
  lib/sources.ts              Reading imports: PDFs, photos, LaTeX, Markdown, Word, HTML, …
  lib/pdf.ts, figures.ts      pdf.js pages and text; finding figures in what a page draws
  lib/importDoc.ts            A source into a document, with or without a model
  lib/useImport.ts            Running imports part by part, with progress and resume
  lib/transcript.ts           The line format models transcribe into, read as it streams
  lib/convert.ts, docx.ts     Direct conversion of LaTeX, Markdown, Word, notebooks, tables
  lib/graph/                  Expression language, graph specs, 2D and 3D geometry
app/src-tauri/src/            Rust backend
  lib.rs                      Tauri commands, the theoremis:// media scheme, application state
  chatgpt/
    oauth.rs                  OIDC discovery, PKCE, callback, refresh, ID-token handling
    vault.rs                  Encrypted credentials backed by the OS keychain
    api.rs                    Model catalog and streaming Responses (text and images)
  lean/mod.rs                 Lean/Mathlib setup and checks
  lean/check.rs               Input screening, theorem/axiom inspection, verdict parsing
  providers/mod.rs            Chat messages (with images) shared by the providers
  providers/ollama.rs         Ollama tags, vision capability, streamed chat
  settings.rs                 Settings persistence
  storage.rs                  Project/document files and their media
```

Desktop-app network requests run in the Rust backend, keeping credentials out of the webview and avoiding browser CORS restrictions. Model output streams to React over a Tauri channel; cancellation drops the underlying HTTP request.

### ChatGPT connection

In **Settings → ChatGPT**, select **Sign in with ChatGPT**. The app uses OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc) flow with OAuth/PKCE, a loopback callback on `127.0.0.1`, ID-token validation against published keys, and background token refresh. The Rust backend sends requests to the Responses API with `store: false` and keeps credentials encrypted using AES-256-GCM with a key held in the OS keychain (Keychain, Credential Manager, or Secret Service). The app does not need an API key embedded in its source.

Using a remote model means relevant prompts and selected document context leave your machine. Local document storage does not mean all model processing is offline. Review the selected provider and its policies before sending sensitive material.

### Ollama connection

Install [Ollama](https://ollama.com/download) and pull a model, for example:

```sh
ollama pull qwen3:8b
```

The default endpoint is `http://127.0.0.1:11434`; `OLLAMA_HOST` and **Settings → Ollama → Server URL** can change it. Local Ollama processing stays on your machine when the configured server is local. Qwen 3 and DeepSeek-R1 reasoning output can appear in a collapsible section.

### Lean 4 and Mathlib

Choose **Settings → Lean 4 & Mathlib → Set up**. The app installs Lean with [elan](https://github.com/leanprover/elan) if needed, then creates a Mathlib project from the Mathlib template and downloads prebuilt libraries. Plan for roughly **5 GB** of disk space. Git is required; on macOS, `xcode-select --install` can provide it.

For a code block proposed by **Formalize**, **Check with Lean** runs `lake env lean` and inspects theorem axioms. Results distinguish:

- **Accepted proof:** No Lean errors, no `sorry` dependency. Axioms beyond the standard Mathlib ones are reported.
- **Compiles but uses `sorry`:** Incomplete proof; it is not marked verified.
- **Lean errors:** Diagnostics can be returned to the collaborator with **Ask to fix**.

The check refuses code involving `#eval`, `run_cmd`, custom elaborators/macros/syntax, `IO`, `unsafe`, or imports outside Lean/Mathlib. **These filters are a precaution, not a general-purpose sandbox or a guarantee that arbitrary input is safe to execute.** Running a Lean toolchain still executes software on your machine.

AI-generated reasoning is always labeled *not verified* until a separately checked proof meets the app's verification criteria.

## Manual, Auto and Seminar

The switch in the collaborator's composer (or `⌘K` → **Collaborator: switch to Auto** / **switch to Seminar**) sets how the collaborator works. It's saved in settings as `autoMode`, with `seminar` beside it.

- **Manual** (the default): replies propose rewrites and additions, which you accept, edit or reject.
- **Auto**: the collaborator uses tools to read and edit the document, set statuses (open, tested, draft), check Lean files, check graph code, and read other documents in the project. It loops, up to 24 rounds of tool calls per reply, until it's done, and then summarizes.
- **Seminar**: the collaborator convenes up to four members, each with a role and an objective it states in its own words (a Prover, a Skeptic, a Formalizer…), who work on the document at the same time with the Auto tools, up to 12 rounds each. A member can't overwrite a block another has changed since it last read it. The collaborator then sums up from their reports. With Ollama the members take turns.

Each reply lists its steps (in Seminar, under each member), blocks it wrote carry an **AUTO** tag until you edit them, and **Undo all** takes back every change. A statement becomes *verified* in Auto only when Lean accepts a named theorem for it with no `sorry` and only standard axioms; its note then reads "checked in Lean (Auto)".

Auto and Seminar need a model that calls tools: any ChatGPT model, or an Ollama model with the `tools` capability (for example `qwen3`, `llama3.1` or `mistral-small`). With others, they work like Manual. How they work is in [architecture.md](../architecture.md#auto-mode).

## Importing research

**Import** in the sidebar (`⌘O`), or drop files on the window. Theoremis reads:

| Files | How |
| --- | --- |
| PDF | Each page's text layer and image. Figures are found from what the page draws (vector paths and images), cropped from the page, and kept with the document |
| Photos and scans (PNG, JPEG, HEIC, …) | Read by a vision model; figures it marks are cropped from the photo |
| LaTeX, Markdown, plain text | Theorems, proofs and equations become statements; `\includegraphics` picks up images dropped alongside |
| Word (`.docx`), HTML, Jupyter, CSV, code | Converted directly, keeping equations (Word's included), tables and images |

With a model, the transcript streams into the document part by part; a failed part can be
continued later from where it stopped. Pick a vision model (any ChatGPT model, or one like
`qwen2.5vl` or `gemma3` in Ollama) for PDFs and photos. Without one, Theoremis lays out the text
layer itself. Imported paragraphs show their page in the gutter, and the original opens beside it.

## Graphs

Add a graph from the bar under the document, or write a fence. One expression per line, in LaTeX
or plain notation:

````md
```graph
y = a \sin(bx)                 % a curve
a = 1 [0, 3]                   % sliders, with their ranges
b = 2
f(x) = x^2 - 2                 % a function, usable as f(x) and f'(x)
x^2 + y^2 = 4 ; dashed         % an implicit curve
y < f(x)                       % a shaded region
r = 1 + \cos\theta             % polar
(\cos t, \sin 2t) [0, 2\pi]    % parametric, with the range of t
(1, 2), (3, 4) ; label=P       % points
view x=[-5, 5] y=[-3, 3]
```
````

`graph3d` takes `z = f(x, y)`, implicit surfaces such as `x^2 + y^2 + z^2 = 9`, curves
`(\cos t, \sin t, t/4) [0, 4\pi]`, surfaces `(x(u,v), y(u,v), z(u,v)) [u0, u1, v0, v1]` and
points. A name that isn't defined yet gets an **Add a slider** button. Options follow semicolons: `color=#e64980`, `dashed`, `hidden`, `label=…`, `width=…`,
`opacity=…`. Drag to pan (or turn, in 3D), scroll to zoom, and edit expressions in the list below
the graph; changes are written back to the fence.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Search documents and commands |
| `⌘N` | New document |
| `⌘O` | Import files (or drop them on the window) |
| `⌘L` | Ask about the selected step |
| `⌘.` or `Esc` | Focus mode |
| `⌘\` | Toggle collaborator |
| `⌘↵` | Accept suggestion / new writing paragraph |
| `⌘,` | Settings |
| `⌘P` | Print, or save as PDF |
| `⌘⇧E` | Export as LaTeX |

Use `Ctrl` in place of `⌘` on Windows and Linux.

## Where local data lives

| Data | Location |
| --- | --- |
| Settings | `settings.json` in app config |
| ChatGPT sign-in | Encrypted `chatgpt.json` in app config; key in system keychain |
| Projects | `workspace/projects.json` in app data |
| Documents and threads | Individual JSON files in `workspace/documents/` |
| Images, figures, attachments, imported originals | `workspace/assets/<document id>/`, removed with the document |
| Earlier versions | `workspace/history/<document id>/`, up to sixty, removed with the document |

The workspace can be moved to a folder of your choosing (**Settings → Workspace**), such as one Dropbox, iCloud Drive or OneDrive shares; it's then in a `Theoremis` folder there, and `settings.json` records where.
| Mathlib project | `lean/TheoremisMath` in app data (`~/.elan` for Lean) |

The app ID is `app.theoremis.desktop`. Typical base directories: `~/Library/Application Support/app.theoremis.desktop` on macOS; `~/.config/app.theoremis.desktop` and `~/.local/share/app.theoremis.desktop` on Linux; `%APPDATA%\app.theoremis.desktop` on Windows.

## Run the website

```sh
cd site
npm install
npm run dev      # http://localhost:1430
npm run build    # site/dist
```

The static site is hosted on Vercel. The repository's `vercel.json` builds `site/`; pushes to `main` redeploy the site. The design includes `site/src/hover.css`, `site/src/main.ts`, and `site/src/download.ts`; the hero, a replay of a review in the app, is styled in `site/src/hero.css` and draws its orb with the app's vendored engine through `site/src/orb.ts`. When the app's interface changes, update the hero to match. Download links choose installers from the latest GitHub release. To activate the email updates form, set `VITE_UPDATES_ENDPOINT` to a suitable form endpoint; without it, the form links to releases.

## Quality checks

```sh
cd app && npm run typecheck && npm test
cd app && npm run test:print        # prints a long test document to PDF and checks every page
cd app/src-tauri && cargo clippy --all-targets && cargo test
cd site && npm run build
```

`npm run test:print` needs Chromium for Playwright (`npx playwright install chromium`). It prints the document at seven lengths, on A4 and US Letter, and checks that each PDF holds every block and every Lean line, ends with `END_OF_DOCUMENT_EXPORT_TEST` on its last page, and keeps its margins. Add `-- --webkit` to print with WebKitGTK as well, the engine Tauri uses on Linux; that needs `python3-gi`, `gir1.2-webkit2-4.1` and `xvfb-run`, and `PYTHON=` names the interpreter when the default `python3` lacks the GTK bindings. On a Mac, `-- --macos` prints with macOS's WebKit too, as the app does there (CI runs it). The PDFs land in `app/e2e/out/` to look at.

To check printing in the desktop app itself, through the print dialog, which CI doesn't drive: open a long document with graphs and a Lean block (or ask Auto mode for one), choose **Print or save as PDF…** (⌘P), and in the dialog's preview check that the last page holds the document's last paragraph, that the Lean code continues across pages, that no equation runs into the margin or under its number, and that both graphs show. Save it as a PDF and check the same in the file; change the paper size in the dialog and check again.

CI runs the application and site checks on pushes. See `.github/workflows/ci.yml` and `.github/workflows/release.yml` for their source definitions.
