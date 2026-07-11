#!/usr/bin/env node
// Stop hook: when a Claude Code turn ends, auto-commit and push local
// changes to the user's personal GitHub repo -- but only if the build is
// actually green. A broken working tree is left uncommitted rather than
// silently becoming what's waiting on the other machine.

const { execSync } = require("child_process");

const ALLOWED_REMOTE = "github.com/chien521/rhythm_game";

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function tryShExit(cmd, opts = {}) {
  try {
    execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

function done(message) {
  if (message) {
    console.log(JSON.stringify({ systemMessage: message }));
  }
  process.exit(0);
}

try {
  const remoteUrl = sh("git remote get-url origin");
  if (!remoteUrl.includes(ALLOWED_REMOTE)) {
    done();
  }

  const branch = sh("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") {
    done();
  }

  const status = sh("git status --porcelain");
  if (status.length === 0) {
    done();
  }

  const changedFiles = status.split("\n").length;

  const tscOk = tryShExit("npx tsc -b --noEmit", { timeout: 90000 }) === 0;
  const validateOk = tscOk && tryShExit("npm run validate:charts", { timeout: 90000 }) === 0;

  if (!tscOk || !validateOk) {
    const failed = !tscOk ? "tsc -b --noEmit" : "npm run validate:charts";
    done(
      `Auto-sync skipped: working tree has ${changedFiles} changed file(s) but ${failed} is failing. ` +
        `Changes left uncommitted -- fix the build, then they'll sync on the next Stop.`
    );
  }

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const message = `Auto-sync: ${changedFiles} file(s) changed (${timestamp})\n\nAutomated commit from Claude Code Stop hook.`;

  tryShExit("git add -A");
  const commitOk = tryShExit(`git commit -m ${JSON.stringify(message)}`) === 0;
  if (!commitOk) {
    done("Auto-sync: git commit failed unexpectedly -- left for manual resolution.");
  }

  const pushOk = tryShExit("git push origin main") === 0;
  if (!pushOk) {
    done(
      `Auto-sync: committed ${changedFiles} file(s) locally but push to origin/main failed ` +
        `(offline, auth, or remote diverged) -- resolve manually.`
    );
  }

  done(`Auto-sync: committed and pushed ${changedFiles} file(s) to origin/main.`);
} catch (err) {
  done(`Auto-sync: stop-hook check failed unexpectedly (${err.message}).`);
}
