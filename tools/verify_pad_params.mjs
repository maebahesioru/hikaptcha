// 改変の最終検証:
//  A) 索引破壊: 配信画像 vs 元画像 の pHash距離が十分大きいか(反転を考慮した最小距離で判定)
//  B) 内容保持: 配信画像から余白を除去した領域 vs 元画像 が一致するか
// デバッグコピーの配信画像は x-hkc-pad ヘッダで余白率を返す前提
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "fin-"));
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
  const indexDists = [], contentDists = [], pads = [];
  for (let round = 0; round < 4; round++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    for (const t of (c.tiles || []).slice(0, 6)) {
      try {
        const orig = Buffer.from(await (await fetch(t.originalUrl, { headers: UA })).arrayBuffer());
        const rr = await fetch(t.url, { headers: UA });
        const served = Buffer.from(await rr.arrayBuffer());
        const pad = Number(rr.headers.get("x-hkc-pad") || 0); // 配信時の余白率(%)
        pads.push(pad);

        // A) 索引破壊: 反転を考慮して「一致しやすさ」の最小値を取る
        const hOrig = gray(orig);
        const hFlip = gray(orig, "hflip");
        const hServed = gray(served);
        indexDists.push(Math.min(ham(hOrig, hServed), ham(hFlip, hServed)));

        // B) 内容保持: 配信画像の余白を切り落としてから比較(元画像も同率で切り落とす)
        const keep = (1 - (2 * pad) / 100).toFixed(3); // 余白は左右(上下)それぞれ pad% なので内側は 1-2pad
        const inner = keep > 0.5 ? `crop=iw*${keep}:ih*${keep},hflip` : "hflip";
        contentDists.push(ham(gray(orig, `crop=iw*${keep}:ih*${keep}`), gray(served, inner)));
      } catch {}
    }
  }
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  const min = Math.min(...indexDists);
  console.log(`サンプル ${indexDists.length}枚 / 余白率 ${Math.min(...pads)}〜${Math.max(...pads)}%`);
  console.log(`A) 索引破壊  : pHash距離 平均 ${avg(indexDists)} (最小 ${min}) /64`);
  console.log(`B) 内容保持  : 余白除去後の一致 平均 ${avg(contentDists)} /64 (小さいほど元と一致)`);
  console.log("");
  console.log(`${Number(avg(indexDists)) >= 20 && min >= 10 ? "✅" : "❌"} 索引破壊: 平均20以上かつ最小10以上`);
  console.log(`${Number(avg(contentDists)) <= 14 ? "✅" : "❌"} 内容保持: 余白除去後に元画像と一致`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
