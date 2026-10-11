/**
 * WAV file utilities for concatenating multiple WAV buffers into one.
 * Assumes all inputs are standard PCM WAV (16-bit, mono or stereo).
 */

interface WavFmt {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

interface ParsedWav {
  fmt: WavFmt;
  pcmOffset: number;
  pcmLength: number;
}

/**
 * Parse the fmt chunk from a WAV buffer.
 * Returns format info, PCM data offset, and PCM data length.
 */
export function parseWav(buffer: Buffer): ParsedWav {
  if (buffer.length < 44) {
    throw new Error(`WAV buffer too short: ${buffer.length} bytes (min 44)`);
  }

  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV header: missing RIFF/WAVE");
  }

  // Find fmt chunk (usually at offset 12)
  let offset = 12;
  let fmt: WavFmt | null = null;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        numChannels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        byteRate: buffer.readUInt32LE(offset + 16),
        blockAlign: buffer.readUInt16LE(offset + 20),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
      offset += 8 + chunkSize;
    } else if (chunkId === "data") {
      if (!fmt) {
        throw new Error("WAV data chunk found before fmt chunk");
      }
      const pcmOffset = offset + 8;
      const pcmLength = chunkSize;
      return { fmt, pcmOffset, pcmLength };
    } else {
      // Skip unknown chunk
      offset += 8 + chunkSize;
    }
  }

  throw new Error("WAV data chunk not found");
}

/**
 * Validate that all WAV buffers share the same format.
 */
function validateCompatible(buffers: Buffer[]): WavFmt {
  if (buffers.length === 0) {
    throw new Error("No WAV buffers to validate");
  }

  const first = parseWav(buffers[0]);

  for (let i = 1; i < buffers.length; i++) {
    const parsed = parseWav(buffers[i]);
    if (
      parsed.fmt.audioFormat !== first.fmt.audioFormat ||
      parsed.fmt.numChannels !== first.fmt.numChannels ||
      parsed.fmt.sampleRate !== first.fmt.sampleRate ||
      parsed.fmt.bitsPerSample !== first.fmt.bitsPerSample
    ) {
      throw new Error(
        `WAV format mismatch at index ${i}: expected ` +
          `${first.fmt.sampleRate}Hz/${first.fmt.bitsPerSample}bit/` +
          `${first.fmt.numChannels}ch, got ` +
          `${parsed.fmt.sampleRate}Hz/${parsed.fmt.bitsPerSample}bit/` +
          `${parsed.fmt.numChannels}ch`
      );
    }
  }

  return first.fmt;
}

/**
 * Write a standard PCM WAV header.
 */
function writeWavHeader(
  pcmLength: number,
  fmt: WavFmt
): Buffer {
  const header = Buffer.allocUnsafe(44);

  // RIFF chunk descriptor
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4); // file size - 8
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1Size (16 for PCM)
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.byteRate, 28);
  header.writeUInt16LE(fmt.blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);

  return header;
}

/**
 * Concatenate multiple WAV buffers into a single WAV buffer.
 * All buffers must have identical PCM format (sample rate, bit depth, channels).
 *
 * @param buffers Array of WAV buffers.
 * @param gapSeconds Silence to insert between buffers (default: 0).
 * @returns Single combined WAV buffer.
 */
export function concatWavBuffers(buffers: Buffer[], gapSeconds = 0): Buffer {
  if (buffers.length === 0) {
    return Buffer.alloc(0);
  }
  if (buffers.length === 1) {
    return buffers[0];
  }

  const fmt = validateCompatible(buffers);

  // Bytes per sample frame = channels * bitsPerSample / 8
  const bytesPerFrame = fmt.numChannels * (fmt.bitsPerSample / 8);
  const gapFrames = gapSeconds > 0 ? Math.round(gapSeconds * fmt.sampleRate) : 0;
  const gapBytes = gapFrames * bytesPerFrame;

  // Calculate total PCM length including gaps between buffers
  let totalPcmLength = 0;
  const chunks: { pcmOffset: number; pcmLength: number }[] = [];

  for (const buf of buffers) {
    const parsed = parseWav(buf);
    chunks.push({ pcmOffset: parsed.pcmOffset, pcmLength: parsed.pcmLength });
    totalPcmLength += parsed.pcmLength;
  }
  // Add gaps between buffers (N buffers → N-1 gaps)
  if (gapBytes > 0) {
    totalPcmLength += gapBytes * (buffers.length - 1);
  }

  const header = writeWavHeader(totalPcmLength, fmt);
  const output = Buffer.allocUnsafe(header.length + totalPcmLength);

  header.copy(output, 0);
  let writeOffset = header.length;

  for (let i = 0; i < buffers.length; i++) {
    const { pcmOffset, pcmLength } = chunks[i];
    buffers[i].copy(output, writeOffset, pcmOffset, pcmOffset + pcmLength);
    writeOffset += pcmLength;

    // Insert silence gap between buffers (not after the last one)
    if (gapBytes > 0 && i < buffers.length - 1) {
      output.fill(0, writeOffset, writeOffset + gapBytes);
      writeOffset += gapBytes;
    }
  }

  return output;
}

/**
 * Check if a buffer looks like a valid WAV file.
 */
export function isValidWav(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  return riff === "RIFF" && wave === "WAVE";
}

/** What scaling a buffer did, so a caller can report the runs that ran out of
 * headroom instead of quietly distorting them. */
export interface GainResult {
  /** The scaled audio, or the input unchanged when scaling did not apply. */
  buffer: Buffer;
  /** Samples the gain pushed past full scale, which were clamped to it. */
  clippedSamples: number;
  /** Samples read. Zero when the buffer was left alone — see `applied`. */
  totalSamples: number;
  /** False when the buffer was returned untouched because it is not 16-bit PCM
   * this can scale, or because the gain was 1 (which is the same buffer). */
  applied: boolean;
}

/**
 * Scale a WAV buffer's samples by a linear gain, clamping at full scale.
 *
 * The engines do not agree on loudness — measured on one Vietnamese sentence,
 * kokoro and piper return at full scale (peak 0.0 dBFS) and supertonic ~8 dB
 * below it — and the gateway has no volume parameter to ask them to agree, so
 * the levelling is done here, on the PCM it returned.
 *
 * Scaling is linear and per sample, so scaling each utterance gives exactly the
 * samples scaling their concatenation would: a reply that had to be divided and
 * rejoined needs no second pass and no undoing.
 *
 * Anything that is not 16-bit PCM is returned untouched rather than guessed at.
 * A wrong sample width would rewrite the audio into noise, which is worse than
 * an engine being the wrong volume, and nothing here needs the other depths: all
 * three engines return 16-bit PCM mono (44100 / 24000 / 22050 Hz respectively).
 *
 * @param buffer The WAV to scale.
 * @param gain Linear multiplier; 1 returns the buffer as it is, 0 silences it.
 */
export function applyGainToWav(buffer: Buffer, gain: number): GainResult {
  const unchanged: GainResult = {
    buffer,
    clippedSamples: 0,
    totalSamples: 0,
    applied: false,
  };

  // A gain of 1 is the identity, and returning the same buffer keeps the common
  // case free of a copy. A negative or non-finite gain is refused rather than
  // clamped: see `parseGain` — the config parser is supposed to have already
  // rejected it, and a caller reaching here with one is a bug, not a volume.
  if (!Number.isFinite(gain) || gain < 0) return unchanged;
  if (gain === 1) return { ...unchanged, applied: true };

  let fmt: WavFmt;
  let pcmOffset: number;
  let pcmLength: number;
  try {
    ({ fmt, pcmOffset, pcmLength } = parseWav(buffer));
  } catch {
    // Not a WAV this understands. Returning it is the only option that does not
    // corrupt it; the caller's audio is then merely at the engine's own level.
    return unchanged;
  }

  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return unchanged;

  // Trust the header only as far as the bytes actually present.
  pcmLength = Math.min(pcmLength, buffer.length - pcmOffset);
  const totalSamples = Math.floor(pcmLength / 2);
  if (totalSamples === 0) return unchanged;

  const output = Buffer.from(buffer);
  let clippedSamples = 0;

  for (let i = 0; i < totalSamples; i++) {
    const at = pcmOffset + i * 2;
    const scaled = Math.round(output.readInt16LE(at) * gain);
    if (scaled > 32767) {
      output.writeInt16LE(32767, at);
      clippedSamples++;
    } else if (scaled < -32768) {
      output.writeInt16LE(-32768, at);
      clippedSamples++;
    } else {
      output.writeInt16LE(scaled, at);
    }
  }

  return { buffer: output, clippedSamples, totalSamples, applied: true };
}
