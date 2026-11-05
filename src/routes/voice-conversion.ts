import { Router } from "express";
import config from "@/lib/config";
import { voiceConversion, type VoiceConversionClient } from "@/lib/audio/client";

/**
 * What this deployment does to a converted reply, for a console that wants to
 * show the effective settings before a turn.
 *
 * The console cannot read the runtime's environment, so it asks here: the
 * configured model, whether a service is named, the model currently active, the
 * deployment's voice-agent shaping, and the F0 methods the active model
 * advertises. The runtime is the authority for all of it; the console only
 * presents it.
 *
 * A deployment with no service answers `configured: false` without calling the
 * service at all. A named service that is unreachable answers `reachable: false`
 * rather than failing the read: the caller is asking what will happen, and
 * "nothing until it is fixed" is an answer.
 */
export function createVoiceConversionRouter(
  client: Pick<VoiceConversionClient, "status"> = voiceConversion
): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const ovc = config.audio.ovc;
    const status =
      ovc.url === ""
        ? { reachable: false, activeModel: null, f0Methods: [] as string[] }
        : await client.status();

    res.json({
      configured: ovc.url !== "",
      reachable: status.reachable,
      activeModel: status.activeModel,
      model: ovc.model,
      required: ovc.required,
      timeoutMs: ovc.timeoutMs,
      f0Methods: status.f0Methods,
      voiceAgent: {
        pitchShift: ovc.voiceAgent.pitchShift,
        formantShift: ovc.voiceAgent.formantShift,
        f0Method: ovc.voiceAgent.f0Method,
      },
    });
  });

  return router;
}

export default createVoiceConversionRouter();
