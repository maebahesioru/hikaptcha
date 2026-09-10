// タイル視認性の改善案を実測: 「余白」ではなく「ズーム+微小回転+再圧縮」で
// pHash距離を稼げるか(＝枠で被写体を縮めずに逆検索対策できるか)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const TMP = mkdtempSync(path.join(tmpdir(), "zoom-"));
let seq = 0;
const F = () => path.join(TMP, `f${(seq = (seq + 1) % 100000)}`);

function gray(buf, extra = "") {
  const inp = F() + ".jpg", out = F() + ".gray";
  writeFileSync(inp, buf);
  const vf = extra ? `${extra},scale=8:8,format=gray` : "scale=8:8,format=gray";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-vf", vf, "-f", "rawvideo", out]);
  const px = readFileSync(out);
  const avg = [...px].reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((p) => (p >= avg ? "1" : "0")).join("");
}
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

function tf(buf, { pad = 0, crop = 0, rot = 0, quality = 4, zoom = 0 }) {
  const inp = F() + ".jpg", out = F() + ".jpg";
  writeFileSync(inp, buf);
  const f = [];
  // zoom: 拡大してから中央を元サイズで切る(枠なしで構図が変わる)
  if (zoom > 0) f.push(`scale=iw*${(1 + zoom / 100).toFixed(3)}:ih*${(1 + zoom / 100).toFixed(3)},crop=iw/${(1 + zoom / 100).toFixed(3)}:ih/${(1 + zoom / 100).toFixed(3)}`);
  if (crop > 0) f.push(`crop=iw*${(1 - crop / 100).toFixed(3)}:ih*${(1 - crop / 100).toFixed(3)}`);
  if (pad > 0) f.push(`pad=iw+2*iw*${(pad / 100).toFixed(3)}:ih+2*ih*${(pad / 100).toFixed(3)}:iw*${(pad / 100).toFixed(3)}:ih*${(pad / 100).toFixed(3)}:0x1a1a2e`);
  if (rot) f.push(`rotate=${((rot * Math.PI) / 180).toFixed(6)}:fillcolor=0x1a1a2e`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, ...(f.length ? ["-vf", f.join(",")] : []), "-q:v", String(quality), out]);
  return readFileSync(out);
}

async function main() {
  const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
  const samples = [];
  for (const t of (c.tiles || []).slice(0, 8)) {
    samples.push(Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer()));
  }
  console.log(`サンプル ${samples.length}枚\n`);

  const variants = [
    { name: "改変なし", pad: 0 },
    { name: "ズーム6% + rot1° + q3", zoom: 6, rot: 1, quality: 3 },
    { name: "ズーム10% + rot1.5° + q3", zoom: 10, rot: 1.5, quality: 3 },
    { name: "ズーム14% + rot2° + q2", zoom: 14, rot: 2, quality: 2 },
    { name: "ズーム20% + rot2° + q2", zoom: 20, rot: 2, quality: 2 },
    { name: "ズーム14% + pad6%", zoom: 14, pad: 6, quality: 3 },
    { name: "余白8%(現行候補)", pad: 8, crop: 3, rot: 2, quality: 3 },
  ];
  for (const v of variants) {
    const dists = [];
    for (const o of samples) {
      const h0 = gray(o);
      const t = tf(o, v);
      dists.push(ham(h0, gray(t)));
    }
    const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
    console.log(`  ${v.name.padEnd(28)} 全体距離=${avg.padStart(5)}/64`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
