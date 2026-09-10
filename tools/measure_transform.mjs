// 画像改変パイプラインの実測: 改変の強度を変えて「元画像との差異」と「処理時間」を測る
//  目的: 逆画像検索・事前インデックス構築を無効化する(元画像と見た目は同じだがバイト/ハッシュが別物)
//  指標: 知覚ハッシュ(pHash)のハミング距離 (0=同一, 大きいほど別物と判定される)
import { createHash } from "node:crypto";

// ---- 純JSでJPEGを扱うための最小デコーダ(ベースラインJPEGのみ) ----
// 外部依存を避けるため、sharp/imagemagickの有無を確認して使える方を使う
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function have(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS_MAGICK = have("magick", ["-version"]) || have("convert", ["-version"]);
const HAS_FFMPEG = have("ffmpeg", ["-version"]);
console.log(`利用可能: ImageMagick=${HAS_MAGICK} ffmpeg=${HAS_FFMPEG}`);

const OUT = mkdtempSync(path.join(tmpdir(), "imgt-"));

async function fetchImg(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  return Buffer.from(await r.arrayBuffer());
}

// pHash(8x8 DCTではなく簡易版: 8x8ブロック平均の中央値比較)
// JPEGを直接デコードせず、ffmpegで8x8グレースケールに落として読む(簡潔・確実)
function pHashViaFfmpeg(buf) {
  const inp = path.join(OUT, "in.jpg");
  const out = path.join(OUT, "out.gray");
  writeFileSync(inp, buf);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", out]);
  const px = readFileSync(out);
  const avg = [...px].reduce((a, b) => a + b, 0) / px.length;
  let bits = "";
  for (const p of px) bits += p >= avg ? "1" : "0";
  return bits;
}
function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

// 改変: 微小クロップ+回転+再圧縮(見た目は保ったままバイト列とハッシュを変える)
function transform(buf, { cropPct, rotateDeg, quality, scale, padPct, bg }) {
  const inp = path.join(OUT, "t_in.jpg");
  const out = path.join(OUT, "t_out.jpg");
  writeFileSync(inp, buf);
  const filters = [];
  if (scale) filters.push(`scale=${scale}:-2`);
  if (cropPct > 0) {
    // 中央を (100-cropPct)% 残して切り出す
    const keep = (100 - cropPct) / 100;
    filters.push(`crop=iw*${keep}:ih*${keep}`);
  }
  if (padPct > 0) {
    // 余白を足して構図を変える(pHashのブロックが大きく動く)
    const px = `iw*${padPct / 100}`;
    filters.push(`pad=iw+2*${px}:ih+2*${px}:${px}:${px}:${bg || "black"}`);
  }
  if (rotateDeg) filters.push(`rotate=${(rotateDeg * Math.PI / 180).toFixed(6)}:fillcolor=black`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, ...(filters.length ? ["-vf", filters.join(",")] : []), "-q:v", String(quality), out]);
  return readFileSync(out);
}

async function main() {
  const url = process.argv[2];
  const orig = await fetchImg(url);
  const h0 = pHashViaFfmpeg(orig);
  const sha0 = createHash("sha256").update(orig).digest("hex").slice(0, 12);
  console.log(`元: ${orig.length}bytes sha=${sha0}`);

  const variants = [
    { name: "無改変(再圧縮のみ)", cropPct: 0, rotateDeg: 0, quality: 3, scale: null },
    { name: "中: crop6% + rot1.5°", cropPct: 6, rotateDeg: 1.5, quality: 4, scale: null },
    { name: "余白10%(黒)", cropPct: 0, rotateDeg: 0, quality: 4, scale: null, padPct: 10, bg: "black" },
    { name: "余白15%(ランダム色)", cropPct: 0, rotateDeg: 0, quality: 4, scale: null, padPct: 15, bg: "0x3366aa" },
    { name: "余白20%+縮小", cropPct: 0, rotateDeg: 0, quality: 4, scale: 300, padPct: 20, bg: "0x224466" },
    { name: "余白15%+crop5%+rot1°", cropPct: 5, rotateDeg: 1, quality: 5, scale: null, padPct: 15, bg: "0x442266" },
  ];
  for (const v of variants) {
    const t0 = Date.now();
    const out = transform(orig, v);
    const ms = Date.now() - t0;
    const h1 = pHashViaFfmpeg(out);
    const sha1 = createHash("sha256").update(out).digest("hex").slice(0, 12);
    console.log(
      `  ${v.name.padEnd(26)} 距離=${String(hamming(h0, h1)).padStart(2)}/64 ` +
      `sha一致=${sha1 === sha0} ${out.length}bytes ${ms}ms`
    );
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
