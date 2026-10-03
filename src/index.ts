import "dotenv/config";

import { createApp } from "./app";
import { unavailableConfiguredVoices } from "./lib/audio/voice-catalog";

const PORT = process.env.PORT || 4000;

createApp().listen(PORT, () => {
  console.log(`Adaptive Interview API listening on port ${PORT}`);
  void reportUnavailableVoices();
});

/**
 * Report any configured Supertonic voice the synthesis service does not hold.
 *
 * Runs once at boot so a misconfigured voice name is visible before a turn
 * tries to speak in it. The audio stack is not on this API's boot path, so this
 * never throws and never blocks startup: when the gateway relays no catalog the
 * check reports nothing, because an unreachable audio stack says nothing about
 * which voices are installed.
 */
async function reportUnavailableVoices(): Promise<void> {
  try {
    const unavailable = await unavailableConfiguredVoices();
    if (unavailable === null) {
      return;
    }
    for (const voice of unavailable) {
      console.warn(
        `[Audio Gateway] Configured Supertonic voice '${voice}' holds no style ` +
          `in the synthesis service. A turn resolved to it will fail rather ` +
          `than fall back to another voice.`
      );
    }
  } catch (error) {
    console.warn("[Audio Gateway] Voice catalog check failed:", error);
  }
}
