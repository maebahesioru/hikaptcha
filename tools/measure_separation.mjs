// 仮説の検証: 「正解とダミーの視覚的な分離度」で、不公平な出題を事前に判定できるか。
//
// 失敗の支配要因は「視覚的には該当するのにタグが付いていない画像(誤漏れ)」。
// そういう出題では、正解もダミーも人間には同じに見える → 視覚的な分離が小さいはず。
//   intra = 正解同士の平均距離(小さいほど正解は似ている)
//   inter = 正解とダミーの平均距離(大きいほど見分けやすい)
//   sep   = inter / max(1, intra)  … 1.0未満なら「ダミーの方が正解に近い」
//
// 使い方: node tools/measure_separation.mjs <debugURL> <N> <prefix>
//   → tools/acc/sep-{prefix}.json に指標、truth-{prefix}.json に答えを保存
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 8);
const PREFIX = process.argv[4] || "sep";
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

// サーバーと同じ 8x8 グレースケール署名(配信画像をそのまま使う)
function sigs8x8(dir, n) {
  const args = ["-v", "error"];
  for (let i = 0; i < n; i++) args.push("-i", path.join(dir, `t${i}.jpg`));
  const parts = Array.from({ length: n }, (_, i) => `[${i}:v]scale=8:8,format=gray[a${i}]`).join(";");
  const stack = Array.from({ length: n }, (_, i) => `[a${i}]`).join("") + `vstack=inputs=${n}[out]`;
  args.push("-filter_complex", `${parts};${stack}`, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1 << 20 });
  const sigs = [];
  for (let i = 0; i < n; i++) {
    const px = [...buf.subarray(i * 64, i * 64 + 64)];
    const mean = px.reduce((a, c) => a + c, 0) / 64;
    sigs.push(px.map((v) => (v > mean ? 1 : 0)));
  }
  return sigs;
}
const ham = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

const cases = [];
const metrics = [];
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
  if (!c) { console.log(`case${n}: 取得失敗`); continue; }

  const tmp = mkdtempSync(path.join(tmpdir(), "sep-"));
  const files = [];
  for (const t of c.tiles) {
    const b = Buffer.from(await (await fetch(t.url, { headers: UA })).arrayBuffer());
    const p = path.join(tmp, `t${files.length}.jpg`);
    writeFileSync(p, b);
    files.push(p);
  }
  montage(files, path.join(OUT, `${PREFIX}${n}.jpg`));
  const sigs = sigs8x8(tmp, 9);
  rmSync(tmp, { recursive: true, force: true });

  const tg = c.tiles.map((t, i) => (t.target ? i : -1)).filter((i) => i >= 0);
  const dm = c.tiles.map((t, i) => (t.target ? -1 : i)).filter((i) => i >= 0);

  let intra = 0, nI = 0;
  for (let a = 0; a < tg.length; a++)
    for (let b = a + 1; b < tg.length; b++) { intra += ham(sigs[tg[a]], sigs[tg[b]]); nI++; }
  intra = nI ? intra / nI : 0;
  let inter = 0;
  for (const t of tg) for (const d of dm) inter += ham(sigs[t], sigs[d]);
  inter = dm.length && tg.length ? inter / (tg.length * dm.length) : 0;
  // ダミー側の「最も近い正解との距離」の平均
  let nearest = 0, minDT = 999;
  for (const d of dm) {
    let m = 999;
    for (const t of tg) m = Math.min(m, ham(sigs[d], sigs[t]));
    nearest += m;
    if (m < minDT) minDT = m;
  }
  nearest = dm.length ? nearest / dm.length : 0;
  const sep = inter / Math.max(1, intra);

  cases.push({ n, prompt: c.prompt, mode: c.mode, targets: tg.map((i) => POS[i]), truth: c.tiles.map((t) => (t.target ? 1 : 0)).join("") });
  metrics.push({ n, prompt: c.prompt, mode: c.mode, nTargets: tg.length, intra: +intra.toFixed(1), inter: +inter.toFixed(1), sep: +sep.toFixed(2), nearest: +nearest.toFixed(1), minDT });
  console.log(
    `case${n}: [${c.mode}] ${c.prompt} 正解${tg.length}枚 | intra ${intra.toFixed(1)} / inter ${inter.toFixed(1)} / sep ${sep.toFixed(2)} / ダミー最近 ${nearest.toFixed(1)} (min ${minDT})`
  );
  await new Promise((s) => setTimeout(s, 400));
}

writeFileSync(path.join(OUT, `truth-${PREFIX}.json`), JSON.stringify(cases, null, 1));
writeFileSync(path.join(OUT, `sep-${PREFIX}.json`), JSON.stringify(metrics, null, 1));
console.log(`\n保存: sep-${PREFIX}.json / truth-${PREFIX}.json`);
// 2件ずつ横並び(vision採点用)
for (let i = 0; i + 1 < cases.length; i += 2) {
  try {
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-i", path.join(OUT, `${PREFIX}${i}.jpg`), "-i", path.join(OUT, `${PREFIX}${i + 1}.jpg`),
      "-filter_complex", "[0:v]pad=iw+30:ih:0:0:0x2a2a33[l];[l][1:v]hstack=inputs=2[out]",
      "-map", "[out]", "-q:v", "3", path.join(OUT, `${PREFIX}pair${i / 2}.jpg`),
    ]);
    console.log(`pair${i / 2}: 左=case${i} / 右=case${i + 1}`);
  } catch (e) {
    console.log(`pair${i / 2}: 失敗 ${e.message}`);
  }
}
