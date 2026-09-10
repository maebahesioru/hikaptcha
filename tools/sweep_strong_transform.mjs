// 幾何列挙(反転×クロップ×回転×ガンマ)に耐える改変を探す
//  pHashは幾何変換に頑健なので、幾何では破れない。非幾何の改変を試す
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "strong-"));
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

// 強い攻撃者: 反転×クロップ×回転×ガンマ を全部試す
function strongestMatch(orig, served) {
  const hServed = gray(served);
  const pre = [];
  for (const fl of ["", "hflip,"]) {
    for (const cr of ["", "crop=iw*0.85:ih*0.85,", "crop=iw*0.7:ih*0.7,"]) {
      for (const rt of ["", "rotate=-0.05:fillcolor=black,", "rotate=0.05:fillcolor=black,"]) {
        for (const gm of ["", "eq=gamma=1.1"]) {
          pre.push(gray(orig, (fl + cr + rt + gm).replace(/,$/, "")));
        }
      }
    }
  }
  return Math.min(...pre.map((h) => ham(h, hServed)));
}

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
    for (const t of (c.tiles || []).slice(0, 5)) {
      try { samples.push(Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer())); } catch {}
    }
  }
  console.log(`サンプル ${samples.length}枚 / 攻撃者: 反転×クロップ(0.85,0.7)×回転(±3°)×ガンマ の18通り\n`);

  const variants = [
    { name: "現行(crop+flip+rot+gamma)", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "rotate=0.017:fillcolor=black", "eq=gamma=1.05"] },
    { name: "+シアー", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "shear=0.06:0", "rotate=0.017:fillcolor=black"] },
    { name: "+透視", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "perspective=x0=0:y0=0:x1=iw:y1=0:x2=0:y2=ih:x3=iw*0.96:y3=ih"] },
    { name: "+ぼかし1.5", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "gblur=sigma=1.5"] },
    { name: "+ノイズ強", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "noise=alls=25:allf=t+u"] },
    { name: "+ピクセル化", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "scale=iw/6:ih/6,scale=iw*6:ih*6"] },
    { name: "+オーバーレイ文字", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "drawtext=text='HK':fontsize=h/6:x=(w-tw)/2:y=(h-th)/2:fontcolor=white@0.45:box=1:boxcolor=black@0.25"] },
    { name: "+グラデ重ね", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "geq=r='r(X,Y)*0.8+40':g='g(X,Y)*0.8+40':b='b(X,Y)*0.8+40'"] },
    { name: "+ぼかし+ノイズ+文字", f: ["crop=min(iw\\,ih*1.5):min(ih\\,iw/1.5)", "gblur=sigma=1.2", "noise=alls=15:allf=t", "drawtext=text='HK':fontsize=h/7:x=(w-tw)/2:y=(h-th)/2:fontcolor=white@0.4"] },
  ];
  for (const v of variants) {
    const dists = [];
    for (const o of samples) {
      try { dists.push(strongestMatch(o, tf(o, v.f))); } catch {}
    }
    const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
    const min = Math.min(...dists);
    const pct = (dists.filter((d) => d >= 14).length / dists.length * 100).toFixed(0);
    console.log(`  ${v.name.padEnd(26)} 距離 平均${avg.padStart(5)} 最小${String(min).padStart(2)} /64  14以上の割合 ${pct}%`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
