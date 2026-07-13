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

  // Fetches a score JSON and (first call only — cached thereafter) the piano
  // samples. Safe to call before any user gesture: constructing the
  // AudioContext and decoding don't require one; only actually starting
  // playback in play() does. Reuses the existing AudioContext/GainNode/synth
  // across songs, so switching tracks never resets volume/mute or re-downloads
  // the instrument.
  async loadScore(url: string): Promise<void> {
    this.context ??= new AudioContext();
    if (!this.gainNode) {
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.currentVolume;
      this.gainNode.connect(this.context.destination);
    }
    this.synth ??= new PianoSynth(this.context, this.gainNode);

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
}
