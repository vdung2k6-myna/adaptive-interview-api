/**
 * 7.1's measurement: what a material turn's locator request scores on the
 * development corpus, in scope and out.
 *
 * The request this issues is the turn's own locator request — `top_k: 1` scoped
 * to the speakable collections — so the numbers printed here are the numbers the
 * gate actually sees, not a proxy for them. Run it against a live doc-etl-api:
 *
 *   node scripts/measure-material-floor.mjs
 *
 * The full table (including the Vietnamese queries as written) is written to
 * `D:/tmp/material-floor.json`; stdout carries an ASCII-only summary, because
 * this shell mangles UTF-8 on the way out.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const SERVICE = process.env.DOC_ETL_API_URL || "http://127.0.0.1:8000";
/** The collections a development deployment speaks (MATERIAL_COLLECTIONS). */
const SPEAKABLE = ["truyen-kiem-hiep", "kiem-hiep"];
const FLOOR_UNDER_TEST = Number(process.env.MATERIAL_SCORE_FLOOR || 0.55);

/** In scope: turns about what the speakable corpus actually holds. */
const IN_SCOPE = [
  ["in-1", "Đả Cẩu Bổng Pháp là gì?"],
  ["in-2", "Ai là nhân vật chính trong Anh hùng xạ điêu?"],
  ["in-3", "Kể cho tôi về Thần điêu hiệp lữ"],
  ["in-4", "Ngọc Nữ Công luyện như thế nào?"],
  ["in-5", "Đoạn Chỉ Thần Công có tác dụng gì?"],
  ["in-6", "Võ Mục Di Thư nói về cái gì?"],
  ["in-7", "Huyền Thiết Trọng Kiếm của ai?"],
  ["in-8", "Lạc Anh Thần Kiếm Chưởng mạnh ở điểm nào?"],
];

/** In scope, asked vaguely: the same corpus, but the turn does not name a source. */
const IN_SCOPE_VAGUE = [
  ["vague-1", "kể cho tôi một câu chuyện kiếm hiệp"],
  ["vague-2", "kiếm hiệp là gì"],
  ["vague-3", "kể chuyện kiếm hiệp cho tôi nghe"],
  ["vague-4", "có truyện kiếm hiệp nào hay không"],
  ["vague-5", "võ công trong truyện kiếm hiệp"],
  ["vague-6", "nhân vật trong truyện kiếm hiệp"],
  ["vague-7", "truyen kiem hiep"],
  ["vague-8", "cho tôi nghe về chuyện kiếm hiệp"],
];

/** Out of scope: ordinary turns from the same user, about anything else. */
const OUT_OF_SCOPE = [
  ["out-1", "Làm sao để nấu phở bò ngon?"],
  ["out-2", "Thời tiết Hà Nội ngày mai thế nào?"],
  ["out-3", "Cách học tiếng Anh hiệu quả cho người mới?"],
  ["out-4", "Giá vàng hôm nay bao nhiêu một lượng?"],
  ["out-5", "Tôi nên tập thể dục bao nhiêu phút mỗi ngày?"],
  ["out-6", "Cách chăm sóc người lớn tuổi tại nhà?"],
  ["out-7", "Lập trình Python cho người mới bắt đầu"],
  ["out-8", "Luật giao thông khi đi xe máy ở Việt Nam"],
];

/** Issue one locator request — the turn's own — and report what it scored. */
async function locate(query) {
  const response = await fetch(`${SERVICE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: 1, collections: SPEAKABLE }),
  });
  if (!response.ok) {
    return { score: null, error: `HTTP ${response.status}` };
  }
  const body = await response.json();
  const [hit] = body.results ?? [];
  if (!hit) {
    return { score: null, error: "no result" };
  }
  return {
    score: hit.score ?? null,
    source: hit.source_name ?? "",
    address: hit.address ?? null,
    collections: hit.collections ?? null,
    hasRouting: hit.address != null && hit.collections != null && hit.position != null,
  };
}

const measure = async (group, queries) =>
  Promise.all(
    queries.map(async ([label, query]) => ({ label, group, query, ...(await locate(query)) }))
  );

const rows = [
  ...(await measure("in-scope", IN_SCOPE)),
  ...(await measure("in-scope-vague", IN_SCOPE_VAGUE)),
  ...(await measure("out-of-scope", OUT_OF_SCOPE)),
];

mkdirSync("D:/tmp", { recursive: true });
writeFileSync("D:/tmp/material-floor.json", JSON.stringify({ service: SERVICE, speakable: SPEAKABLE, rows }, null, 2));

const scores = (group) =>
  rows.filter((row) => row.group === group && typeof row.score === "number").map((row) => row.score);
const inScores = scores("in-scope");
const vagueScores = scores("in-scope-vague");
const outScores = scores("out-of-scope");
const round = (value) => Number(value.toFixed(3));

console.log(`service ${SERVICE}  speakable ${SPEAKABLE.join(",")}  floor-under-test ${FLOOR_UNDER_TEST}`);
for (const row of rows) {
  console.log(
    `${row.label.padEnd(6)} ${String(row.score === null ? row.error : round(row.score)).padStart(6)}` +
      `  routing=${row.hasRouting ? "yes" : "NO"}  ${row.source}`
  );
}

const worst = Math.max(...outScores);
const best = Math.min(...inScores);
console.log(`\nin-scope named   n=${inScores.length} min ${round(best)} max ${round(Math.max(...inScores))}`);
console.log(
  `in-scope vague   n=${vagueScores.length} min ${round(Math.min(...vagueScores))} max ${round(Math.max(...vagueScores))}`
);
console.log(`out-of-scope     n=${outScores.length} min ${round(Math.min(...outScores))} max ${round(worst)}`);
console.log(`gap: every off-topic probe is below ${round(worst)}, every named in-scope one is above ${round(best)}`);

if (best <= worst) {
  console.log(`OVERLAP — no floor separates these probes; the in-scope minimum is under the out-of-scope maximum`);
} else {
  console.log(`separable: any floor in (${round(worst)}, ${round(best)}] refuses every off-topic probe and reads every named in-scope one`);
}

for (const floor of [0.45, 0.5, 0.52, 0.55, 0.6, 0.635, 0.65]) {
  const refusedInScope = inScores.filter((score) => score < floor).length;
  const refusedVague = vagueScores.filter((score) => score < floor).length;
  const spokenOutOfScope = outScores.filter((score) => score >= floor).length;
  console.log(
    `floor ${floor.toFixed(3)}: generates ${refusedInScope}/${inScores.length} named in-scope, ` +
      `${refusedVague}/${vagueScores.length} vague in-scope, speaks ${spokenOutOfScope}/${outScores.length} off-topic`
  );
}
