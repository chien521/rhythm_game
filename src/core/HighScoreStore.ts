const STORAGE_KEY = "rhythm-game-high-score";

export function getHighScore(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? Number(stored) : 0;
}

// Returns the (possibly unchanged) high score after comparing against `score`.
export function updateHighScore(score: number): number {
  const current = getHighScore();
  if (score <= current) return current;
  localStorage.setItem(STORAGE_KEY, String(score));
  return score;
}
