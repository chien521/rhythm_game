import { AudioManager } from "./core/AudioManager";
import { ChartManager } from "./core/ChartManager";
import { getHighScore, updateHighScore } from "./core/HighScoreStore";
import { InputManager } from "./core/InputManager";
import { ScoreManager } from "./core/ScoreManager";
import { HitParticle, JudgmentDisplay, KeyFlash, Renderer, getPauseMenuRowRect, getSongSelectRowRect, UiRect } from "./render/Renderer";
import { computeViewport } from "./core/Viewport";
import {
  AUDIO_OFFSET_MS,
  BASE_HEIGHT,
  BASE_WIDTH,
  ChartData,
  GameState,
  INPUT_LATENCY_MS,
  JUDGMENT_TEXT_DURATION_MS,
  KEY_FLASH_DURATION_MS,
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  PARTICLE_LIFESPAN_MS,
  SongManifest,
  STATE_FADE_DURATION_MS,
  VOLUME_BAR_RECT,
  VOLUME_ICON_WIDTH,
  VOLUME_STEP
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
let recordingSongId: string | null = null; // manifest id of the song currently being recorded, for the export filename/title
let songManifest: SongManifest = []; // loaded once from /songs.json, before TITLE
let selectedSongIndex = 0; // currently highlighted row in SONG_SELECT
let loadingSelectedSong = false; // guards against a repeated Enter re-firing the async load
let pauseMenuIndex = 0; // 0 = Restart, 1 = Back to Menu — currently highlighted row in the PAUSED overlay, driven by keyboard AND mouse hover alike
let isDraggingVolume = false; // true while the mouse button is held down on the volume level bar

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

// Menu clicks (TITLE -> SONG_SELECT, volume-icon click-to-mute) stay
// pointer-driven — gameplay itself is keyboard-only now, but a mouse/touch
// gesture is still what's allowed to unlock the AudioContext, and it's the
// natural way to click through a menu.
function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const viewport = computeViewport(rect.width, rect.height);
  return {
    x: (clientX - rect.left - viewport.offsetX) / viewport.width,
    y: (clientY - rect.top - viewport.offsetY) / viewport.height
  };
}

async function loadChart(url: string): Promise<ChartData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load chart: ${url} (${res.status})`);
  return res.json();
}

async function loadSongManifest(url: string): Promise<SongManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load song manifest: ${url} (${res.status})`);
  return res.json();
}

// Fires immediately on script launch. Only the (small) manifest is fetched up
// front — each song's actual audio/chart is loaded lazily in startSelectedSong(),
// once the player picks it in SONG_SELECT, so adding songs never inflates the
// initial load.
async function loadAssets(): Promise<void> {
  songManifest = await loadSongManifest("/songs.json");
  setState("TITLE");
}
void loadAssets().catch((err: unknown) => {
  console.error("Asset loading failed:", err);
});

// Shared by the first SONG_SELECT -> GAMEPLAY transition and every RESULTS -> GAMEPLAY retry.
function beginGameplay(): void {
  if (!chartData) return; // guards against a click racing ahead of startSelectedSong(), shouldn't happen once past SONG_SELECT

  chartManager.loadChart(chartData);
  scoreManager.reset();
  judgmentTexts = [];
  hitParticles = [];
  keyFlashes = [];
  comboChangedAt = 0;
  audioManager.restart(); // first call here also resumes the AudioContext — inside this gesture handler
  setState("GAMEPLAY");
}

// Loads the currently-highlighted manifest entry's score + first difficulty
// chart, then hands off to beginGameplay(). Guarded by loadingSelectedSong so
// holding/mashing Enter can't fire overlapping loads. (The first score load
// also fetches/decodes the shared piano samples — cached for every song after.)
async function startSelectedSong(): Promise<void> {
  if (loadingSelectedSong) return;
  const song = songManifest[selectedSongIndex];
  const chartPath = song ? Object.values(song.charts)[0] : undefined;
  if (!song || !chartPath) return;

  loadingSelectedSong = true;
  try {
    const [chart] = await Promise.all([loadChart(chartPath), audioManager.loadScore(song.scoreUrl)]);
    chartData = chart;
    beginGameplay();
  } catch (err) {
    console.error(`Failed to load song "${song.id}":`, err);
  } finally {
    loadingSelectedSong = false;
  }
}

function finishGameplay(): void {
  audioManager.pause();
  updateHighScore(scoreManager.score);
  setState("RESULTS");
}

// Shared by PAUSED's Enter keydown handler and its mouse-click equivalent, so
// keyboard and mouse can never drift into executing different logic for the
// "same" option. index 0 = Restart, 1 = Back to Menu.
function activatePauseMenuOption(index: number): void {
  if (index === 0) {
    beginGameplay(); // re-loads chartData fresh and calls audioManager.restart(), which resets to 0ms and plays
  } else {
    audioManager.pause(); // stop the audio; the next startSelectedSong() call resets position via loadAudioFile()/restart()
    setState("SONG_SELECT");
  }
}

// Shared by RESULTS' Enter keydown handler and its mouse-click equivalent.
function returnToTitleFromResults(): void {
  scoreManager.reset();
  setState("TITLE");
}

// Developer hotkey entry point. Scoped to SONG_SELECT (not TITLE, which has
// nothing preloaded — TITLE would crash on audioManager.restart() with no
// score loaded). Loads the currently-highlighted song's REAL score first via
// loadScore(), so recording always happens against the exact performance that
// song's chart needs to end up synced to. Guarded by loadingSelectedSong so
// mashing 'R' can't fire overlapping loads.
async function enterRecordingMode(): Promise<void> {
  if (loadingSelectedSong) return;
  const song = songManifest[selectedSongIndex];
  if (!song) return;

  loadingSelectedSong = true;
  try {
    await audioManager.loadScore(song.scoreUrl);
    recordingSongId = song.id;
    recordedNotes = [];
    keyFlashes = [];
    audioManager.restart(); // first call here also resumes the AudioContext — inside this gesture handler
    setState("RECORDING");
  } catch (err) {
    console.error(`Failed to load score for recording "${song.id}":`, err);
  } finally {
    loadingSelectedSong = false;
  }
}

// Stops on Escape or natural track-end (checked in frame()). Compiles the
// captured taps into a chart JSON, logs it, triggers a download named after
// the song that was just recorded (e.g. gymnopedie.json), and returns to
// SONG_SELECT — drop the downloaded file straight into public/charts/.
function stopRecordingAndExport(): void {
  const songLengthMs = Math.round(getEffectiveSongTime());
  audioManager.pause();

  const recordedSong = songManifest.find((s) => s.id === recordingSongId);
  const chart: ChartData = {
    meta: {
      title: recordedSong?.title ?? recordingSongId ?? "Recorded Chart",
      bpm: recordedSong?.bpm ?? 120,
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
  link.download = `${recordingSongId ?? "chart"}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  recordedNotes = [];
  recordingSongId = null;
  setState("SONG_SELECT");
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

// Generic axis-aligned hit-test against a UiRect (logical BASE_WIDTH/HEIGHT
// space) — shared by every mouse interaction below, so "is this point inside
// that rect" is defined exactly once.
function isInsideRect(px: number, py: number, rect: UiRect): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// The volume icon ("VOL" label / mute toggle) occupies the left VOLUME_ICON_WIDTH
// of VOLUME_BAR_RECT; the rest is the draggable/clickable level bar.
function getVolumeIconRect(): UiRect {
  return { x: VOLUME_BAR_RECT.x, y: VOLUME_BAR_RECT.y, width: VOLUME_ICON_WIDTH, height: VOLUME_BAR_RECT.height };
}
function getVolumeLevelRect(): UiRect {
  return {
    x: VOLUME_BAR_RECT.x + VOLUME_ICON_WIDTH,
    y: VOLUME_BAR_RECT.y,
    width: VOLUME_BAR_RECT.width - VOLUME_ICON_WIDTH,
    height: VOLUME_BAR_RECT.height
  };
}

// Sets volume proportionally to where px falls along the level bar — click
// jumps straight to that level, and (per isDraggingVolume in pointermove)
// dragging continues updating it live.
function setVolumeFromBarX(px: number): void {
  const rect = getVolumeLevelRect();
  audioManager.setVolume(clamp01((px - rect.x) / rect.width));
}

// Converts a pointer event's client coords into logical BASE_WIDTH/HEIGHT px,
// the same space every UiRect (song rows, pause rows, volume bar) is defined in.
function pointerToLogicalPx(e: PointerEvent): { px: number; py: number } {
  const { x, y } = clientToNormalized(e.clientX, e.clientY);
  return { px: x * BASE_WIDTH, py: y * BASE_HEIGHT };
}

canvas.addEventListener("pointerdown", (e) => {
  if (pausedByFocusLoss) {
    resumeFromFocusLoss();
    return;
  }

  const { px, py } = pointerToLogicalPx(e);

  if (currentState === "SONG_SELECT" || currentState === "PAUSED") {
    if (isInsideRect(px, py, getVolumeIconRect())) {
      audioManager.toggleMute();
      return;
    }
    if (isInsideRect(px, py, getVolumeLevelRect())) {
      isDraggingVolume = true;
      setVolumeFromBarX(px);
      return;
    }
  }

  if (currentState === "SONG_SELECT" && !loadingSelectedSong && songManifest.length > 0) {
    for (let i = 0; i < songManifest.length; i++) {
      if (isInsideRect(px, py, getSongSelectRowRect(i, songManifest.length))) {
        selectedSongIndex = i;
        void startSelectedSong();
        return;
      }
    }
  } else if (currentState === "PAUSED") {
    for (let i = 0; i < 2; i++) {
      if (isInsideRect(px, py, getPauseMenuRowRect(i))) {
        pauseMenuIndex = i;
        activatePauseMenuOption(i);
        return;
      }
    }
  } else if (currentState === "RESULTS") {
    // Only one possible action here, same as TITLE below — any click anywhere
    // on the results screen returns to the menu, matching the existing
    // whole-canvas-click convention rather than requiring a precise hit on the
    // (already pulsing, already implied-clickable) footer prompt text.
    returnToTitleFromResults();
    return;
  }

  if (currentState === "TITLE") {
    selectedSongIndex = 0;
    setState("SONG_SELECT");
  }
});

// Mouse hover drives the exact same selection state arrow keys do — not a
// separate "hovered" concept — so hovering an item then pressing Enter acts
// on it, and the existing selected-row highlight doubles as hover feedback
// with no new visual state needed.
canvas.addEventListener("pointermove", (e) => {
  const { px, py } = pointerToLogicalPx(e);

  if (isDraggingVolume) {
    setVolumeFromBarX(px);
    return;
  }

  if (currentState === "SONG_SELECT" && !loadingSelectedSong && songManifest.length > 0) {
    for (let i = 0; i < songManifest.length; i++) {
      if (isInsideRect(px, py, getSongSelectRowRect(i, songManifest.length))) {
        selectedSongIndex = i;
        break;
      }
    }
  } else if (currentState === "PAUSED") {
    for (let i = 0; i < 2; i++) {
      if (isInsideRect(px, py, getPauseMenuRowRect(i))) {
        pauseMenuIndex = i;
        break;
      }
    }
  }
});

// Ends a volume-bar drag no matter where the pointer is released (including
// outside the canvas entirely) — listening on window, not canvas, for that.
window.addEventListener("pointerup", () => {
  isDraggingVolume = false;
});

inputManager.onLaneDown((lane) => {
  if (pausedByFocusLoss) return; // swallowed by the capture-phase resume listener below
  if (currentState === "GAMEPLAY") {
    const songTimeMs = getEffectiveSongTime();
    keyFlashes.push({ lane, time: songTimeMs }); // flash reflects the real moment of the press, unaffected by input-latency calibration
    chartManager.registerKeyDown(lane, songTimeMs - INPUT_LATENCY_MS); // only the judgment timestamp is nudged
  } else if (currentState === "RECORDING") {
    const songTimeMs = getEffectiveSongTime();
    keyFlashes.push({ lane, time: songTimeMs }); // same capture-confirmation flash as gameplay
    recordedNotes.push({ time: Math.round(songTimeMs), lane, type: "tap" });
  }
});

// Developer hotkeys: Escape stops an active recording session (KeyR now lives
// in the SONG_SELECT listener below, since it needs that song's real audio
// loaded first).
window.addEventListener("keydown", (e) => {
  if (e.code === "Escape" && currentState === "RECORDING") {
    e.preventDefault();
    stopRecordingAndExport();
  } else if (e.code === "Enter" && currentState === "RESULTS") {
    e.preventDefault();
    returnToTitleFromResults();
  } else if (e.code === "Enter" && currentState === "TITLE") {
    e.preventDefault();
    selectedSongIndex = 0;
    setState("SONG_SELECT");
  }
});

// SONG_SELECT navigation: Up/Down move the highlighted row, Enter loads that
// song's audio + chart (async) and hands off to GAMEPLAY, Escape backs out to
// TITLE. Ignored entirely while loadingSelectedSong is true, so a load in
// flight can't be interrupted or double-triggered by mashing keys.
//
// Input Bleedthrough guard: TITLE's own Enter handler (above) and this one are
// both "keydown" listeners on window, so the very keydown that flips TITLE ->
// SONG_SELECT is still dispatching when this listener runs immediately after
// — currentState has already changed, so without a guard this same keypress
// would instantly fire startSelectedSong(). transitionStartMs is set by
// setState() at the moment of that transition, so ignoring input for
// STATE_FADE_DURATION_MS after entering the state filters out that bled-through
// event while still feeling instant to a real, separate keypress.
window.addEventListener("keydown", (e) => {
  if (currentState !== "SONG_SELECT" || loadingSelectedSong) return;
  if (performance.now() - transitionStartMs < STATE_FADE_DURATION_MS) return;

  if (e.code === "ArrowUp") {
    e.preventDefault();
    if (songManifest.length > 0) {
      selectedSongIndex = (selectedSongIndex - 1 + songManifest.length) % songManifest.length;
    }
  } else if (e.code === "ArrowDown") {
    e.preventDefault();
    if (songManifest.length > 0) {
      selectedSongIndex = (selectedSongIndex + 1) % songManifest.length;
    }
  } else if (e.code === "Enter") {
    e.preventDefault();
    void startSelectedSong();
  } else if (e.code === "Escape") {
    e.preventDefault();
    setState("TITLE");
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    audioManager.setVolume(audioManager.volume - VOLUME_STEP);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    audioManager.setVolume(audioManager.volume + VOLUME_STEP);
  } else if (e.code === "KeyM") {
    e.preventDefault();
    audioManager.toggleMute();
  } else if (e.code === "KeyR") {
    e.preventDefault();
    void enterRecordingMode(); // records against whichever song is currently highlighted
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
    audioManager.pause(); // freezes the audio clock; getEffectiveSongTime() then returns the same value every frame
    pauseMenuIndex = 0;
    setState("PAUSED");
  } else if (e.code === "Space" && currentState === "PAUSED") {
    e.preventDefault();
    audioManager.play(); // resumes from exactly where it froze — no time-skip, AudioManager already handles this
    setState("GAMEPLAY");
  }
});

// PAUSED menu: Up/Down move the highlighted option, Enter confirms it.
// Restart re-initializes the current song/chart from 0ms (beginGameplay()
// already does exactly this). Back to Menu stops the audio and returns to
// SONG_SELECT — guarded by the same transitionStartMs/STATE_FADE_DURATION_MS
// debounce pattern used for SONG_SELECT's own listener, so this same Enter
// keydown can't also bleed through into SONG_SELECT's Enter handler once
// currentState flips.
window.addEventListener("keydown", (e) => {
  if (currentState !== "PAUSED") return;

  if (e.code === "ArrowUp") {
    e.preventDefault();
    pauseMenuIndex = (pauseMenuIndex + 1) % 2; // only 2 options, so up/down both just toggle between them
  } else if (e.code === "ArrowDown") {
    e.preventDefault();
    pauseMenuIndex = (pauseMenuIndex + 1) % 2;
  } else if (e.code === "Enter") {
    e.preventDefault();
    activatePauseMenuOption(pauseMenuIndex);
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    audioManager.setVolume(audioManager.volume - VOLUME_STEP);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    audioManager.setVolume(audioManager.volume + VOLUME_STEP);
  } else if (e.code === "KeyM") {
    e.preventDefault();
    audioManager.toggleMute();
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
  } else if (currentState === "SONG_SELECT") {
    renderer.clear();
    renderer.drawSongSelectScreen(
      songManifest,
      selectedSongIndex,
      loadingSelectedSong,
      nowMs,
      audioManager.volume,
      audioManager.isMuted
    );
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
    renderer.drawNotes(chartManager.getActiveNotes(), songTimeMs, chartManager.getNoteVelocity());
    renderer.drawParticles(hitParticles, songTimeMs);
    renderer.drawJudgmentText(judgmentTexts, songTimeMs);
    renderer.drawHud(scoreManager.score, scoreManager.combo, comboChangedAt, songTimeMs);
    renderer.drawDebug(songTimeMs, audioManager.playing);
    renderer.endShake(shakeActive);

    if (pausedByFocusLoss) {
      renderer.drawResumePrompt(nowMs);
    }

    // The song always plays to its natural end — there is no fail/sudden-death
    // state, so this is the only way GAMEPLAY ever transitions onward.
    if (chartManager.isComplete(songTimeMs)) {
      finishGameplay();
    }
  } else if (currentState === "PAUSED") {
    // audioManager is genuinely paused here, so getEffectiveSongTime() returns
    // the same frozen value every call — no separate "cached songTimeMs"
    // variable needed, and chartManager.update() is deliberately never called
    // in this branch, so no note can be judged/missed while the menu is open.
    const songTimeMs = getEffectiveSongTime();

    renderer.clear();
    renderer.drawLanes(inputManager.getHeldLanes(), songTimeMs, keyFlashes);
    renderer.drawNotes(chartManager.getActiveNotes(), songTimeMs, chartManager.getNoteVelocity());
    renderer.drawParticles(hitParticles, songTimeMs);
    renderer.drawJudgmentText(judgmentTexts, songTimeMs);
    renderer.drawHud(scoreManager.score, scoreManager.combo, comboChangedAt, songTimeMs);
    renderer.drawPauseMenu(pauseMenuIndex, nowMs, audioManager.volume, audioManager.isMuted);
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
    renderer.drawResultsScreen(
      {
        score: scoreManager.score,
        maxCombo: scoreManager.maxCombo,
        perfectCount: scoreManager.perfectCount,
        goodCount: scoreManager.goodCount,
        earlyCount: scoreManager.earlyCount,
        lateCount: scoreManager.lateCount,
        missCount: scoreManager.missCount,
        accuracy: scoreManager.getAccuracy(),
        grade: scoreManager.getGrade()
      },
      true, // isCleared: there's no fail state anymore, every run that reaches RESULTS cleared the song
      nowMs
    );
  }

  renderer.drawStateFade(transitionStartMs, nowMs);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
