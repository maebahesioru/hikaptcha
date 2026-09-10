// 修正後の検証: (1) 投稿IDが漏れていないか (2) 画像プロキシが実体を返すか
const BASE = "http://localhost:3107";

async function main() {
  const r = await fetch(BASE + "/api/challenge");
  const raw = await r.text();
  const d = JSON.parse(raw);

  console.log("prompt:", d.prompt);
  for (const t of d.tiles.slice(0, 3)) console.log("  url:", t.url);

  // 元URL(投稿IDやhikabooruドメイン)が漏れていないか
  const leakId = /\d{4,}_[A-Za-z0-9_\-]+\.\w+/.test(raw);
  const leakDomain = raw.includes("hikabooru");
  const leakPath = raw.includes("data/");
  const leakPostIdField = raw.includes("postId");
  console.log(`漏洩チェック: 投稿ID=${leakId} ドメイン=${leakDomain} パス=${leakPath} postIdフィールド=${leakPostIdField}`);

  // 画像プロキシの実体確認
  const img = await fetch(d.tiles[0].url, { headers: { "user-agent": "Mozilla/5.0" } });
  const buf = Buffer.from(await img.arrayBuffer());
  console.log(`画像: status=${img.status} type=${img.headers.get("content-type")} bytes=${buf.length}`);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isWebp = buf.subarray(0, 4).toString() === "RIFF";
  console.log(`  → JPEG=${isJpeg} PNG=${isPng} WEBP=${isWebp}`);

  // 全タイルが実際に画像として取れるか
  let okCount = 0;
  for (const t of d.tiles) {
    const res = await fetch(t.url, { headers: { "user-agent": "Mozilla/5.0" } });
    const b = Buffer.from(await res.arrayBuffer());
    if (res.ok && b.length > 1000) okCount++;
  }
  console.log(`タイル画像の取得成功: ${okCount}/${d.tiles.length}`);

  // 知らないimgIdは404か
  const bad = await fetch(BASE + "/api/img/deadbeefdeadbeefdeadbeef");
  console.log(`未登録imgId: status=${bad.status} (404期待)`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
