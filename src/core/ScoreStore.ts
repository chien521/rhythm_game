import { Grade } from "../config/constants";

// Per-song, per-difficulty best-run persistence. Replaces the old single
// global high score: since Song Select and Results both need to compare
// against "your best on THIS song," the score has to be keyed by which song
// (and difficulty — the manifest already supports multiple charts per song
// via SongManifestEntry.charts, even though only "Normal" exists today) a
// run belongs to, not a single global number.
export interface BestScoreEntry {
  score: number;
  grade: Grade;
  accuracy: number;
  maxCombo: number;
}

const STORAGE_KEY = "rhythm-game-best-scores"; // one JSON blob, not one localStorage key per song
type ScoreStoreData = Record<string, BestScoreEntry>;

export function getBestScoreKey(songId: string, difficulty: string): string {
  return `${songId}::${difficulty}`;
}

export function getAllBestScores(): ScoreStoreData {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ScoreStoreData;
  } catch {
    return {}; // corrupt/foreign data in this key should never crash the game
  }
}

export function getBestScore(songId: string, difficulty: string): BestScoreEntry | null {
  return getAllBestScores()[getBestScoreKey(songId, difficulty)] ?? null;
}

// Writes `candidate` as the new best for (songId, difficulty) only if it
// beats the current entry (or none exists yet) — score is the ranking
// metric, same rule the old global HighScoreStore used. Returns the
// resulting best plus whether this call was the one that set it.
export function updateBestScore(
  songId: string,
  difficulty: string,
  candidate: BestScoreEntry
): { best: BestScoreEntry; isNewBest: boolean } {
  const key = getBestScoreKey(songId, difficulty);
  const all = getAllBestScores();
  const current = all[key];

  if (current && current.score >= candidate.score) {
    return { best: current, isNewBest: false };
  }

  all[key] = candidate;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return { best: candidate, isNewBest: true };
}
