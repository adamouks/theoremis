// The collaborator's visual effects, in Theoremis's palette: the thinking orb, shimmering
// status text, the beam around the composer while Auto works, sparks, spotlight cards and soft
// edges on the thread. Each wraps a vendored component (see src/vendor/README.md) so colours
// and sizes are set once, here. All of them respect prefers-reduced-motion.

import { forwardRef, type ReactNode } from "react";
import { ThinkingOrb, type OrbState } from "../../vendor/thinking-orbs";
import ClickSpark, { type ClickSparkHandle } from "../../vendor/react-bits/ClickSpark";
import GradientText from "../../vendor/react-bits/GradientText";
import GradualBlur from "../../vendor/react-bits/GradualBlur";
import ShinyText from "../../vendor/react-bits/ShinyText";
import SpotlightCard from "../../vendor/react-bits/SpotlightCard";
import StarBorder from "../../vendor/react-bits/StarBorder";

/** The accent colours, as hex for the canvas effects (oklch(0.7 0.1 276) and its lighter steps). */
const ACCENT = "#8d99dd";
const ACCENT_LIGHT = "#d4dcff";
const MUTED = "#9d9ea3";
const VIOLET = "#b093e5";
const CYAN = "#71c5df";

/** Each seminar member's colour, in the order the chair convened them; the chair keeps the accent. */
export const MEMBER_TINTS = ["#c9b3f5", "#9fdcf0", "#b7e4c0", "#f0d39a"];

/** What the collaborator is doing, which decides how its orb moves. */
export type Activity = "idle" | "thinking" | "acting";

/**
 * Idle: the sphere turns slowly and nothing moves on it. Thinking: dots wander across it.
 * Acting (a tool running in Auto mode): its bands twist like a Rubik's cube.
 */
const ORB_STATES: Record<Activity, OrbState> = {
  idle: "solving",
  thinking: "working",
  acting: "solving",
};

/** The Rubik's sphere with no moves to make only rotates. */
const STILL = { moveCount: 0 };

/** The collaborator's presence: a small animated orb in the accent colour, or a seminar member's tint. */
export function Orb({ activity = "idle", size = 20, tint }: { activity?: Activity; size?: 20 | 32 | 64; tint?: string }) {
  return (
    <ThinkingOrb
      state={ORB_STATES[activity]}
      opts={activity === "idle" ? STILL : undefined}
      speed={activity === "idle" ? 0.6 : 1}
      size={size}
      theme="dark"
      color={tint ?? ACCENT_LIGHT}
      aria-hidden="true"
      className={`orb orb--${activity}`}
    />
  );
}

/** Status text with a light passing through it: "Thinking…", "Checking with Lean…". */
export function Shimmer({ children }: { children: ReactNode }) {
  return (
    <ShinyText color={MUTED} shineColor={ACCENT_LIGHT} speed={1.6} delay={0.2} shineWidth={34} className="shimmer">
      {children}
    </ShinyText>
  );
}

/** "Auto" or "Seminar", lit while the collaborator works on its own. */
export function AutoLabel({ children = "Auto" }: { children?: ReactNode }) {
  return (
    <GradientText colors={[ACCENT_LIGHT, VIOLET, CYAN, ACCENT_LIGHT]} animationSpeed={6} variant="flow" className="auto-label">
      {children}
    </GradientText>
  );
}

/** A light running around the composer while the collaborator works on its own. */
export function ComposerBeam() {
  return (
    <StarBorder
      as="span"
      aria-hidden="true"
      className="composer-beam"
      color={ACCENT_LIGHT}
      trailColor={VIOLET}
      duration={3.2}
      thickness={1}
      radius={10}
      trailLength={0.35}
      stars={2}
      glow={0.6}
      hover="none"
      theme="dark"
      backgroundColor="transparent"
      borderColor="transparent"
    />
  );
}

/** Sparks from a click inside, or on demand through the handle (when Lean verifies a statement). */
export const Sparks = forwardRef<ClickSparkHandle, { children?: ReactNode; className?: string; disabled?: boolean }>(function Sparks({ children, className, disabled }, ref) {
  return (
    <ClickSpark
      ref={ref}
      sparkColor={[ACCENT_LIGHT, VIOLET, CYAN]}
      sparkSize={9}
      sparkRadius={22}
      sparkCount={9}
      duration={480}
      shape="star"
      disabled={disabled}
      className={className}
      style={{ height: "auto" }}
    >
      {children}
    </ClickSpark>
  );
});

export type { ClickSparkHandle };

/** A card lit where the pointer is, for proposals the person decides on. */
export function Spotlight({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SpotlightCard
      className={`spotlight${className ? ` ${className}` : ""}`}
      theme="dark"
      spotlightColor={ACCENT}
      intensity={0.22}
      spotlightSize={260}
      borderGlow={0.55}
      grain={0}
      style={{ ["--spotlight-card-surface" as string]: "transparent", ["--spotlight-card-shadow" as string]: "none" }}
    >
      {children}
    </SpotlightCard>
  );
}

/** Soft blurred edges where the thread scrolls under the header and the composer, shown only
 *  when there is more to scroll to. Place them beside the thread's scroller. */
export function ThreadEdges() {
  return (
    <>
      <GradualBlur position="top" height="28px" strength={1.2} layers={5} curve="bezier" tint="var(--panel)" autoHide zIndex={2} className="thread-edge" />
      <GradualBlur position="bottom" height="36px" strength={1.2} layers={5} curve="bezier" tint="var(--panel)" autoHide zIndex={2} className="thread-edge" />
    </>
  );
}
