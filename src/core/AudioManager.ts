import { ScoreData, ScoreNote } from "../config/constants";
import { PianoSynth } from "./PianoSynth";

// Core timekeeper. All game/render timing must read from getSongTime() —
// never from performance.now()/requestAnimationFrame deltas — so visuals stay
// audio-clock locked and pause/resume is instant with zero drift.
//
// Playback is not a decoded audio file: the game itself performs the song.
// loadScore() fetches a score JSON (the same single source of truth its chart
// was generated from) and play() hands the note list to PianoSynth, which
// schedules every note at an exact AudioContext timestamp derived from the
// same startContextTime anchor getSongTime() reads. One clock, one note list
// — audio/chart drift is impossible by construction.

// Extra ms past the last note onset covered by getDuration(), so Recording
// Mode's natural-end detection doesn't cut off the final note's decay.
const DURATION_TAIL_MS = 1000;

// SETTINGS screen's audio-offset calibration metronome: a steady tick plus a
// synced visual flash (see getMetronomePulse below), both driven off the same
// AudioContext clock so they can never drift relative to each other — the
// whole point of the calibration aid.
const METRONOME_BEAT_SEC = 0.6; // ~100 BPM tick
const METRONOME_FLASH_SEC = 0.12; // how long the visual flash takes to fade

export class AudioManager {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private synth: PianoSynth | null = null;

  private score: ScoreData | null = null;
  private scoreNotes: ScoreNote[] = []; // sorted by time, the synth's playback list

  private startContextTime = 0; // audioContext.currentTime corresponding to song-time 0
  private pausedAtSongTime = 0; // song-time (ms) captured when paused
  private isPlaying = false;

  private currentVolume = 0.5; // 0.0-1.0, independent of mute — what unmuting restores to
  private muted = false;
  private preMuteVolume = 0.5; // currentVolume snapshotted at the instant mute was turned on

  private metronomeTimer: number | null = null;
  private metronomeBeatZero = 0; // AudioContext time of tick #0 for the current metronome run
  private metronomeNextBeat = 0; // AudioContext time of the next not-yet-scheduled tick

  // Creates this.context/this.gainNode if they don't exist yet. Factored out
  // of loadScore() so the SETTINGS metronome works even if the player opens
  // Settings before ever loading a song — it needs the context+gain chain but
  // not the synth (that stays loadScore()-only, score playback specific).
  private ensureContext(): void {
    this.context ??= new AudioContext();
    if (!this.gainNode) {
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.currentVolume;
      this.gainNode.connect(this.context.destination);
    }
  }

  // Fetches a score JSON and (first call only — cached thereafter) the piano
  // samples. Safe to call before any user gesture: constructing the
  // AudioContext and decoding don't require one; only actually starting
  // playback in play() does. Reuses the existing AudioContext/GainNode/synth
  // across songs, so switching tracks never resets volume/mute or re-downloads
  // the instrument.
  async loadScore(url: string): Promise<void> {
    this.ensureContext();
    this.synth ??= new PianoSynth(this.context!, this.gainNode!);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch score: ${url} (${response.status})`);
    const score = (await response.json()) as ScoreData;

    await this.synth.loadSamples(); // no-op after the first song

    this.score = score;
    this.scoreNotes = [...score.notes].sort((a, b) => a.time - b.time);
    this.pausedAtSongTime = 0;
    this.isPlaying = false;
  }

  play(): void {
    if (!this.context || !this.synth || !this.score) {
      throw new Error("AudioManager.loadScore() must complete before play()");
    }
    if (this.isPlaying) return;

    // The context can start "suspended" since it was constructed outside a
    // user gesture (during loading); resuming here, inside the caller's
    // gesture-triggered call stack, is what satisfies the autoplay policy.
    if (this.context.state === "suspended") {
      void this.context.resume();
    }

    this.startContextTime = this.context.currentTime - this.pausedAtSongTime / 1000;
    this.synth.start(this.scoreNotes, this.pausedAtSongTime, this.startContextTime);
    this.isPlaying = true;
  }

  pause(): void {
    if (!this.isPlaying || !this.synth) return;
    this.pausedAtSongTime = this.getSongTime();
    this.synth.stop();
    this.isPlaying = false;
  }

  // Stops any current playback and starts over from song-time 0 — used for retry.
  restart(): void {
    if (this.isPlaying && this.synth) {
      this.synth.stop();
      this.isPlaying = false;
    }
    this.pausedAtSongTime = 0;
    this.play();
  }

  togglePlayPause(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  // Sets the audible level (0.0-1.0, clamped). Applies instantly to the live
  // GainNode — no need to be playing, paused, or even loaded yet (harmless if
  // gainNode doesn't exist yet; the stored value is picked up by loadScore()
  // once it creates the node). Does not touch `muted`: while muted, the
  // audible gain stays 0 regardless — the new level takes effect the moment
  // toggleMute() unmutes.
  setVolume(value: number): void {
    this.currentVolume = Math.min(1, Math.max(0, value));
    this.applyGain();
  }

  toggleMute(): void {
    if (this.muted) {
      this.muted = false;
      this.currentVolume = this.preMuteVolume;
    } else {
      this.preMuteVolume = this.currentVolume;
      this.muted = true;
    }
    this.applyGain();
  }

  private applyGain(): void {
    if (this.gainNode) this.gainNode.gain.value = this.muted ? 0 : this.currentVolume;
  }

  get volume(): number {
    return this.currentVolume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  // Full song length in ms (score duration + a decay tail) — used by
  // Recording Mode to detect natural track-end.
  getDuration(): number {
    return this.score ? this.score.meta.durationMs + DURATION_TAIL_MS : 0;
  }

  // Derived purely from audioContext.currentTime — never from wall-clock or rAF deltas.
  getSongTime(): number {
    if (!this.context) return 0;
    if (!this.isPlaying) return this.pausedAtSongTime;
    return (this.context.currentTime - this.startContextTime) * 1000;
  }

  // Starts the SETTINGS screen's calibration metronome: a steady tick every
  // METRONOME_BEAT_SEC, scheduled ahead of the clock via a lookahead
  // setInterval (same pattern PianoSynth's scheduler uses) so ticks land at
  // exact AudioContext timestamps rather than drifting with setInterval's own
  // imprecision. Idempotent — safe to call again while already running.
  startMetronome(): void {
    this.ensureContext();
    const context = this.context!;
    if (context.state === "suspended") {
      void context.resume(); // called from a keypress handler, so this satisfies the autoplay policy
    }

    this.stopMetronome();

    this.metronomeBeatZero = context.currentTime + 0.1; // small lead so the first tick isn't already in the past
    this.metronomeNextBeat = this.metronomeBeatZero;

    const tick = (): void => {
      while (this.metronomeNextBeat < context.currentTime + 0.2) {
        this.scheduleTick(this.metronomeNextBeat);
        this.metronomeNextBeat += METRONOME_BEAT_SEC;
      }
    };
    tick();
    this.metronomeTimer = window.setInterval(tick, 25);
  }

  stopMetronome(): void {
    if (this.metronomeTimer === null) return;
    clearInterval(this.metronomeTimer);
    this.metronomeTimer = null;
  }

  // Short percussive "click" via an OscillatorNode + fast gain envelope,
  // routed through this.gainNode so it respects the shared volume/mute.
  private scheduleTick(atContextTime: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.frequency.value = 1000;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, atContextTime);
    gain.gain.exponentialRampToValueAtTime(0.6, atContextTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, atContextTime + 0.05);

    osc.connect(gain);
    gain.connect(this.gainNode!);

    osc.start(atContextTime);
    osc.stop(atContextTime + 0.06);
    osc.onended = () => gain.disconnect();
  }

  // 0..1 visual flash value for the SETTINGS calibration display, peaking
  // exactly at each (beat + offsetMs) — driven off the SAME AudioContext
  // clock the tick itself is scheduled on, so the flash can never drift
  // relative to the sound. Shifting by offsetMs moves the flash LATER as the
  // offset increases, so the player nudges it up until the (now-delayed)
  // flash catches up to the sound they actually hear, landing on their true
  // device latency.
  getMetronomePulse(offsetMs: number): number {
    if (!this.context || this.metronomeTimer === null) return 0;
    const visualBeatZero = this.metronomeBeatZero + offsetMs / 1000;
    const elapsed = this.context.currentTime - visualBeatZero;
    const phase = ((elapsed % METRONOME_BEAT_SEC) + METRONOME_BEAT_SEC) % METRONOME_BEAT_SEC;
    return phase < METRONOME_FLASH_SEC ? 1 - phase / METRONOME_FLASH_SEC : 0;
  }
}
