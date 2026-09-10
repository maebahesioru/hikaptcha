// 余白(pad)の強度を振って「逆検索対策の効果」と「被写体の見やすさ」の最適点を探す
//  目的: padを小さくしてもpHash距離を稼げるか(＝被写体を大きく見せられるか)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const TMP = mkdtempSync(path.join(tmpdir(), "pad-"));
let seq = 0;

function gray(buf, extra = "") {
  const inp = path.join(TMP, `i${seq}.jpg`);
  const out = path.join(TMP, `o${seq}.gray`);
  seq++;
  writeFileSync(inp, buf);
  const vf = extra ? `${extra},scale=8:8,format=gray` : "scale=8:8,format=gray";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-vf", vf, "-f", "rawvideo", out]);
  const px = readFileSync(out);
  const avg = [...px].reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((p) => (p >= avg ? "1" : "0")).join("");
}
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

function transform(buf, { pad, crop, rot, quality }) {
  const inp = path.join(TMP, `ti${seq}.jpg`);
  const out = path.join(TMP, `to${seq}.jpg`);
  seq++;
  writeFileSync(inp, buf);
  const f = [];
  if (crop > 0) f.push(`crop=iw*${(1 - crop / 100).toFixed(3)}:ih*${(1 - crop / 100).toFixed(3)}`);
  if (pad > 0) f.push(`pad=iw+2*iw*${(pad / 100).toFixed(3)}:ih+2*ih*${(pad / 100).toFixed(3)}:iw*${(pad / 100).toFixed(3)}:ih*${(pad / 100).toFixed(3)}:0x1a1a2e`);
  if (rot) f.push(`rotate=${((rot * Math.PI) / 180).toFixed(6)}:fillcolor=0x1a1a2e`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, ...(f.length ? ["-vf", f.join(",")] : []), "-q:v", String(quality), out]);
  return readFileSync(out);
}

async function main() {
  const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
  const samples = [];
  for (const t of (c.tiles || []).slice(0, 6)) {
    const o = Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer());
    samples.push(o);
  }
  console.log(`サンプル ${samples.length}枚で測定\n`);

  const variants = [
    { pad: 0, crop: 0, rot: 0, quality: 4, name: "改変なし" },
    { pad: 4, crop: 2, rot: 1, quality: 4, name: "pad4% crop2% rot1°" },
    { pad: 6, crop: 3, rot: 1.5, quality: 3, name: "pad6% crop3% rot1.5°" },
    { pad: 8, crop: 3, rot: 2, quality: 3, name: "pad8% crop3% rot2°" },
    { pad: 10, crop: 3, rot: 2, quality: 4, name: "pad10% crop3% rot2°" },
    { pad: 12, crop: 4, rot: 2, quality: 3, name: "pad12% crop4% rot2°" },
    { pad: 15, crop: 5, rot: 2, quality: 4, name: "pad15% crop5% rot2°" },
  ];

  for (const v of variants) {
    const dists = [], centers = [];
    for (const o of samples) {
      const h0 = gray(o);
      const t = transform(o, v);
      const h1 = gray(t);
      dists.push(ham(h0, h1));
      // 中央（余白を除いた領域）同士で内容が保たれているか
      centers.push(ham(gray(o, "crop=iw*0.7:ih*0.7"), gray(t, "crop=iw*0.7:ih*0.7")));
    }
    const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
    console.log(`  ${v.name.padEnd(26)} 全体距離=${avg(dists).padStart(5)}/64  中央距離=${avg(centers).padStart(5)}/64  被写体占有率≈${(100 / (1 + 2 * v.pad / 100)).toFixed(0)}%`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
