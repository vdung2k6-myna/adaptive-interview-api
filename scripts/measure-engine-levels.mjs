/**
 * What each engine's audio levels at, and what the configured per-engine volume
 * (`config.audio.volume`) makes of it.
 *
 * The point of the volume map is that the engines do not agree on loudness, so
 * this prints the disagreement — peak and RMS per engine, before and after the
 * gain — and how much of each would clip. Run it against a live gateway:
 *
 *   node scripts/measure-engine-levels.mjs
 *
 * Voices and gains come from the same environment variables the app reads
 * (`*_VOICE_VIETNAMESE`, `*_VOLUME`), so this measures the configuration that
 * would actually be deployed rather than a second opinion about it. The two
 * exceptions are deliberate: an engine whose Vietnamese voice is unset falls back
 * to a voice the gateway is known to hold, because a measurement of nothing is
 * not a measurement, and the gain falls back to the shipped default.
 *
 * Output is ASCII only — this shell mangles UTF-8 on the way out — so the
 * sentence being spoken is never printed, only the numbers.
 */
const GATEWAY = process.env.AUDIO_GATEWAY_URL || "http://127.0.0.1:8082";

/** Four sentences of a real interviewer reply, so the level is measured on the
 * text the product actually speaks rather than on a word. */
const TEXT =
  "Chào bạn, rất vui được gặp bạn hôm nay. Tôi sẽ hỏi bạn một vài câu về kinh nghiệm của bạn. " +
  "Trước tiên, bạn có thể giới thiệu ngắn gọn về bản thân và 3 năm kinh nghiệm gần nhất của bạn không? " +
  "Sau đó chúng ta sẽ nói về 2 dự án mà bạn tâm đắc nhất.";

const CASES = [
  {
    engine: "supertonic",
    voice: process.env.SUPERTONIC_VOICE_VIETNAMESE || "F1",
    gain: Number(process.env.SUPERTONIC_VOLUME ?? 1.2),
  },
  {
    engine: "kokoro",
    voice: process.env.KOKORO_VOICE_VIETNAMESE || "diem_trinh",
    gain: Number(process.env.KOKORO_VOLUME ?? 0.5),
  },
  {
    engine: "piper",
    voice: process.env.PIPER_VOICE_VIETNAMESE || "vi_VN-vais1000-medium",
    gain: Number(process.env.PIPER_VOLUME ?? 0.7),
  },
];

const dBFS = (amplitude) =>
  amplitude <= 0 ? "-inf" : (20 * Math.log10(amplitude / 32768)).toFixed(1);

/** The PCM out of a WAV, found by walking the chunks rather than assuming the
 * header is the canonical 44 bytes. */
function pcmOf(wav) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const rows = [];

for (const { engine, voice, gain } of CASES) {
  const res = await fetch(`${GATEWAY}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: TEXT, engine, voice }),
  });

  if (!res.ok) {
    console.log(`${engine.padEnd(11)} HTTP ${res.status} ${(await res.text()).slice(0, 90)}`);
    continue;
  }

  const wav = Buffer.from(await res.arrayBuffer());
  const pcm = pcmOf(wav);
  const samples = Math.floor(pcm.length / 2);

  let peak = 0;
  let sumSq = 0;
  let wouldClip = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const amplitude = Math.abs(sample);
    if (amplitude > peak) peak = amplitude;
    sumSq += sample * sample;
    if (amplitude * gain > 32767) wouldClip++;
  }
  const rms = Math.sqrt(sumSq / samples);

  rows.push({
    engine,
    voice,
    gain,
    sampleRate: wav.readUInt32LE(24),
    peak,
    rms,
    scaledPeak: Math.min(peak * gain, 32767),
    scaledRms: rms * gain,
    clipped: wouldClip,
    samples,
  });
}

const col = (value, width) => String(value).padStart(width);

console.log(`\n${"engine".padEnd(11)} ${"voice".padEnd(24)} ${"gain".padStart(5)} ${"rate".padStart(6)}`);
console.log("-".repeat(52));
for (const r of rows) {
  console.log(
    `${r.engine.padEnd(11)} ${r.voice.padEnd(24)} ${col(r.gain, 5)} ${col(r.sampleRate, 6)}`
  );
}

console.log(`\n${"engine".padEnd(11)} ${"peak".padStart(8)} ${"rms".padStart(8)}   ${"-> peak".padStart(8)} ${"rms".padStart(8)}   clipped`);
console.log("-".repeat(64));
for (const r of rows) {
  console.log(
    `${r.engine.padEnd(11)} ${col(dBFS(r.peak), 8)} ${col(dBFS(r.rms), 8)}   ` +
      `${col(dBFS(r.scaledPeak), 8)} ${col(dBFS(r.scaledRms), 8)}   ` +
      `${r.clipped}/${r.samples} (${((100 * r.clipped) / r.samples).toFixed(3)}%)`
  );
}

if (rows.length > 1) {
  // A spread in dB is a difference of levels, not a difference of amplitudes —
  // subtracting two PCM amplitudes would be arithmetic on the wrong scale.
  const spreadDb = (amplitudes) => {
    const levels = amplitudes.map((a) => 20 * Math.log10(a / 32768));
    return (Math.max(...levels) - Math.min(...levels)).toFixed(1);
  };
  console.log(
    `\nRMS spread across engines: ${spreadDb(rows.map((r) => r.rms))} dB before gain, ` +
      `${spreadDb(rows.map((r) => r.scaledRms))} dB after`
  );
}
