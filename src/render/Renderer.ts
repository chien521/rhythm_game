import {
  BASE_HEIGHT,
  BASE_WIDTH,
  COMBO_POP_DURATION_MS,
  JUDGMENT_LINE_Y,
  JUDGMENT_POP_DURATION_MS,
  JUDGMENT_TEXT_DURATION_MS,
  KEY_FLASH_DURATION_MS,
  LANE_COUNT,
  LANE_LABELS,
  PARTICLE_FRICTION,
  PARTICLE_LIFESPAN_MS,
  PRE_RENDER_WINDOW_MS,
  RETRY_BUTTON_RECT,
  SCREEN_SHAKE_MAGNITUDE_PX,
  STATE_FADE_DURATION_MS
} from "../config/constants";
import { RuntimeNote } from "../core/ChartManager";
import { Judgment } from "../core/ScoreManager";
import { computeViewport } from "../core/Viewport";

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const LANE_WIDTH = BASE_WIDTH / LANE_COUNT;
const laneCenterX = (lane: number): number => (lane + 0.5) * LANE_WIDTH;

const NOTE_COLORS: Record<RuntimeNote["type"], string> = {
  tap: "#39f6ff",
  slide: "#ffd166"
};
const MISSED_COLOR = "#5a5f6b";
const FADE_IN_MS = 250;

const JUDGMENT_COLORS: Record<Judgment, string> = {
  perfect: "#39f6ff",
  good: "#ffe066",
  miss: "#ff4d5e"
};
const JUDGMENT_LABELS: Record<Judgment, string> = {
  perfect: "PERFECT!",
  good: "GOOD",
  miss: "MISS"
};

// Particle burst colors — a distinct palette from JUDGMENT_COLORS (which
// drives the floating text), per spec: gold for Perfect, electric cyan for Good.
type ParticleJudgment = "perfect" | "good";
const PARTICLE_COLORS: Record<ParticleJudgment, string> = {
  perfect: "#ffd700",
  good: "#4dd8ff"
};

export interface KeyFlash {
  lane: number;
  time: number; // songTimeMs of the keydown
}

export interface JudgmentDisplay {
  lane: number;
  judgment: Judgment;
  time: number; // songTimeMs when the judgment was decided
}

// Position is derived analytically from elapsed time (never stepped frame by
// frame), so the whole burst freezes exactly in place if the song is paused.
export interface HitParticle {
  lane: number;
  angle: number; // radians, fixed at spawn
  speed: number; // logical px/ms, fixed at spawn
  judgment: ParticleJudgment;
  time: number; // songTimeMs when spawned
}

export interface ResultsSummary {
  score: number;
  maxCombo: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  accuracy: number;
  grade: string;
}

// Pure presentation layer. Receives a song-time (ms) each frame from the
// driving loop in main.ts and draws — it never owns or advances time itself,
// keeping visuals fully decoupled from the audio clock that drives them.
//
// All draw calls operate in a fixed BASE_WIDTH x BASE_HEIGHT logical space;
// the canvas transform (set in resize()) handles scaling that into a
// letterboxed/pillarboxed box that fits the real window, so gameplay math
// never has to know or care about the actual screen size or aspect ratio.
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private resizeScheduled = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.scheduleResize());
  }

  // Coalesces rapid-fire resize events (e.g. a VIVERSE widget being dragged
  // wider) into at most one recalculation per animation frame, instead of
  // thrashing the canvas backing store and transform on every single event.
  private scheduleResize(): void {
    if (this.resizeScheduled) return;
    this.resizeScheduled = true;
    requestAnimationFrame(() => {
      this.resizeScheduled = false;
      this.resize();
    });
  }

  // Reads the canvas's own rendered box (clientWidth/clientHeight) rather
  // than window.innerWidth/innerHeight, so this stays correct even if the
  // canvas is embedded in a container sized independently of the window (as
  // a VIVERSE widget might be). Only touches the canvas backing store and
  // the ctx transform — never game state — so a resize mid-song can't affect
  // ScoreManager, ChartManager, or any in-flight particles/animations.
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;

    const viewport = computeViewport(width, height);
    this.ctx.setTransform(
      dpr * viewport.scale,
      0,
      0,
      dpr * viewport.scale,
      dpr * viewport.offsetX,
      dpr * viewport.offsetY
    );
  }

  clear(): void {
    // Blank the whole physical canvas first (raw device pixels) so the
    // letterbox/pillarbox bars outside the logical game area are solid black.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    // Then fill just the logical game area with the actual background color.
    this.ctx.fillStyle = "#05060a";
    this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
  }

  // Quick camera-shake on a Perfect hit: translates by a random tiny offset
  // for the draw calls in between beginShake/endShake, restored immediately
  // after — the caller is responsible for making `active` true for exactly
  // one frame() call so the shake never persists longer than that.
  beginShake(active: boolean): void {
    if (!active) return;
    this.ctx.save();
    const dx = (Math.random() * 2 - 1) * SCREEN_SHAKE_MAGNITUDE_PX;
    const dy = (Math.random() * 2 - 1) * SCREEN_SHAKE_MAGNITUDE_PX;
    this.ctx.translate(dx, dy);
  }

  endShake(active: boolean): void {
    if (!active) return;
    this.ctx.restore();
  }

  // Lane dividers, per-lane key captions (glowing + pulsing when held, muted
  // when not), a held-lane gradient, a keydown hit-flash, and the static
  // judgment line on top. All in logical BASE_WIDTH/BASE_HEIGHT units, so the
  // letterbox transform set in resize() places everything correctly
  // regardless of the real window's aspect ratio. The pulse is a sine wave of
  // songTimeMs itself (not an elapsed-since-event timer), so it freezes
  // mid-oscillation exactly where it was when the song pauses.
  drawLanes(heldLanes: ReadonlySet<number>, songTimeMs: number, keyFlashes: readonly KeyFlash[]): void {
    const lineY = JUDGMENT_LINE_Y * BASE_HEIGHT;

    this.ctx.save();

    this.ctx.strokeStyle = "rgba(143, 227, 255, 0.15)";
    this.ctx.lineWidth = 1;
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const x = lane * LANE_WIDTH;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, BASE_HEIGHT);
      this.ctx.stroke();
    }

    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const laneX = lane * LANE_WIDTH;
      const held = heldLanes.has(lane);

      if (held) {
        const pulse = 0.5 + 0.5 * Math.sin(songTimeMs / 70); // 0..1, ~440ms period
        const alpha = 0.14 + pulse * 0.1;
        const gradient = this.ctx.createLinearGradient(0, 0, 0, lineY);
        gradient.addColorStop(0, "rgba(255, 209, 102, 0)");
        gradient.addColorStop(1, `rgba(255, 209, 102, ${alpha.toFixed(3)})`);
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(laneX, 0, LANE_WIDTH, lineY);
      }

      if (held) {
        this.ctx.font = "bold 34px monospace";
        this.ctx.fillStyle = "#ffd700";
        this.ctx.shadowColor = "#ffd700";
        this.ctx.shadowBlur = 15;
      } else {
        this.ctx.font = "28px monospace";
        this.ctx.fillStyle = "#a0a5b5";
        this.ctx.shadowBlur = 0;
      }
      this.ctx.fillText(LANE_LABELS[lane], laneCenterX(lane), lineY + 46);
    }
    this.ctx.shadowBlur = 0;

    this.ctx.strokeStyle = "#39f6ff";
    this.ctx.lineWidth = 3;
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 12;
    this.ctx.beginPath();
    this.ctx.moveTo(0, lineY);
    this.ctx.lineTo(BASE_WIDTH, lineY);
    this.ctx.stroke();

    // Keydown hit-flash: a bright glow across just that lane's width, right on
    // the judgment line, fading out over KEY_FLASH_DURATION_MS from the exact
    // songTimeMs of the press.
    for (const flash of keyFlashes) {
      const elapsed = songTimeMs - flash.time;
      const progress = clamp(elapsed / KEY_FLASH_DURATION_MS, 0, 1);
      if (progress >= 1) continue;

      const laneX = flash.lane * LANE_WIDTH;
      this.ctx.save();
      this.ctx.globalAlpha = 1 - progress;
      this.ctx.strokeStyle = "#ffffff";
      this.ctx.lineWidth = 2 + 6 * (1 - progress);
      this.ctx.shadowColor = "#ffffff";
      this.ctx.shadowBlur = 20;
      this.ctx.beginPath();
      this.ctx.moveTo(laneX, lineY);
      this.ctx.lineTo(laneX + LANE_WIDTH, lineY);
      this.ctx.stroke();
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  // Falling-note math: y is purely a function of time remaining until the
  // note's hit time, so it lands exactly on the judgment line at songTimeMs === note.time.
  drawNotes(activeNotes: readonly RuntimeNote[], songTimeMs: number): void {
    const barHeight = 28;
    const padding = 10;

    for (const note of activeNotes) {
      const timeRemaining = note.time - songTimeMs;
      const yFraction =
        timeRemaining > 0 ? JUDGMENT_LINE_Y - (timeRemaining / PRE_RENDER_WINDOW_MS) * JUDGMENT_LINE_Y : JUDGMENT_LINE_Y;
      const cy = yFraction * BASE_HEIGHT;
      const laneX = note.x * LANE_WIDTH;

      const spawnTime = note.time - PRE_RENDER_WINDOW_MS;
      const opacity = note.status === "missed" ? 0.35 : clamp((songTimeMs - spawnTime) / FADE_IN_MS, 0, 1);
      const color = note.status === "missed" ? MISSED_COLOR : NOTE_COLORS[note.type];

      this.ctx.save();
      this.ctx.globalAlpha = opacity;
      this.ctx.fillStyle = color;
      this.ctx.shadowColor = color;

      if (note.type === "tap") {
        // Sharp bar, square-edged, spanning the lane's full width.
        this.ctx.shadowBlur = 6;
        this.ctx.fillRect(laneX + padding, cy - barHeight / 2, LANE_WIDTH - padding * 2, barHeight);
      } else {
        // Slide: glowing rounded pill so it visually reads as "sweep-through-able".
        this.ctx.shadowBlur = 18;
        this.ctx.beginPath();
        this.ctx.roundRect(laneX + padding, cy - barHeight / 2, LANE_WIDTH - padding * 2, barHeight, barHeight / 2);
        this.ctx.fill();
      }

      // Stamp the target key onto the note body. Dark, no glow, so it stays
      // sharp against the bright fill regardless of how fast the note is moving.
      this.ctx.shadowBlur = 0;
      this.ctx.fillStyle = "#0b1220";
      this.ctx.font = `bold ${Math.round(barHeight * 0.62)}px monospace`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(LANE_LABELS[note.x], laneCenterX(note.x), cy);

      this.ctx.restore();
    }
  }

  // Particle burst at the lane/judgment-line intersection. Each particle's
  // position is solved analytically from elapsed time under exponential
  // friction decay (pos = pos0 + (v0/k)*(1 - e^-kt)) rather than integrated
  // frame-by-frame, so the whole burst is a pure function of songTimeMs and
  // freezes exactly in place on pause.
  drawParticles(particles: readonly HitParticle[], songTimeMs: number): void {
    const lineY = JUDGMENT_LINE_Y * BASE_HEIGHT;

    for (const particle of particles) {
      const elapsed = songTimeMs - particle.time;
      const progress = clamp(elapsed / PARTICLE_LIFESPAN_MS, 0, 1);
      if (progress >= 1 || elapsed < 0) continue;

      const travel = (particle.speed / PARTICLE_FRICTION) * (1 - Math.exp(-PARTICLE_FRICTION * elapsed));
      const cx = laneCenterX(particle.lane) + Math.cos(particle.angle) * travel;
      const cy = lineY + Math.sin(particle.angle) * travel;
      const radius = 4 * (1 - progress) + 1;
      const color = PARTICLE_COLORS[particle.judgment];

      this.ctx.save();
      this.ctx.globalAlpha = 1 - progress;
      this.ctx.fillStyle = color;
      this.ctx.shadowColor = color;
      this.ctx.shadowBlur = 8;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  // comboChangedAt: songTimeMs the combo last incremented — drives a quick
  // scale-pop (1.3x easing back to 1.0x over COMBO_POP_DURATION_MS) so the
  // counter feels punchy instead of just updating its text in place.
  drawHud(score: number, combo: number, comboChangedAt: number, songTimeMs: number): void {
    this.ctx.save();
    this.ctx.textAlign = "right";
    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 36px monospace";
    this.ctx.fillText(`${Math.floor(score)}`, BASE_WIDTH - 32, 52);

    if (combo > 0) {
      const popProgress = clamp((songTimeMs - comboChangedAt) / COMBO_POP_DURATION_MS, 0, 1);
      const scale = 1 + 0.3 * (1 - popProgress) ** 2;

      this.ctx.save();
      this.ctx.translate(BASE_WIDTH - 32, 88);
      this.ctx.scale(scale, scale);
      this.ctx.font = "26px monospace";
      this.ctx.fillStyle = "#8fe3ff";
      this.ctx.fillText(`${combo} COMBO`, 0, 0);
      this.ctx.restore();
    }
    this.ctx.restore();
  }

  // Floating judgment text at the lane/judgment-line intersection where the
  // hit happened. Faded, drifted upward, and scale-popped on birth, all as
  // pure functions of songTimeMs delta rather than wall clock, so the whole
  // animation freezes in place if the song is paused right after a hit. A
  // list (not a single "last judgment") since multiple lanes can be judged in close succession.
  drawJudgmentText(displays: readonly JudgmentDisplay[], songTimeMs: number): void {
    const baseY = JUDGMENT_LINE_Y * BASE_HEIGHT;

    for (const display of displays) {
      const elapsed = songTimeMs - display.time;
      const progress = clamp(elapsed / JUDGMENT_TEXT_DURATION_MS, 0, 1);
      if (progress >= 1) continue;

      const rise = progress * 26; // gentle upward drift over its lifespan
      const popProgress = clamp(elapsed / JUDGMENT_POP_DURATION_MS, 0, 1);
      const scale = 1.4 - 0.4 * popProgress; // birth pop: 1.4x shrinking to 1.0x
      const cx = laneCenterX(display.lane);
      const cy = baseY - 40 - rise;

      this.ctx.save();
      this.ctx.globalAlpha = 1 - progress;
      this.ctx.translate(cx, cy);
      this.ctx.scale(scale, scale);
      this.ctx.textAlign = "center";
      this.ctx.font = "bold 22px monospace";
      this.ctx.fillStyle = JUDGMENT_COLORS[display.judgment];
      this.ctx.shadowColor = JUDGMENT_COLORS[display.judgment];
      this.ctx.shadowBlur = 12;
      this.ctx.fillText(JUDGMENT_LABELS[display.judgment], 0, 0);
      this.ctx.restore();
    }
  }

  drawDebug(songTimeMs: number, isPlaying: boolean): void {
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "20px monospace";
    this.ctx.textAlign = "left";
    this.ctx.fillText(`t=${songTimeMs.toFixed(1)}ms  ${isPlaying ? "PLAYING" : "PAUSED"} (space to toggle)`, 20, 32);
  }

  // Dims the (frozen) gameplay scene behind a prompt after an auto-pause from
  // losing window focus / tab visibility. Deliberately requires an explicit
  // click/keypress to dismiss — never auto-resumes on refocus, so regaining
  // focus can't jump-scare the player back into gameplay.
  drawResumePrompt(nowMs: number): void {
    this.ctx.save();
    this.ctx.fillStyle = "rgba(5, 6, 10, 0.72)";
    this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 40px monospace";
    this.ctx.fillText("PAUSED", BASE_WIDTH / 2, BASE_HEIGHT / 2 - 34);

    const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
    this.ctx.globalAlpha = 0.6 + pulse * 0.4;
    this.ctx.fillStyle = "#39f6ff";
    this.ctx.font = "bold 24px monospace";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 14;
    this.ctx.fillText("CLICK OR PRESS A KEY TO RESUME", BASE_WIDTH / 2, BASE_HEIGHT / 2 + 20);

    this.ctx.restore();
  }

  drawLoadingScreen(nowMs: number): void {
    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
    this.ctx.globalAlpha = 0.5 + pulse * 0.5;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "28px monospace";
    this.ctx.fillText("LOADING AUDIO ASSETS...", BASE_WIDTH / 2, BASE_HEIGHT / 2);

    this.ctx.restore();
  }

  drawTitleScreen(highScore: number, nowMs: number): void {
    this.ctx.save();
    this.ctx.textAlign = "center";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 96px monospace";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 24;
    this.ctx.fillText("RHYTHM POC", BASE_WIDTH / 2, BASE_HEIGHT * 0.35);

    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "32px monospace";
    this.ctx.fillText(`HIGH SCORE: ${Math.floor(highScore)}`, BASE_WIDTH / 2, BASE_HEIGHT * 0.48);

    const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
    this.ctx.globalAlpha = 0.5 + pulse * 0.5;
    this.ctx.fillStyle = "#39f6ff";
    this.ctx.font = "bold 30px monospace";
    this.ctx.fillText("TAP TO START", BASE_WIDTH / 2, BASE_HEIGHT * 0.65);

    this.ctx.restore();
  }

  drawResultsScreen(summary: ResultsSummary): void {
    this.ctx.save();
    this.ctx.textAlign = "center";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 64px monospace";
    this.ctx.fillText("RESULTS", BASE_WIDTH / 2, BASE_HEIGHT * 0.16);

    this.ctx.fillStyle = JUDGMENT_COLORS.perfect;
    this.ctx.font = "bold 140px monospace";
    this.ctx.shadowColor = JUDGMENT_COLORS.perfect;
    this.ctx.shadowBlur = 20;
    this.ctx.fillText(summary.grade, BASE_WIDTH / 2, BASE_HEIGHT * 0.4);
    this.ctx.shadowBlur = 0;

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 40px monospace";
    this.ctx.fillText(`SCORE ${Math.floor(summary.score)}`, BASE_WIDTH / 2, BASE_HEIGHT * 0.5);

    this.ctx.font = "26px monospace";
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.fillText(
      `MAX COMBO ${summary.maxCombo}   ACCURACY ${summary.accuracy.toFixed(1)}%`,
      BASE_WIDTH / 2,
      BASE_HEIGHT * 0.57
    );

    this.ctx.font = "24px monospace";
    this.ctx.fillStyle = JUDGMENT_COLORS.perfect;
    this.ctx.fillText(`PERFECT ${summary.perfectCount}`, BASE_WIDTH / 2 - 260, BASE_HEIGHT * 0.65);
    this.ctx.fillStyle = JUDGMENT_COLORS.good;
    this.ctx.fillText(`GOOD ${summary.goodCount}`, BASE_WIDTH / 2, BASE_HEIGHT * 0.65);
    this.ctx.fillStyle = JUDGMENT_COLORS.miss;
    this.ctx.fillText(`MISS ${summary.missCount}`, BASE_WIDTH / 2 + 260, BASE_HEIGHT * 0.65);

    const r = RETRY_BUTTON_RECT;
    this.ctx.strokeStyle = "#39f6ff";
    this.ctx.lineWidth = 3;
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 12;
    this.ctx.strokeRect(r.x, r.y, r.width, r.height);
    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 30px monospace";
    this.ctx.fillText("RETRY", r.x + r.width / 2, r.y + r.height / 2 + 10);

    this.ctx.restore();
  }

  // Fades in from black right after a state switch. Timed off performance.now()
  // (via nowMs passed in) so it's independent of whatever clock (or lack of one)
  // the current state is using.
  drawStateFade(transitionStartMs: number, nowMs: number): void {
    const progress = clamp((nowMs - transitionStartMs) / STATE_FADE_DURATION_MS, 0, 1);
    if (progress >= 1) return;
    this.ctx.save();
    this.ctx.globalAlpha = 1 - progress;
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
    this.ctx.restore();
  }
}
