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
│     ├─ useCollaborator  threads, replies, revisions, Auto and Seminar runs     │
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
│  storage.rs       documents, media, versions; never saves over others' edits   │
│  references.rs    papers by arXiv id or DOI, and searches of arXiv and Crossref│
│  settings.rs      settings.json                                                │
└────────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS                       │ HTTP (localhost)          │ processes
   ChatGPT, arXiv, Crossref      Ollama server              elan / lake / lean

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
gutter, and one click undoes them all. **Seminar** mode is Auto with several members working
at once, under the same rules and with one Undo for all of them. Even in Auto it can't mark
anything proved or adopted,
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
mid-save never leaves half a document. On Windows, where a file another program has open can't
be replaced for a moment, the rename is retried briefly. Documents load one at a time; the
sidebar lists them from the header fields `storage.rs` reads.

**Versions.** Saving also keeps a version of the document, at most every ten minutes of work,
in `history/<document id>/` (an `index.json` and one file per version), up to sixty; past that
the oldest go, unlabelled ones first. An empty new document keeps none. Before an Auto reply,
a seminar or a restore, the document is kept too, labelled (`snapshot_document`). Version
history lists them, shows one as it was, and restores its title, summary, blocks, macros and
references; threads stay as they are.

**Never over someone else's edits.** The workspace can live in a folder a sync service shares
(see [Working with co-authors](#working-with-co-authors)), so another computer may change a file
while it's open here. `storage.rs` remembers a fingerprint of each document's file as it last
read or wrote it, and `save_document` returns nothing, without writing, when the file on disk
differs. The open document's save then keeps both: theirs becomes the document, and the edits
made here are saved beside it as "(your version)", with its media copied (`keepBoth` in
`useWorkspace`). The check that a file changed (`changed_documents`) runs in the same queue as
saves, so a save of this app's own is never mistaken for someone else's.

## The collaborator

`useCollaborator` drives a conversation; `lib/prompts.ts` decides what the model sees.

The collaborator works in one of three ways, switched in the composer and saved in settings
(`autoMode`, and `seminar` beside it): **Manual** (the default), where replies propose;
**Auto**, where it acts; and **Seminar**, where several members it convenes act at once (both
below).

**What a request contains.** The system message holds the collaborator's rules (rigor, the
"Proposed revision" / "Proposed addition" conventions, the graph syntax), the person's own
instructions from Settings, and the whole document as text, with equation numbers and
statuses, capped at 12,000 characters. Each user turn carries the mode's instruction
(Explore, Find gaps, Challenge, Formalize, Is it known?), the selected passage and any attached
files. The document's macros and references follow the document (`notationForPrompt`).

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

In Auto mode a reply is a loop (`agentLoop` in `lib/agentLoop.ts`, run by `runAgent` in
`useCollaborator`; the tools are in `lib/agent.ts`):

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
| `search_literature` | Search arXiv and Crossref, for whether a result is known |
| `add_reference` | Add a paper to the document's references by arXiv id or DOI, and get its key to `\cite` |

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

### Seminar mode

In Seminar mode the collaborator chairs a small seminar on the request (`runSeminar` in
`useCollaborator`, its pieces in `lib/seminar.ts`):

```
the chair: one request whose only tool is convene
   │   members: a role, an objective in the member's own words, the blocks it concerns
   ▼
the members work at the same time, each in its own Auto loop, on the one document
   │   ChatGPT: three at a time · Ollama: one at a time
   ▼
the chair: one request without tools, from the members' reports ──► the reply
```

- **The chair only convenes.** Its request offers one tool, `convene`: one to four members,
  each with a role that fits the request (Prover, Skeptic, Formalizer, Illustrator, Editor…),
  an objective in its own voice, and its blocks. `readConvene` trims what comes back and tells
  two members with one role apart ("Prover 2"). A chair that names nobody gets one member who
  takes the whole request.
- **A member is an Auto reply with a brief.** It gets the Auto rules and tools, its
  objective, the others' objectives and its blocks (`buildMemberMessages`), and runs
  `agentLoop` for up to 12 rounds. What it says last is its report to the chair.
- **Members don't overwrite each other.** Each remembers every block's text as it last saw
  it (`AgentEnv.seen`, updated by `read_document` and by its own changes). An edit or deletion
  of a block that has changed since is refused, with a result telling the member to read the
  document again. The check and the change run in one `transactDocument`, so nothing slips in
  between. Adding blocks is always allowed.
- **One Undo for the seminar.** Every member's changes go into one list in the order they
  happened, so `undoRun` takes them back newest first, across members.
- **Stop reaches everyone.** The hook tracks every request in flight for the reply
  (`inFlight`), and Stop cancels them all. Members still waiting don't start, and the
  summary is skipped.
- **Concurrency follows the provider** (`concurrency`). ChatGPT serves members together,
  three at a time, and a fourth starts when one finishes. A local Ollama model would only
  queue them, so they take turns.
- **Later turns know who did what.** The history sends the summary with each member's role,
  objective and steps (`describeSeminar`).

Seminar needs a model that calls tools, as Auto does, and works like Manual without one.

### Is it known?

A sixth way to ask, for the question mathematicians ask most: has this been done?

```
question ──► the model writes one or two keyword searches (buildQueryMessages, readQueries)
   │
   ▼
Rust searches arXiv (Atom, with abstracts) and Crossref (published work) at once ──► papers
   │                                           a preprint Crossref also found is listed once
   ▼
the reply is given the numbered results and asked to cite them by number ──► the reply
```

- **Searching is in Rust** (`references.rs`), like everything that leaves the computer. Only
  the searches go out, never the document. Both services are free and need no account; one
  that doesn't answer is named rather than failing the search.
- **The model is held to the results.** It is told to tell the same result from a stronger,
  weaker or merely related one, to cite by number, never to invent a reference, and to say
  plainly when the search doesn't settle it (`MODE_INSTRUCTIONS.literature`).
- **The reply shows its sources** (`components/ai/Sources.tsx`), numbered as it cites them, each
  opening in the browser and added to the references in one click. Later turns are told what
  [1], [2]… were (`describeSources`).
- **Agents have it as tools.** In Auto and Seminar, `search_literature` and `add_reference` do
  the same, and an added reference is a recorded change (`kind: "bibliography"`) that Undo
  takes back. The chair may convene a Librarian for it.

zbMATH Open isn't searched yet: its API couldn't be reached while this was built, so its
answers' shape couldn't be checked. Adding it means a third function beside `search_arxiv`
and `search_crossref`.

### How the collaborator looks

The collaborator's AI surfaces live in `components/ai/`. Motion there carries information
about what the model is doing; none of it is decoration on its own.

| Piece | Shows |
| --- | --- |
| `Orb` | What the collaborator is doing (`Activity`). Idle: the sphere only turns. Thinking: dots wander across it. Acting (a tool running in Auto): its bands twist like a Rubik's cube. The header's orb follows the reply that is streaming, and is acting while any seminar member's tool runs. Members' orbs are tinted (`MEMBER_TINTS`) |
| `EffortGauge` | How hard the model thinks: a dial with a tick per effort the model offers, in the composer |
| `Shimmer` | Status text while something runs: "Thinking…", "Checking with Lean…" |
| `Reasoning` | What the model thought. It opens while the model thinks, folds a second after the answer starts, and then says how long it thought (`thoughtSeconds`) |
| `AgentTimeline` | An Auto reply: its text, with each tool on a rail between. Lean's errors open under Details. It ends with what changed, Undo, and how long the run took (`finishedAt`) |
| `Sources` | What an "Is it known?" reply searched for and found, numbered as it cites them, with Add to references |
| `SeminarView` | A Seminar reply: a card for each member with its orb, role, objective, what it is doing now, its report, and its steps under Show work. Then the chair's summary, what changed and Undo |
| `ComposerBeam`, `AutoLabel` | A light around the composer and a lit "Auto" or "Seminar" while the collaborator works on its own |
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
  NDJSON. Whether a model can see, call tools or think comes from `/api/show` capabilities. Tool
  arguments go to Ollama as JSON objects and results as `tool` messages naming the tool;
  calls Ollama doesn't number are numbered on arrival. `num_ctx` is raised for large
  requests (transcriptions), since Ollama's default context silently truncates.

Model lists are fetched by `list_models`, which reports each provider's availability and a
message to show when it isn't (Ollama not running, not signed in).

**Effort.** Each model lists the efforts it takes, least first (`ModelInfo.efforts`), and the
composer offers them as a gauge. The choice is kept per model (`efforts` in settings, keyed
`provider:model`) and sent with every request; `resolveEffort` in `lib/effort.ts` falls back to
the model's default when a remembered choice is no longer offered.

| Provider | Where the efforts come from | What is sent |
| --- | --- | --- |
| ChatGPT | The catalog's `supported_reasoning_levels` and `default_reasoning_level` (`none` … `xhigh`, shown as Instant … Max) | `reasoning: { effort, summary: "auto" }`, so the reply also streams summaries of its reasoning. A 400 naming `reasoning.summary` or `reasoning.effort` is retried without it (`Options::without_refused`) |
| Ollama | `thinking` in the model's capabilities: gpt-oss takes `low`, `medium` or `high`; other thinking models take `none` (Instant) or `think` | `think: false`, `think: true`, or the level |

Models that offer no choice show no gauge and get no effort.

## Macros and references

A paper has a preamble of macros and a bibliography; so does a document.

- **Macros** (`doc.macros`, `lib/macros.ts`): whatever is pasted, a whole preamble included.
  `readMacros` reads out the `\newcommand`, `\renewcommand`, `\providecommand`,
  `\DeclareMathOperator` and `\def` definitions and gives each to KaTeX (with `globalGroup`, so
  they fill a macros object every render then copies). LaTeX lacks some commands KaTeX has
  (`\R`, `\N`), so a `\newcommand` KaTeX calls a redefinition is retried as `\renewcommand`;
  `\DeclareMathOperator` becomes `\operatorname`. A definition KaTeX can't take, like an
  optional argument with a default, is named with the reason and still exported.
- **References** (`doc.bibliography`, `lib/bibtex.ts`): BibTeX, kept as written, so the export
  writes it back unchanged. `parseBibtex` reads entries, `@string`s and `#` concatenation.
  An entry is added by arXiv id or DOI (`lookup_reference`: arXiv's API turned into a `@misc`
  with `howpublished` and `eprint`; doi.org's BibTeX by content negotiation), from a .bib file,
  or pasted. A looked-up title is braced so styles keep its capitals.
- **Citations** are LaTeX: `\cite{key}`, `\cite{a,b}`, `\cite[Thm. 2]{key}`. For showing,
  `linkCitations` turns each into a `cite:` link the Markdown component draws as "[3, Thm. 2]",
  with the reference in its tooltip; an unknown key is a red "[?]". The LaTeX export passes
  them through.
- **The numbers are the paper's.** The export uses amsplain, so the app numbers, names and
  titles references as amsplain does (`citationNumbers`, `formatEntry`, `sentenceCase`): only
  cited entries, sorted by author, full first names, titles in sentence case except what's
  braced. The cited references are listed at the end of the document and of a print.
- **The collaborator is told both** (`notationForPrompt`, after the document in every request),
  and asked to use the macros and cite only the listed references.

`lib/notation.ts` reads both once for the open document; App provides them to every Markdown
through `NotationContext`. The citation signature (the sorted cited keys) is what the context
depends on, so typing doesn't re-render every equation.

## Export and print

**LaTeX** (`lib/latexExport.ts`, `lib/exportDocument.ts`). `documentToLatex` turns a document
into an amsart source for pdfLaTeX, walking each block's Markdown as an mdast tree (remark with
GFM and math):

- Statements become amsthm environments that keep their names and numbers:
  `\begin{statement}{Theorem 2.1}`, plain style when the statement's text is italic (the
  italics are then dropped), definition style (`statement*`) when it isn't. Proofs use amsthm's
  `proof`, without a second end-of-proof box.
- Display equations are numbered by LaTeX exactly where `numberEquations` numbers them
  (`displayMath`), so LaTeX's counter gives the same sequence and "(3)" in the prose still
  points at (3).
- Graphs become PNGs drawn afresh from their code for paper (`graphPicture`): a 2D graph with
  `drawPlane` in `PAPER` colours, a 3D graph by `picture3d`, which builds the same scene as the
  graph on screen (`scene3d.ts`) offscreen on white, frames it to fill the picture and draws the
  axes' names and numbers into it. Neither depends on the graph on screen, which may never have
  been drawn. Figures are copied, converted to PNG when pdfLaTeX can't include their format.
- Unicode pdfLaTeX doesn't know (Lean's ℕ, ∑, ∈, Greek, arrows) is declared with
  `\DeclareUnicodeCharacter`; macros KaTeX has but LaTeX doesn't get `\providecommand`s after
  the document's own; packages are added for what the source uses; statuses stay as comments.

With figures or references, the export is a ZIP (`lib/zip.ts`, written in the browser) with the
`.tex`, `figures/` and `references.bib`, ready for Overleaf or arXiv; otherwise a `.tex`. It's
saved through `save_file`, which runs the save dialog in Rust (`tauri-plugin-dialog`) and writes
where the person chose, so the interface never names a path.

**Print and PDF.** Printing makes a copy of the document as it is (`PrintJob`: the blocks, their
equation numbers, the author and the references) and `PrintDocument` renders it into the page:
black on white, the title, author and summary, every block but pending suggestions, graphs as
paper pictures with a key, and the references. `print_page` then opens the system print dialog
through the webview (wry prints on all three platforms), whose Save as PDF makes the PDF.

- **The copy is ready before the dialog opens.** It is first laid out off screen at the
  paper's width (170 mm, A4's text width, the narrower of A4 and Letter), each graph asks for
  its picture and gets it (`graphPicture`, after the fonts load), images are decoded, and then
  `lib/printLayout.ts` fits it to the page. Only then does `print_page` run.
- **The copy stays.** It is left in the page unchanged until the next print or until another
  document opens, never taken down on `afterprint`: dialogs read the page while they're open,
  and macOS's preview reads it again later. Being a snapshot, it doesn't change under the
  dialog when the document reloads from disk or a run edits it.
- **Pages.** Blocks flow from page to page like a paper's paragraphs, with at least three lines
  of a paragraph or of code at the foot or head of a page. Only short things are kept whole: a
  block shorter than a quarter of a page, a heading with a short block after it (a heading is
  always kept with what follows), a figure, an equation. So a long proof or a Lean file runs on
  across pages, and moving something to the next page never leaves much of a page empty.
- **Equations.** Nothing in the copy scrolls or clips. A displayed equation too wide for the
  column is shrunk a little (to 80%), or has its number set on its own line under it, or is
  broken at its top-level relations and operators as inline math is, or as a last resort
  shrunk until it fits (`planEquation`); its number never overlaps it.
- **Code** wraps at the column and continues across pages.
- **Text stays text.** Common ligatures are off in the copy: WebKitGTK writes "fi" and "Th"
  into PDFs without the letters they stand for, which would make a saved PDF unsearchable.

## Working with co-authors

- **A shared folder.** Settings → Workspace keeps the workspace in another folder, usually one
  Dropbox, iCloud Drive or OneDrive shares (`choose_workspace_folder`, kept as `workspaceDir` in
  settings; a `Theoremis` folder inside the one picked). Moving copies the workspace in beside
  what the folder has, without overwriting, merging the project lists, and leaves the
  original (`copy_workspace`); opening a shared folder uses it as it is. Theoremis restarts to
  use it. A chosen folder missing at launch isn't created; the app's own is used and the app
  says so.
- **No lost changes.** See [Saving](#saving): a save never goes over a change made elsewhere;
  both are kept. The open document is checked when the window comes back and every 20 seconds;
  changed elsewhere with no edits here, it reloads, and new projects and documents appear.
  The sync services do the syncing; Theoremis only makes sure it doesn't destroy what they bring.
- **Shared files.** "Share a copy as a file" writes a `.theoremis` file, a ZIP of the document
  (`document.json`), its media and a manifest, leaving out the sender's own: collaborator
  threads, suggestions awaiting a decision, Auto marks and history (`lib/share.ts`). Opening one
  adds it as a new document with its media.

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
| Workspace | `load_workspace`, `save_projects`, `load_document`, `save_document` (nothing when the file changed elsewhere), `delete_document`, `changed_documents`, `workspace_folder`, `choose_workspace_folder`, `reset_workspace_folder` |
| Versions | `list_versions`, `load_version`, `snapshot_document` |
| Media | `save_asset` (raw body), `delete_asset`, `list_assets`, `copy_assets`, and the `theoremis://` scheme for reads |
| Files | `save_file` (raw body; Rust runs the save dialog), `print_page` |
| References | `lookup_reference` (arXiv id or DOI to BibTeX), `search_literature` (arXiv and Crossref) |

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
  changes can be undone. In Auto and Seminar modes it changes only the document it was asked about (other
  documents are read-only to it), every change is recorded and undoable, and it can't give
  the statuses that mean a person or Lean checked something.
- The model never runs code itself. The only thing Auto can run is a Lean check, which goes
  through the same screening as a check the person starts.
- Files are written only where the person chooses: `save_file` runs the save dialog itself
  and takes no path from the interface. The workspace folder is chosen the same way.
- Looking up and searching for references sends only the id or the search words to arXiv,
  Crossref and doi.org, never the document.

What it doesn't protect against: a malicious Mathlib, a compromised model provider, or
someone with access to the unlocked user account. The vault's key is in that user's keychain.

## The site

`site/` is theoremis.com: one static page built with Vite from the landing design, with
hover styles in `hover.css`, and Download buttons (`download.ts`). The hero is the app's window
replaying a review, in `hero.css` (the app's own tokens and sizes) and `main.ts` (the script);
when the app's interface changes, the hero should change with it. Its orb is drawn by
`orb.ts` with the app's vendored Thinking Orbs engine, imported from `app/src/vendor`, the
one place the site uses the app's code. The buttons ask GitHub's API for the latest release
and pick the installer for the visitor's OS and architecture, falling back to the releases
page. Its figures are HTML with live KaTeX, like the app, except the 3D surface in §5, an SVG
drawn by `site/scripts/draw-surface.py`. Vercel builds it from `vercel.json` on every push to
`main`. It shares nothing with the app at runtime.

## Build, release and updates

- **CI** (`.github/workflows/ci.yml`) runs on every push: typecheck, unit tests and a build
  for the interface; `cargo fmt`, `clippy -D warnings` and `cargo test` for the backend, on
  Linux, macOS and Windows; a build for the site.
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
  fake Lean. Seminar's convening, its limit on members at once, and the guard against
  overwriting another member's change are tested the same way, as are the LaTeX export (and
  its equation numbering against Theoremis's), ZIP writing, macros, BibTeX, citations and
  their numbering, the literature tools and their Undo, and what a shared copy leaves out.
  Most of the app's intelligence lives in `lib/` precisely so it can be tested without a
  browser. Exports were also compiled with pdfLaTeX and BibTeX while this was built.
- **Rust** has unit tests for every module, including token handling, the vault (with a fake
  key store), Lean screening and verdicts (with Lean's real output), storage (versions,
  conflicts with a file a co-author's sync replaced, copying a workspace into a shared one),
  arXiv and Crossref answers, and streaming
  clients, including tool calls and the encrypted-reasoning fallback, against a local HTTP
  server that replays recorded responses (`providers/test_server.rs`).
- **The interface** is exercised by driving the built frontend in a browser with Tauri's IPC
  mocked (`@tauri-apps/api/mocks`), which covers imports, graphs and the collaborator,
  including a scripted Auto run with Lean, graphs, Undo and Stop, and a scripted seminar
  (members at once, one held back from overwriting another, Undo, Stop, turns on Ollama),
  exports and print, macros and references, version history, "Is it known?", and
  co-authors (a shared file, a conflict kept both ways, a change picked up from elsewhere),
  without a model or a desktop window.
- **Print** is checked end to end by `e2e/print-check.mjs` (`npm run test:print`, in CI):
  a long document heavy with theorems, piecewise and wide numbered equations, a 2D and a 3D
  graph and a 170-line Lean file with prose after it (`lib/fixtures/quartic.ts`) is printed to
  PDF on A4 and Letter in Chromium and WebKitGTK, and every page is read back: every block once
  and in order, every Lean line, the Lean file across pages, the prose after it, both graphs,
  no equation outside the column or under its number, nothing clipped, no page left mostly
  empty. The PDFs are kept as a CI artifact. macOS's WKWebView isn't in CI; WebKitGTK shares
  its layout engine.

## Where to make a change

| To… | Look at |
| --- | --- |
| Change what the collaborator is told | `lib/prompts.ts` |
| Give the collaborator a new tool in Auto mode | `AGENT_TOOLS` and `runTool` in `lib/agent.ts` (a document-to-document function, with a test), and its working label in `components/ai/AgentTimeline.tsx` |
| Name or describe a new effort | `LABELS` and `NOTES` in `lib/effort.ts`, and its place in `sort_efforts` (`providers/mod.rs`) |
| Change the collaborator's effects or their colours | The wrappers in `components/ai/effects.tsx`. Leave `src/vendor/` as upstream wrote it, and list any change in `src/vendor/README.md` |
| Change how a seminar is convened, or how many members and rounds it may take | `CHAIR` and `membership` in `lib/prompts.ts`; `CONVENE`, `MAX_MEMBERS`, `MEMBER_ROUNDS` and `concurrency` in `lib/seminar.ts` |
| Change the LaTeX export | `documentToLatex` in `lib/latexExport.ts` (pure, with tests); the files around it in `lib/exportDocument.ts` |
| Change how documents print | `PrintDocument.tsx` (what prints and when it's ready), `lib/printLayout.ts` (pages and equations, with tests), the print rules in `styles.css`; run `npm run test:print` |
| Change how a graph looks on paper | `graphPicture.ts` and `PAPER` in `Graph2D.tsx`; `picture3d.ts` and `scene3d.ts` for 3D |
| Change how references are shown or numbered | `formatEntry`, `sentenceCase` and `citationNumbers` in `lib/bibtex.ts`, together with the export's `\bibliographystyle` |
| Search another source for "Is it known?" | A function beside `search_arxiv` and `search_crossref` in `references.rs`, joined in `search` |
| Change how often versions are kept, or how many | `VERSION_EVERY_MS` and `MAX_VERSIONS` in `storage.rs` |
| Add a collaborator mode | `Mode` in `lib/types.ts`, `MODE_INSTRUCTIONS` in `lib/prompts.ts`, the composer in `Collaborator.tsx` |
| Add a model provider | `providers/` (stream `StreamEvent`s from `ChatMessage`s), `Provider` in both `providers/mod.rs` and `lib/types.ts`, `list_models` and `run_chat` in `lib.rs` |
| Add a block field | `Block` in `lib/types.ts`. Rust needs no change |
| Support a new import format | `fileKind` and `readImports` in `lib/sources.ts`, a converter in `lib/convert.ts` |
| Change how transcripts are written | `lib/transcribePrompt.ts` and `lib/transcript.ts`, together |
| Add a graph feature | `lib/graph/spec.ts` (what a line means), `expr.ts` (syntax), `plot2d.ts`/`plot3d.ts` (geometry) |
| Allow a new media type | `ASSET_TYPES` in `storage.rs` and `EXTENSIONS` in `lib/media.ts` |
| Loosen or tighten Lean screening | `refusal` in `lean/check.rs`, with a test |
