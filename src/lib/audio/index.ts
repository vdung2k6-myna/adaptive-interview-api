/**
 * Audio library exports.
 * Provides STT (audio.cpp), TTS (via Audio Gateway), storage, and health check utilities.
 */

import { audioClient, audioGateway } from "./client";

export {
  audioClient,
  audioGateway,
  AudioCppClient,
  AudioGatewayClient,
  type TranscriptionResult,
  type SynthesizeOptions,
} from "./client";
export { transcribeAudio } from "./stt";
export { synthesizeSpeech, synthesizeSentences } from "./tts";
export { saveAudio, readAudio, audioExists, urlPathToFilePath, detectAudioFormat } from "./storage";
export { splitSentences, extractNewSentences } from "./split-sentences";
export { concatWavBuffers, isValidWav } from "./wav-utils";
export {
  stripMarkdown,
  splitForTTS,
  synthesizeSpeechWithFallback,
  synthesizeChunkWithFallback,
  type SynthesizeResult,
} from "./text-processing";

/**
 * Log a warning if audio services are unreachable.
 * Call this once at a strategic entry point (e.g. first voice API call).
 */
export async function logAudioHealth(): Promise<void> {
  const [sttHealthy, ttsHealthy] = await Promise.all([
    audioClient.healthCheck(),
    audioGateway.healthCheck(),
  ]);

  if (!sttHealthy) {
    console.warn(
      "[audio.cpp] STT health check failed. Transcription will not work."
    );
  }
  if (!ttsHealthy.kokoro && !ttsHealthy.piper) {
    console.warn(
      "[Audio Gateway] TTS health check failed. Speech synthesis will not work."
    );
  } else {
    if (!ttsHealthy.kokoro) {
      console.warn("[Audio Gateway] Kokoro engine is unreachable.");
    }
    if (!ttsHealthy.piper) {
      console.warn("[Audio Gateway] Piper engine is unreachable.");
    }
  }
}
