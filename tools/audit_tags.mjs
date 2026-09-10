// タグ精度を実測する: 各出題について「お題の対象が画像から判別できるか」を評価し、
// 正解タイル(サーバーの真実)と突き合わせて「人間に解ける問題か」を測る。
//
// 出力: 出題ごとに JSON を書き出す(visionで判定するため、親エージェントが読む)。
// デバッグコピー(:3108)の payload に target が入っている前提。
import { writeFileSync, mkdirSync } from "node:fs";

const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 6);
const UA = { "user-agent": "Mozilla/5.0" };
const OUTDIR = "C:/Users/maeba/Desktop/hikamani-captcha/tag_audit";
mkdirSync(OUTDIR, { recursive: true });

async function main() {
  const rows = [];
  for (let i = 0; i < N; i++) {
    let c;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
        if (r.ok) { c = await r.json(); break; }
      } catch {}
      await new Promise((s) => setTimeout(s, 500));
    }
    if (!c) continue;
    const targets = c.tiles.filter((t) => t.target).map((t) => t.id);
    rows.push({
      idx: i,
      prompt: c.prompt,
      tags: c.tags,
      mode: c.mode,
      targetCount: targets.length,
      tiles: c.tiles.map((t) => ({ id: t.id, url: t.url, target: t.target, originalUrl: t.originalUrl })),
    });
    await new Promise((s) => setTimeout(s, 700));
  }
  writeFileSync(`${OUTDIR}/audit.json`, JSON.stringify(rows, null, 1));
  console.log(`監査対象 ${rows.length}件を書き出し: ${OUTDIR}/audit.json`);
  for (const r of rows) {
    console.log(`  [${r.idx}] ${r.mode === "and" ? "2タグ" : "単一"} 「${r.prompt}」 正解 ${r.targetCount}枚`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
