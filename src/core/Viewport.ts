import { BASE_HEIGHT, BASE_WIDTH } from "../config/constants";

export interface Viewport {
  scale: number;
  offsetX: number; // CSS px offset of the logical game area's left edge within the window
  offsetY: number; // CSS px offset of the logical game area's top edge within the window
  width: number; // CSS px width of the letterboxed game area
  height: number; // CSS px height of the letterboxed game area
}

// Pure function of window size — Renderer and InputManager each call this
// independently and always agree on the same scale-to-fit box, no shared state needed.
export function computeViewport(windowWidth: number, windowHeight: number): Viewport {
  const scale = Math.min(windowWidth / BASE_WIDTH, windowHeight / BASE_HEIGHT);
  const width = BASE_WIDTH * scale;
  const height = BASE_HEIGHT * scale;
  return {
    scale,
    width,
    height,
    offsetX: (windowWidth - width) / 2,
    offsetY: (windowHeight - height) / 2
  };
}
