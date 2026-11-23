// The collaborator's orb in the hero, drawn by the app's own vendored Thinking Orbs engine
// (app/src/vendor/thinking-orbs, MIT) so it moves exactly as it does in Theoremis. The app wraps
// the engine in a React component; the site only needs its canvas painter.
import { paintFrame } from "../../app/src/vendor/thinking-orbs/engine/core";
import { MODE_FRAMES } from "../../app/src/vendor/thinking-orbs/engine/registry";
import { resolvePreset } from "../../app/src/vendor/thinking-orbs/presets";

export type Activity = "idle" | "thinking";

/** The app's ACCENT_LIGHT, #d4dcff. */
const TINT = { r: 0xd4, g: 0xdc, b: 0xff };

/** As in the app's components/ai/effects.tsx: idle turns slowly, thinking sends dots across it. */
const LOOKS = {
  idle: { state: "solving", speed: 0.6, opts: { moveCount: 0 } },
  thinking: { state: "working", speed: 1, opts: {} },
} as const;

export interface Orb {
  set(activity: Activity): void;
}

export function mountOrb(canvas: HTMLCanvasElement, still: boolean): Orb {
  const size = Number(canvas.dataset.size) === 32 ? 32 : 20;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(size * dpr);
  canvas.style.width = canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  let activity: Activity = canvas.dataset.activity === "thinking" ? "thinking" : "idle";
  let raf = 0;
  let visible = false;

  const draw = (seconds: number) => {
    if (!ctx) return;
    const look = LOOKS[activity];
    const preset = resolvePreset(look.state, size);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    paintFrame(ctx, MODE_FRAMES[preset.mode](size, seconds * preset.speed * look.speed, { ...preset.opts, ...look.opts }), true, TINT);
  };
  const loop = () => {
    draw(performance.now() / 1000);
    raf = requestAnimationFrame(loop);
  };
  const sync = () => {
    cancelAnimationFrame(raf);
    if (still) draw(0.6);
    else if (visible && document.visibilityState !== "hidden") loop();
  };

  draw(still ? 0.6 : performance.now() / 1000);
  // Only animate while it can be seen: the hero hides most orbs until their moment comes.
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", sync);

  return {
    set(next) {
      if (next === activity) return;
      activity = next;
      sync();
    },
  };
}
