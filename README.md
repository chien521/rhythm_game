# Rhythm POC

A high-performance, zero-drift Deemo-style vertical-fall rhythm engine built with Vite + TypeScript + Canvas 2D, purpose-built for deployment as an HTC VIVERSE widget.

All gameplay timing is anchored to the Web Audio API's hardware clock (`AudioContext.currentTime`) rather than `requestAnimationFrame` deltas or wall-clock time, so notes, hit judgments, and visual effects never drift out of sync with the music — even under heavy load, tab backgrounding, or a paused/resumed session. Rendering operates in a fixed 1920x1080 logical coordinate space that the renderer letterboxes/pillarboxes to fit whatever real window or widget frame it's embedded in, so the game looks and plays identically regardless of the host's aspect ratio.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm

## Installation & Local Development

```bash
npm install
npm run dev
```

This starts the Vite dev server (default `http://localhost:5173`). Open it in a browser and click/tap the title screen to begin — the first click is required to unlock the Web Audio API per browser autoplay policy.

## Production Build for VIVERSE

```bash
npm run build:viverse
```

This runs a full type-check (`tsc`), builds optimized production assets into `/dist` via `vite build`, and packages everything into `viverse-prototype.zip` at the project root — with `index.html` sitting at the archive's immediate root (not nested inside a `dist/` folder), which is what VIVERSE Studio expects on upload.

Other useful scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Type-check + production build only (no zip) |
| `npm run preview` | Preview the production build locally |
| `npm run parse:sheet -- <sheet> <id> "<Title>"` | Convert a MusicXML/MIDI piano sheet into a score JSON (`public/scores/`) |
| `npm run generate:chart -- <id> [flags]` | Thin a score into a playable chart (`public/charts/`) |
| `npm run validate:charts` | Verify every chart against its score (length + exact note onsets) |

There are no audio files: the game itself performs each song with a sampled
piano (`public/samples/piano/`, Salamander Grand — CC-BY), scheduling the
score's notes on the same `AudioContext` clock gameplay is judged against.
Score and chart both derive from one committed sheet file in `sheets/`, so
the music you hear and the notes you hit can never drift apart.

## Gameplay Ergonomics

Notes fall vertically down 8 lanes toward a judgment line near the bottom of the screen. Input is entirely keyboard-driven, split across two rows for comfortable hand placement:

| Left hand | `Q` | `W` | `E` | `R` |
|---|---|---|---|---|
| **Lane** | 0 | 1 | 2 | 3 |

| Right hand | `J` | `K` | `L` | `;` |
|---|---|---|---|---|
| **Lane** | 4 | 5 | 6 | 7 |

- **Tap notes** — press the matching key the instant the note crosses the judgment line. Judged Perfect (≤50ms), Good (≤120ms), or Miss.
- **Slide notes** — no frame-perfect press required; just have the key held down (or press it) at any point within ±100ms of the note crossing the line, so you can roll your fingers across a run of notes.
- **Space** pauses/resumes during gameplay.

**Focus-loss auto-pause:** if the browser tab/window loses focus, becomes hidden (`document.visibilityState`), or the app otherwise loses focus mid-song, playback automatically pauses and the current position freezes exactly. Regaining focus does **not** auto-resume — a "CLICK OR PRESS A KEY TO RESUME" prompt stays up until you explicitly re-engage, so tabbing back in never throws you back into gameplay unannounced.

The layout is also resize-safe: dragging/resizing the window (as a VIVERSE widget frame might be resized live) recalculates the letterbox instantly without resetting score, combo, or note timing.

## Developer Tools: Recording Mode

Recording Mode lets you map a new chart by tapping along to the current track in real time, rather than hand-authoring JSON timestamps.

**To record a new chart:**

1. From the **Title screen**, press **`R`**.
2. The track starts playing from the beginning. Tap along on any of the 8 lane keys (`Q W E R J K L ;`) in time with the music — each press is captured with its exact millisecond timestamp (already compensated for `AUDIO_OFFSET_MS` calibration) and confirmed with a bright flash on that lane.
3. Stop recording at any time by pressing **`Escape`**, or just let the track play to its end.
4. On stop, the tool:
   - Logs the complete chart JSON to the browser console.
   - Automatically downloads it as **`chart.json`** to your downloads folder.

The exported file follows the same schema as the generated charts in `public/charts/`:

```json
{
  "meta": { "title": "Recorded Chart", "bpm": 120, "songLengthMs": 8000 },
  "notes": [
    { "id": "r1", "time": 1000, "x": 0, "type": "tap" }
  ]
}
```

All recorded notes are `"tap"` type — if you want `"slide"` notes or a custom title/BPM, hand-edit the exported JSON afterward and drop it into `public/charts/` to use it as a new playable chart.
