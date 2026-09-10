// ユーザーから見た「9枚がどれくらい似通っているか」を実測する
//  指標: 9枚の画像を8x8グレースケール署名にして、全ペアのハミング距離の平均
//        (大きいほど多様 = ユーザーの「なんとなく似通ってる」が改善したかが分かる)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 10);
const UA = { "user-agent": "Mozilla/5.0" };

function sigsBatch(bufs) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(tmpdir(), "div-"));
    const files = bufs.map((b, i) => { const f = path.join(dir, `i${i}.jpg`); writeFileSync(f, b); return f; });
    const args = ["-v", "error"];
    for (const f of files) args.push("-i", f);
    const parts = bufs.map((_, i) => `[${i}:v]scale=8:8,format=gray[a${i}]`).join(";");
    const stack = bufs.map((_, i) => `[a${i}]`).join("") + `vstack=inputs=${bufs.length}[out]`;
    args.push("-filter_complex", `${parts};${stack}`, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    const p = spawn("ffmpeg", args);
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("close", (code) => {
      const out = Buffer.concat(chunks);
      const sigs = [];
      for (let i = 0; i < bufs.length; i++) {
        const px = [...out.subarray(i * 64, i * 64 + 64)];
        if (px.length < 64) return resolve(null);
        const mean = px.reduce((a, c) => a + c, 0) / 64;
        sigs.push(px.map((v) => (v > mean ? 1 : 0)));
      }
      try { for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f)); rmdirSync(dir); } catch {}
      resolve(code === 0 ? sigs : null);
    });
    p.on("error", () => resolve(null));
  });
}

const ham = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

const all = [];
for (let k = 0; k < N; k++) {
  let c = null;
  for (let t = 0; t < 4 && !c; t++) {
    try { const r = await fetch(`${URL_}/api/challenge`, { headers: UA }); if (r.ok) c = await r.json(); } catch {}
    if (!c) await new Promise((s) => setTimeout(s, 600));
  }
  if (!c) { console.log("取得失敗"); continue; }
  const bufs = await Promise.all(c.tiles.map(async (t) => {
    const r = await fetch(t.url, { headers: UA });
    return Buffer.from(await r.arrayBuffer());
  }));
  const sigs = await sigsBatch(bufs);
  if (!sigs) { console.log("署名失敗"); continue; }
  let s = 0, n = 0, worst = 64;
  for (let i = 0; i < sigs.length; i++)
    for (let j = i + 1; j < sigs.length; j++) { const d = ham(sigs[i], sigs[j]); s += d; n++; if (d < worst) worst = d; }
  const mean = s / n;
  all.push(mean);
  console.log(`[${c.mode}] 「${c.prompt.slice(0, 34)}」 平均距離 ${mean.toFixed(1)} / 最も似たペア ${worst}`);
  await new Promise((s) => setTimeout(s, 300));
}
if (all.length) {
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  all.sort((a, b) => a - b);
  console.log(`\n=== 平均 ${avg.toFixed(1)} / 中央値 ${all[Math.floor(all.length / 2)].toFixed(1)} (${all.length}件) ===`);
  console.log("※ 64bit中でこの値が大きいほど「9枚がバラバラ」= 見た目が多様");
}
