---
name: verify
description: Build, launch, and drive this rhythm game end-to-end in headless Chrome to verify changes at the real surface (canvas + Web Audio clock).
---

# Verifying rhythm_game changes

## Launch

```bash
npx vite --port 5173          # dev server (run in background)
```

Requires `playwright-core` (install with `npm install --no-save playwright-core`
if missing — do NOT save it) and system Chrome at
`C:/Program Files/Google/Chrome/Application/chrome.exe`.

Launch Chrome headless with `--autoplay-policy=no-user-gesture-required` so the
AudioContext runs without a real gesture. The Web Audio clock advances normally
in headless Chrome — timing behavior is fully observable even though no sound
device plays.

## Drive

Dev builds expose `window.__debug` (dead-code-eliminated in prod) with:
`getState()`, `getEffectiveSongTime()`, `audioManager`, `chartManager`,
`scoreManager`, `inputManager`, `getRecordedNotes()`.

Flow: wait for `getState() === "TITLE"` → click canvas → SONG_SELECT →
**wait ≥500ms** (input-bleedthrough debounce swallows keys for
STATE_FADE_DURATION_MS=400ms after every state change — pressing Enter too
early is silently ignored, not queued) → Enter → GAMEPLAY.

Useful checks that worked:
- Clock: sample `getEffectiveSongTime()` twice N ms apart; should advance ≈N.
- Pause: Space; songTime must be frozen EXACTLY (0.00ms drift) while PAUSED.
- Hit judgment: inside `page.evaluate`, poll `chartManager.getActiveNotes()`
  until a pending note is within ±25ms of `getEffectiveSongTime()`, then
  dispatch `new KeyboardEvent("keydown", { code })` for its lane
  (lane→code: Q W E R J K L Semicolon). Expect scoreManager.perfectCount +1.
- Passive misses: idle a few seconds; `scoreManager.missCount` must grow.
- Song switch: pause → ArrowDown → Enter (Back to Menu) → wait 500ms →
  ArrowDown/Enter. Second song loads in ~tens of ms (piano samples cached).
- Recording mode: `KeyR` in SONG_SELECT, dispatch lane keys,
  `getRecordedNotes()`, Escape to exit.

## Gotchas

- `/favicon.ico` 404s in the console are pre-existing noise, not a failure.
- Verify scripts must live where they can resolve the repo's node_modules, or
  use `createRequire("<repo>/package.json")`.
- After any score/chart change also run `npm run validate:charts` (chart vs
  score integrity gate), but that is CI-style checking — the browser drive
  above is the actual verification.
