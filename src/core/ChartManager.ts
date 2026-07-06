import { ChartData, ChartNote, JUDGMENT_WINDOWS_MS, MISSED_WINDOW_MS, PRE_RENDER_WINDOW_MS, SLIDE_WINDOW_MS } from "../config/constants";
import { Judgment } from "./ScoreManager";

export type NoteStatus = "pending" | "hit" | "missed";

export interface RuntimeNote extends ChartNote {
  status: NoteStatus;
}

export interface JudgmentEvent {
  noteId: string;
  judgment: Judgment;
  lane: number;
  time: number; // songTimeMs at which the judgment was decided
}

type JudgmentListener = (event: JudgmentEvent) => void;

function judgmentWindowMs(type: ChartNote["type"]): number {
  return type === "slide" ? SLIDE_WINDOW_MS : MISSED_WINDOW_MS;
}

// Owns note lifecycle — spawn window, hit detection against lane/key input,
// and miss detection — driven purely by the songTimeMs (and, for slides, the
// currently-held lanes) it's handed each frame/event. Never reads a wall clock.
export class ChartManager {
  private notes: RuntimeNote[] = [];
  private activeNotes: RuntimeNote[] = [];
  private meta: ChartData["meta"] | null = null;
  private judgmentListeners: JudgmentListener[] = [];

  loadChart(chart: ChartData): void {
    this.meta = chart.meta;
    this.notes = chart.notes
      .map((note) => ({ ...note, status: "pending" as NoteStatus }))
      .sort((a, b) => a.time - b.time);
    this.activeNotes = [];
  }

  getMeta(): ChartData["meta"] | null {
    return this.meta;
  }

  onJudgment(listener: JudgmentListener): void {
    this.judgmentListeners.push(listener);
  }

  private emitJudgment(note: RuntimeNote, judgment: Judgment, time: number): void {
    const event: JudgmentEvent = { noteId: note.id, judgment, lane: note.x, time };
    for (const listener of this.judgmentListeners) listener(event);
  }

  // heldLanes: lanes whose mapped key is currently down — drives the slide
  // auto-hit check (no discrete keydown required, just "were you holding it").
  update(songTimeMs: number, heldLanes: ReadonlySet<number>): void {
    const active: RuntimeNote[] = [];

    for (const note of this.notes) {
      const spawnTime = note.time - PRE_RENDER_WINDOW_MS;
      const windowMs = judgmentWindowMs(note.type);
      const missCutoff = note.time + windowMs;

      if (note.status === "pending") {
        if (note.type === "slide" && Math.abs(songTimeMs - note.time) <= SLIDE_WINDOW_MS && heldLanes.has(note.x)) {
          note.status = "hit";
          this.emitJudgment(note, "perfect", songTimeMs);
        } else if (songTimeMs > missCutoff) {
          note.status = "missed";
          this.emitJudgment(note, "miss", songTimeMs);
        }
      }

      if (songTimeMs >= spawnTime && songTimeMs <= missCutoff) {
        active.push(note);
      }
    }

    this.activeNotes = active;
  }

  getActiveNotes(): readonly RuntimeNote[] {
    return this.activeNotes;
  }

  // True once the song has run its length and every note has been resolved
  // (hit or missed) — the signal main.ts uses to transition GAMEPLAY -> RESULTS.
  isComplete(songTimeMs: number): boolean {
    if (!this.meta) return false;
    if (songTimeMs < this.meta.songLengthMs) return false;
    return this.notes.every((note) => note.status === "hit" || note.status === "missed");
  }

  // Resolves a fresh keydown against the earliest unprocessed note in that lane.
  // Tap notes always resolve immediately (perfect/good/miss by delta). Slide
  // notes only resolve here if the press lands inside their window — this is
  // what makes a "fresh press" register even if it's shorter than one
  // animation frame; a press held from before the window opens is instead
  // caught by the continuous heldLanes check in update().
  registerKeyDown(lane: number, songTimeMs: number): void {
    let candidate: RuntimeNote | null = null;

    for (const note of this.activeNotes) {
      if (note.x !== lane || note.status !== "pending") continue;
      if (!candidate || note.time < candidate.time) candidate = note;
    }

    if (!candidate) return;

    const deltaTime = Math.abs(songTimeMs - candidate.time);

    if (candidate.type === "slide") {
      if (deltaTime <= SLIDE_WINDOW_MS) {
        candidate.status = "hit";
        this.emitJudgment(candidate, "perfect", songTimeMs);
      }
      return;
    }

    const judgment: Judgment =
      deltaTime <= JUDGMENT_WINDOWS_MS.perfect ? "perfect" : deltaTime <= JUDGMENT_WINDOWS_MS.good ? "good" : "miss";
    candidate.status = judgment === "miss" ? "missed" : "hit";
    this.emitJudgment(candidate, judgment, songTimeMs);
  }
}
