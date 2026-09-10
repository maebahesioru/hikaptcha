// 監査を一括でやる: 出題取得→タイル即DL→モンタージュ作成→真実を出力
//  (URLはサーバーのメモリ内マップを参照するため、取得とDLは同時に行う必要がある)
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 4);
const PREFIX = process.argv[4] || "case"; // 形式ごとに出力名を分ける(例: not0.jpg)
const EXPECT = process.argv[5] || null; // 期待する形式(違う形式が返ったら捨てる)
const UA = { "user-agent": "Mozilla/5.0" };
const OUTDIR = "C:/Users/maeba/Desktop/hikamani-captcha/tag_audit";
mkdirSync(OUTDIR, { recursive: true });
const POS = ["左上", "上中", "右上", "左中", "中央", "右中", "左下", "下中", "右下"];
const TW = 300, TH = 200;

async function buildMontage(files, out) {
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(`[${i}:v]scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:0x18181b[c${i}]`);
  }
  const layout = [];
  for (let i = 0; i < 9; i++) layout.push(`${(i % 3) * (TW + 4)}_${Math.floor(i / 3) * (TH + 4)}`);
  const filter = parts.join(";") + ";" + Array.from({ length: 9 }, (_, i) => `[c${i}]`).join("") +
    `xstack=inputs=9:layout=${layout.join("|")}:fill=0x18181b[out]`;
  const args = ["-y", "-loglevel", "error"];
  for (const f of files) args.push("-i", f);
  args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "2", out);
  execFileSync("ffmpeg", args);
}

async function main() {
  const results = [];
  for (let n = 0; n < N; n++) {
    let c = null;
    for (let t = 0; t < 6 && !c; t++) {
      try {
        const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
        if (r.ok) {
          const j = await r.json();
          // 期待する形式だけを採用する(古いサーバーの応答を拾わないため)
          if (!EXPECT || j.mode === EXPECT) c = j;
        }
      } catch {}
      if (!c) await new Promise((s) => setTimeout(s, 500));
    }
    if (!c) continue;
    const TMP = mkdtempSync(path.join(tmpdir(), "aud-"));
    const files = [];
    let got = 0;
    for (let i = 0; i < c.tiles.length; i++) {
      try {
        const b = Buffer.from(await (await fetch(c.tiles[i].url, { headers: UA })).arrayBuffer());
        if (b[0] === 0xff && b[1] === 0xd8) got++;
        const p = path.join(TMP, `t${i}.jpg`);
        writeFileSync(p, b);
        files.push(p);
      } catch {}
    }
    const out = path.join(OUTDIR, `${PREFIX}${n}.jpg`);
    try { await buildMontage(files, out); } catch (e) { console.log(`case${n}: montage失敗 ${e.message}`); }
    const truth = c.tiles.map((t, i) => `${POS[i]}=${t.target ? "正解" : "ダミー"}`).join(" ");
    results.push({ n, prompt: c.prompt, mode: c.mode, targets: c.tiles.filter((t) => t.target).length, out, truth, imagesOk: got });
    console.log(`case${n}: 画像${got}/9 [${c.mode}] ${c.prompt} (正解${c.tiles.filter((t) => t.target).length}枚)`);
    console.log(`   真実: ${truth}`);
    await new Promise((s) => setTimeout(s, 600));
  }
  writeFileSync(path.join(OUTDIR, "cases.json"), JSON.stringify(results, null, 1));
  console.log(`\n保存: ${OUTDIR}/cases.json`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
