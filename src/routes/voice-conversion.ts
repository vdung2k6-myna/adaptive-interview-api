import { Router } from "express";
import config from "@/lib/config";
import {
  audioGateway,
  effectiveVoiceConversion,
  parseVoiceConversionConfig,
  type SynthesizeOptions,
} from "@/lib/audio";
import { voiceConversion, type VoiceConversionClient } from "@/lib/audio/client";

/** The sentence an audition speaks when the caller names none. */
const AUDITION_TEXT = "Hello, this is how this voice sounds.";

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
  client: Pick<VoiceConversionClient, "status"> = voiceConversion,
  synthesize: (text: string, options: SynthesizeOptions) => Promise<Buffer> = (text, options) =>
    audioGateway.synthesize(text, options)
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

  /**
   * Speak one sample through a chosen TTS provider and the requested conversion.
   *
   * The console's audition is the same two stages a turn takes — synthesize, then
   * convert — but with a fixed short sentence and the provider the agent's TTS
   * profile names. `ovc` absent inherits the deployment's voice-agent shaping;
   * `{"enabled":false}` returns the provider's own voice.
   */
  router.post("/audition", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

    const baseUrl = text(body.ttsBaseUrl);
    const model = text(body.ttsModel);
    const voice = text(body.ttsVoice);
    const apiKey = text(body.ttsApiKey);
    const missing =
      baseUrl === ""
        ? "ttsBaseUrl"
        : model === ""
          ? "ttsModel"
          : voice === ""
            ? "ttsVoice"
            : null;
    if (missing !== null) {
      res.status(400).json({ error: `${missing} is required` });
      return;
    }

    const parsed = parseVoiceConversionConfig(
      body.ovc,
      voiceConversion.advertisedF0Methods.length > 0
        ? voiceConversion.advertisedF0Methods
        : undefined
    );
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const conversion = effectiveVoiceConversion(parsed.value, config.audio.ovc.voiceAgent);

    const sample =
      typeof body.text === "string" && body.text.trim() !== ""
        ? body.text.trim().slice(0, 200)
        : AUDITION_TEXT;

    try {
      const wav = await synthesize(sample, {
        baseUrl,
        model,
        voice,
        ...(apiKey === "" ? {} : { apiKey }),
        conversion,
      });
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Length", String(wav.length));
      res.send(wav);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "the voice could not be synthesized",
      });
    }
  });

  return router;
}

export default createVoiceConversionRouter();
