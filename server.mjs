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

// ---------- 出題生成(ランダム画像 + 辞書検証済みタグ) ----------
// 方針:
//  - 画像は毎回ランダムなバッチ(出題のバラエティを担保)
//  - お題タグは、そのバッチに付いているタグのうち allowed_tags.json に載っているものだけ
//    allowed_tags.json = hikabooruの全タグ(10,806件)を
//      「JMdict(日本語辞書)の常用名詞」+「UniDicで 名詞/普通名詞/一般 と判定」
//    で検証して残った“画像を見て判別できる一般名詞”だけの集合(辞書から自動生成・手選定ではない)
//    → 造語(ポヴ/バウティー)・動作性名詞(変換/送信)・形状詞(安全/透明)・
//      固有名詞・抽象語・構図/UI語を原理的に排除できる
//  - 直近で使ったタグは避けて単調さを防ぐ

const ALLOWED =
  (() => {
    try {
      const arr = JSON.parse(readFileSync(path.join(__dirname, "allowed_tags.json"), "utf8"));
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  })();
if (ALLOWED.size < 50) {
  console.error("allowed_tags.json が読めません。先に tools/build_allowlist.py を実行してください");
  process.exit(1);
}

// 直近で出題したタグ(同じタグが続かないようにする)
const RECENT_TAGS = [];
const RECENT_MAX = 60;
function markUsed(tag) {
  RECENT_TAGS.push(tag);
  while (RECENT_TAGS.length > RECENT_MAX) RECENT_TAGS.shift();
}

// タイルは正方形なので、極端な縦長/横長(9:16未満・16:9超)は
// 表示したときに小さく/切れて判別不能になる → 出題から除外
function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0;
  const h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 0.56 && r <= 1.78; // 9:16(0.5625)〜16:9(1.7778) の範囲
}

// ランダムなoffset位置からsafe画像を1バッチ引く(タグ名も返す)
async function fetchRandomImageBatch(limit) {
  const offset = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  const d = await hkFetch(`/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`);
  return (d?.results || [])
    .filter((p) => p && p.id && p.thumbnailUrl && goodAspect(p))
    .map((p) => ({
      id: p.id,
      url: absUrl(p.thumbnailUrl),
      tags: new Set((p.tags || []).map((t) => (t.names && t.names[0]) || "").filter(Boolean)),
    }));
}

async function makeChallenge() {
  for (let i = 0; i < 30; i++) {
    const batch = await fetchRandomImageBatch(24);
    if (batch.length < GRID_SIZE) continue;

    // バッチ内タグの登場回数(辞書検証済みタグのみ)
    const counts = new Map();
    for (const p of batch) {
      for (const t of p.tags) {
        if (!ALLOWED.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }

    // 2〜3枚に付くタグがお題候補(正解が絞られていて、かつ多すぎない)
    let candidates = [];
    for (const [tag, n] of counts) {
      if (n >= 2 && n <= 3) candidates.push({ tag, n });
    }
    if (!candidates.length) continue;

    // 直近使ったタグは避ける(候補が全部最近なら仕方なく使う)
    const fresh = candidates.filter((c) => !RECENT_TAGS.includes(c.tag));
    if (fresh.length) candidates = fresh;

    // 重み付きランダム選択(出現数が多い方をやや優先)
    const roulette = [];
    for (const c of candidates) for (let k = 0; k < c.n; k++) roulette.push(c.tag);
    const tag = roulette[Math.floor(Math.random() * roulette.length)];
    const tagCount = counts.get(tag) || 2;

    // 正解=お題タグが付く画像(2〜3枚) / ダミー=同じバッチ内でお題タグが付かない画像
    const targets = batch.filter((p) => p.tags.has(tag)).slice(0, tagCount);
    const rest = batch.filter((p) => !p.tags.has(tag));
    if (rest.length < GRID_SIZE - targets.length) continue;
    const distractors = shuffle(rest).slice(0, GRID_SIZE - targets.length);

    const tiles = shuffle([
      ...targets.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        target: true,
      })),
      ...distractors.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        target: false,
      })),
    ]);

    markUsed(tag);
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

  // 出題
  if (url.pathname === "/api/challenge" && req.method === "GET") {
    const ip = clientIp(req);
    if (!checkQuota(ip)) {
      return sendJson(res, 429, { error: "リクエストが多すぎます。しばらく待ってから再試行してください" });
    }
    sweep();
    for (const [id, c] of challenges) if (c.ip === ip) challenges.delete(id);
    const c = await makeChallenge();
    if (!c) {
      return sendJson(res, 502, { error: "問題を準備できませんでした。少し待ってからもう一度お試しください" });
    }
    c.ip = ip;
    challenges.set(c.id, c);
    return sendJson(res, 200, {
      id: c.id,
      prompt: c.prompt,
      tiles: c.tiles.map((t) => ({ id: t.id, url: t.url })),
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
