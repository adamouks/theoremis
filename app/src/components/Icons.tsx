import type { SVGProps } from "react";
import type { Status } from "../lib/types";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

// Line icons drawn on the design's 12/14px grids with 1.3px strokes.
function Icon({ size = 14, viewBox = "0 0 14 14", strokeWidth = 1.3, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDown = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M3 4.5 6 7.5l3-3" />
  </Icon>
);

export const ChevronRight = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M4.5 3 7.5 6l-3 3" />
  </Icon>
);

export const UpDown = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M3.5 4.75 6 2.25l2.5 2.5M3.5 7.25 6 9.75l2.5-2.5" />
  </Icon>
);

export const Search = (p: IconProps) => (
  <Icon size={13} {...p}>
    <circle cx="6" cy="6" r="4.25" />
    <path d="M9.25 9.25 12.5 12.5" />
  </Icon>
);

export const Plus = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M6 2.5v7M2.5 6h7" />
  </Icon>
);

export const PlusLarge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3v8M3 7h8" />
  </Icon>
);

export const Focus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" />
  </Icon>
);

export const ExitFocus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 2v3H2M12 5H9V2M9 12V9h3M2 9h3v3" />
  </Icon>
);

export const More = (p: IconProps) => (
  <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="7" r="1.1" />
    <circle cx="7" cy="7" r="1.1" />
    <circle cx="11" cy="7" r="1.1" />
  </svg>
);

export const History = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="5" />
    <path d="M7 4.5V7l1.75 1.25" />
  </Icon>
);

export const PanelRight = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.5" width="10.5" height="9" rx="1.5" />
    <path d="M8.5 2.5v9" />
  </Icon>
);

export const Close = (p: IconProps) => (
  <Icon size={10} viewBox="0 0 10 10" strokeWidth={1.4} {...p}>
    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
  </Icon>
);

export const ArrowUp = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" strokeWidth={1.6} {...p}>
    <path d="M6 10V2.5M2.75 5.5 6 2.25 9.25 5.5" />
  </Icon>
);

export const StopSquare = (p: IconProps) => (
  <svg width={p.size ?? 10} height={p.size ?? 10} viewBox="0 0 10 10" aria-hidden="true">
    <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" />
  </svg>
);

export const Compare = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" strokeWidth={1.2} {...p}>
    <rect x="1.5" y="2" width="9" height="8" rx="1.25" />
    <path d="M1.5 6h9" />
  </Icon>
);

export const Gear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="1.9" />
    <path d="M7 1.75v1.5M7 10.75v1.5M1.75 7h1.5M10.75 7h1.5M3.3 3.3l1.05 1.05M9.65 9.65l1.05 1.05M3.3 10.7l1.05-1.05M9.65 4.35l1.05-1.05" />
  </Icon>
);

export const Trash = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M2.5 3.5h7M5 5.5v3M7 5.5v3M3.25 3.5l.5 6a1 1 0 0 0 1 .9h2.5a1 1 0 0 0 1-.9l.5-6M4.75 3.5V2h2.5v1.5" />
  </Icon>
);

export const Copy = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <rect x="4" y="4" width="6.25" height="6.25" rx="1.25" />
    <path d="M8 4V2.75A1 1 0 0 0 7 1.75H2.75a1 1 0 0 0-1 1V7a1 1 0 0 0 1 1H4" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" strokeWidth={1.5} {...p}>
    <path d="M2.5 6.25 5 8.75l4.5-5" />
  </Icon>
);

export const Retry = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M10 6a4 4 0 1 1-1.2-2.85M10 2v2.5H7.5" />
  </Icon>
);

/** The collaborator's mark: a small open square in the accent colour. */
export const ArrowUpRight = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p}>
    <path d="M4 8 8.5 3.5M4.5 3.5h4v4" />
  </Icon>
);

export function CollaboratorGlyph({ size = 9 }: { size?: number }) {
  return <span className="collab-glyph" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** The status marks from the design: ○ open, ⊙ tested, ◐ draft, □ adopted, ● proved, ■ verified. */
export function StatusGlyph({ status, size = 7, suggested = false }: { status?: Status; size?: number; suggested?: boolean }) {
  const kind = suggested ? "suggested" : (status ?? "open");
  return <span className={`status-glyph status-glyph--${kind}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

/** The OpenAI mark, for ChatGPT models. */
export function OpenAILogo({ size = 13 }: { size?: number }) {
  return <img src="/logos/openai.svg" alt="" width={size} height={size} className="provider-logo" />;
}

/** A plain mark for local Ollama models. */
export function OllamaMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="provider-logo">
      <rect x="2" y="2" width="10" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
    </svg>
  );
}
