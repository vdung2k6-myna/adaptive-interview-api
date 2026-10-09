import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyGainToWav, concatWavBuffers, parseWav } from "./wav-utils";

/**
 * `applyGainToWav` — the per-engine volume, applied to the PCM the gateway
 * returned.
 *
 * The property most of these tests rest on is that the operation is linear and
 * per sample: scaling an utterance and scaling the reply it was divided out of
 * have to give the same samples, or the fallback that divides a failing
 * utterance would change the volume of the half that succeeded.
 */

/** A 16-bit PCM mono WAV holding the given samples. */
function wav(
  samples: number[],
  { sampleRate = 24000, bitsPerSample = 16, audioFormat = 1 } = {}
): Buffer {
  const header = Buffer.alloc(44);
  const bytesPerSample = bitsPerSample / 8;
  const pcm = Buffer.alloc(samples.length * bytesPerSample);
  samples.forEach((sample, i) => {
    if (bitsPerSample === 16) pcm.writeInt16LE(sample, i * 2);
    else pcm.writeUInt8(sample, i);
  });

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The samples back out of a WAV this module produced. */
function samplesOf(buffer: Buffer, count: number): number[] {
  const { pcmOffset } = parseWav(buffer);
  return Array.from({ length: count }, (_, i) => buffer.readInt16LE(pcmOffset + i * 2));
}

describe("applyGainToWav", () => {
  it("scales every sample by the gain", () => {
    const result = applyGainToWav(wav([1000, -2000, 3000]), 0.5);

    assert.equal(result.applied, true);
    assert.deepEqual(samplesOf(result.buffer, 3), [500, -1000, 1500]);
    assert.equal(result.clippedSamples, 0);
  });

  it("amplifies above 1 and reports nothing clipped while there is headroom", () => {
    // Supertonic's case: its peak is ~8 dB below full scale, so a gain above 1
    // is the point of the feature rather than a mistake.
    const result = applyGainToWav(wav([1000, -5000, 8000]), 1.2);

    assert.deepEqual(samplesOf(result.buffer, 3), [1200, -6000, 9600]);
    assert.equal(result.clippedSamples, 0);
    assert.equal(result.totalSamples, 3);
  });

  it("clamps what the gain pushes past full scale and counts it", () => {
    // Kokoro and piper arrive at full scale, so any gain above 1 clips them —
    // the count is what makes that visible instead of merely audible.
    const result = applyGainToWav(wav([30000, -30000, 1000]), 1.2);

    assert.deepEqual(samplesOf(result.buffer, 3), [32767, -32768, 1200]);
    assert.equal(result.clippedSamples, 2, "both ends of the range must be reported");
  });

  it("returns the buffer untouched at a gain of 1, and says it applied", () => {
    const input = wav([1000, -2000]);
    const result = applyGainToWav(input, 1);

    assert.equal(result.buffer, input, "the identity case must not copy the audio");
    assert.equal(result.applied, true);
    assert.equal(result.clippedSamples, 0);
  });

  it("silences the audio at a gain of 0", () => {
    // Zero is a volume an operator may mean, not a missing value.
    const result = applyGainToWav(wav([1000, -2000]), 0);

    assert.equal(result.applied, true);
    assert.deepEqual(samplesOf(result.buffer, 2), [0, 0]);
  });

  it("refuses a negative gain rather than inverting the waveform", () => {
    const input = wav([1000, -2000]);
    const result = applyGainToWav(input, -1);

    assert.equal(result.buffer, input);
    assert.equal(result.applied, false, "a negative gain is a bug, not a volume");
  });

  it("leaves a buffer it cannot scale exactly as it found it", () => {
    // Guessing the sample width here would rewrite the audio into noise, which
    // is a worse outcome than an engine being the wrong volume.
    const eightBit = wav([100, 200], { bitsPerSample: 8 });
    const result = applyGainToWav(eightBit, 0.5);

    assert.equal(result.buffer, eightBit);
    assert.equal(result.applied, false);
    assert.equal(result.totalSamples, 0);
  });

  it("leaves a non-WAV buffer alone instead of reading it as samples", () => {
    const notWav = Buffer.from("this is not audio at all, it is text", "utf8");
    const result = applyGainToWav(notWav, 0.5);

    assert.equal(result.buffer, notWav);
    assert.equal(result.applied, false);
  });

  it("keeps the format and the header intact", () => {
    const result = applyGainToWav(wav([1000, -2000], { sampleRate: 44100 }), 1.2);
    const parsed = parseWav(result.buffer);

    assert.equal(parsed.fmt.sampleRate, 44100);
    assert.equal(parsed.fmt.numChannels, 1);
    assert.equal(parsed.fmt.bitsPerSample, 16);
    assert.equal(parsed.pcmLength, 4, "the data chunk must not grow or shrink");
  });

  it("scales an utterance to the same samples as scaling its concatenation", () => {
    // The property the fallback depends on: when an utterance fails and is
    // divided, the halves are scaled on their own and then joined — if that
    // differed from scaling the whole, the volume of a reply would depend on
    // whether anything in it had to be retried.
    const left = wav([1000, -2000]);
    const right = wav([3000, -4000]);

    const scaledSeparately = concatWavBuffers([
      applyGainToWav(left, 1.2).buffer,
      applyGainToWav(right, 1.2).buffer,
    ]);
    const scaledWhole = applyGainToWav(concatWavBuffers([left, right]), 1.2).buffer;

    assert.deepEqual(samplesOf(scaledSeparately, 4), samplesOf(scaledWhole, 4));
  });

  it("does not report clipping for a buffer whose data chunk overruns it", () => {
    // A truncated download is the realistic version of this. The header must not
    // be trusted past the bytes that are actually present, or the loop reads
    // undefined samples off the end.
    const truncated = wav([1000, -2000, 3000]).subarray(0, 48);
    const result = applyGainToWav(truncated, 1.2);

    assert.equal(result.applied, true);
    assert.equal(result.totalSamples, 2, "only the samples actually present");
    assert.equal(result.clippedSamples, 0);
  });
});
