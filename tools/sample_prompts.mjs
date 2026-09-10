// 実サーバーから出題タグを大量サンプリングして品質を点検する
const BASE = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 100);
const UA = { "user-agent": "Mozilla/5.0" };

async function main() {
  const prompts = [];
  const errors = new Map();
  for (let i = 0; i < N; i++) {
    try {
      const r = await fetch(BASE + "/api/challenge", { headers: UA });
      if (!r.ok) {
        const t = await r.text();
        const key = r.status + " " + t.slice(0, 60);
        errors.set(key, (errors.get(key) || 0) + 1);
      } else {
        const j = await r.json();
        if (j.prompt) prompts.push(j.prompt);
      }
    } catch (e) { errors.set("network " + e.message, (errors.get("network " + e.message) || 0) + 1); }
    await new Promise((s) => setTimeout(s, 350));
  }
  console.log(`取得成功: ${prompts.length}/${N}`);
  if (errors.size) {
    console.log("--- 失敗内訳 ---");
    for (const [k, v] of errors) console.log(`  ${v}回: ${k}`);
  }
  const seen = new Map();
  for (const p of prompts) seen.set(p, (seen.get(p) || 0) + 1);
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\nユニーク ${sorted.length}種:`);
  for (const [p, c] of sorted) console.log(`  ${String(c).padStart(2)}回 ${p}`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
