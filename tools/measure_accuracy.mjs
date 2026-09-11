// 「タグの精度」を毎回同じ条件で測るための土台。
//
// 出すもの:
//   - 出題をN件生成し、各9枚のモンタージュ画像を作る(視覚での採点用)
//   - truth.json に「お題・モード・正解の位置」を記録
//   - 2件ずつ横に並べた -pair.jpg も作る(visionの呼び出し回数を半分にする)
//
// 使い方: node tools/measure_accuracy.mjs <debugURL> <N> <prefix>
//   → tools/acc/{prefix}0.jpg ... と tools/acc/truth-{prefix}.json
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 6);
const PREFIX = process.argv[4] || "base";
const OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tools/acc";
const UA = { "user-agent": "Mozilla/5.0" };
const POS = ["左上", "上中", "右上", "左中", "中央", "右中", "左下", "下中", "右下"];
const TW = 300, TH = 200;

mkdirSync(OUT, { recursive: true });

function montage(files, out) {
  const parts = files.map(
    (f, i) =>
      `[${i}:v]scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:0x18181b[c${i}]`
  );
  const layout = [];
  for (let i = 0; i < 9; i++) layout.push(`${(i % 3) * (TW + 4)}_${Math.floor(i / 3) * (TH + 4)}`);
  const filter =
    parts.join(";") + ";" + Array.from({ length: 9 }, (_, i) => `[c${i}]`).join("") +
    `xstack=inputs=9:layout=${layout.join("|")}:fill=0x18181b[out]`;
  const args = ["-y", "-loglevel", "error"];
  for (const f of files) args.push("-i", f);
  args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "3", out);
  execFileSync("ffmpeg", args);
}

// 2枚を横に並べる(間に余白を入れて境界を分かりやすくする)
function sideBySide(a, b, out) {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", a, "-i", b,
    "-filter_complex", "[0:v]pad=iw+30:ih:0:0:0x2a2a33[l];[l][1:v]hstack=inputs=2[out]",
    "-map", "[out]", "-q:v", "3", out,
  ]);
}

const cases = [];
for (let n = 0; n < N; n++) {
  let c = null;
  for (let t = 0; t < 4 && !c; t++) {
    try {
      const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
      if (r.ok) {
        const j = await r.json();
        if (j && j.tiles && j.tiles[0].target !== undefined) c = j;
      }
    } catch {}
    if (!c) await new Promise((s) => setTimeout(s, 500));
  }
  if (!c) { console.log(`case${n}: 取得失敗(srcの無いサーバー?)`); continue; }

  const tmp = mkdtempSync(path.join(tmpdir(), "acc-"));
  const files = [];
  for (const t of c.tiles) {
    const b = Buffer.from(await (await fetch(t.url, { headers: UA })).arrayBuffer());
    const p = path.join(tmp, `t${files.length}.jpg`);
    writeFileSync(p, b);
    files.push(p);
  }
  const out = path.join(OUT, `${PREFIX}${n}.jpg`);
  montage(files, out);
  const targets = c.tiles.map((t, i) => (t.target ? POS[i] : null)).filter(Boolean);
  cases.push({ n, prompt: c.prompt, mode: c.mode, targets, truth: c.tiles.map((t) => (t.target ? 1 : 0)).join("") });
  console.log(`case${n}: [${c.mode}] ${c.prompt} (正解${targets.length}枚: ${targets.join(",")})`);
  rmSync(tmp, { recursive: true, force: true });
  await new Promise((s) => setTimeout(s, 400));
}

// 2件ずつ横並びにした版も作る(visionの呼び出しを半分にする)
for (let i = 0; i + 1 < cases.length; i += 2) {
  const a = path.join(OUT, `${PREFIX}${i}.jpg`);
  const b = path.join(OUT, `${PREFIX}${i + 1}.jpg`);
  const out = path.join(OUT, `${PREFIX}pair${i / 2}.jpg`);
  try {
    sideBySide(a, b, out);
    console.log(`pair${i / 2}: 左=case${i} 「${cases[i].prompt}」 / 右=case${i + 1} 「${cases[i + 1].prompt}」`);
  } catch (e) {
    console.log(`pair${i / 2}: 生成失敗 ${e.message}`);
  }
}

writeFileSync(path.join(OUT, `truth-${PREFIX}.json`), JSON.stringify(cases, null, 1));
console.log(`\n保存: ${OUT}truth-${PREFIX}.json`);
