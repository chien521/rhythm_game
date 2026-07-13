import { ScoreNote } from "../config/constants";

// Sampled piano voice, scheduled directly on the AudioContext timeline. This
// is what "plays the song": AudioManager hands it the score's note list and a
// context-time anchor, and every note is scheduled at its exact hardware-clock
// timestamp — the same clock gameplay judges against, so audio and chart can
// never drift.
//
// Samples: Salamander Grand Piano (CC-BY Alexander Holm — see
// public/samples/piano/LICENSE.txt), 30 files at minor-third spacing from
// A0 (midi 21) to C8 (midi 108). Any pitch in between plays the nearest
// sample repitched via playbackRate = 2^(semitones/12) — the standard
// sampler technique; at most 1 semitone of stretch, inaudible on piano tones.

const SAMPLE_MIN_MIDI = 21; // A0
const SAMPLE_MAX_MIDI = 108; // C8
const SAMPLE_SPACING = 3; // minor thirds

// midi pitch-class -> Salamander filename fragment (only these four occur at
// minor-third spacing from A0).
const PITCH_CLASS_NAMES: Record<number, string> = { 0: "C", 3: "Ds", 6: "Fs", 9: "A" };

function sampleFileName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = PITCH_CLASS_NAMES[midi % 12];
  return `${name}${octave}.mp3`;
}

// How often the scheduler wakes, and how far ahead of the hardware clock it
// schedules. Lookahead comfortably exceeds the interval so a late timer tick
// (background throttling, GC pause) never lets the schedule horizon lapse.
const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULE_LOOKAHEAD_SEC = 0.15;

// Release envelope applied at each note's written end — smooths the cutoff
// where a real piano's sustain pedal would blur it (pedal isn't modeled).
const NOTE_RELEASE_SEC = 0.4;
// Fast fade used when playback is stopped/paused mid-note.
const STOP_RELEASE_SEC = 0.05;

export class PianoSynth {
  private context: AudioContext;
  private destination: AudioNode;
  private samples = new Map<number, AudioBuffer>(); // sampleMidi -> decoded buffer
  private loadPromise: Promise<void> | null = null;

  private schedulerTimer: number | null = null;
  private activeSources = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>();

  constructor(context: AudioContext, destination: AudioNode) {
    this.context = context;
    this.destination = destination;
  }

  // Fetches + decodes all 30 samples in parallel. Idempotent — concurrent and
  // repeat callers share the one in-flight/completed load, so switching songs
  // never re-downloads the instrument.
  loadSamples(): Promise<void> {
    this.loadPromise ??= (async () => {
      const midis: number[] = [];
      for (let m = SAMPLE_MIN_MIDI; m <= SAMPLE_MAX_MIDI; m += SAMPLE_SPACING) midis.push(m);

      await Promise.all(
        midis.map(async (midi) => {
          const url = `/samples/piano/${sampleFileName(midi)}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch piano sample: ${url} (${res.status})`);
          const buffer = await this.context.decodeAudioData(await res.arrayBuffer());
          this.samples.set(midi, buffer);
        })
      );
    })().catch((err: unknown) => {
      this.loadPromise = null; // allow a retry after a failed load
      throw err;
    });
    return this.loadPromise;
  }

  get samplesLoaded(): boolean {
    return this.samples.size > 0;
  }

  // Begins scheduling `notes` (sorted by time) against the hardware clock.
  // startContextTime is the AudioContext.currentTime that corresponds to
  // song-time 0 — the exact anchor AudioManager.getSongTime() derives from.
  // Notes whose onset is earlier than fromSongTimeMs are skipped (resume
  // semantics: a note already sounding at the pause point doesn't re-attack).
  start(notes: readonly ScoreNote[], fromSongTimeMs: number, startContextTime: number): void {
    this.stopScheduler();

    let nextIndex = notes.findIndex((n) => n.time >= fromSongTimeMs);
    if (nextIndex === -1) nextIndex = notes.length;

    const tick = (): void => {
      const horizon = this.context.currentTime + SCHEDULE_LOOKAHEAD_SEC;
      while (nextIndex < notes.length) {
        const note = notes[nextIndex];
        const noteContextTime = startContextTime + note.time / 1000;
        if (noteContextTime > horizon) break;
        // max() guards the very first tick after start()/resume(), where a
        // note can land a hair in the past while the interval spins up.
        this.scheduleNote(note, Math.max(noteContextTime, this.context.currentTime));
        nextIndex++;
      }
      if (nextIndex >= notes.length) this.stopScheduler(); // all scheduled; sources finish on their own
    };

    tick(); // schedule the first window immediately, don't wait one interval
    if (nextIndex < notes.length) {
      this.schedulerTimer = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
    }
  }

  // Halts scheduling and fades out everything currently sounding.
  stop(): void {
    this.stopScheduler();
    const now = this.context.currentTime;
    for (const voice of this.activeSources) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, STOP_RELEASE_SEC / 3);
      voice.source.stop(now + STOP_RELEASE_SEC * 4);
    }
    // onended handlers (below) clear activeSources as each source dies.
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private nearestSampleMidi(midi: number): number {
    const clamped = Math.min(SAMPLE_MAX_MIDI, Math.max(SAMPLE_MIN_MIDI, midi));
    const offset = clamped - SAMPLE_MIN_MIDI;
    return SAMPLE_MIN_MIDI + Math.round(offset / SAMPLE_SPACING) * SAMPLE_SPACING;
  }

  private scheduleNote(note: ScoreNote, atContextTime: number): void {
    const sampleMidi = this.nearestSampleMidi(note.midi);
    const buffer = this.samples.get(sampleMidi);
    if (!buffer) return; // loadSamples() hasn't completed — caller's contract violated, fail silent-safe

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.pow(2, (note.midi - sampleMidi) / 12);

    const gain = this.context.createGain();
    gain.gain.value = 0.15 + 0.85 * note.velocity; // quiet notes stay audible; loud notes keep headroom
    source.connect(gain);
    gain.connect(this.destination);

    // Natural sample decay until the note's written end, then a release ramp
    // (sustain-pedal resonance is not modeled — acceptable v1 tradeoff).
    const noteEnd = atContextTime + note.durationMs / 1000;
    gain.gain.setTargetAtTime(0, noteEnd, NOTE_RELEASE_SEC / 3);

    source.start(atContextTime);
    source.stop(noteEnd + NOTE_RELEASE_SEC * 4);

    const voice = { source, gain };
    this.activeSources.add(voice);
    source.onended = () => {
      this.activeSources.delete(voice);
      gain.disconnect();
    };
  }
}
