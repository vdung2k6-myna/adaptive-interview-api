#!/usr/bin/env node
/**
 * Cross-platform audio service launcher.
 * Detects Windows vs Unix and delegates to the appropriate script.
 */

const { spawn } = require("child_process");
const path = require("path");

const isWin = process.platform === "win32";
const script = isWin
  ? path.join(__dirname, "start-audio-services.bat")
  : path.join(__dirname, "start-audio-services.sh");

console.log(`Launching audio services via ${script}`);

if (isWin) {
  const child = spawn("cmd", ["/c", script], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
} else {
  const child = spawn("bash", [script], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
