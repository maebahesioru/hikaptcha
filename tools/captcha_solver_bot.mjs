// ヒカマニCAPTCHA 突破ボット(検証用)
// 人力ゼロ・画像も見ない。公開APIのタグ情報だけで機械的に解く。
const CAPTCHA = "http://localhost:3107";
const BOORU = "https://hikabooru.hikamers.app/api";

async function j(url, opts) {
  const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ...(opts?.headers || {}) };
  const r = await fetch(url, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

function postIdFromThumb(url) {
  // 例: .../000000/07/72968_zSayx....jpg  → 72968
  const m = url.match(/(\d+)_[^/]+\.\w+$/);
  return m ? Number(m[1]) : null;
}

async function main() {
  let solved = 0, failed = 0, tokens = [];
  const N = 5;
  for (let i = 0; i < N; i++) {
    // 1. 出題を取得(人間には見えない「正解」をタグから復元する)
    const c = await j(CAPTCHA + "/api/challenge");
    if (c.status !== 200) { console.log(`[${i}] challenge失敗`, c.status); failed++; continue; }
    const { id, prompt, tiles } = c.body;

    // 2. 各タイルの投稿IDをURLから取り、公開APIでタグを引く(画像は一切見ない)
    const selected = [];
    for (const t of tiles) {
      const pid = postIdFromThumb(t.url);
      if (!pid) continue;
      const r = await j(`${BOORU}/posts?query=id:${pid}&fields=id,tags&limit=1`);
      const tags = (r.body?.results?.[0]?.tags || []).map((x) => x.names?.[0]).filter(Boolean);
      if (tags.includes(prompt)) selected.push(t.id);
      await new Promise((s) => setTimeout(s, 120)); // 礼儀正しく間隔をあける
    }

    // 3. 回答(正解タイルを全部選ぶ)
    const v = await j(CAPTCHA + "/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, selected }),
    });
    if (v.body?.ok && v.body?.token) {
      solved++;
      tokens.push(v.body.token);
      console.log(`[${i}] 突破成功: お題「${prompt}」正解${selected.length}枚 トークン=${v.body.token.slice(0, 10)}...`);
    } else {
      failed++;
      console.log(`[${i}] 失敗: お題「${prompt}」選択${selected.length}枚 -> ${v.status} ${JSON.stringify(v.body).slice(0, 90)}`);
    }
    await new Promise((s) => setTimeout(s, 800));
  }
  console.log(`\n=== 結果: ${solved}/${N} 突破 / 失敗 ${failed} ===`);
  if (tokens.length) {
    console.log("得たトークンで登録/consumeを試す:");
    const con = await j(CAPTCHA + "/api/consume", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens[0] }),
    });
    console.log("  consume ->", con.status, JSON.stringify(con.body));
  }
}

main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
