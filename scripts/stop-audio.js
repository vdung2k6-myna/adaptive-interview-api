#!/usr/bin/env node
/**
 * Stop the audio-tier compose project.
 *
 * Replaces the old native kill-by-window-title and kill-by-image-name paths:
 * the tier is now containers, and `docker compose down` is the whole stop.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const composeFile = path.join(root, "docker-compose.audio.yml");

console.log("==========================================");
console.log("Stopping Audio Services Stack");
console.log("==========================================");
console.log();

const result = spawnSync(
  "docker",
  ["compose", "-f", composeFile, "down", "--remove-orphans"],
  { stdio: "inherit", cwd: root }
);

if (result.error) {
  console.error(`[FAIL] could not run docker: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[FAIL] docker compose down exited ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log();
console.log("All audio services stopped. Models under AUDIO_MODELS_DIR are untouched.");
