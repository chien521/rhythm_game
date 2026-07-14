import {
  AUDIO_OFFSET_MAX_MS,
  AUDIO_OFFSET_MIN_MS,
  BASE_HEIGHT,
  BASE_WIDTH,
  COMBO_POP_DURATION_MS,
  COUNTDOWN_MS,
  JUDGMENT_LINE_Y,
  JUDGMENT_POP_DURATION_MS,
  JUDGMENT_TEXT_DURATION_MS,
  KEY_FLASH_DURATION_MS,
  LANE_COUNT,
  LANE_LABELS,
  PARTICLE_FRICTION,
  PARTICLE_LIFESPAN_MS,
  PROGRESS_BAR_RECT,
  SCREEN_SHAKE_MAGNITUDE_PX,
  STATE_FADE_DURATION_MS,
  VOLUME_BAR_RECT,
  VOLUME_ICON_WIDTH
} from "../config/constants";
import { RuntimeNote } from "../core/ChartManager";
import { Judgment } from "../core/ScoreManager";
import { BestScoreEntry } from "../core/ScoreStore";
import { computeViewport } from "../core/Viewport";
import { SongManifestEntry } from "../config/constants";

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const formatTime = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Shared layout for SONG_SELECT's row list — called by drawSongSelectScreen
// AND by main.ts's mouse hit-testing (hover + click), so the two can never
// disagree about where a row actually is on screen.
export function getSongSelectRowRect(index: number, total: number): UiRect {
  const rowHeight = 90;
  const rowWidth = 840;
  const listCenterY = BASE_HEIGHT / 2;
  const startY = listCenterY - ((total - 1) * rowHeight) / 2;
  const y = startY + index * rowHeight;
  return { x: BASE_WIDTH / 2 - rowWidth / 2, y: y - rowHeight / 2 + 8, width: rowWidth, height: rowHeight - 16 };
}

// Shared layout for DIFFICULTY_SELECT's row list — same reasoning as
// getSongSelectRowRect, but narrower since these rows only need a difficulty
// name + a best-score line, not a song title + artist/BPM.
export function getDifficultySelectRowRect(index: number, total: number): UiRect {
  const rowHeight = 90;
  const rowWidth = 520;
  const listCenterY = BASE_HEIGHT / 2;
  const startY = listCenterY - ((total - 1) * rowHeight) / 2;
  const y = startY + index * rowHeight;
  return { x: BASE_WIDTH / 2 - rowWidth / 2, y: y - rowHeight / 2 + 8, width: rowWidth, height: rowHeight - 16 };
}

// Shared layout for the PAUSED menu's 2 options — same reasoning as above.
export function getPauseMenuRowRect(index: number): UiRect {
  const rowHeight = 80;
  const rowWidth = 440;
  const startY = BASE_HEIGHT * 0.55;
  const y = startY + index * rowHeight;
  return { x: BASE_WIDTH / 2 - rowWidth / 2, y: y - 30, width: rowWidth, height: 60 };
}

const LANE_WIDTH = BASE_WIDTH / LANE_COUNT;
const laneCenterX = (lane: number): number => (lane + 0.5) * LANE_WIDTH;

const NOTE_COLORS: Record<RuntimeNote["type"], string> = {
  tap: "#39f6ff",
  slide: "#ffd166",
  hold: "#b478ff" // violet — visually distinct from both tap (cyan) and slide (gold)
};
const FADE_IN_MS = 250;

const JUDGMENT_COLORS: Record<Judgment, string> = {
  perfect: "#ffd700", // Radiant Gold
  good: "#39ff6b", // Bright Green
  early: "#8fe3ff", // Ice Blue
  late: "#ff5a36", // Crimson Orange
  miss: "#ff4d5e"
};
const JUDGMENT_LABELS: Record<Judgment, string> = {
  perfect: "PERFECT!",
  good: "GOOD",
  early: "EARLY",
  late: "LATE",
  miss: "MISS"
};

// Particle burst colors — mirrors JUDGMENT_COLORS (which drives the floating
// text) so a hit's particle burst and its text always agree on tier color.
type ParticleJudgment = "perfect" | "good" | "early" | "late";
const PARTICLE_COLORS: Record<ParticleJudgment, string> = {
  perfect: "#ffd700",
  good: "#39ff6b",
  early: "#8fe3ff",
  late: "#ff5a36"
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
  earlyCount: number;
  lateCount: number;
  missCount: number;
  accuracy: number;
  grade: string;
  isFullCombo: boolean;
  isAllPerfect: boolean;
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
  // note's hit time, scaled by noteVelocity (px/ms, derived per-chart from its
  // BPM — see computeNoteVelocity) so it lands exactly on the judgment line at
  // songTimeMs === note.time regardless of tempo. lookaheadMs (how far ahead
  // of its hit time a note starts fading in) is derived from that same
  // velocity, so a slower noteVelocity automatically fades notes in earlier,
  // matching how much further up the screen they need to spawn.
  drawNotes(activeNotes: readonly RuntimeNote[], songTimeMs: number, noteVelocity: number): void {
    const barHeight = 28;
    const padding = 10;
    const judgmentLineYPx = JUDGMENT_LINE_Y * BASE_HEIGHT;
    const lookaheadMs = judgmentLineYPx / noteVelocity;

    for (const note of activeNotes) {
      if (note.status === "missed") continue; // no dim "ghost" bar — a missed note yields no score, so it's gone

      const timeRemaining = note.time - songTimeMs;
      const cy = timeRemaining > 0 ? judgmentLineYPx - timeRemaining * noteVelocity : judgmentLineYPx;
      const laneX = note.x * LANE_WIDTH;

      const spawnTime = note.time - lookaheadMs;
      const opacity = clamp((songTimeMs - spawnTime) / FADE_IN_MS, 0, 1);
      const color = NOTE_COLORS[note.type];

      this.ctx.save();
      this.ctx.globalAlpha = opacity;
      this.ctx.fillStyle = color;
      this.ctx.shadowColor = color;

      if (note.type === "tap") {
        // Sharp bar, square-edged, spanning the lane's full width.
        this.ctx.shadowBlur = 6;
        this.ctx.fillRect(laneX + padding, cy - barHeight / 2, LANE_WIDTH - padding * 2, barHeight);
      } else if (note.type === "hold") {
        // Trail: a rounded-rect body from the tail up to the head, draining
        // as the hold is consumed (bodyH shrinks toward 0), plus a solid head
        // cap so the press point stays obvious. Brighter/more glow while
        // actively holding, dimmer while still just pending/approaching.
        const durationMs = note.durationMs ?? 0;
        const tailRemaining = note.time + durationMs - songTimeMs;
        const tailY = judgmentLineYPx - Math.max(0, tailRemaining) * noteVelocity;
        const bodyX = laneX + padding;
        const bodyW = LANE_WIDTH - padding * 2;
        const bodyTop = tailY; // tail is above the head (earlier y)
        const bodyH = Math.max(0, cy - tailY); // body drains as the hold is consumed
        const holding = note.status === "holding";

        this.ctx.globalAlpha = opacity * (holding ? 1 : 0.7);
        this.ctx.shadowBlur = holding ? 24 : 14;
        this.ctx.beginPath();
        this.ctx.roundRect(bodyX, bodyTop, bodyW, bodyH, Math.min(bodyW, barHeight) / 2);
        this.ctx.fill();

        this.ctx.globalAlpha = opacity;
        this.ctx.shadowBlur = holding ? 12 : 6;
        this.ctx.fillRect(bodyX, cy - barHeight / 2, bodyW, barHeight);
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

  // Song-progress bar: elapsed/total (mm:ss) above a filled track, with the
  // percentage centered inside the bar itself. The percentage is drawn TWICE,
  // each pass clipped to a different region (filled vs. unfilled), so it
  // stays legible at any progress: dark text where it overlaps the bright
  // cyan fill, light text where it overlaps the dark track — otherwise a
  // single centered draw would be unreadable against the track for the first
  // half of every song.
  drawProgressBar(songTimeMs: number, durationMs: number, isPlaying: boolean): void {
    const { x, y, width, height } = PROGRESS_BAR_RECT;
    const progress = durationMs > 0 ? clamp(songTimeMs / durationMs, 0, 1) : 0;
    const fillWidth = width * progress;
    const activeColor = "#ff9f45";
    const trackColor = "rgba(255, 255, 255, 0.15)";

    this.ctx.save();

    this.ctx.fillStyle = trackColor;
    this.ctx.fillRect(x, y, width, height);

    this.ctx.fillStyle = activeColor;
    this.ctx.shadowColor = activeColor;
    this.ctx.shadowBlur = 6;
    this.ctx.fillRect(x, y, fillWidth, height);
    this.ctx.shadowBlur = 0;

    const pctText = `${Math.round(progress * 100)}%`;
    const textX = x + width / 2;
    const textY = y + height / 2;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "bold 16px monospace";

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, fillWidth, height);
    this.ctx.clip();
    this.ctx.fillStyle = "#05060a";
    this.ctx.fillText(pctText, textX, textY);
    this.ctx.restore();

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x + fillWidth, y, width - fillWidth, height);
    this.ctx.clip();
    this.ctx.fillStyle = "#e6faff";
    this.ctx.fillText(pctText, textX, textY);
    this.ctx.restore();

    this.ctx.textBaseline = "alphabetic";
    this.ctx.font = "16px monospace";
    this.ctx.fillStyle = "#ffd0a0";
    this.ctx.fillText(`${formatTime(songTimeMs)} / ${formatTime(durationMs)}`, textX, y - 10);

    if (!isPlaying) {
      this.ctx.font = "14px monospace";
      this.ctx.fillStyle = "rgba(143, 227, 255, 0.7)";
      this.ctx.fillText("PAUSED (space to pause)", textX, y + height + 20);
    }

    this.ctx.restore();
  }

  // Pre-game countdown lead-in: GAMEPLAY's song-time clock starts at
  // -COUNTDOWN_MS and rises to 0 (see AudioManager.restart()'s leadInMs), so
  // notes are already falling in normally by the time it hits 0 — this just
  // overlays the "3 2 1" on top of that. Drawn as long as songTimeMs is still
  // negative; input isn't locked during it (existing judgment windows already
  // make early presses inert).
  drawCountdown(songTimeMs: number): void {
    if (songTimeMs >= 0) return;

    const secondsLeft = Math.min(Math.ceil(COUNTDOWN_MS / 1000), Math.ceil(-songTimeMs / 1000));
    const frac = (-songTimeMs / 1000) % 1; // ~1 -> 0 within each second, drives the scale-pop below
    const scale = 1 + 0.4 * frac;

    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.translate(BASE_WIDTH / 2, BASE_HEIGHT / 2);
    this.ctx.scale(scale, scale);

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 140px monospace";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 24;
    this.ctx.fillText(`${secondsLeft}`, 0, 0);
    this.ctx.shadowBlur = 0;

    this.ctx.restore();
  }

  // Manual pause menu (Space during GAMEPLAY): a dark scrim over the frozen
  // scene with a 2-option, keyboard-navigable list (Up/Down + Enter, handled
  // in main.ts). Distinct from drawResumePrompt, which is the involuntary
  // auto-pause-on-focus-loss prompt and has no menu at all.
  drawPauseMenu(selectedIndex: number, nowMs: number, volume: number, isMuted: boolean): void {
    this.ctx.save();
    this.ctx.fillStyle = "rgba(5, 6, 10, 0.72)";
    this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 56px monospace";
    this.ctx.fillText("PAUSED", BASE_WIDTH / 2, BASE_HEIGHT * 0.35);

    const options = ["RESTART", "BACK TO MENU"];

    options.forEach((label, i) => {
      const rect = getPauseMenuRowRect(i);
      const y = rect.y + rect.height / 2;
      const isSelected = i === selectedIndex;

      if (isSelected) {
        const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
        this.ctx.save();
        this.ctx.globalAlpha = 0.15 + pulse * 0.1;
        this.ctx.fillStyle = "#39f6ff";
        this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.restore();

        this.ctx.strokeStyle = "#39f6ff";
        this.ctx.lineWidth = 2;
        this.ctx.shadowColor = "#39f6ff";
        this.ctx.shadowBlur = 12;
        this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.shadowBlur = 0;
      }

      this.ctx.fillStyle = isSelected ? "#39f6ff" : "#8fe3ff";
      this.ctx.font = isSelected ? "bold 30px monospace" : "26px monospace";
      this.ctx.fillText(label, BASE_WIDTH / 2, y);
    });

    this.ctx.globalAlpha = 0.8;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "18px monospace";
    this.ctx.fillText("\u2191 / \u2193 TO SELECT   ENTER TO CONFIRM   S SETTINGS   SPACE TO RESUME", BASE_WIDTH / 2, BASE_HEIGHT * 0.8);
    this.drawVolumeBar(VOLUME_BAR_RECT.x, VOLUME_BAR_RECT.y, VOLUME_BAR_RECT.width, VOLUME_BAR_RECT.height, volume, isMuted);

    this.ctx.restore();
  }

  // Shared volume control, rendered identically on SONG_SELECT and PAUSED so
  // the two screens never look or behave differently. "VOL" label doubles as
  // the speaker icon (a drawn glyph would need its own asset/path data for no
  // real benefit at this size) with a crossing red X when muted; the level is
  // 10 segmented rectangles, lit up to round(volume * 10) — muted forces the
  // fill to read as empty/grayed regardless of the stored volume, matching
  // AudioManager's own `gain = isMuted ? 0 : volume` behavior.
  drawVolumeBar(x: number, y: number, width: number, height: number, volume: number, isMuted: boolean): void {
    this.ctx.save();
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "middle";

    const iconWidth = VOLUME_ICON_WIDTH;
    const segmentCount = 10;
    const segmentGap = 4;
    const barX = x + iconWidth;
    const barWidth = width - iconWidth;
    const segmentWidth = (barWidth - segmentGap * (segmentCount - 1)) / segmentCount;
    const filledCount = isMuted ? 0 : Math.round(volume * segmentCount);
    const activeColor = "#39f6ff";
    const dimColor = "rgba(255, 255, 255, 0.15)";

    this.ctx.font = "bold 16px monospace";
    this.ctx.fillStyle = isMuted ? "rgba(255, 255, 255, 0.35)" : "#8fe3ff";
    this.ctx.fillText("VOL", x, y + height / 2);

    if (isMuted) {
      this.ctx.strokeStyle = "#ff4d5e";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y + 2);
      this.ctx.lineTo(x + iconWidth - 10, y + height - 2);
      this.ctx.moveTo(x + iconWidth - 10, y + 2);
      this.ctx.lineTo(x, y + height - 2);
      this.ctx.stroke();
    }

    for (let i = 0; i < segmentCount; i++) {
      const segX = barX + i * (segmentWidth + segmentGap);
      const isFilled = i < filledCount;
      this.ctx.fillStyle = isFilled ? activeColor : dimColor;
      this.ctx.shadowColor = activeColor;
      this.ctx.shadowBlur = isFilled ? 6 : 0;
      this.ctx.fillRect(segX, y + height * 0.25, segmentWidth, height * 0.5);
    }
    this.ctx.shadowBlur = 0;
    this.ctx.restore();
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

  // HUD for the developer Recording Mode: a pulsing REC dot, elapsed/total
  // time, captured note count, and the stop hotkey — driven by songTimeMs so
  // it stays in lockstep with the same clock the captured note timestamps use.
  drawRecordingHud(songTimeMs: number, durationMs: number, noteCount: number, nowMs: number): void {
    this.ctx.save();
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "alphabetic";

    const pulse = (Math.sin(nowMs / 200) + 1) / 2; // 0..1, cosmetic-only blink
    this.ctx.globalAlpha = 0.5 + pulse * 0.5;
    this.ctx.fillStyle = "#ff4d5e";
    this.ctx.font = "bold 26px monospace";
    this.ctx.fillText("● REC", 20, 60);

    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "20px monospace";
    this.ctx.fillText(`${(songTimeMs / 1000).toFixed(1)}s / ${(durationMs / 1000).toFixed(1)}s`, 20, 90);
    this.ctx.fillText(`${noteCount} notes captured`, 20, 116);
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "16px monospace";
    this.ctx.fillText("ESC to stop and export chart.json", 20, 144);

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

  drawTitleScreen(nowMs: number): void {
    this.ctx.save();
    this.ctx.textAlign = "center";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 96px monospace";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 24;
    this.ctx.fillText("RHYTHM POC", BASE_WIDTH / 2, BASE_HEIGHT * 0.35);
    this.ctx.shadowBlur = 0;

    const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
    this.ctx.globalAlpha = 0.5 + pulse * 0.5;
    this.ctx.fillStyle = "#39f6ff";
    this.ctx.font = "bold 30px monospace";
    this.ctx.fillText("PRESS ENTER OR TAP TO SELECT A SONG", BASE_WIDTH / 2, BASE_HEIGHT * 0.65);

    this.ctx.restore();
  }

  // Song Select: a simple centered vertical list, one row per manifest entry.
  // The highlighted row gets a translucent fill + glowing outline behind the
  // text (rather than just recoloring the text) so the current selection
  // reads clearly even at a glance, plus an Artist/BPM subtext line and (both
  // rows) a best-score line sourced from ScoreStore — "NO RECORD" until that
  // song/difficulty has been cleared once. While isLoading is true (the async
  // audio+chart fetch for the pick is in flight), a flashing full-screen
  // overlay blocks the list from reading as interactive, so mashing
  // Enter/arrows can't queue up a second load.
  drawSongSelectScreen(
    songs: readonly SongManifestEntry[],
    bestScores: readonly (BestScoreEntry | null)[], // same length/order as songs
    selectedIndex: number,
    isLoading: boolean,
    nowMs: number,
    volume: number,
    isMuted: boolean
  ): void {
    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 48px monospace";
    this.ctx.fillText("SELECT SONG", BASE_WIDTH / 2, BASE_HEIGHT * 0.15);

    songs.forEach((song, i) => {
      const rect = getSongSelectRowRect(i, songs.length);
      const y = rect.y + rect.height / 2;
      const isSelected = i === selectedIndex;
      const titleY = isSelected ? y - 24 : y - 12;
      const best = bestScores[i];
      const bestText = best ? `BEST  ${best.grade}  ${Math.floor(best.score)}` : "NO RECORD";

      if (isSelected) {
        this.ctx.save();
        this.ctx.fillStyle = "rgba(57, 246, 255, 0.15)";
        this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.strokeStyle = "#39f6ff";
        this.ctx.lineWidth = 2;
        this.ctx.shadowColor = "#39f6ff";
        this.ctx.shadowBlur = 12;
        this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.restore();
      }

      this.ctx.fillStyle = isSelected ? "#39f6ff" : "#8fe3ff";
      this.ctx.font = isSelected ? "bold 32px monospace" : "26px monospace";
      this.ctx.fillText(song.title, BASE_WIDTH / 2, titleY);

      if (isSelected) {
        this.ctx.font = "18px monospace";
        this.ctx.fillStyle = "#8fe3ff";
        this.ctx.fillText(`${song.artist} • ${song.bpm} BPM`, BASE_WIDTH / 2, y);

        this.ctx.font = "18px monospace";
        this.ctx.fillStyle = best ? "#ffd700" : "rgba(143, 227, 255, 0.4)";
        this.ctx.fillText(bestText, BASE_WIDTH / 2, y + 22);
      } else {
        this.ctx.font = "16px monospace";
        this.ctx.fillStyle = best ? "rgba(143, 227, 255, 0.55)" : "rgba(143, 227, 255, 0.3)";
        this.ctx.fillText(bestText, BASE_WIDTH / 2, y + 15);
      }
    });

    this.ctx.globalAlpha = 0.8;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "20px monospace";
    this.ctx.fillText("↑ / ↓ TO BROWSE   ENTER TO CONTINUE   S SETTINGS   ESC TO GO BACK", BASE_WIDTH / 2, BASE_HEIGHT * 0.85);
    this.ctx.globalAlpha = 1;

    this.drawVolumeBar(VOLUME_BAR_RECT.x, VOLUME_BAR_RECT.y, VOLUME_BAR_RECT.width, VOLUME_BAR_RECT.height, volume, isMuted);

    if (isLoading) {
      this.ctx.fillStyle = "rgba(5, 6, 10, 0.6)";
      this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

      const pulse = (Math.sin(nowMs / 150) + 1) / 2; // fast blink — reads as "busy, don't press anything"
      this.ctx.globalAlpha = 0.55 + pulse * 0.45;
      this.ctx.fillStyle = "#ffe066";
      this.ctx.font = "bold 34px monospace";
      this.ctx.fillText("LOADING TRACK...", BASE_WIDTH / 2, BASE_HEIGHT / 2);
      this.ctx.globalAlpha = 1;
    }

    this.ctx.restore();
  }

  // Difficulty picker between SONG_SELECT and GAMEPLAY, shown only for songs
  // with more than one chart tier. Mirrors drawSongSelectScreen's visual
  // language exactly (selected-row translucent fill + glow outline, dim vs.
  // bright text, per-row "BEST <grade> <score>"/"NO RECORD" line) so the two
  // screens read as one continuous flow rather than a jarring different UI.
  drawDifficultySelectScreen(
    song: SongManifestEntry,
    difficultyNames: readonly string[],
    bestScores: readonly (BestScoreEntry | null)[], // same length/order as difficultyNames
    selectedIndex: number,
    isLoading: boolean,
    nowMs: number,
    volume: number,
    isMuted: boolean
  ): void {
    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 48px monospace";
    this.ctx.fillText("SELECT DIFFICULTY", BASE_WIDTH / 2, BASE_HEIGHT * 0.15);

    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "22px monospace";
    this.ctx.fillText(song.title, BASE_WIDTH / 2, BASE_HEIGHT * 0.15 + 40);

    difficultyNames.forEach((name, i) => {
      const rect = getDifficultySelectRowRect(i, difficultyNames.length);
      const y = rect.y + rect.height / 2;
      const isSelected = i === selectedIndex;
      const nameY = isSelected ? y - 14 : y - 6;
      const best = bestScores[i];
      const bestText = best ? `BEST  ${best.grade}  ${Math.floor(best.score)}` : "NO RECORD";

      if (isSelected) {
        this.ctx.save();
        this.ctx.fillStyle = "rgba(57, 246, 255, 0.15)";
        this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.strokeStyle = "#39f6ff";
        this.ctx.lineWidth = 2;
        this.ctx.shadowColor = "#39f6ff";
        this.ctx.shadowBlur = 12;
        this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        this.ctx.restore();
      }

      this.ctx.fillStyle = isSelected ? "#39f6ff" : "#8fe3ff";
      this.ctx.font = isSelected ? "bold 32px monospace" : "26px monospace";
      this.ctx.fillText(name.toUpperCase(), BASE_WIDTH / 2, nameY);

      if (isSelected) {
        this.ctx.font = "18px monospace";
        this.ctx.fillStyle = best ? "#ffd700" : "rgba(143, 227, 255, 0.4)";
        this.ctx.fillText(bestText, BASE_WIDTH / 2, y + 22);
      } else {
        this.ctx.font = "16px monospace";
        this.ctx.fillStyle = best ? "rgba(143, 227, 255, 0.55)" : "rgba(143, 227, 255, 0.3)";
        this.ctx.fillText(bestText, BASE_WIDTH / 2, y + 15);
      }
    });

    this.ctx.globalAlpha = 0.8;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "20px monospace";
    this.ctx.fillText("↑ / ↓ TO BROWSE   ENTER TO START   ESC TO GO BACK", BASE_WIDTH / 2, BASE_HEIGHT * 0.85);
    this.ctx.globalAlpha = 1;

    this.drawVolumeBar(VOLUME_BAR_RECT.x, VOLUME_BAR_RECT.y, VOLUME_BAR_RECT.width, VOLUME_BAR_RECT.height, volume, isMuted);

    if (isLoading) {
      this.ctx.fillStyle = "rgba(5, 6, 10, 0.6)";
      this.ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

      const pulse = (Math.sin(nowMs / 150) + 1) / 2; // fast blink — reads as "busy, don't press anything"
      this.ctx.globalAlpha = 0.55 + pulse * 0.45;
      this.ctx.fillStyle = "#ffe066";
      this.ctx.font = "bold 34px monospace";
      this.ctx.fillText("LOADING TRACK...", BASE_WIDTH / 2, BASE_HEIGHT / 2);
      this.ctx.globalAlpha = 1;
    }

    this.ctx.restore();
  }

  // Settings screen (opened from SONG_SELECT via KeyS, Escape returns there):
  // currently just the live-adjustable AUDIO_OFFSET_MS override, plus a
  // metronome calibration aid. Matches drawSongSelectScreen's visual language
  // (centered header, monospace, cyan palette) and reuses
  // drawProgressBar/drawVolumeBar's plain track-plus-fill slider style rather
  // than introducing a new one. `pulse` (0..1, from
  // AudioManager.getMetronomePulse — the SAME AudioContext clock the audible
  // tick is scheduled on) drives a flashing beat indicator: the player nudges
  // the offset until the flash they SEE lines up with the click they HEAR.
  drawSettingsScreen(audioOffsetMs: number, nowMs: number, pulse: number): void {
    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    this.ctx.fillStyle = "#e6faff";
    this.ctx.font = "bold 48px monospace";
    this.ctx.fillText("SETTINGS", BASE_WIDTH / 2, BASE_HEIGHT * 0.15);

    // Beat indicator: a filled circle whose alpha/glow track `pulse` directly
    // (bright flash at pulse=1, dark/idle at pulse=0) — sits above the offset
    // controls so it reads as the calibration focal point.
    const beatY = BASE_HEIGHT * 0.26;
    const beatRadius = 40;
    this.ctx.beginPath();
    this.ctx.arc(BASE_WIDTH / 2, beatY, beatRadius, 0, Math.PI * 2);
    this.ctx.fillStyle = "#ffd700";
    this.ctx.globalAlpha = 0.15 + pulse * 0.85;
    this.ctx.shadowColor = "#ffd700";
    this.ctx.shadowBlur = pulse * 30;
    this.ctx.fill();
    this.ctx.shadowBlur = 0;
    this.ctx.globalAlpha = 1;

    const rowY = BASE_HEIGHT * 0.42;
    const sign = audioOffsetMs > 0 ? "+" : "";
    const valueText = `${sign}${audioOffsetMs} ms`;

    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "bold 24px monospace";
    this.ctx.fillText("AUDIO OFFSET", BASE_WIDTH / 2, rowY - 40);

    this.ctx.fillStyle = "#39f6ff";
    this.ctx.font = "bold 32px monospace";
    const idlePulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only, same formula used elsewhere
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 8 + idlePulse * 6;
    this.ctx.fillText(valueText, BASE_WIDTH / 2, rowY);
    this.ctx.shadowBlur = 0;

    // Slider: a plain track-plus-fill bar (same style as drawProgressBar/
    // drawVolumeBar), center = 0, filled from center toward the handle so
    // negative/positive offsets read as "left of center"/"right of center."
    const sliderWidth = 480;
    const sliderHeight = 14;
    const sliderX = BASE_WIDTH / 2 - sliderWidth / 2;
    const sliderY = rowY + 30;
    const range = AUDIO_OFFSET_MAX_MS - AUDIO_OFFSET_MIN_MS;
    const fraction = (audioOffsetMs - AUDIO_OFFSET_MIN_MS) / range; // 0..1 across the full range
    const centerX = sliderX + sliderWidth / 2;
    const handleX = sliderX + sliderWidth * fraction;

    this.ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    this.ctx.fillRect(sliderX, sliderY, sliderWidth, sliderHeight);

    this.ctx.fillStyle = "#39f6ff";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 6;
    this.ctx.fillRect(Math.min(centerX, handleX), sliderY, Math.abs(handleX - centerX), sliderHeight);
    this.ctx.shadowBlur = 0;

    // Handle: a small bright tick at the current value's position on the track.
    const handleWidth = 6;
    this.ctx.fillStyle = "#e6faff";
    this.ctx.fillRect(handleX - handleWidth / 2, sliderY - 6, handleWidth, sliderHeight + 12);

    this.ctx.globalAlpha = 0.8;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "16px monospace";
    this.ctx.fillText("A TICK PLAYS ON THE BEAT — ADJUST UNTIL THE FLASH MATCHES THE SOUND YOU HEAR", BASE_WIDTH / 2, sliderY + 50);
    this.ctx.font = "14px monospace";
    this.ctx.fillText("POSITIVE = NOTES ARRIVE LATER (FOR DELAYED AUDIO)", BASE_WIDTH / 2, sliderY + 74);
    this.ctx.globalAlpha = 1;

    this.ctx.globalAlpha = 0.8;
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.font = "20px monospace";
    this.ctx.fillText("← / → ADJUST     S / ESC TO GO BACK", BASE_WIDTH / 2, BASE_HEIGHT * 0.85);
    this.ctx.globalAlpha = 1;

    this.ctx.restore();
  }

  // Post-game summary. Header communicates pass/fail at a glance (glowing
  // cyan STAGE CLEAR vs. solid crimson STAGE FAILED, isCleared coming from
  // whether life remained above 0 at teardown), the grade sits front and
  // center, and a two-column stats matrix balances judgment counts (left)
  // against the core score metrics (right) around BASE_WIDTH / 2. Below that,
  // a best-score comparison banner (previousBest/isNewBest, from ScoreStore
  // via main.ts's finishGameplay()) fills the gap before the footer prompt —
  // the only way back to the menu now, keyboard-driven (Enter), replacing the
  // old click-to-retry rect entirely.
  drawResultsScreen(
    summary: ResultsSummary,
    isCleared: boolean,
    nowMs: number,
    previousBest: BestScoreEntry | null,
    isNewBest: boolean
  ): void {
    this.ctx.save();
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "alphabetic";

    // Header zone.
    if (isCleared) {
      this.ctx.fillStyle = "#39f6ff";
      this.ctx.shadowColor = "#39f6ff";
      this.ctx.shadowBlur = 24;
      this.ctx.font = "bold 72px monospace";
      this.ctx.fillText("STAGE CLEAR", BASE_WIDTH / 2, BASE_HEIGHT * 0.16);
      this.ctx.shadowBlur = 0;
    } else {
      this.ctx.fillStyle = "#ff1f3d";
      this.ctx.font = "bold 72px monospace";
      this.ctx.fillText("STAGE FAILED", BASE_WIDTH / 2, BASE_HEIGHT * 0.16);
    }

    // Grade.
    this.ctx.fillStyle = JUDGMENT_COLORS.perfect;
    this.ctx.font = "bold 120px monospace";
    this.ctx.shadowColor = JUDGMENT_COLORS.perfect;
    this.ctx.shadowBlur = 20;
    this.ctx.fillText(summary.grade, BASE_WIDTH / 2, BASE_HEIGHT * 0.38);
    this.ctx.shadowBlur = 0;

    // Achievement badge: ALL PERFECT (every hit was a Perfect — strictly
    // stronger) takes priority over FULL COMBO (no misses at all), gold vs.
    // cyan making the tiers visually distinct at a glance. Sits between the
    // grade above and the stats matrix's "JUDGMENTS"/"SUMMARY" header row
    // below, independent of and positioned well clear of the NEW BEST banner
    // further down, so both can show at once without overlapping.
    if (summary.isAllPerfect) {
      const badgePulse = (Math.sin(nowMs / 300) + 1) / 2;
      this.ctx.globalAlpha = 0.55 + badgePulse * 0.45;
      this.ctx.fillStyle = "#ffd700";
      this.ctx.shadowColor = "#ffd700";
      this.ctx.shadowBlur = 16;
      this.ctx.font = "bold 30px monospace";
      this.ctx.fillText("ALL PERFECT", BASE_WIDTH / 2, BASE_HEIGHT * 0.44);
      this.ctx.shadowBlur = 0;
      this.ctx.globalAlpha = 1;
    } else if (summary.isFullCombo) {
      const badgePulse = (Math.sin(nowMs / 300) + 1) / 2;
      this.ctx.globalAlpha = 0.55 + badgePulse * 0.45;
      this.ctx.fillStyle = "#39f6ff";
      this.ctx.shadowColor = "#39f6ff";
      this.ctx.shadowBlur = 16;
      this.ctx.font = "bold 30px monospace";
      this.ctx.fillText("FULL COMBO", BASE_WIDTH / 2, BASE_HEIGHT * 0.44);
      this.ctx.shadowBlur = 0;
      this.ctx.globalAlpha = 1;
    }

    // Stats matrix: judgment counts on the left, core metrics on the right,
    // each column's text anchored an equal distance from center.
    const colOffset = 120;
    const leftX = BASE_WIDTH / 2 - colOffset;
    const rightX = BASE_WIDTH / 2 + colOffset;
    const rowStartY = BASE_HEIGHT * 0.52;
    const rowStep = 42;

    this.ctx.textAlign = "right";
    this.ctx.font = "bold 20px monospace";
    this.ctx.fillStyle = "#e6faff";
    this.ctx.fillText("JUDGMENTS", leftX, rowStartY - rowStep);
    this.ctx.font = "22px monospace";
    this.ctx.fillStyle = JUDGMENT_COLORS.perfect;
    this.ctx.fillText(`PERFECT   ${summary.perfectCount}`, leftX, rowStartY);
    this.ctx.fillStyle = JUDGMENT_COLORS.good;
    this.ctx.fillText(`GOOD      ${summary.goodCount}`, leftX, rowStartY + rowStep);
    this.ctx.fillStyle = JUDGMENT_COLORS.early;
    this.ctx.fillText(`EARLY     ${summary.earlyCount}`, leftX, rowStartY + rowStep * 2);
    this.ctx.fillStyle = JUDGMENT_COLORS.late;
    this.ctx.fillText(`LATE      ${summary.lateCount}`, leftX, rowStartY + rowStep * 3);
    this.ctx.fillStyle = JUDGMENT_COLORS.miss;
    this.ctx.fillText(`MISS      ${summary.missCount}`, leftX, rowStartY + rowStep * 4);

    this.ctx.textAlign = "left";
    this.ctx.font = "bold 20px monospace";
    this.ctx.fillStyle = "#e6faff";
    this.ctx.fillText("SUMMARY", rightX, rowStartY - rowStep);
    this.ctx.font = "22px monospace";
    this.ctx.fillStyle = "#e6faff";
    this.ctx.fillText(`SCORE     ${Math.floor(summary.score)}`, rightX, rowStartY);
    this.ctx.fillStyle = "#8fe3ff";
    this.ctx.fillText(`MAX COMBO ${summary.maxCombo}`, rightX, rowStartY + rowStep);
    this.ctx.fillText(`ACCURACY  ${summary.accuracy.toFixed(2)}%`, rightX, rowStartY + rowStep * 2);

    // Best-score comparison banner: fills the gap between the stat matrix and
    // the footer prompt. isNewBest covers both beating a real previous run
    // AND a song/difficulty's first-ever clear (ScoreStore.updateBestScore
    // always writes when no prior entry exists) — previousBest is only null
    // in that first-clear case.
    this.ctx.textAlign = "center";
    if (isNewBest) {
      const bannerPulse = (Math.sin(nowMs / 300) + 1) / 2;
      this.ctx.globalAlpha = 0.55 + bannerPulse * 0.45;
      this.ctx.fillStyle = "#ffd700";
      this.ctx.shadowColor = "#ffd700";
      this.ctx.shadowBlur = 16;
      this.ctx.font = "bold 30px monospace";
      this.ctx.fillText("NEW BEST SCORE!", BASE_WIDTH / 2, BASE_HEIGHT * 0.78);
      this.ctx.shadowBlur = 0;
      this.ctx.globalAlpha = 1;

      this.ctx.font = "18px monospace";
      this.ctx.fillStyle = "#8fe3ff";
      const subline = previousBest
        ? `PREVIOUS BEST: ${previousBest.grade}  ${Math.floor(previousBest.score)}`
        : "FIRST CLEAR!";
      this.ctx.fillText(subline, BASE_WIDTH / 2, BASE_HEIGHT * 0.815);
    } else if (previousBest) {
      this.ctx.font = "20px monospace";
      this.ctx.fillStyle = "#8fe3ff";
      this.ctx.fillText(`BEST: ${previousBest.grade}  ${Math.floor(previousBest.score)}`, BASE_WIDTH / 2, BASE_HEIGHT * 0.8);
    }

    // Interactive footer: pulsing prompt, sine wave on nowMs.
    this.ctx.textAlign = "center";
    const pulse = (Math.sin(nowMs / 300) + 1) / 2; // 0..1 idle pulse, cosmetic-only
    this.ctx.globalAlpha = 0.55 + pulse * 0.45;
    this.ctx.fillStyle = "#39f6ff";
    this.ctx.shadowColor = "#39f6ff";
    this.ctx.shadowBlur = 14;
    this.ctx.font = "bold 26px monospace";
    this.ctx.fillText("PRESS ENTER TO RETURN TO MAIN MENU", BASE_WIDTH / 2, BASE_HEIGHT * 0.88);

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
