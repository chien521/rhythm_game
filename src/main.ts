import { AudioManager } from "./core/AudioManager";
import { ChartManager } from "./core/ChartManager";
import { getHighScore, updateHighScore } from "./core/HighScoreStore";
import { InputManager } from "./core/InputManager";
import { ScoreManager } from "./core/ScoreManager";
import { HitParticle, JudgmentDisplay, KeyFlash, Renderer } from "./render/Renderer";
import { computeViewport } from "./core/Viewport";
import {
  AUDIO_OFFSET_MS,
  BASE_HEIGHT,
  BASE_WIDTH,
  ChartData,
  GameState,
  JUDGMENT_TEXT_DURATION_MS,
  KEY_FLASH_DURATION_MS,
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  PARTICLE_LIFESPAN_MS,
  RETRY_BUTTON_RECT
} from "./config/constants";

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

const renderer = new Renderer(canvas);
const audioManager = new AudioManager();
const chartManager = new ChartManager();
const inputManager = new InputManager();
const scoreManager = new ScoreManager();

let currentState: GameState = "LOADING";
let transitionStartMs = performance.now();
let chartData: ChartData | null = null;
let judgmentTexts: JudgmentDisplay[] = [];
let hitParticles: HitParticle[] = [];
let keyFlashes: KeyFlash[] = [];
let comboChangedAt = 0; // songTimeMs the combo last incremented, drives the HUD scale-pop
let shakeThisFrame = false; // set on a Perfect judgment, consumed by the very next frame() call
let pausedByFocusLoss = false; // true only while showing the "click/press a key to resume" prompt
let recordedNotes: Array<{ time: number; lane: number; type: "tap" }> = []; // Recording Mode capture buffer

function setState(state: GameState): void {
  currentState = state;
  transitionStartMs = performance.now();
}

// Calibrated gameplay clock: actual audio output can reach the player's ears
// some ms after the Web Audio clock thinks playback started. All gameplay
// logic and rendering reads this, never audioManager.getSongTime() directly,
// so a single constant tunes sync without touching hit-detection or draw code.
function getEffectiveSongTime(): number {
  return audioManager.getSongTime() - AUDIO_OFFSET_MS;
}

// Dev-only hook for driving/inspecting exact songTimeMs and state from test harnesses.
// import.meta.env.DEV is a compile-time constant, so this is dead-code-eliminated in prod builds.
if (import.meta.env.DEV) {
  (window as unknown as { __debug: unknown }).__debug = {
    audioManager,
    chartManager,
    scoreManager,
    inputManager,
    getState: () => currentState,
    getEffectiveSongTime,
    getRecordedNotes: () => recordedNotes
  };
}

chartManager.onJudgment((event) => {
  scoreManager.registerJudgment(event.judgment);
  judgmentTexts.push({ lane: event.lane, judgment: event.judgment, time: event.time });

  if (event.judgment !== "miss") {
    comboChangedAt = event.time;

    const count = PARTICLE_COUNT_MIN + Math.floor(Math.random() * (PARTICLE_COUNT_MAX - PARTICLE_COUNT_MIN + 1));
    for (let i = 0; i < count; i++) {
      hitParticles.push({
        lane: event.lane,
        angle: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.5,
        judgment: event.judgment,
        time: event.time
      });
    }
  }

  if (event.judgment === "perfect") {
    shakeThisFrame = true;
  }
});

// Menu clicks (TITLE start / RESULTS retry) stay pointer-driven — gameplay
// itself is keyboard-only now, but a mouse/touch gesture is still what's
// allowed to unlock the AudioContext, and it's the natural way to click "Retry".
function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const viewport = computeViewport(rect.width, rect.height);
  return {
    x: (clientX - rect.left - viewport.offsetX) / viewport.width,
    y: (clientY - rect.top - viewport.offsetY) / viewport.height
  };
}

function isInRetryButton(normX: number, normY: number): boolean {
  const px = normX * BASE_WIDTH;
  const py = normY * BASE_HEIGHT;
  const r = RETRY_BUTTON_RECT;
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

async function loadChart(url: string): Promise<ChartData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load chart: ${url} (${res.status})`);
  return res.json();
}

// Fires immediately on script launch — fetching/decoding the audio file and
// the chart JSON need no user gesture, only actually starting playback does.
async function loadAssets(): Promise<void> {
  const [chart] = await Promise.all([loadChart("/charts/demo.json"), audioManager.loadAudioFile("/audio/track.wav")]);
  chartData = chart;
  setState("TITLE");
}
void loadAssets().catch((err: unknown) => {
  console.error("Asset loading failed:", err);
});

// Shared by the first TITLE -> GAMEPLAY transition and every RESULTS -> GAMEPLAY retry.
function beginGameplay(): void {
  if (!chartData) return; // guards against a click racing ahead of loadAssets(), shouldn't happen once past LOADING

  chartManager.loadChart(chartData);
  scoreManager.reset();
  judgmentTexts = [];
  hitParticles = [];
  keyFlashes = [];
  comboChangedAt = 0;
  audioManager.restart(); // first call here also resumes the AudioContext — inside this gesture handler
  setState("GAMEPLAY");
}

function finishGameplay(): void {
  audioManager.pause();
  updateHighScore(scoreManager.score);
  setState("RESULTS");
}

// Developer hotkey entry point, from TITLE only. restart() both satisfies
// "start the audio track" and guarantees recording always begins from t=0,
// even if a previous playthrough left the track mid-song.
function enterRecordingMode(): void {
  recordedNotes = [];
  keyFlashes = [];
  audioManager.restart();
  setState("RECORDING");
}

// Stops on Escape or natural track-end (checked in frame()). Compiles the
// captured taps into a chart JSON, logs it, triggers a chart.json download,
// and returns to TITLE.
function stopRecordingAndExport(): void {
  const songLengthMs = Math.round(getEffectiveSongTime());
  audioManager.pause();

  const chart: ChartData = {
    meta: {
      title: "Recorded Chart",
      bpm: chartData?.meta.bpm ?? 120,
      songLengthMs
    },
    notes: recordedNotes.map((note, i) => ({
      id: `r${i + 1}`,
      time: note.time,
      x: note.lane,
      type: note.type
    }))
  };

  const json = JSON.stringify(chart, null, 2);
  console.log(json);

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "chart.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  recordedNotes = [];
  setState("TITLE");
}

// Auto-pause used by both the window blur handler and the Page Visibility
// fallback (some mobile/XR browsers signal backgrounding via visibility
// changes rather than blur). Only ever pauses — resuming is always explicit.
function handleAutoPause(): void {
  if (currentState === "GAMEPLAY" && audioManager.playing) {
    audioManager.pause();
    pausedByFocusLoss = true;
  }
}

// Deliberately the only way out of pausedByFocusLoss — never automatic, so
// regaining window focus can't jump-scare the player back into gameplay.
function resumeFromFocusLoss(): void {
  pausedByFocusLoss = false;
  audioManager.play();
}

window.addEventListener("blur", handleAutoPause);
window.addEventListener("focus", () => {
  // Intentionally does nothing beyond this comment: we do NOT auto-resume on
  // refocus. If pausedByFocusLoss is set, the prompt stays up until the
  // player explicitly clicks or presses a key.
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") handleAutoPause();
});

canvas.addEventListener("pointerdown", (e) => {
  if (pausedByFocusLoss) {
    resumeFromFocusLoss();
    return;
  }
  if (currentState === "TITLE") {
    beginGameplay();
  } else if (currentState === "RESULTS") {
    const { x, y } = clientToNormalized(e.clientX, e.clientY);
    if (isInRetryButton(x, y)) beginGameplay();
  }
});

inputManager.onLaneDown((lane) => {
  if (pausedByFocusLoss) return; // swallowed by the capture-phase resume listener below
  if (currentState === "GAMEPLAY") {
    const songTimeMs = getEffectiveSongTime();
    keyFlashes.push({ lane, time: songTimeMs }); // flashes on every press, hit or not
    chartManager.registerKeyDown(lane, songTimeMs);
  } else if (currentState === "RECORDING") {
    const songTimeMs = getEffectiveSongTime();
    keyFlashes.push({ lane, time: songTimeMs }); // same capture-confirmation flash as gameplay
    recordedNotes.push({ time: Math.round(songTimeMs), lane, type: "tap" });
  }
});

// Developer hotkeys: 'R' on TITLE starts a recording session, Escape stops one.
// KeyR happens to also be lane 3's gameplay key (InputManager's own listener
// still fires for it harmlessly on TITLE, since onLaneDown above has no
// TITLE branch); this listener is what actually triggers the mode switch.
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR" && currentState === "TITLE") {
    e.preventDefault();
    enterRecordingMode();
  } else if (e.code === "Escape" && currentState === "RECORDING") {
    e.preventDefault();
    stopRecordingAndExport();
  }
});

// Capture phase + stopImmediatePropagation so a "wake up" keypress resumes
// from the focus-loss prompt without also being processed as a lane hit by
// InputManager's own (bubble-phase) keydown listener, or as a pause toggle below.
window.addEventListener(
  "keydown",
  (e) => {
    if (pausedByFocusLoss) {
      e.preventDefault();
      e.stopImmediatePropagation();
      resumeFromFocusLoss();
    }
  },
  { capture: true }
);

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && currentState === "GAMEPLAY") {
    e.preventDefault();
    audioManager.togglePlayPause();
  }
});

function frame(): void {
  const nowMs = performance.now();

  if (currentState === "LOADING") {
    renderer.clear();
    renderer.drawLoadingScreen(nowMs);
  } else if (currentState === "TITLE") {
    renderer.clear();
    renderer.drawTitleScreen(getHighScore(), nowMs);
  } else if (currentState === "GAMEPLAY") {
    const songTimeMs = getEffectiveSongTime();
    chartManager.update(songTimeMs, inputManager.getHeldLanes());
    judgmentTexts = judgmentTexts.filter((j) => songTimeMs - j.time <= JUDGMENT_TEXT_DURATION_MS);
    hitParticles = hitParticles.filter((p) => songTimeMs - p.time <= PARTICLE_LIFESPAN_MS);
    keyFlashes = keyFlashes.filter((f) => songTimeMs - f.time <= KEY_FLASH_DURATION_MS);

    const shakeActive = shakeThisFrame;
    shakeThisFrame = false; // consumed immediately so it only ever applies for exactly one frame() call

    renderer.clear();
    renderer.beginShake(shakeActive);
    renderer.drawLanes(inputManager.getHeldLanes(), songTimeMs, keyFlashes);
    renderer.drawNotes(chartManager.getActiveNotes(), songTimeMs);
    renderer.drawParticles(hitParticles, songTimeMs);
    renderer.drawJudgmentText(judgmentTexts, songTimeMs);
    renderer.drawHud(scoreManager.score, scoreManager.combo, comboChangedAt, songTimeMs);
    renderer.drawDebug(songTimeMs, audioManager.playing);
    renderer.endShake(shakeActive);

    if (pausedByFocusLoss) {
      renderer.drawResumePrompt(nowMs);
    }

    if (chartManager.isComplete(songTimeMs)) {
      finishGameplay();
    }
  } else if (currentState === "RECORDING") {
    const songTimeMs = getEffectiveSongTime();
    keyFlashes = keyFlashes.filter((f) => songTimeMs - f.time <= KEY_FLASH_DURATION_MS);

    renderer.clear();
    renderer.drawLanes(inputManager.getHeldLanes(), songTimeMs, keyFlashes);
    renderer.drawRecordingHud(songTimeMs, audioManager.getDuration(), recordedNotes.length, nowMs);

    if (songTimeMs >= audioManager.getDuration()) {
      stopRecordingAndExport();
    }
  } else if (currentState === "RESULTS") {
    renderer.clear();
    renderer.drawResultsScreen({
      score: scoreManager.score,
      maxCombo: scoreManager.maxCombo,
      perfectCount: scoreManager.perfectCount,
      goodCount: scoreManager.goodCount,
      missCount: scoreManager.missCount,
      accuracy: scoreManager.getAccuracy(),
      grade: scoreManager.getGrade()
    });
  }

  renderer.drawStateFade(transitionStartMs, nowMs);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
