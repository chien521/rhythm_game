import { AUDIO_OFFSET_MAX_MS, AUDIO_OFFSET_MIN_MS, AUDIO_OFFSET_MS } from "../config/constants";

// Player-adjustable settings persistence, same bare-functional localStorage
// style as ScoreStore.ts \u2014 one JSON blob under a single key, never throws on
// missing/corrupt data.
export interface Settings {
  audioOffsetMs: number;
}

const STORAGE_KEY = "rhythm-game-settings";

export function getSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { audioOffsetMs: AUDIO_OFFSET_MS };
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    return { audioOffsetMs: AUDIO_OFFSET_MS }; // corrupt/foreign data in this key should never crash the game
  }
}

export function getAudioOffsetMs(): number {
  return getSettings().audioOffsetMs;
}

export function setAudioOffsetMs(ms: number): void {
  const clamped = Math.min(AUDIO_OFFSET_MAX_MS, Math.max(AUDIO_OFFSET_MIN_MS, ms));
  const settings = getSettings();
  settings.audioOffsetMs = clamped;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
