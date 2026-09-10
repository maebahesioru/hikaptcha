// 画像改変の効果測定(ライブ経路の実測)
//  1) 配信画像(改変済み) vs 元画像 → pHash距離が大きい(逆検索・事前索引が壊れる)
//  2) 配信画像の中央(余白を除いた部分) vs 元画像 → pHash距離が小さい(被写体は保たれている)
// デバッグコピー(:3108)の payload に originalUrl が入っている前提
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const TMP = mkdtempSync(path.join(tmpdir(), "phash-"));

function gray(buf, extraFilters = "") {
  const inp = path.join(TMP, "in.jpg");
  const out = path.join(TMP, "out.gray");
  writeFileSync(inp, buf);
  const vf = extraFilters ? `${extraFilters},scale=8:8,format=gray` : "scale=8:8,format=gray";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-vf", vf, "-f", "rawvideo", out]);
  const px = readFileSync(out);
  const avg = [...px].reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((p) => (p >= avg ? "1" : "0")).join("");
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? " → " + detail : ""}`); }
}

async function main() {
  const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
  if (!c.tiles || !c.tiles[0].originalUrl) {
    console.log("デバッグコピーに originalUrl がありません(python tools/make_debug_copy.py を再実行)");
    process.exit(1);
  }
  console.log(`お題「${c.prompt}」で測定`);

  const dists = [], contentDists = [], shas = [];
  for (const t of c.tiles.slice(0, 5)) {
    const served = Buffer.from(await (await fetch(t.url, { headers: UA })).arrayBuffer());
    const orig = Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer());
    const hOrig = gray(orig);
    const hServed = gray(served);
    // 余白を除いた中央60%を切り出して比較(被写体が保たれているかの確認)
    const hCenter = gray(served, "crop=iw*0.6:ih*0.6");
    const hOrigCenter = gray(orig, "crop=iw*0.6:ih*0.6");
    const dAll = hamming(hOrig, hServed);
    const dCenter = hamming(hOrigCenter, hCenter);
    dists.push(dAll);
    contentDists.push(dCenter);
    shas.push(createHash("sha256").update(served).digest("hex").slice(0, 8) !== createHash("sha256").update(orig).digest("hex").slice(0, 8));
  }

  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  console.log(`  配信 vs 元     : pHash距離 平均${avg(dists)}/64 (大きい=逆検索が壊れる)`);
  console.log(`  中央同士の比較 : pHash距離 平均${avg(contentDists)}/64 (小さい=被写体は保たれている)`);
  check("配信画像は元画像と別物(逆検索・事前索引が無効)", Number(avg(dists)) >= 20, `平均${avg(dists)}/64`);
  check("被写体は保たれている(中央の比較で近い)", Number(avg(contentDists)) <= 14, `平均${avg(contentDists)}/64`);
  check("全画像でバイト列が元と不一致(完全一致キャッシュも無効)", shas.every(Boolean));

  console.log(`\n=== 合計: ${pass} PASS / ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
