// 実際に配信されている画像で「索引破壊の実力」を測る
//  攻撃者の前処理(反転・クロップ・縮小)を考慮した最小距離で評価する(厳しめ)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "idx-"));
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

async function main() {
  const dists = [];
  for (let round = 0; round < 4; round++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    for (const t of (c.tiles || []).slice(0, 5)) {
      try {
        const orig = Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer());
        const served = Buffer.from(await (await fetch(t.url, { headers: UA })).arrayBuffer());
        const hServed = gray(served);
        // 攻撃者が取り得る前処理を全部試して「最も一致するもの」との距離を取る
        const probes = [
          gray(orig),
          gray(orig, "hflip"),
          gray(orig, "crop=iw*0.9:ih*0.9"),
          gray(orig, "crop=iw*0.8:ih*0.8"),
          gray(orig, "hflip,crop=iw*0.9:ih*0.9"),
          gray(orig, "hflip,crop=iw*0.8:ih*0.8"),
          gray(orig, "scale=iw*0.8:ih*0.8"),
          gray(orig, "eq=gamma=1.1"),
        ];
        dists.push(Math.min(...probes.map((h) => ham(h, hServed))));
      } catch {}
    }
  }
  const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
  const min = Math.min(...dists);
  const safe = dists.filter((d) => d >= 14).length;
  console.log(`サンプル ${dists.length}枚`);
  console.log(`  前処理を考慮した最小距離: 平均 ${avg} / 最小 ${min} /64`);
  console.log(`  距離14以上(pHash照合が外れる目安)の割合: ${safe}/${dists.length} = ${(safe / dists.length * 100).toFixed(0)}%`);
  console.log("");
  console.log(`  参考: pHashの一致判定は一般に距離10〜14以下。上回っていれば事前索引から引けない`);
  console.log(`  ※ ただし知覚ハッシュは回転・クロップに頑健なため、これを「絶対安全」とは扱わない`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
