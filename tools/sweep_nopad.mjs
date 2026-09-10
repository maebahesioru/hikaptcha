// 余白(pad)を使わずに索引破壊できるフィルタ組み合わせを探す
//  条件: 内容を一切削らない(反転・回転・アスペクト・ガンマ・ノイズ・ぼかし)
//  → padを0にできれば、タイル内で画像を最大限大きく表示できる
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "nopad-"));
let n = 0;
const F = () => path.join(TMP, `f${(n = (n + 1) % 100000)}`);

function gray(buf, extra = "") {
  const i = F() + ".jpg", o = F() + ".gray";
  writeFileSync(i, buf);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", i, "-vf", `${extra ? extra + "," : ""}scale=8:8,format=gray`, "-f", "rawvideo", o]);
  const px = readFileSync(o);
  const avg = [...px].reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((p) => (p >= avg ? "1" : "0")).join("");
}
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

function tf(buf, filters) {
  const i = F() + ".jpg", o = F() + ".jpg";
  writeFileSync(i, buf);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", i, "-vf", filters.join(","), "-q:v", "3", o]);
  return readFileSync(o);
}

async function main() {
  const samples = [];
  for (let r = 0; r < 2; r++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    for (const t of (c.tiles || []).slice(0, 6)) {
      try { samples.push(Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer())); } catch {}
    }
  }
  console.log(`サンプル ${samples.length}枚\n`);

  const variants = [
    { name: "反転のみ", f: ["hflip"] },
    { name: "反転+回転3°", f: ["hflip", "rotate=0.05236:fillcolor=black"] },
    { name: "反転+アスペクト±8%", f: ["hflip", "scale=iw*1.08:ih*0.94"] },
    { name: "反転+回転3°+アスペクト", f: ["hflip", "scale=iw*1.08:ih*0.94", "rotate=0.05236:fillcolor=black"] },
    { name: "上+ガンマ", f: ["hflip", "scale=iw*1.08:ih*0.94", "rotate=0.05236:fillcolor=black", "eq=gamma=1.08"] },
    { name: "上+ぼかし", f: ["hflip", "scale=iw*1.08:ih*0.94", "rotate=0.05236:fillcolor=black", "eq=gamma=1.08", "gblur=sigma=0.8"] },
    { name: "上+ノイズ", f: ["hflip", "scale=iw*1.08:ih*0.94", "rotate=0.05236:fillcolor=black", "eq=gamma=1.08", "noise=alls=8:allf=t"] },
    { name: "上+クロップ4%", f: ["hflip", "scale=iw*1.08:ih*0.94", "rotate=0.05236:fillcolor=black", "eq=gamma=1.08", "crop=iw*0.96:ih*0.96"] },
  ];
  for (const v of variants) {
    const dists = [];
    for (const o of samples) {
      try {
        const h0 = gray(o);
        const hf = gray(o, "hflip");
        const t = tf(o, v.f);
        const h1 = gray(t);
        // 反転を考慮して「索引から引かれやすさ」の最小値を取る
        dists.push(Math.min(ham(h0, h1), ham(hf, h1)));
      } catch {}
    }
    const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
    const min = Math.min(...dists);
    console.log(`  ${v.name.padEnd(26)} 距離 平均${avg.padStart(5)} 最小${String(min).padStart(2)} /64`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
