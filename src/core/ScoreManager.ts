import { GRADE_THRESHOLDS, Grade, SCORE_VALUES } from "../config/constants";

export type Judgment = "perfect" | "good" | "early" | "late" | "miss";

export class ScoreManager {
  score = 0;
  combo = 0;
  maxCombo = 0;
  perfectCount = 0;
  goodCount = 0;
  earlyCount = 0;
  lateCount = 0;
  missCount = 0;

  registerJudgment(judgment: Judgment): void {
    this.score += SCORE_VALUES[judgment];

    if (judgment === "miss") {
      this.combo = 0;
      this.missCount++;
    } else {
      // Early/Late don't break combo, same as Perfect/Good \u2014 they're
      // imprecise, direction-flagged hits, not misses.
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (judgment === "perfect") this.perfectCount++;
      else if (judgment === "good") this.goodCount++;
      else if (judgment === "early") this.earlyCount++;
      else this.lateCount++;
    }
  }

  // Weighted by judgment quality (perfect=100%, good=50%, early/late=25%,
  // miss=0%) so the grade bands in GRADE_THRESHOLDS reward precision, not
  // just "didn't miss" \u2014 early/late score points but count for less accuracy
  // than a clean GOOD, since they're flagged as off-rhythm in either direction.
  getAccuracy(): number {
    const total = this.perfectCount + this.goodCount + this.earlyCount + this.lateCount + this.missCount;
    if (total === 0) return 0;
    const weighted = this.perfectCount + this.goodCount * 0.5 + (this.earlyCount + this.lateCount) * 0.25;
    return (weighted / total) * 100;
  }

  getGrade(): Grade {
    const accuracy = this.getAccuracy();
    if (accuracy >= GRADE_THRESHOLDS.S) return "S";
    if (accuracy >= GRADE_THRESHOLDS.A) return "A";
    if (accuracy >= GRADE_THRESHOLDS.B) return "B";
    return "C";
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfectCount = 0;
    this.goodCount = 0;
    this.earlyCount = 0;
    this.lateCount = 0;
    this.missCount = 0;
  }
}
