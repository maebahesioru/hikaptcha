// 正解フローの検証(デバッグ情報を持つテスト用コピー :3108 に対して実行)
const BASE = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { ...UA, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

async function main() {
  // 1. 正解を選ぶ
  const c = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  const correct = c.tiles.filter((t) => t.target).map((t) => t.id);
  console.log(`お題「${c.prompt}」正解タイル ${correct.length}枚 / 全9枚`);

  const v = await post("/api/verify", { id: c.id, selected: correct });
  console.log(`正解を選んで検証 -> ${v.status} ${v.body?.ok ? "OK token=" + v.body.token.slice(0, 10) + "..." : JSON.stringify(v.body)}`);
  if (!v.body?.ok) { console.log("NG: 正解が通らない"); return; }

  // 2. トークン消費(登録ゲート想定)
  const con = await post("/api/consume", { token: v.body.token });
  console.log(`consume -> ${con.status} ${JSON.stringify(con.body)}`);

  // 3. 同じトークンの再利用は失敗するか
  const con2 = await post("/api/consume", { token: v.body.token });
  console.log(`consume再利用 -> ${con2.status} ${JSON.stringify(con2.body)}`);

  // 4. 誤答 → 400、3回で410(試行回数上限)
  const c2 = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  const wrong = c2.tiles.filter((t) => !t.target).slice(0, 1).map((t) => t.id);
  for (let i = 1; i <= 3; i++) {
    const r = await post("/api/verify", { id: c2.id, selected: wrong });
    console.log(`誤答${i}回目 -> ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    await sleep(200);
  }

  // 5. 画像プロキシが全タイル配信できるか
  const c3 = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  let ok = 0;
  for (const t of c3.tiles) {
    const r = await fetch(t.url, { headers: UA });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.ok && b.length > 1000) ok++;
  }
  console.log(`タイル画像配信: ${ok}/9`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
