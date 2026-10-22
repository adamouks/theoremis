# Theoremis

A desktop AI workspace built with [Tauri](https://tauri.app). Chat with local models through
[Ollama](https://ollama.com) or with OpenAI's ChatGPT models, side by side in one app, with
first-class math rendering.

![Theoremis showing a proof with rendered LaTeX, a table and a code block](docs/screenshot.png)

- **Ollama**: auto-detects a running Ollama server and lists the models you've pulled.
- **ChatGPT (OpenAI)**: streams replies from any chat model your API key can use.
- **Math and code**: Markdown, LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) via KaTeX, tables, and highlighted code blocks.
- **Streaming**: token-by-token replies, a Stop button, and Retry with any model.
- **Reasoning**: shows the "thinking" stream from models that expose it (e.g. Qwen 3 and DeepSeek-R1 on Ollama).
- **Local-first**: conversations and settings stay on your machine. Your API key is never handed to the web view.

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
2. Pull a model, for example `ollama pull llama3.2` or `ollama pull qwen3:8b`.
3. Open Theoremis. Your models appear in the model picker.

Theoremis talks to `http://127.0.0.1:11434` by default. It also honours `OLLAMA_HOST`, and you
can point it at another server in **Settings → Ollama → Server URL**.

### ChatGPT (OpenAI)

1. Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Paste it in **Settings → ChatGPT (OpenAI) → API key**.

API usage is billed to your OpenAI Platform account, separately from a ChatGPT Plus or Pro
subscription. If `OPENAI_API_KEY` is set in the environment Theoremis was launched from, it's used
when no key is saved in the app. **API base URL** accepts any OpenAI-compatible endpoint
(OpenRouter, LM Studio, vLLM, …).

## Where your data lives

| What | Where |
| --- | --- |
| Settings, including the API key | `settings.json` in the app config directory, readable only by your user on macOS and Linux |
| Conversations | one JSON file each in `conversations/` in the app data directory |

The directories follow each OS's conventions for the app id `app.theoremis.desktop`
(e.g. `~/Library/Application Support/app.theoremis.desktop` on macOS,
`~/.config/app.theoremis.desktop` and `~/.local/share/app.theoremis.desktop` on Linux,
`%APPDATA%\app.theoremis.desktop` on Windows).

## How it's built

```
src/                    React + TypeScript UI (Vite)
  components/           Sidebar, chat view, composer, model picker, settings
  lib/api.ts            Typed wrappers around the Rust commands
  lib/useChat.ts        Conversation state and streaming
src-tauri/src/
  lib.rs                Tauri commands and app state
  providers/ollama.rs   Ollama: /api/tags, streaming /api/chat (NDJSON)
  providers/openai.rs   OpenAI: /models, streaming /chat/completions (SSE)
  settings.rs           Settings persistence and API key handling
  storage.rs            Conversation files
```

All network calls happen in Rust. That avoids CORS entirely (Ollama rejects browser origins by
default) and keeps the API key out of the web view. Replies stream to the UI over a Tauri
[channel](https://v2.tauri.app/develop/calling-frontend/#channels). Cancelling a reply drops the
HTTP request, which also stops generation on the server.

### Checks

```sh
npm run typecheck && npm test                 # frontend
cd src-tauri && cargo clippy --all-targets && cargo test   # backend
```

CI runs both on every push.

## Roadmap

- More providers: OpenRouter, Poe
- Landing page
- Attachments and images
- Signed, auto-updating releases
