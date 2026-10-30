import "dotenv/config";

import { createApp } from "./app";
import { unavailableConfiguredVoices } from "./lib/audio/voice-catalog";
import { libraryComplaint } from "./lib/music";
import config from "./lib/config";

// Read as a number because `listen` takes one when a host is named as well.
const PORT = Number(process.env.PORT || 4000);
/**
 * The address the API binds. Defaults to every interface, which is what every
 * deployment did before this setting existed; a deployment that puts the API
 * behind a proxy, or on the same host as its only caller, names loopback here
 * and the socket is then reachable from nowhere else.
 */
const HOST = process.env.HOST || "0.0.0.0";

createApp().listen(PORT, HOST, () => {
  console.log(`Adaptive Interview API listening on port ${PORT}`);
  void reportUnavailableVoices();
  void reportMusicLibrary();
});

/**
 * Report a music library this deployment cannot serve, once, at boot.
 *
 * The two ways it can fail are both silent otherwise. A directory that is not there is "no music"
 * to a turn, which is indistinguishable from a deployment that configured none; and a directory
 * outside the audio root has no URL a client could fetch, because the mount is the only thing that
 * serves these and it serves one directory — so a track in it would be a name that plays silence.
 *
 * Reported and not thrown, for the reason the voice check is: this service's subject is interviews,
 * and a music directory is not a reason to refuse to serve them. A deployment with no library
 * configured has nothing to report.
 */
async function reportMusicLibrary(): Promise<void> {
  const complaint = await libraryComplaint(config.music.libraryDir);
  if (complaint !== null) {
    console.warn(`[Music] ${complaint} — no music will be offered to the model.`);
  }
}

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
