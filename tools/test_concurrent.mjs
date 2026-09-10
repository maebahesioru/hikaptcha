// 同一IPで複数の出題を同時に持てるか(別タブ/NAT対策の確認)
const BASE = "http://localhost:3107";
const UA = { "user-agent": "Mozilla/5.0" };

async function main() {
  const c1 = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  const c2 = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  console.log("出題1:", c1.prompt, "| 出題2:", c2.prompt);

  // 1問目にわざと誤答 → 「出題が見つかりません(410)」なら消されている、「違う画像(400)」なら生きている
  const r1 = await fetch(BASE + "/api/verify", {
    method: "POST", headers: { ...UA, "Content-Type": "application/json" },
    body: JSON.stringify({ id: c1.id, selected: [c1.tiles[0].id] }),
  });
  const j1 = await r1.json();
  console.log(`出題1への誤答 -> ${r1.status} ${JSON.stringify(j1)}`);
  console.log(`  → 出題1は${r1.status === 400 ? "生きている(OK)" : "消された(NG)"}`);

  const r2 = await fetch(BASE + "/api/verify", {
    method: "POST", headers: { ...UA, "Content-Type": "application/json" },
    body: JSON.stringify({ id: c2.id, selected: [c2.tiles[0].id] }),
  });
  const j2 = await r2.json();
  console.log(`出題2への誤答 -> ${r2.status} ${JSON.stringify(j2)}`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
