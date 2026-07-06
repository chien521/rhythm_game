import { Grade, GRADE_THRESHOLDS, SCORE_VALUES } from "../config/constants";

export type Judgment = "perfect" | "good" | "miss";

export class ScoreManager {
  score = 0;
  combo = 0;
  maxCombo = 0;
  perfectCount = 0;
  goodCount = 0;
  missCount = 0;

  registerJudgment(judgment: Judgment): void {
    this.score += SCORE_VALUES[judgment];

    if (judgment === "miss") {
      this.combo = 0;
      this.missCount++;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (judgment === "perfect") this.perfectCount++;
      else this.goodCount++;
    }
  }

  // Weighted by judgment quality (perfect=100%, good=50%, miss=0%) so the
  // grade bands in GRADE_THRESHOLDS reward precision, not just "didn't miss".
  getAccuracy(): number {
    const total = this.perfectCount + this.goodCount + this.missCount;
    if (total === 0) return 0;
    return ((this.perfectCount + this.goodCount * 0.5) / total) * 100;
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
    this.missCount = 0;
  }
}
