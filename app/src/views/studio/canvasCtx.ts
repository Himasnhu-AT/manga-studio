import { createContext, useContext, useState } from "react";
import { useMotionValueEvent, type MotionValue } from "motion/react";

// The canvas transform lives in motion values (no React re-render per wheel/drag frame).
// Floating UI that must follow content on screen subscribes with useCanvasTick.

export interface CanvasTransform {
  x: MotionValue<number>;
  y: MotionValue<number>;
  z: MotionValue<number>;
}

export const CanvasCtx = createContext<CanvasTransform | null>(null);

/** Re-render the caller whenever the canvas pans or zooms. */
export function useCanvasTick() {
  const t = useContext(CanvasCtx);
  const [, setN] = useState(0);
  const bump = () => setN((n) => n + 1);
  useMotionValueEvent(t!.x, "change", bump);
  useMotionValueEvent(t!.y, "change", bump);
  useMotionValueEvent(t!.z, "change", bump);
  return t!;
}
