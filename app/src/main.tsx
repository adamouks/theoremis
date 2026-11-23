import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import App from "./App";

// The interface needs the desktop app's backend; opened in a plain browser, say so instead of
// failing on the first call to it.
const inDesktopApp = "__TAURI_INTERNALS__" in window;

function DesktopOnly() {
  return (
    <main className="desktop-only">
      <h1>Theoremis is a desktop app</h1>
      <p>Your documents and your ChatGPT sign-in stay on your computer, so the workspace runs as an app rather than in the browser.</p>
      <a className="button button--cream" href="https://theoremis.com">
        Download Theoremis
      </a>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{inDesktopApp ? <App /> : <DesktopOnly />}</React.StrictMode>,
);
