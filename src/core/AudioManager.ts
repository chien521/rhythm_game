// Core timekeeper. All game/render timing must read from getSongTime() —
// never from performance.now()/requestAnimationFrame deltas — so visuals stay
// audio-clock locked and pause/resume is instant with zero drift.
export class AudioManager {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;

  private startContextTime = 0; // audioContext.currentTime corresponding to song-time 0
  private pausedAtSongTime = 0; // song-time (ms) captured when paused
  private isPlaying = false;

  private currentVolume = 0.5; // 0.0-1.0, independent of mute — what unmuting restores to
  private muted = false;
  private preMuteVolume = 0.5; // currentVolume snapshotted at the instant mute was turned on

  // Fetches and decodes a real audio file. Safe to call immediately on script
  // load (the LOADING state), before any user gesture — constructing the
  // AudioContext and decoding don't require one; only actually starting
  // playback in play() does. Reuses the existing AudioContext (and GainNode)
  // if one already exists, since Song Select can call this again (switching
  // tracks) — without the reuse guard, each call would leak a fresh, never-
  // closed context, and a fresh gain node would reset the player's volume/mute.
  async loadAudioFile(url: string): Promise<void> {
    this.context ??= new AudioContext();
    if (!this.gainNode) {
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.currentVolume;
      this.gainNode.connect(this.context.destination);
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch audio file: ${url} (${response.status})`);

    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.context.decodeAudioData(arrayBuffer);
    this.sourceNode = null;
    this.pausedAtSongTime = 0;
    this.isPlaying = false;
  }

  play(): void {
    if (!this.context || !this.buffer || !this.gainNode) {
      throw new Error("AudioManager.loadAudioFile() must complete before play()");
    }
    if (this.isPlaying) return;

    // The context can start "suspended" since it was constructed outside a
    // user gesture (during LOADING); resuming here, inside the caller's
    // gesture-triggered call stack, is what satisfies the autoplay policy.
    if (this.context.state === "suspended") {
      void this.context.resume();
    }

    const offsetSec = this.pausedAtSongTime / 1000;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gainNode); // routed through the persistent gain stage, not straight to destination
    source.start(0, offsetSec);

    this.sourceNode = source;
    this.startContextTime = this.context.currentTime - offsetSec;
    this.isPlaying = true;
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) return;
    this.pausedAtSongTime = this.getSongTime();
    this.sourceNode.stop();
    this.sourceNode.disconnect();
    this.sourceNode = null;
    this.isPlaying = false;
  }

  // Stops any current playback and starts over from song-time 0 — used for retry.
  restart(): void {
    if (this.isPlaying && this.sourceNode) {
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
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
  // gainNode doesn't exist yet; the stored value is picked up by
  // loadAudioFile() once it creates the node). Does not touch `muted`: while
  // muted, the audible gain stays 0 regardless, matching
  // `gain = isMuted ? 0 : volume` — the new level takes effect the moment
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

  // Full track length in ms — used by Recording Mode to detect natural track-end.
  getDuration(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  // Derived purely from audioContext.currentTime — never from wall-clock or rAF deltas.
  getSongTime(): number {
    if (!this.context) return 0;
    if (!this.isPlaying) return this.pausedAtSongTime;
    return (this.context.currentTime - this.startContextTime) * 1000;
  }
}
