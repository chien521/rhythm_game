import { KEY_LANE_MAP } from "../config/constants";

export type LaneHandler = (lane: number) => void;

// Global keyboard-driven lane input: 8 lanes split across two hand positions
// (Q/W/E/R, J/K/L/;). Tracks real-time held state per lane so ChartManager's
// continuous slide-note check can query "is this lane currently pressed".
export class InputManager {
  private heldLanes = new Set<number>();
  private downHandlers: LaneHandler[] = [];
  private upHandlers: LaneHandler[] = [];

  constructor() {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  onLaneDown(handler: LaneHandler): void {
    this.downHandlers.push(handler);
  }

  onLaneUp(handler: LaneHandler): void {
    this.upHandlers.push(handler);
  }

  getHeldLanes(): ReadonlySet<number> {
    return this.heldLanes;
  }

  isLaneHeld(lane: number): boolean {
    return this.heldLanes.has(lane);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const lane = KEY_LANE_MAP[e.code];
    if (lane === undefined) return;
    e.preventDefault(); // stop the browser from scrolling/triggering hotkeys on game keys

    if (this.heldLanes.has(lane)) return; // ignore OS key-repeat; fire only on the fresh press
    this.heldLanes.add(lane);
    for (const handler of this.downHandlers) handler(lane);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const lane = KEY_LANE_MAP[e.code];
    if (lane === undefined) return;
    e.preventDefault();

    this.heldLanes.delete(lane);
    for (const handler of this.upHandlers) handler(lane);
  };
}
