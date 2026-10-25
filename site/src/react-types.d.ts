// The vendored orb engine's types file names two of React's prop types for its React component.
// The site draws the orb without React, so these stand in for them.
declare module "react" {
  export type CSSProperties = Record<string, string | number>;
  export interface CanvasHTMLAttributes<T> {
    ref?: T;
  }
}
