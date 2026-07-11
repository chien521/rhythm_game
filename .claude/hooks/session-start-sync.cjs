#!/usr/bin/env node
// SessionStart hook: pull origin/main automatically, but only when it's
// unambiguously safe (clean tree, clean fast-forward). Anything murkier is
// left for the human to resolve by hand -- this script never merges or
// discards local state on its own.

const { execSync } = require("child_process");

const ALLOWED_REMOTE = "github.com/chien521/rhythm_game";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryShExit(cmd) {
  try {
    execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
    // Not the personal repo (e.g. a fork, a different clone) -- do nothing.
    done();
  }

  const branch = sh("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") {
    done();
  }

  if (tryShExit("git fetch origin main") !== 0) {
    done("Auto-sync: could not fetch origin/main (offline or auth issue) -- skipped.");
  }

  const behindCount = Number(sh("git rev-list HEAD..origin/main --count"));
  if (behindCount === 0) {
    done();
  }

  const status = sh("git status --porcelain");
  const isCleanWorkingTree = status.length === 0;
  const canFastForward = tryShExit("git merge-base --is-ancestor HEAD origin/main") === 0;

  if (isCleanWorkingTree && canFastForward) {
    tryShExit("git merge --ff-only origin/main");
    done(`Auto-sync: pulled ${behindCount} commit(s) from origin/main.`);
  }

  const reason = !isCleanWorkingTree
    ? "local working tree has uncommitted changes"
    : "local and origin/main have diverged (not a fast-forward)";
  done(`origin/main has ${behindCount} commit(s) not present locally -- resolve manually (${reason}).`);
} catch (err) {
  done(`Auto-sync: session-start check failed unexpectedly (${err.message}).`);
}
