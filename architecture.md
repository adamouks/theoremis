# Theoremis architecture

How Theoremis works, and why it's built the way it is. Read this before changing anything
structural. For setup, commands and data paths see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md);
for releases and signing see [docs/RELEASING.md](docs/RELEASING.md).

## The shape of it

Theoremis is a desktop app with two halves joined by Tauri's IPC, plus a separate static site.

```
┌──────────────────────────── the webview (app/src) ─────────────────────────────┐
│  React + TypeScript                                                            │
│                                                                                │
│  App.tsx ── Sidebar · DocumentView (blocks) · Collaborator · dialogs           │
│     │                                                                          │
│     ├─ useWorkspace     documents in memory, autosave                          │
│     ├─ useCollaborator  threads, replies, revisions, Auto-mode runs            │
│     ├─ useImport        files → documents, part by part                        │
│     ├─ useLean          Lean status, setup, checks                             │
│     ├─ components/ai/   the collaborator's orbs, reasoning and run timeline    │
│     └─ lib/             pure logic: numbering, prompts, transcripts, graphs…   │
│                                                                                │
└───────────────┬────────────────────────────────────────────┬───────────────────┘
                │ invoke() commands, Channel<StreamEvent>     │ theoremis://<doc>/<file>
┌───────────────┴──── the Rust process (app/src-tauri) ──────┴───────────────────┐
│  lib.rs           commands, AppState, the media URI scheme                     │
│  chatgpt/         Sign in with ChatGPT (OAuth+PKCE), encrypted vault, Responses │
│  providers/       Ollama, and the chat message shape both providers share      │
│  lean/            elan + Mathlib setup, screening and running checks           │
│  storage.rs       projects.json, one JSON file per document, media per document│
│  settings.rs      settings.json                                                │
└────────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS                       │ HTTP (localhost)          │ processes
   ChatGPT (OpenAI)              Ollama server              elan / lake / lean

site/   theoremis.com: a static Vite page with download buttons, deployed by Vercel
```

The split follows one rule: **the webview does documents and people; Rust does the outside
world.** The interface owns everything about writing (rendering, numbering, editing, the
collaborator's conversation). Rust owns anything that touches the network, the disk, secrets
or other programs.

## Decisions that shape everything

These are the choices the rest of the code leans on. Changing one is an architectural change.

**A desktop app, not a web service.** Mathematicians' drafts are unpublished work. Keeping
documents as files on their own machine, with their own model account (or a local model),
means Theoremis has no server to run, no database to secure and nothing to leak. Tauri was
chosen over Electron for a small installer and a Rust backend with a real type system for the
security-sensitive parts.

**Every network call happens in Rust.** The webview never makes a request to a model, so
tokens never enter JavaScript, and there is no CORS to work around (Ollama rejects browser
origins by default). The content security policy in `tauri.conf.json` enforces this:
`connect-src` allows only the app itself, IPC and the local media scheme.

**AI output is never a proof.** Replies are labelled _not verified_. A statement becomes
_verified_ only when Lean accepts a formalization with no `sorry` and no unexpected axioms.
Everything else (the collaborator agreeing, a transcription saying "proved") is at most a
status a person chose.

**The person chooses how much the collaborator may do, and can always take it back.** In
**Manual** mode the collaborator proposes and never edits: a rewrite appears as an
original/proposed comparison, new material as a dashed suggestion block, and both can be
undone after accepting. In **Auto** mode, which the person switches on, it works on the
document itself with tools. Every change it makes is recorded on its reply and marked in the
gutter, and one click undoes them all. Even in Auto it can't mark anything proved or adopted,
which are judgments only the mathematician can make, and it can mark a statement verified
only by getting Lean to accept a proof. Imports also write on their own, but only into a new
document or onto the end of one the person chose.

**Documents are opaque to Rust.** The backend stores the JSON the frontend sends and reads
only a few header fields to list documents (`storage.rs`). The document format can grow,
as it did for imports and graphs, without touching Rust or writing migrations.

**Text formats over structured ones where models are involved.** Models write Markdown with
LaTeX, and transcripts use a line format (`@@ block …`), not JSON. LaTeX is full of
backslashes that JSON would need escaped, and a line format can be read while it's still
streaming.

## The document model

`lib/types.ts` defines it. A **project** groups **documents**. A document has a title, a lede
(the summary paragraph), a list of **blocks**, and collaborator **threads**.

A block is one paragraph-sized piece of Markdown with LaTeX, plus:

- `status`: `open`, `tested`, `draft`, `adopted`, `proved` or `verified`, with an optional
  short `note` shown under it in the gutter;
- `suggestion`: set while the block is a collaborator suggestion awaiting a decision;
- `page`: for imported blocks, the page of the original it came from.

The document's own `status` (shown in the sidebar) is derived on save: the furthest any
accepted statement has got (`docStatus` in `lib/doc.ts`). `revision` counts content edits;
"meta" changes such as opening a thread don't bump it.

Blocks were chosen over one long Markdown string because statuses, selections, revisions and
page links all attach to a paragraph. Equation numbers still run across the whole document.

### Rendering a block

`components/Markdown.tsx` is the single renderer for documents, replies and previews:

1. `normalizeMath` (`lib/text.ts`) rewrites the delimiters models commonly emit
   (`\[…\]`, `\(…\)`, one-line `$$…$$`) into forms remark-math understands.
2. `numberBlocks` (`lib/doc.ts`) numbers display equations across the document the way a paper
   would: `\tag{n}` on each equation, one number per row of `align`/`gather`, skipping
   `\notag`, starred environments and equations that already have a tag. It also gives each
   block a label such as "Theorem 2 · (3)" for selections and pins.
3. react-markdown with remark-gfm, remark-math, rehype-katex and rehype-highlight renders it.
4. Two kinds of content are swapped for components: `![…](asset:<file>)` becomes a figure
   loaded from the document's media, and ` ```graph ` / ` ```graph3d ` fences become graph
   blocks (below).

Numbering happens on the text, not the DOM, so the same numbers appear in what the model is
sent (`documentAsText`) and in what the person sees. When the collaborator says "(2)", both
mean the same equation.

### Saving

`useWorkspace` keeps the open document in memory and writes it 600 ms after the last change,
and on window hide. Rust writes each file atomically (to `.tmp`, then rename), so a crash
mid-save never leaves half a document. Documents load one at a time; the sidebar lists them
from the header fields `storage.rs` reads.

## The collaborator

`useCollaborator` drives a conversation; `lib/prompts.ts` decides what the model sees.

The collaborator works in one of two modes, a setting (`autoMode`) switched in the composer:
**Manual** (the default), where replies propose, and **Auto**, where it acts (below).

**What a request contains.** The system message holds the collaborator's rules (rigor, the
"Proposed revision" / "Proposed addition" conventions, the graph syntax), the person's own
instructions from Settings, and the whole document as text, with equation numbers and
statuses, capped at 12,000 characters. Each user turn carries the mode's instruction
(Explore, Find gaps, Challenge, Formalize), the selected passage and any attached files.

**Streaming.** `api.streamChat` invokes the `chat_stream` command with a Tauri `Channel`.
Rust streams deltas (and, for models that expose it, reasoning) into the channel; the hook
batches them into one document update per animation frame. Stop calls `chat_cancel`, which
cancels a token that `tokio::select!` races against the request. Dropping the HTTP future
closes the connection, which also stops generation on the server.

**Proposals.** When a reply ends with `### Proposed revision`, `splitProposals` lifts it out
and the thread shows an original/proposed comparison bound to the selected block. When it
ends with `### Proposed addition`, it can be inserted as a suggestion block after the
selection. Accepting keeps the previous text on the message so it can be undone.

**Attachments.** Files attached to a question are read in the browser (`lib/attachments.ts`)
with the same readers imports use. Images and the first six pages of a PDF are saved as
JPEGs in the document's media; text (a PDF's text layer, LaTeX, Word converted to Markdown)
goes into the message. When the reply runs, the images are loaded and sent only if the model
can see them (`readsImages` in `lib/types.ts`), up to the twelve most recent in the thread.
The message text always says what was attached, so a model that can't see images still knows.

### Auto mode

In Auto mode a reply is a loop (`runAgent` in `useCollaborator`, tools in `lib/agent.ts`):

```
request (document with block handles, thread, tools)
   │
   ▼
model streams text and tool calls ──► no calls: done, the text is the summary
   │ calls
   ▼
run each tool on the latest document ──► results go back as `tool` messages ──► next round
```

The tools:

| Tool | Does |
| --- | --- |
| `read_document`, `list_documents` | Read this document (with handles) or another in the project |
| `edit_block`, `insert_block`, `delete_block` | Change blocks |
| `set_status` | Set open, tested or draft (never adopted, proved or verified) |
| `set_title` | Change the title and summary |
| `check_lean` | Run Lean on a file; with `block`, mark that block verified if Lean accepts it |
| `check_graph` | Parse graph code and report what each line draws and any errors |

How it's built, and why:

- **The loop runs in the webview, not in Rust.** The tools act on documents, and documents
  belong to the interface (Rust keeps them opaque). So Rust stays a streaming client that
  now also passes tool definitions, tool calls and results through `chat_stream`.
- **Blocks get short handles** (`B1`, `B2`, …) fixed for the run (`Handles`), because models
  copy `B3` reliably and UUIDs less so. The document in the prompt is shown with them, as is
  every `read_document`.
- **Every tool is a function from the latest document to the next.** It runs through
  `transactDocument` (in `useWorkspace`), a single read-modify-write that works whether or
  not the document is open. The person can keep typing, or switch documents, mid-run without
  losing anything. Each change records the block before and after (`AgentChange`).
- **Undo replays the changes backwards** (`undoRun`): insertions are removed, deletions put
  back where they were, and edits and statuses restored. Blocks the person added meanwhile
  are left alone. Retry is hidden while a reply's changes are still in the document, so a
  fresh attempt can't silently stack on top of them.
- **Verified stays earned.** `set_status` refuses verified, proved and adopted. `check_lean`
  marks a block verified only when Lean accepts every proof with no `sorry`, the file
  declares a named theorem, and no theorem rests on axioms beyond Mathlib's standard three.
  The note says "checked in Lean (Auto)" so it reads differently from a person's own check.
  The remaining risk is a formalization that states something other than the block. The
  prompt forbids weakening a statement, and the reply shows the Lean file for review.
- **Edits undo earlier checks.** Rewriting a proved or verified block moves it back to
  draft, since the check was of the old text.
- **Provenance is visible.** Blocks the agent writes carry `byAgent` and an AUTO tag in the
  gutter until the person edits them. The reply shows each step (with Lean's errors under
  Details) and ends with how many changes it made and an **Undo all** button.
- **Bounded.** A reply may take 24 rounds of tool calls; Stop cancels the request in flight
  and ends the loop after the current tool. Tool failures (bad arguments, a missing block,
  Lean errors) go back to the model as results rather than ending the run.
- **Later turns know what happened.** The history sends each past Auto reply's text plus a
  one-line list of what it did (`describeRun`), not the raw tool traffic.

Auto needs a model that calls tools (`callsTools` in `lib/types.ts`): every ChatGPT model, and
Ollama models whose `/api/show` capabilities include `tools`. With any other model, Auto
works like Manual and the composer says so.

### How the collaborator looks

The collaborator's AI surfaces live in `components/ai/`. Motion there carries information
about what the model is doing; none of it is decoration on its own.

| Piece | Shows |
| --- | --- |
| `Orb` | The model is working. Its motion says what at: thinking, reading, Lean, writing, graphs (`toolActivity`) |
| `Shimmer` | Status text while something runs: "Thinking…", "Checking with Lean…" |
| `Reasoning` | What the model thought. It opens while the model thinks, folds a second after the answer starts, and then says how long it thought (`thoughtSeconds`) |
| `AgentTimeline` | An Auto reply: its text, with each tool on a rail between. Lean's errors open under Details. It ends with what changed, Undo, and how long the run took (`finishedAt`) |
| `ComposerBeam`, `AutoLabel` | A light around the composer and a lit "Auto" while Auto works on its own |
| `Sparks` | Two moments worth marking: Lean verifying a statement, and the person taking in a proposal (Accept, Insert) |
| `Spotlight`, `ThreadEdges` | Proposal cards lit under the pointer, and soft edges where the thread scrolls |

- **The effects are vendored, behind wrappers.** `src/vendor/` holds Libraries.dev's Thinking
  Orbs and six React Bits components, as upstream wrote them. `components/ai/effects.tsx`
  wraps each with Theoremis's colours and sizes, so the rest of the app never imports a
  vendored file. The reasoning, chain-of-thought, scroll-to-latest and suggestion patterns
  follow Vercel AI Elements and Prompt Kit, reimplemented in plain CSS (the app has no
  Tailwind). Licenses are in `THIRD_PARTY_NOTICES.md` and `src/vendor/README.md`.
- **Agents Kit's own components aren't used.** They carry a non-commercial license, which
  doesn't fit an MIT app. Only the MIT and Apache-2.0 work it collects is used.
- **Sparks are earned.** A verified step sparks only when it turns verified in front of the
  person (pending to verified), not when a thread with one loads.
- **Everything stops for reduced motion.** The canvas effects check
  `prefers-reduced-motion` and pause offscreen. The CSS motion stops under the global
  reduced-motion rule.

### Providers

Both providers implement the same thing: take `ChatMessage`s (role, content, images, tool
calls and results), emit `StreamEvent`s (text, reasoning, tool calls).

- **ChatGPT** (`chatgpt/`). Sign in with ChatGPT is an OAuth authorization-code flow with
  PKCE, a nonce and a loopback redirect to `127.0.0.1`. The first sign-in registers the
  installation dynamically and keeps the issued client id. Tokens are refreshed a minute
  before they expire. The whole connection is sealed with AES-256-GCM using a key kept in
  the OS credential store (Keychain, Credential Manager, Secret Service), with deliberately
  no plaintext fallback. Requests go to the Responses API with `store: false`; images are
  sent as `input_image` parts. Tools are `function` tools; tool calls arrive as finished
  `function_call` output items, and results go back as `function_call_output`. Because
  nothing is stored server-side, Auto requests ask for encrypted reasoning
  (`include: ["reasoning.encrypted_content"]`) and pass every output item back verbatim
  (`StreamEvent::Opaque`), so the model keeps its train of thought between tool calls. A model
  that refuses encrypted reasoning is asked again without it, and its turns are written out
  from their text and calls.
- **Ollama** (`providers/ollama.rs`). `GET /api/tags` lists models; `POST /api/chat` streams
  NDJSON. Whether a model can see or call tools comes from `/api/show` capabilities. Tool
  arguments go to Ollama as JSON objects and results as `tool` messages naming the tool;
  calls Ollama doesn't number are numbered on arrival. `num_ctx` is raised for large
  requests (transcriptions), since Ollama's default context silently truncates.

Model lists are fetched by `list_models`, which reports each provider's availability and a
message to show when it isn't (Ollama not running, not signed in).

## Lean 4

`lean/mod.rs` installs Lean with elan (its official installer scripts) and creates a Lake
project in the app's data directory from Mathlib's template. It then fills that project from
Mathlib's cache of prebuilt files, so nothing is compiled on the person's machine (about
5 GB).

A check (`lean_check`):

1. **Screens** the file (`lean/check.rs`, `refusal`). Lean can run programs at elaboration
   time, so files using `#eval`, `run_cmd`, `IO`, `unsafe`, custom syntax, macros or
   elaborators, code-running attributes, or imports outside Lean and Mathlib are refused.
   Comments are stripped first so prose can't trip the checks, while strings are kept
   because interpolated strings hold code. This is a precaution, not a sandbox.
2. **Runs** `lake env lean --json` on the file with `#print axioms` appended for every
   declared theorem, with a 10-minute timeout.
3. **Interprets** the result: errors; compiles but rests on `sorry`; or accepted, with any
   axioms beyond `propext`, `Classical.choice` and `Quot.sound` reported.

Only an accepted check can mark a block _verified_, and it records "checked in Lean" as its
note. Lean's errors can be sent back to the collaborator in one click.

## Imports

Importing turns files into a Theoremis document: statements, statuses, equations, figures.
The pipeline lives in the webview because pdf.js, canvas cropping and the model calls already
do, and Rust only needs to store the results.

```
files ──readImports (lib/sources.ts)──► ImportSource
          PDF      pdf.js: page renders, text layer, figure regions (lib/pdf.ts, figures.ts)
          photos   decoded to canvases
          LaTeX / Markdown / text   kept as text, plus a direct conversion
          Word, HTML, notebooks, CSV, code   converted directly (convert.ts, docx.ts)
                │
                ▼
        ImportDialog: new document or append, which pages, with or without the model
                │
                ▼
useImport ── split into parts (3 pages with images, 6 without; ~14k chars of text)
                │
      with a model:  transcribePrompt → streamChat → transcript.ts parses "@@" sections
                     as they stream → importDoc.ts puts blocks into the document
      without:       layout.ts (PDF text in reading order) or the direct conversion
                │
                ▼
        figures cropped from the rendered page and saved as media; blocks get `page`
```

Key choices:

- **Figures are copied, not redrawn.** Figures are found from what the page's content stream
  actually draws. `pdf.ts` walks pdf.js's operator list, tracking the transformation matrix,
  to get the box of every path and image. `figures.ts` then clusters vector paths (plots,
  diagrams), images and their nearby labels, and keeps clusters that look like figures rather
  than rules or framed equations. Each is
  cropped from the page rendered at 180 dpi. A model sees the page with figures boxed and
  numbered (`F1`, `F2`, …) and places them by reference, so the image in the document is
  exactly what the PDF drew. For photos, the model gives crop boxes instead.
- **Transcribing in parts.** Long papers don't fit one reply, and a failure halfway shouldn't
  lose the rest. Each part's blocks replace the previous reading of that part, so the reply
  can be re-parsed on every delta and shown live. `DocOrigin.done` records how far it got,
  and **Continue** resumes from there. A paragraph cut by a page break is marked `continues`
  and joined to the previous one.
- **The original stays.** The imported file is kept in the document's media, and blocks
  carry their page, so the gutter's "p. 3" opens the original beside the transcription
  (`SourceViewer`).
- **Models are optional.** Every format has a direct path, so imports work offline and
  without an account, just less cleverly (one-column PDF layout, no handwriting).

pdf.js and its worker are loaded only with the first PDF; its fonts, character maps and
decoders are copied into the build by `vite.config.ts`.

## Graphs

` ```graph ` and ` ```graph3d ` fences are a graphing calculator inside documents and replies.
The fence's text is the source of truth: dragging a slider, picking a colour or saving the
window rewrites the fence, so graphs survive copy and paste, export as text, and are what
the model reads and writes.

```
fence text ──parseGraph (lib/graph/spec.ts)──► GraphSpec: items, sliders, view
                  │ each line → parse() → AST (lib/graph/expr.ts) → compile() → closure
                  │ toLatex() for the typeset expression list
                  ▼
   2D: Graph2D (canvas)        plot2d.ts: adaptive sampling for curves, marching squares
                                for implicit curves, masks for regions, asymptote breaks
   3D: Graph3D (three.js)      plot3d.ts: grids for surfaces, marching tetrahedra for
                                implicit surfaces, polylines for curves
```

- **Our own expression language.** It reads both plain input (`y = a x^2 + sin 2x`) and the
  LaTeX models write (`\frac{1}{2}\sin^2 x`), with Desmos's conventions: implicit
  multiplication, subscripted variables, piecewise braces, `f'(x)`, sums, products and
  integrals. It compiles to JavaScript closures, because the content security policy rules
  out `eval` and `new Function`, and closures are fast enough to sample hundreds of
  thousands of points.
- **What a line means** is decided by its shape: `y = …` is explicit, `r = …` polar, a pair
  or triple of expressions in `t` (or `u, v`) parametric, an equation in both variables
  implicit, an inequality a region, `a = 1` a slider, `f(x) = …` a function. Names used but
  not defined get an **Add a slider** button rather than silently becoming zero.
- **Canvas for 2D, WebGL for 3D.** The plane is drawn on a 2D canvas, which is crisp and needs
  no dependencies. three.js (with orbit controls, fat lines and CSS labels) is about 600 kB,
  so `Graph3D` is lazy-loaded with the first 3D graph.

## Media

Images, figure crops, attachments and imported originals live in
`workspace/assets/<document id>/` and are deleted with the document.

- **Writing** uses `save_asset`, which takes the raw bytes as the IPC body (names in headers)
  so a 20 MB PDF isn't base64'd into JSON.
- **Reading** uses a custom URI scheme, `theoremis://localhost/<document>/<file>`
  (`http://theoremis.localhost/…` on Windows), registered in `lib.rs`. The webview loads
  figures like any image, with no IPC round trip.
- File names are generated (`fig-<uuid>.png`) and validated in Rust against a known list of
  extensions, so a document can't name a path outside its folder. Responses carry their own
  CSP, so an SVG is shown as an image and never runs as a document.

## The IPC surface

Every command is in `lib.rs` and typed in `lib/api.ts`:

| Area | Commands |
| --- | --- |
| Settings | `get_settings`, `update_settings` |
| Models | `list_models`, `chat_stream` (with a channel, and tools in Auto mode), `chat_cancel` |
| ChatGPT | `chatgpt_session`, `chatgpt_sign_in`, `chatgpt_cancel_sign_in`, `chatgpt_sign_out` |
| Lean | `lean_status`, `lean_setup`, `lean_cancel_setup`, `lean_check` |
| Workspace | `load_workspace`, `save_projects`, `load_document`, `save_document`, `delete_document` |
| Media | `save_asset` (raw body), `delete_asset`, and the `theoremis://` scheme for reads |

Errors cross the boundary as one serialized string (`error.rs`), written to be shown to a
person as they are.

## Security model

- Tokens and the vault key never leave Rust; the frontend sees only a `Session`: whether and
  as whom the person is signed in, and whether the account shares its plan with Theoremis.
- The CSP allows scripts only from the app (plus WebAssembly for pdf.js), connections only to
  IPC and the media scheme, and images from the app, data/blob URLs, HTTPS and the media
  scheme.
- Lean files are screened before they run; the screening is a precaution, not a sandbox.
- In Manual mode collaborator output can't change a document without a click, and accepted
  changes can be undone. In Auto mode it changes only the document it was asked about (other
  documents are read-only to it), every change is recorded and undoable, and it can't give
  the statuses that mean a person or Lean checked something.
- The model never runs code itself. The only thing Auto can run is a Lean check, which goes
  through the same screening as a check the person starts.

What it doesn't protect against: a malicious Mathlib, a compromised model provider, or
someone with access to the unlocked user account. The vault's key is in that user's keychain.

## The site

`site/` is theoremis.com: one static page built with Vite from the landing design, with
hover styles in `hover.css`, the animated review in the hero in `main.ts`, and Download
buttons (`download.ts`). The buttons ask GitHub's API for the latest release and pick the
installer for the visitor's OS and architecture, falling back to the releases page. Its figures are HTML with live KaTeX, like the app, except the 3D surface in §5, an SVG
drawn by `site/scripts/draw-surface.py`. Vercel
builds it from `vercel.json` on every push to `main`. It shares nothing with the app at
runtime.

## Build, release and updates

- **CI** (`.github/workflows/ci.yml`) runs on every push: typecheck, unit tests and a build
  for the interface; `cargo fmt`, `clippy -D warnings` and `cargo test` for the backend; a
  build for the site.
- **Release** (`release.yml`) runs after CI succeeds on `main`, only if something under `app/`
  changed. The version is the major.minor from `tauri.conf.json` with the workflow's run
  number as the patch, so every release is newer than the last. It builds installers for
  macOS (Apple silicon and Intel), Windows and Linux, and signs update bundles and
  `latest.json` with the updater key.
- **Updates.** Installed apps check `latest.json` 10 seconds after launch and every six hours
  (`useUpdates`), download a verified update in the background, and offer **Restart to
  update**.

Merging app changes to `main` therefore ships them to every user within hours. Treat `main`
as production.

## Testing

- **Pure logic is tested in isolation** with Vitest: equation numbering, proposals, prompt
  assembly, transcript parsing, figure detection, converters, the expression language, graph
  specs and geometry, and every Auto-mode tool and Undo, run against plain documents with a
  fake Lean. Most of the app's intelligence lives in `lib/` precisely so it can be
  tested without a browser.
- **Rust** has unit tests for every module, including token handling, the vault (with a fake
  key store), Lean screening and verdicts (with Lean's real output), storage, and streaming
  clients, including tool calls and the encrypted-reasoning fallback, against a local HTTP
  server that replays recorded responses (`providers/test_server.rs`).
- **The interface** is exercised by driving the built frontend in a browser with Tauri's IPC
  mocked (`@tauri-apps/api/mocks`), which covers imports, graphs and the collaborator,
  including a scripted Auto run with Lean, graphs, Undo and Stop, without a model or a
  desktop window.

## Where to make a change

| To… | Look at |
| --- | --- |
| Change what the collaborator is told | `lib/prompts.ts` |
| Give the collaborator a new tool in Auto mode | `AGENT_TOOLS` and `runTool` in `lib/agent.ts` (a document-to-document function, with a test), its working label in `components/ai/AgentTimeline.tsx` and its orb in `toolActivity` (`components/ai/effects.tsx`) |
| Change the collaborator's effects or their colours | The wrappers in `components/ai/effects.tsx`. Leave `src/vendor/` as upstream wrote it, and list any change in `src/vendor/README.md` |
| Add a collaborator mode | `Mode` in `lib/types.ts`, `MODE_INSTRUCTIONS` in `lib/prompts.ts`, the composer in `Collaborator.tsx` |
| Add a model provider | `providers/` (stream `StreamEvent`s from `ChatMessage`s), `Provider` in both `providers/mod.rs` and `lib/types.ts`, `list_models` and `run_chat` in `lib.rs` |
| Add a block field | `Block` in `lib/types.ts`. Rust needs no change |
| Support a new import format | `fileKind` and `readImports` in `lib/sources.ts`, a converter in `lib/convert.ts` |
| Change how transcripts are written | `lib/transcribePrompt.ts` and `lib/transcript.ts`, together |
| Add a graph feature | `lib/graph/spec.ts` (what a line means), `expr.ts` (syntax), `plot2d.ts`/`plot3d.ts` (geometry) |
| Allow a new media type | `ASSET_TYPES` in `storage.rs` and `EXTENSIONS` in `lib/media.ts` |
| Loosen or tighten Lean screening | `refusal` in `lean/check.rs`, with a test |
