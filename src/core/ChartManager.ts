import {
  BASE_BPM,
  ChartData,
  ChartNote,
  computeLookaheadMs,
  computeNoteVelocity,
  MISSED_WINDOW_MS,
  SLIDE_WINDOW_MS
} from "../config/constants";
import { resolveJudgment } from "./JudgmentEngine";
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

  // BPM-derived: recomputed per loadChart() call so slower songs get a
  // proportionally slower fall speed and a correspondingly larger spawn
  // look-ahead window (see computeNoteVelocity/computeLookaheadMs).
  private noteVelocity = computeNoteVelocity(BASE_BPM);
  private lookaheadMs = computeLookaheadMs(this.noteVelocity);

  loadChart(chart: ChartData): void {
    this.meta = chart.meta;
    this.noteVelocity = computeNoteVelocity(chart.meta.bpm);
    this.lookaheadMs = computeLookaheadMs(this.noteVelocity);
    this.notes = chart.notes
      .map((note) => ({ ...note, status: "pending" as NoteStatus }))
      .sort((a, b) => a.time - b.time);
    this.activeNotes = [];
  }

  getMeta(): ChartData["meta"] | null {
    return this.meta;
  }

  // Current fall speed (px/ms) for the loaded chart — the Renderer uses this
  // same value so the visual scroll and the spawn/active window below always
  // agree on exactly where a note is on screen.
  getNoteVelocity(): number {
    return this.noteVelocity;
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
      const spawnTime = note.time - this.lookaheadMs;
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

    const delta = songTimeMs - candidate.time; // signed: negative = early, positive = late

    if (candidate.type === "slide") {
      if (Math.abs(delta) <= SLIDE_WINDOW_MS) {
        candidate.status = "hit";
        this.emitJudgment(candidate, "perfect", songTimeMs);
      }
      return;
    }

    const judgment = resolveJudgment(delta);
    if (judgment === null) return; // too far off to be a legitimate attempt \u2014 leave the note pending

    candidate.status = "hit"; // active-press judgments are never "miss" \u2014 that's exclusively a passive timeout
    this.emitJudgment(candidate, judgment, songTimeMs);
  }
}
