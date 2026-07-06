// Core timekeeper. All game/render timing must read from getSongTime() —
// never from performance.now()/requestAnimationFrame deltas — so visuals stay
// audio-clock locked and pause/resume is instant with zero drift.
export class AudioManager {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;

  private startContextTime = 0; // audioContext.currentTime corresponding to song-time 0
  private pausedAtSongTime = 0; // song-time (ms) captured when paused
  private isPlaying = false;

  // Fetches and decodes a real audio file. Safe to call immediately on script
  // load (the LOADING state), before any user gesture — constructing the
  // AudioContext and decoding don't require one; only actually starting
  // playback in play() does.
  async loadAudioFile(url: string): Promise<void> {
    this.context = new AudioContext();

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch audio file: ${url} (${response.status})`);

    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.context.decodeAudioData(arrayBuffer);
  }

  play(): void {
    if (!this.context || !this.buffer) throw new Error("AudioManager.loadAudioFile() must complete before play()");
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
    source.connect(this.context.destination);
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

  // Derived purely from audioContext.currentTime — never from wall-clock or rAF deltas.
  getSongTime(): number {
    if (!this.context) return 0;
    if (!this.isPlaying) return this.pausedAtSongTime;
    return (this.context.currentTime - this.startContextTime) * 1000;
  }
}
