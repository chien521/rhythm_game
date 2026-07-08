export const JUDGMENT_WINDOWS_MS = {
  perfect: 50,
  good: 120
} as const;

// Latency calibration: audio output can reach the player's ears some ms after
// the Web Audio clock thinks playback started. effectiveSongTimeMs =
// actualAudioTimeMs - AUDIO_OFFSET_MS. Positive delays the visual/gameplay
// clock (for late-arriving audio); negative pulls it earlier.
export const AUDIO_OFFSET_MS = 0;

export const NOTE_TYPES = ["tap", "slide"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface ChartNote {
  id: string;
  time: number; // ms, relative to song start
  x: number; // lane index 0-7
  type: NoteType;
}

export interface ChartMeta {
  title: string;
  bpm: number;
  songLengthMs: number;
}

export interface ChartData {
  meta: ChartMeta;
  notes: ChartNote[];
}

// How long before its hit time a note spawns and starts falling toward the judgment line.
export const PRE_RENDER_WINDOW_MS = 800;

// Tap notes stay hittable/rendered until this long after their hit time.
export const MISSED_WINDOW_MS = JUDGMENT_WINDOWS_MS.good;

// Slide notes use a single, wider window for both the "is a held/pressed key
// close enough" check and the miss cutoff — no separate start/end phase.
export const SLIDE_WINDOW_MS = 100;

export const SCORE_VALUES = {
  perfect: 1000,
  good: 500,
  miss: 0
} as const;

export const JUDGMENT_TEXT_DURATION_MS = 600;
export const JUDGMENT_POP_DURATION_MS = 100; // birth scale-pop, a portion of the full float lifespan above

// Hit-particle burst: position is a pure function of (songTimeMs - spawnTime),
// never incrementally simulated, so particles freeze exactly in place on pause.
export const PARTICLE_LIFESPAN_MS = 200;
export const PARTICLE_COUNT_MIN = 12;
export const PARTICLE_COUNT_MAX = 16;
export const PARTICLE_FRICTION = 1 / 60; // per-ms velocity decay constant

export const KEY_FLASH_DURATION_MS = 100;
export const COMBO_POP_DURATION_MS = 150;
export const SCREEN_SHAKE_MAGNITUDE_PX = 3;

// Logical design resolution. All gameplay/render math operates in this fixed
// coordinate space; the Renderer scales+letterboxes it to fit the real window,
// so hit-testing and visuals stay consistent regardless of actual screen size/aspect.
export const BASE_WIDTH = 1920;
export const BASE_HEIGHT = 1080;

export const GAME_STATES = ["LOADING", "TITLE", "GAMEPLAY", "RESULTS", "RECORDING"] as const;
export type GameState = (typeof GAME_STATES)[number];

// Cosmetic cross-fade when switching states. Timed off performance.now(), not
// songTimeMs, since TITLE has no audio clock yet and RESULTS has none running.
export const STATE_FADE_DURATION_MS = 400;

export const GRADE_THRESHOLDS = { S: 95, A: 90, B: 80 } as const;
export type Grade = "S" | "A" | "B" | "C";

export const RETRY_BUTTON_RECT = {
  x: BASE_WIDTH / 2 - 160,
  y: BASE_HEIGHT * 0.78,
  width: 320,
  height: 90
} as const;

// Deemo-style vertical fall layout: fixed 8-lane grid, split across two
// keyboard rows for left/right hand separation.
export const LANE_COUNT = 8;
export const JUDGMENT_LINE_Y = 0.85; // fraction of BASE_HEIGHT

// event.code values (layout-independent), left hand on the top row, right
// hand on home row — lanes 0-3 occupy the left half of the screen, 4-7 the right.
export const KEY_LANE_MAP: Record<string, number> = {
  KeyQ: 0,
  KeyW: 1,
  KeyE: 2,
  KeyR: 3,
  KeyJ: 4,
  KeyK: 5,
  KeyL: 6,
  Semicolon: 7
};

// Display text for each event.code — most codes are already the letter
// ("KeyQ" -> "Q"); a few punctuation codes need an explicit label.
const CODE_LABELS: Record<string, string> = { Semicolon: ";" };
function labelForCode(code: string): string {
  return CODE_LABELS[code] ?? code.replace(/^Key/, "");
}

// Derived from KEY_LANE_MAP so the on-screen key captions can never drift out
// of sync with the actual input mapping.
export const LANE_LABELS: string[] = Object.entries(KEY_LANE_MAP).reduce<string[]>((labels, [code, lane]) => {
  labels[lane] = labelForCode(code);
  return labels;
}, new Array(LANE_COUNT).fill("?"));
