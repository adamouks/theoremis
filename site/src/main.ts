// The landing page's behaviour, ported from the design's component: math typesetting,
// the animated review in the hero, in-page navigation and the updates form.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "katex/dist/katex.min.css";
import katex from "katex";
import "./site.css";
import "./hover.css";
import "./hero.css";
import { RELEASES, setUpDownloads } from "./download";
import { mountOrb } from "./orb";
/** Set VITE_UPDATES_ENDPOINT to a form backend (Buttondown, Formspree, …) to collect emails. */
const UPDATES_ENDPOINT = (import.meta.env.VITE_UPDATES_ENDPOINT as string | undefined) ?? "";

// --- Math -------------------------------------------------------------------

for (const el of document.querySelectorAll<HTMLElement>("[data-tex]")) {
  const tex = el.dataset.tex ?? "";
  katex.render(tex, el, {
    throwOnError: false,
    strict: "ignore",
    output: "html",
    // The proposed-revision highlight is drawn with \htmlStyle; nothing else needs trust.
    trust: (context) => context.command === "\\htmlStyle",
  });
  el.style.whiteSpace = "nowrap";
  if (!tex.startsWith("\\displaystyle")) el.style.fontSize = "0.95em";
}

// --- Conditional fragments ----------------------------------------------------

let phase = 4;
let cursorOn = false;
let dipping = false;
let sent = false;

// The review, phase by phase: 0 nothing asked yet, 1 a step selected, 2 Find gaps asked and the
// collaborator thinking, 3 its reply, 4 its proposed revision, 5 accepted, 6 back to writing.
function values(): Record<string, boolean> {
  const p = phase;
  return {
    empty: p < 2,
    selOn: p >= 1,
    tbOn: p === 1,
    asked: p >= 2,
    thinking: p === 2,
    idleSend: p !== 2,
    replied: p >= 3,
    proposal: p === 4,
    pinOn: p === 4,
    findingNote: p === 4,
    threadNote: p === 2 || p === 3 || p >= 5,
    done: p >= 4,
    before: p < 5,
    after: p >= 5,
    clicking: p === 2 || p === 5,
    cursorOn,
    dipping,
    notSent: !sent,
    sent,
  };
}

const fragments = [...document.querySelectorAll<HTMLElement>(".dc-if")];

const thread = document.querySelector<HTMLElement>(".hx-thread");
const threadInner = document.getElementById("hx-thread-inner");
let threadShift = 0;

function render() {
  const v = values();
  for (const el of fragments) {
    const show = !!v[el.dataset.if ?? ""];
    if (el.hidden === show) el.hidden = !show;
  }
  headOrb?.set(phase === 2 ? "thinking" : "idle");
  // The thread follows its latest message, as the app's does.
  if (thread && threadInner) {
    threadShift = Math.max(0, threadInner.offsetHeight - thread.clientHeight);
    threadInner.style.transform = threadShift ? `translateY(${-threadShift}px)` : "";
  }
}

// --- Hero: scaling, parallax and the scripted review -------------------------

const wrap = document.getElementById("hero-wrap");
const frame = document.getElementById("hero-frame");
const parallax = document.getElementById("hero-par");
const glow = document.getElementById("hero-glow");
const cursor = document.getElementById("hero-cursor");
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const reasoning = document.getElementById("hx-reasoning");

let headOrb: ReturnType<typeof mountOrb> | undefined;
for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-orb]")) {
  const orb = mountOrb(canvas, reducedMotion);
  if (canvas.id === "hx-orb-head") headOrb = orb;
}

const THOUGHT =
  "Checking (2). Splitting off the last term leaves the first n odd numbers, which (1) says sum to n². Adding 2n+1 gives (n+1)², so the step holds, but (1) is used without being cited.";

let scale = 1;
let offsetX = 0;
let mouseX = 0;
let mouseY = 0;

function applyFrame() {
  if (frame) frame.style.transform = `translate3d(${offsetX.toFixed(2)}px,0,0) scale(${scale})`;
  if (parallax) {
    const k = scale || 1;
    parallax.style.transform = `translate3d(${((mouseX * -10) / k).toFixed(2)}px,${((mouseY * -8) / k).toFixed(2)}px,0)`;
  }
  if (glow) glow.style.transform = `translate(calc(-50% + ${(mouseX * 28).toFixed(1)}px),${(mouseY * 20).toFixed(1)}px)`;
}

/** The hero shows a 1200×720 window, scaled down to fit narrower screens. */
function layoutHero() {
  if (!wrap) return;
  const width = wrap.clientWidth;
  scale = Math.min(1, width / 1200);
  offsetX = Math.max(0, (width - 1200 * scale) / 2);
  wrap.style.height = `${Math.round(720 * scale)}px`;
  applyFrame();
}

if (wrap) {
  wrap.addEventListener("mousemove", (e) => {
    if (reducedMotion) return;
    const r = wrap.getBoundingClientRect();
    mouseX = (e.clientX - r.left) / r.width - 0.5;
    mouseY = (e.clientY - r.top) / r.height - 0.5;
    applyFrame();
  });
  wrap.addEventListener("mouseleave", () => {
    mouseX = 0;
    mouseY = 0;
    applyFrame();
  });
  new ResizeObserver(layoutHero).observe(wrap);
}
layoutHero();

// Where the pointer goes in each phase, and how long each phase lasts.
const TARGETS = ["hx-eq2", "hx-gaps", "hx-gaps", "hx-f1", "hx-accept", "hx-accept", "hx-caret"];
const NUDGE = [
  [-6, 4],
  [0, 3],
  [0, 3],
  [12, 1],
  [0, 3],
  [0, 3],
  [6, 6],
];
const DURATIONS = [1500, 1500, 2800, 1900, 2400, 2300, 2000];

let running = false;
let visible = false;
let timers: number[] = [];
let cursorTimer = 0;

function later(fn: () => void, ms: number) {
  timers.push(window.setTimeout(fn, ms));
}

function placeCursor(show = false) {
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => {
    const win = document.getElementById("hx-win");
    const target = document.getElementById(TARGETS[phase] ?? "");
    if (!win || !target || !cursor) return;
    let x = 0;
    let y = 0;
    let node: HTMLElement | null = target;
    while (node && node !== win) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    if (node !== win) return;
    if (threadInner?.contains(target)) y -= threadShift;
    y += target.offsetHeight / 2;
    if (phase !== 0 && phase !== 6) x += target.offsetWidth / 2;
    x += NUDGE[phase][0];
    y += NUDGE[phase][1];
    if (show) {
      cursorOn = true;
      render();
    }
    if (show || cursorOn) cursor.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }, 70);
}

function advance() {
  if (!running) return;
  if (phase >= 6) {
    dipping = true;
    render();
    later(() => {
      phase = 0;
      render();
      placeCursor();
    }, 330);
    later(() => {
      dipping = false;
      render();
    }, 760);
    later(advance, 760 + DURATIONS[0]);
    return;
  }
  phase += 1;
  render();
  placeCursor();
  if (phase === 2) streamThought();
  later(advance, DURATIONS[phase]);
}

/** The collaborator's reasoning, arriving a few words at a time while it thinks. */
function streamThought() {
  if (!reasoning) return;
  reasoning.textContent = "";
  (THOUGHT.match(/\S+\s*/g) ?? []).forEach((word, i) => later(() => reasoning.append(word), 140 + i * 62));
}

function syncLoop() {
  const want = visible && !reducedMotion;
  if (want && !running) {
    running = true;
    placeCursor(true);
    later(advance, 2200);
  } else if (!want && running) {
    running = false;
    timers.forEach(window.clearTimeout);
    timers = [];
  }
}

if (wrap && "IntersectionObserver" in window) {
  new IntersectionObserver(
    (entries) => {
      visible = entries.some((e) => e.isIntersecting);
      syncLoop();
    },
    { threshold: 0.2 },
  ).observe(wrap);
}

// --- Navigation ---------------------------------------------------------------

function go(id: string) {
  const el = id === "top" ? null : document.getElementById(id);
  const top = el ? el.getBoundingClientRect().top + window.scrollY - 60 : 0;
  window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
}

for (const el of document.querySelectorAll<HTMLElement>("[data-go]")) {
  el.addEventListener("click", () => go(el.dataset.go ?? "top"));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(el.dataset.go ?? "top");
    }
  });
}

// --- Updates form ---------------------------------------------------------------

const form = document.getElementById("updates-form") as HTMLFormElement | null;
if (form) {
  if (!UPDATES_ENDPOINT) {
    // No mailing list is connected yet: point people at the releases feed instead of
    // pretending to take their address.
    const link = document.createElement("a");
    link.className = "updates-fallback";
    link.href = RELEASES;
    link.target = "_blank";
    link.rel = "noopener";
    link.innerHTML = 'Follow releases on GitHub<span style="font-size:12.5px;color:oklch(0.62 0.008 276)">↗</span>';
    form.replaceWith(link);
  } else {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
      if (!/\S+@\S+\.\S+/.test(email)) return;
      form.querySelector(".updates-error")?.remove();
      try {
        const response = await fetch(UPDATES_ENDPOINT, {
          method: "POST",
          body: new FormData(form),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(String(response.status));
        sent = true;
        render();
      } catch {
        const error = document.createElement("p");
        error.className = "updates-error";
        error.textContent = "That didn’t go through. Please try again in a moment.";
        form.after(error);
      }
    });
  }
}

render();

// --- Downloads -------------------------------------------------------------------

void setUpDownloads();
