// 監査データの指定エントリを3x3モンタージュ画像にして、visionで判定できるようにする
//  タイルの並びは row-major(左上→右下)で、audit.json の tiles 順と一致する
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const IDX = Number(process.argv[2] || 0);
const AUDIT = "C:/Users/maeba/Desktop/hikamani-captcha/tag_audit/audit.json";
const OUT = `C:/Users/maeba/Desktop/hikamani-captcha/tag_audit/entry${IDX}.jpg`;
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "aud-"));

async function main() {
  const rows = JSON.parse(readFileSync(AUDIT, "utf8"));
  const r = rows.find((x) => x.idx === IDX);
  if (!r) throw new Error("entry not found");
  const files = [];
  for (let i = 0; i < r.tiles.length; i++) {
    const buf = Buffer.from(await (await fetch(r.tiles[i].url, { headers: UA })).arrayBuffer());
    const p = path.join(TMP, `t${i}.jpg`);
    writeFileSync(p, buf);
    files.push(p);
  }
  const TW = 300, TH = 200;
  // シンプルに scale + tile で並べる(メモリを食うblur合成はしない)
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
  args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "2", OUT);
  execFileSync("ffmpeg", args);

  const pos = ["左上", "上中", "右上", "左中", "中央", "右中", "左下", "下中", "右下"];
  const truth = r.tiles.map((t, i) => `${pos[i]}:${t.target ? "正解" : "ダミー"}`).join(" ");
  console.log(JSON.stringify({ idx: IDX, prompt: r.prompt, mode: r.mode, targetCount: r.targetCount, out: OUT }));
  console.log("真実: " + truth);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
