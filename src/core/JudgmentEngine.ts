import { JUDGMENT_WINDOWS_MS } from "../config/constants";
import { Judgment } from "./ScoreManager";

// Pure classification: given the signed delta (inputTimeMs - noteTimeMs,
// negative = pressed early, positive = pressed late) between a keypress and
// its note's target time, returns which tier it falls into \u2014 or null if the
// press is too far off to be a legitimate attempt on that note at all. No
// side effects, no clock reads, no state \u2014 callers (ChartManager) own
// applying the result to note status, and ScoreManager owns applying it to
// score/combo. Never returns "miss": that tier is exclusively a passive
// timeout (see ChartManager.update()), not something an active press yields.
export function resolveJudgment(delta: number): Judgment | null {
  const abs = Math.abs(delta);
  if (abs <= JUDGMENT_WINDOWS_MS.perfect) return "perfect";
  if (abs <= JUDGMENT_WINDOWS_MS.good) return "good";
  if (delta < 0 && abs <= JUDGMENT_WINDOWS_MS.earlyLate) return "early";
  if (delta > 0 && abs <= JUDGMENT_WINDOWS_MS.earlyLate) return "late";
  return null; // out of range entirely \u2014 not a legitimate attempt, ignored
}
