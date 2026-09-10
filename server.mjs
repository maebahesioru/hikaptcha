// ヒカマニCAPTCHA 単体サーバー
// hikabooru(https://hikabooru.hikamers.app)の実在タグ付き画像を使った
// 「◯◯の画像を全部選んで」式の画像選択CAPTCHA。
//
// 使い方:
//   node server.mjs            # http://localhost:3107
//   PORT=8080 node server.mjs  # ポート変更
//
// 埋め込み:
//   <div id="hmc-captcha"></div>
//   <script src="https://<このサーバー>/captcha.js"></script>
//   <script>
//     HikamaniCaptcha.render(document.getElementById("hmc-captcha"), {
//       onSolved: (token) => { /* 登録ボタン等を有効化 */ },
//     });
//   </script>
//   サーバー側(登録API)でトークンを1回だけ消費:
//     POST /api/consume  {"token":"..."}  →  {"ok":true}
//
// 依存パッケージゼロ(Node 18+)。メモリ保持=単一プロセス前提。
// hikabooru APIは公開なので、本気のボットには解ける(量産スクリプト抑止+コミュニティの遊び目的)。
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const HIKABOORU_BASE = process.env.HIKABOORU_BASE || "https://hikabooru.hikamers.app";
const HIKABOORU_API = HIKABOORU_BASE + "/api";
const PORT = Number(process.env.PORT || 3107);

const GRID_SIZE = 9;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 出題の有効期限
const MAX_ATTEMPTS = 3; // 1出題あたりの回答試行回数
const TOKEN_TTL_MS = 5 * 60 * 1000; // 解決トークンの有効期限(消費されるまで)
const IP_QUOTA = 60; // IPごとの出題+回答リクエスト上限(人間の試行錯誤ではまず到達しない水準)
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_CHALLENGES = 2000;
const MAX_PER_IP = 10; // 同一IPで同時に保持する出題の上限(別タブ・同一NAT対策)

const challenges = new Map(); // id -> {prompt, createdAt, tiles, attempts, ip}
const tokens = new Map(); // token -> {exp}
const ipCounts = new Map(); // ip -> {n, resetAt}

// ---------- hikabooru API ----------

async function hkFetch(p) {
  try {
    const res = await fetch(HIKABOORU_API + p, {
      headers: { "user-agent": "hikamani-captcha/1.0" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function absUrl(u) {
  return /^https?:\/\//.test(u) ? u : HIKABOORU_BASE + (u.startsWith("/") ? u : "/" + u);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- お題タグの選別 ----------
// hikabooruのタグはメタ/文の断片/謎タグだらけ。
// 「画像を見て人間が解けるタグ」だけを通す厳しめフィルタ:
//   - 日本語(カタカナ/漢字)を含む短いタグ(2〜10文字)
//   - 数字・句読点始まり・メタ語(構図/技術/依頼系)を除外
//   - ひらがな終端(助詞/活用形: 「黒地に」等)を除外
//   - ひらがな3文字以上連続しうる文系(キャプション)を除外
//   - 使用回数が10〜3000(低すぎ=ノイズ/高すぎ=メタ)

const HAS_JP = /[\u3040-\u30ff\u3400-\u9fff]/;
const HAS_KATAKANA_OR_KANJI = /[\u30a1-\u30f6\u3400-\u9fff]/;
const HAS_NUM = /[0-9０-９]/;
const HIRA = /[\u3040-\u309f]/;
const JUNK_START = /^[、。，「」（）()・\s\-_/\\@]/;
const HIRA_TAIL = /[\u3040-\u309f]$/; // ひらがな終端=助詞/活用形の可能性大
const META_TAG = /上半身|バスト|胸像|クロースアップ|クローズアップ|全身|ポートレート|被写界深度|フレーム|コマ|ツイート|スクリーンショット|ハイレゾ|アルバム|タイムスタンプ|記号|テキスト|キャプション|字幕|ウェブ|アップロード|ダウンロード|チャンネル|ユーザー|ID|ロゴ|アイコン|ライブ|リフレクション|背景|動画|著作権|完成|日常|シンボル|スタンプ|スクショ/;
const JUNK_TAG = [
  /^[\d０-９]+$/,
  /^[0-9a-z]{1,3}$/i,
  /[()（）]/,
  /user/i,
  /https?:|www\.|\.com|\.net|youtube|pixiv/i,
  /@/,
  /^[\s\-_/\\]+$/,
];
const STOP_TAG = /ください|チェック|翻訳|依頼|解説|説明|聞いてみ|なので|じゃない|です|ます|ました|じゃん|ってしま|どうぞ|の巻|つけよう/;
// 広すぎる/抽象的すぎるタグ(ほぼ全画像につく等)はお題にしない
const EXCLUDE_TAGS = new Set([
  "男性", "女性", "実写", "現実の生活", "現実的で", "写真背景", "複数の視点",
  "字幕", "ミーム", "おじいちゃん向けコンテンツ", "なんだって", "食べ物",
  "1人の少年", "2人の男児", "立ち姿", "人物", "人々", "人間の", "子供", "少女",
  "少年", "動物", "日本人", "オタク", "カジュアル", "服", "衣服", "髪", "目",
  "顔", "手", "靴", "建物", "街", "家",
]);

function usableTag(t) {
  if (!t || t.length < 2) return false;
  if (!HAS_JP.test(t)) return false;
  return !JUNK_TAG.some((re) => re.test(t));
}

function questionableTag(t, usages) {
  if (!usableTag(t)) return false;
  const n = Number(usages) || 0;
  if (n < 10 || n > 3000) return false; // ノイズ/メタ排除
  if (t.length > 10) return false;
  if (HAS_NUM.test(t)) return false; // 年号・数字入りを排除
  if (JUNK_START.test(t)) return false; // 句読点/記号始まり
  if (/\s/.test(t)) return false; // 空白入りはクエリ区切りと解釈される
  if (EXCLUDE_TAGS.has(t)) return false;
  if (!HAS_KATAKANA_OR_KANJI.test(t)) return false; // ひらがなのみ除外
  if (HIRA_TAIL.test(t)) return false; // 「黒地に」等の助詞/活用終端を除外
  if (META_TAG.test(t)) return false; // 構図/技術/メタ語
  if (STOP_TAG.test(t)) return false;
  if (HIRA.test(t) && (HIRA.test(t.slice(-2, -1)) || (t.match(/[\u3040-\u309f]/g) || []).length >= 3)) return false; // 文系キャプション
  return true;
}

// ---------- 出題生成 ----------

// タイルは正方形なので、極端な縦長/横長(9:16未満・16:9超)は
// 表示したときに小さく/切れて判別不能になる → 出題から除外
function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0;
  const h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 0.56 && r <= 1.78; // 9:16(0.5625)〜16:9(1.7778) の範囲
}

// 画像プロキシ: 元URLにはhikabooruの投稿IDが含まれるため、そのまま渡すと
// 公開APIでタグを引いて正解を機械的に導出できてしまう。不透明IDに置き換えて中継する。
const images = new Map(); // imgId -> { url, exp }
const IMG_TTL_MS = CHALLENGE_TTL_MS + 120 * 1000;

function registerImage(upstreamUrl) {
  const id = randomBytes(12).toString("hex");
  images.set(id, { url: upstreamUrl, exp: Date.now() + IMG_TTL_MS });
  return id;
}

// リクエストのホストから公開ベースURLを作る(埋め込み先が別オリジンでも絶対URLで返す)
function publicBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

async function fetchRandomImageBatch(limit) {
  const offset = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  const d = await hkFetch(`/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`);
  return (d?.results || [])
    .filter((p) => p && p.id && p.thumbnailUrl && goodAspect(p))
    .map((p) => {
      // タグ名とその使用回数(ノイズ/メタ判定に使う)を保持
      const tagU = new Map();
      for (const x of p.tags || []) {
        const name = (x.names && x.names[0]) || "";
        if (name) tagU.set(name, x.usages || 0);
      }
      return {
        id: p.id,
        url: absUrl(p.thumbnailUrl),
        tags: new Set(tagU.keys()),
        tagU,
      };
    });
}

async function makeChallenge() {
  for (let i = 0; i < 12; i++) {
    const batch = await fetchRandomImageBatch(16);
    if (batch.length < GRID_SIZE) continue;

    const counts = new Map();
    for (const p of batch) {
      for (const t of p.tags) {
        const usages = p.tagU.get(t) || 0;
        if (!questionableTag(t, usages)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const candidates = [];
    for (const [tag, n] of counts) {
      if (n >= 2 && n <= 4) candidates.push({ tag, n });
    }
    if (!candidates.length) continue;

    // 重み付きランダム選択(出現数が多い方をやや優先)
    const roulette = [];
    for (const c of candidates) for (let k = 0; k < c.n; k++) roulette.push(c.tag);
    const tag = roulette[Math.floor(Math.random() * roulette.length)];
    const tagCount = counts.get(tag) || 2;

    const targets = batch.filter((p) => p.tags.has(tag)).slice(0, tagCount);
    const rest = batch.filter((p) => !p.tags.has(tag));
    if (rest.length < GRID_SIZE - targets.length) continue;
    const distractors = shuffle(rest).slice(0, GRID_SIZE - targets.length);

    const tiles = shuffle([
      ...targets.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        imgId: registerImage(p.url), // クライアントには imgId 経由でのみ配信(投稿IDを隠す)
        target: true,
      })),
      ...distractors.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        imgId: registerImage(p.url),
        target: false,
      })),
    ]);

    return {
      id: randomBytes(8).toString("hex"),
      prompt: tag,
      createdAt: Date.now(),
      tiles,
      attempts: 0,
    };
  }
  return null;
}

// ---------- トークン/掃除 ----------

function sweep() {
  const now = Date.now();
  for (const [id, c] of challenges) if (now - c.createdAt > CHALLENGE_TTL_MS) challenges.delete(id);
  for (const [tk, t] of tokens) if (now > t.exp) tokens.delete(tk);
  for (const [imgId, img] of images) if (now > img.exp) images.delete(imgId);
  if (challenges.size > MAX_CHALLENGES) {
    const sorted = [...challenges.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of sorted.slice(0, sorted.length - MAX_CHALLENGES)) challenges.delete(id);
  }
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "local";
}

function checkQuota(ip) {
  const now = Date.now();
  const c = ipCounts.get(ip);
  if (!c || now >= c.resetAt) {
    ipCounts.set(ip, { n: 1, resetAt: now + IP_WINDOW_MS });
    return true;
  }
  if (c.n >= IP_QUOTA) return false;
  c.n += 1;
  return true;
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  // 画像配信: hikabooruのサムネイルを中継する(URLから投稿IDを隠すため)
  if (url.pathname.startsWith("/api/img/") && req.method === "GET") {
    const imgId = url.pathname.slice("/api/img/".length);
    const img = images.get(imgId);
    if (!img || Date.now() > img.exp) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    try {
      // ホットリンク判定を避けるため Referer を送らずに取得する
      const up = await fetch(img.url, {
        headers: { "user-agent": "hikamani-captcha/1.0" },
        signal: AbortSignal.timeout(12000),
        cache: "no-store",
      });
      if (!up.ok || !up.body) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        return res.end("upstream error");
      }
      res.writeHead(200, {
        "content-type": up.headers.get("content-type") || "image/jpeg",
        "cache-control": "private, max-age=300",
        "access-control-allow-origin": "*",
      });
      return await new Promise((resolve) => {
        const stream = Readable.fromWeb(up.body);
        stream.pipe(res);
        stream.on("end", resolve);
        stream.on("error", () => { try { res.end(); } catch {} resolve(); });
      });
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      return res.end("upstream error");
    }
  }

  // 出題
  if (url.pathname === "/api/challenge" && req.method === "GET") {
    const ip = clientIp(req);
    if (!checkQuota(ip)) {
      return sendJson(res, 429, { error: "リクエストが多すぎます。しばらく待ってから再試行してください" });
    }
    sweep();
    // 同一IPの古い出題は「多すぎる分だけ」捨てる。
    // 全部消すと、別タブや複数人が同じIP(NAT)から使った時に
    // 後から出した方以外が全部410になって壊れるため。
    const mine = [...challenges.values()]
      .filter((c) => c.ip === ip)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_PER_IP) {
      const old = mine.shift();
      challenges.delete(old.id);
    }
    const c = await makeChallenge();
    if (!c) {
      return sendJson(res, 502, { error: "問題を準備できませんでした。少し待ってからもう一度お試しください" });
    }
    c.ip = ip;
    challenges.set(c.id, c);
    // 画像URLは自前プロキシ経由の不透明URLで返す(元URL=投稿IDを渡さない)
    const base = publicBase(req);
    return sendJson(res, 200, {
      id: c.id,
      prompt: c.prompt,
      tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}` })),
    });
  }

  // 回答検証(正解でワンタイム解決トークン発行)
  if (url.pathname === "/api/verify" && req.method === "POST") {
    const ip = clientIp(req);
    if (!checkQuota(ip)) {
      return sendJson(res, 429, { error: "リクエストが多すぎます。しばらく待ってから再試行してください" });
    }
    const body = await readBody(req);
    const id = String(body?.id || "");
    const selected = Array.isArray(body?.selected) ? body.selected.map(String) : [];
    if (!id) return sendJson(res, 400, { error: "出題IDがありません" });

    sweep();
    const c = challenges.get(id);
    if (!c) {
      return sendJson(res, 410, { ok: false, error: "出題が見つかりません。もう一度やり直してください", expired: true });
    }
    if (Date.now() - c.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "出題の期限が切れました。もう一度やり直してください", expired: true });
    }
    if (c.ip !== ip) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "不正なリクエストです", expired: true });
    }
    if (c.attempts >= MAX_ATTEMPTS) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "試行回数を超えました。新しい問題に挑戦してください", expired: true });
    }

    const expected = new Set(c.tiles.filter((t) => t.target).map((t) => t.id));
    const got = new Set(selected);
    const correct = expected.size === got.size && [...expected].every((x) => got.has(x));

    if (correct) {
      challenges.delete(id);
      const token = randomBytes(24).toString("hex");
      tokens.set(token, { exp: Date.now() + TOKEN_TTL_MS });
      return sendJson(res, 200, { ok: true, token });
    }

    c.attempts += 1;
    const remaining = MAX_ATTEMPTS - c.attempts;
    if (remaining <= 0) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "不正解です。新しい問題に挑戦してください", expired: true });
    }
    return sendJson(res, 400, { ok: false, error: `違う画像が混ざっています(あと${remaining}回)。選び直してください`, remaining });
  }

  // トークン消費(埋め込み先のサーバーが登録/投稿前に呼ぶ。ワンタイム)
  if (url.pathname === "/api/consume" && req.method === "POST") {
    const body = await readBody(req);
    const token = String(body?.token || "");
    if (!token) return sendJson(res, 400, { ok: false, error: "トークンがありません" });
    sweep();
    const t = tokens.get(token);
    if (!t) return sendJson(res, 400, { ok: false, error: "トークンが無効です(期限切れ or 使用済み)" });
    tokens.delete(token); // 一度使ったら即無効
    if (Date.now() > t.exp) return sendJson(res, 400, { ok: false, error: "トークンの期限が切れています" });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    // API以外は全部CORSヘッダを付けなくてよい(ウィジェットJS経由のfetchはAPIのみ)
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }
      return await handleApi(req, res, url);
    }

    // 静的ファイル: / -> index.html, /captcha.js
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^([/\\])+/, "");
    if (file.includes("..") || file.startsWith(".")) {
      res.writeHead(403); return res.end("forbidden");
    }
    const full = path.join(PUBLIC_DIR, file);
    const data = readFileSync(full); // 無ければ throw -> 404
    const ext = path.extname(full);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`ヒカマニCAPTCHA ready on http://localhost:${PORT} (hikabooru: ${HIKABOORU_BASE})`);
});
