// 抜け道検証: プロキシ画像を hikabooru の逆検索APIに投げれば元投稿が割れるか
const CAPTCHA = "http://localhost:3107";
const BOORU = "https://hikabooru.hikamers.app/api";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function main() {
  const c = await (await fetch(CAPTCHA + "/api/challenge")).json();
  console.log("お題:", c.prompt);

  // 1枚目のタイル画像をプロキシ経由で取得
  const imgRes = await fetch(c.tiles[0].url, { headers: UA });
  const buf = Buffer.from(await imgRes.arrayBuffer());
  console.log(`プロキシ画像: ${imgRes.status} ${buf.length}bytes`);

  // hikabooru の逆検索エンドポイントを試す(szurubooru互換名)
  const endpoints = ["/posts/reverse-search", "/posts/reverse_search", "/post/reverse-search"];
  for (const ep of endpoints) {
    try {
      const fd = new FormData();
      fd.append("content", new Blob([buf], { type: "image/jpeg" }), "q.jpg");
      const r = await fetch(BOORU + ep, { method: "POST", headers: UA, body: fd });
      const text = await r.text();
      console.log(`${ep} -> ${r.status} ${text.slice(0, 300)}`);
      if (r.ok) break;
    } catch (e) {
      console.log(`${ep} -> ERR ${e.message}`);
    }
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
