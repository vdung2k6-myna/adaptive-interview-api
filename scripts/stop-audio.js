const { execSync } = require("child_process");
const process = require("process");

const isWin = process.platform === "win32";

function stopAudioServices() {
  console.log("==========================================");
  console.log("Stopping Audio Services Stack");
  console.log("==========================================");
  console.log();

  if (isWin) {
    // Kill by window title
    const titles = [
      "audio.cpp STT",
      "Kokoro TTS",
      "Piper TTS",
      "Audio Gateway",
    ];

    for (const title of titles) {
      try {
        const output = execSync(
          `tasklist /fi "WINDOWTITLE eq ${title}" /fo csv /nh`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        const lines = output.trim().split("\r\n").filter(Boolean);
        for (const line of lines) {
          const parts = line.split(",");
          if (parts.length >= 2) {
            const pid = parts[1].replace(/"/g, "").trim();
            if (pid) {
              console.log(`Stopping ${title} (PID ${pid})...`);
              try {
                execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
              } catch {
                // already dead
              }
            }
          }
        }
      } catch {
        // none found
      }
    }

    // Fallback: kill by image name
    const images = ["audiocpp_server.exe", "python.exe"];
    for (const image of images) {
      try {
        const output = execSync(
          `tasklist /fi "IMAGENAME eq ${image}" /fo csv /nh`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        const lines = output.trim().split("\r\n").filter(Boolean);
        for (const line of lines) {
          const parts = line.split(",");
          if (parts.length >= 2) {
            const pid = parts[1].replace(/"/g, "").trim();
            if (pid) {
              try {
                execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
              } catch {
                // already dead
              }
            }
          }
        }
      } catch {
        // none found
      }
    }
  } else {
    // Linux/macOS
    const patterns = [
      "audiocpp_server",
      "kokoro-service/main.py",
      "piper-service/main.py",
      "audio-gateway/main.py",
    ];

    for (const pattern of patterns) {
      try {
        const pids = execSync(`pgrep -f "${pattern}"`, {
          encoding: "utf-8",
        })
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const pid of pids) {
          console.log(`Stopping ${pattern} (PID ${pid})...`);
          try {
            execSync(`kill ${pid}`, { stdio: "ignore" });
          } catch {
            // already dead
          }
        }
      } catch {
        // none found
      }
    }
  }

  console.log();
  console.log("All audio services stopped.");
}

stopAudioServices();
