// 出題を大量サンプリングして品質を点検する(単一タグ/2タグの内訳も出す)
const BASE = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 150);
const UA = { "user-agent": "Mozilla/5.0" };

async function main() {
  const rows = [];
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
        if (j.prompt) rows.push({ tags: j.tags || [j.prompt], mode: j.mode || "single" });
      }
    } catch (e) { errors.set("net " + e.message, (errors.get("net " + e.message) || 0) + 1); }
    await new Promise((s) => setTimeout(s, 320));
  }
  const singles = rows.filter((r) => r.mode === "single");
  const pairs = rows.filter((r) => r.mode !== "single");
  console.log(`取得 ${rows.length}/${N} | 単一タグ ${singles.length} / 2タグ ${pairs.length}`);
  if (errors.size) {
    console.log("--- 失敗内訳 ---");
    for (const [k, v] of errors) console.log(`  ${v}回: ${k}`);
  }
  const uniq = new Set(rows.map((r) => r.tags.join(" × ")));
  console.log(`ユニーク出題 ${uniq.size}種\n`);
  console.log("--- 単一タグ ---");
  console.log([...new Set(singles.map((r) => r.tags[0]))].join(" | "));
  console.log("\n--- 2タグ ---");
  console.log([...new Set(pairs.map((r) => r.tags.join(" × ")))].join(" | "));
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
