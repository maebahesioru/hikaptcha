// クロップ(内容を拡大)で索引破壊できるか実測。反転を考慮した攻撃者でも効くかを見る
//  クロップは「被写体がタイル内で大きくなる」ので視認性にもプラス
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "crop-"));
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

// 攻撃者が取り得る前処理(反転・クロップ・縮小)を考慮して「索引一致のしやすさ」を測る
function minDistanceAgainst(orig, served) {
  const hServed = gray(served);
  const variants = [
    gray(orig),
    gray(orig, "hflip"),
    gray(orig, "crop=iw*0.9:ih*0.9"),
    gray(orig, "crop=iw*0.8:ih*0.8"),
    gray(orig, "hflip,crop=iw*0.9:ih*0.9"),
    gray(orig, "crop=iw*0.8:ih*0.8,scale=iw*1.25:ih*1.25"),
  ];
  return Math.min(...variants.map((h) => ham(h, hServed)));
}

async function main() {
  const samples = [];
  for (let r = 0; r < 2; r++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    for (const t of (c.tiles || []).slice(0, 6)) {
      try { samples.push(Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer())); } catch {}
    }
  }
  console.log(`サンプル ${samples.length}枚 / 攻撃者の前処理(反転・クロップ・縮小)を考慮した最小距離\n`);

  const variants = [
    { name: "改変なし", f: ["scale=iw:ih"] },
    { name: "クロップ15%", f: ["crop=iw*0.85:ih*0.85"] },
    { name: "クロップ25%", f: ["crop=iw*0.75:ih*0.75"] },
    { name: "クロップ35%", f: ["crop=iw*0.65:ih*0.65"] },
    { name: "クロップ45%", f: ["crop=iw*0.55:ih*0.55"] },
    { name: "クロップ35%+反転", f: ["hflip", "crop=iw*0.65:ih*0.65"] },
    { name: "クロップ35%+回転", f: ["crop=iw*0.65:ih*0.65", "rotate=0.0873:fillcolor=black"] },
    { name: "クロップ35%+余白6%", f: ["crop=iw*0.65:ih*0.65", "pad=iw*1.12:ih*1.12:iw*0.06:ih*0.06:black"] },
  ];
  for (const v of variants) {
    const dists = [];
    for (const o of samples) {
      try { dists.push(minDistanceAgainst(o, tf(o, v.f))); } catch {}
    }
    const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
    const min = Math.min(...dists);
    console.log(`  ${v.name.padEnd(24)} 最小距離 平均${avg.padStart(5)} 最小${String(min).padStart(2)} /64`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
