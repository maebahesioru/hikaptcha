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

// ---------- 出題生成(完全ランダム+フィルタ) ----------
// 方針: お題タグを手選定しない。ランダムバッチに2〜4枚付いているタグを
//       そのまま候補にし、「画像を見て人間が判別できるか」を機械フィルタで精査する。
//       - 確実に非視覚(数字・記号・文断片・構図/UI/依頼系メタ語・広すぎる語)は除外
//       - 抽象・謎タグはブラックリストで除外(都度追加していく運用)

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

// タグ名の文字構成による事前排除
const NUM_RE = /[0-9０-９]/;
const HIRA_TAIL_RE = /[\u3040-\u309f]$/;
const HAS_KATAKANA_OR_KANJI = /[\u30a1-\u30f6\u3400-\u9fff]/;
const JUNK_START_RE = /^[、。，「」（）()・\s\-_/\\@]/;
// 文系/メタ系の終端(助詞・助動詞・活用で終わるタグは画像の対象を指さない)
const SENTENCE_TAIL_RE = /(なので|だから|ですが|です|ます|ました|ください|じゃない|された|されて|している|して|された|聞いて|言われ|思っ|感じ|みたい|のような|に関して|について|に対して|として|による|からの|までの|としての|っぽい|気味|系の|なの|の巻|しよう|って)/;
// 構図・画像形式・画面UI・技術・依頼・SNS等のメタ語(部分一致)
const META_RE = /上半身|バスト|胸像|クロースアップ|クローズアップ|全身|ポートレート|顔写真|被写界深度|フレーム|コマ|ツイート|スクリーンショット|スクショ|ハイレゾ|低画質|アルバム|タイムスタンプ|記号|テキスト|キャプション|字幕|ウェブ|アップロード|ダウンロード|チャンネル|ユーザー|ロゴ|アイコン|ライブ|リフレクション|背景|動画|著作権|完成|日常|シンボル|スタンプ|参考|絵文字|デフォルメ|チャート|グラフ|スコア|指数|メニュー|一覧|データ|情報|設定|表示|ステータス|画面|値|率|統計|記録|履歴|結果|内容|方法|状態|状況|変化|効果|能力|概念|融合|象徴|表現|存在|意味|理由|中心|範囲|方向|位置|種類|形式|時代|現在|過去|未来|名前|言葉|シリーズ|作品|投稿|配信|放送|更新|削除|追加|作成|送信|受信|検索|登録|会話|対話|セリフ|台詞|読み|訳|翻訳|依頼|確認|質問|回答|募集|告知|報告|紹介|解説|説明|レビュー|比較|一括|途中|終了|開始|進行|閲覧|視聴|使用|利用|表示中|開封|購入|販売|価格|金額|税込|円|万|千|ポイント|コイン|経験値|レベル|ゲーム|実況|攻略|チュートリアル|ロード|セーブ|メール|電話番号|アドレス|ID|パスワード|認証|ログイン|ログアウト|バージョン|更新日|作成日|日時|年|月日|曜日|祝日|天気予報|ニュース速報|見出し|目次|索引|脚注|余談|補足|追記|注記|参考資料|出典|引用|転載|許可|禁止|注意|警告|危険|安全|マナー|規約|利用規約|プライバシー|個人情報|権利|著作|商標|特許|ライセンス|広告|宣伝|PR|告知用|キャンペーン|プレゼント|懸賞|抽選|当選|落選|結果発表|ランキング|順位|格付け|偏差値|平均|最大|最小|合計|差分|増減|比率|割合|確率|期待値|利益|損失|収支|予算|費用|コスト|負担|支払|請求|領収|明細|残高|振込|入金|出金|送金|両替|為替|株価|相場|予約|注文|発送|配送|到着|受取|返品|交換|保証|修理|故障|不具合|エラー|バグ|修正|対策|対応|防止|回避|解決|課題|問題点|懸念|不安|心配|悩み|相談|愚痴|不満|苦情|クレーム|炎上|荒らし|スパム|通報|ブロック|ミュート|フォロー|フォロワー|いいね|リツイート|シェア|保存|共有|埋め込み|リンク|URL|ハッシュタグ|タグ付け|メンション|リプライ|返信|引用|ポスト|スレッド|チャット|DM|グループ|サーバー|サイト|ページ|ブラウザ|アプリ|ソフト|ゲーム機|スマホ|携帯|PC|パソコン|キーボード|タッチ|クリック|スクロール|スワイプ|操作|入力中|編集中|送信中|読み込み中|接続中|切断|通信|ネットワーク|Wi-Fi|充電|バッテリー|電源|オン|オフ|起動|終了|再起動|初期化|リセット|デフォルト|カスタム|モード|オプション|設定画面|ホーム画面|待ち受け|壁紙|テーマ|スキン|フィルタ|エフェクト|加工|編集|切り抜き|合成|修正前|修正後|比較画像|差分画像|元画像|完成画像|途中画像|ラフ|下書き|線画|着色|塗り|仕上げ|提出|納品|依頼主|発注者|制作者|作者|描き手|投稿者|アップローダー|転載者|引用元|出典元|ソース|元ネタ|原作|二次創作|パロディ|オマージュ|コラボ|合作|合同|共同|主催|運営|管理者|権限|モデレーター|スタッフ|メンバー|参加者|視聴者|読者|ファン|アンチ|信者|オタク|厨|勢|民|界隈|コミュニティ|サーバー民|Discord|ニコニコ|YouTube|Twitter|X|Instagram|TikTok|LINE|Skype|Zoom|Teams|Discord|5ch|まとめ|Wiki|ブログ|ニュース|記事|コラム|特集|連載|定期|不定期|毎日|毎週|毎月|年間|上半期|下半期|四半期|第1|第2|第3|最終|前編|後編|中編|序章|終章|完結|連載中|打ち切り|休載|復活|リメイク|リブート|スピンオフ|外伝|本編|番外|特別編|総集編|ダイジェスト|ハイライト|ベスト|傑作|名作|迷作|駄作|神作|クソ|やば|すご|えぐ|草|ワロ|www|w/;
// 広すぎる/抽象的すぎるタグ(完全一致)
const EXCLUDE_TAGS = new Set([
  "男性", "女性", "実写", "現実の生活", "現実的で", "写真背景", "複数の視点",
  "字幕", "ミーム", "おじいちゃん向けコンテンツ", "なんだって", "食べ物",
  "1人の少年", "2人の男児", "立ち姿", "人物", "人々", "人間の", "子供", "少女",
  "少年", "動物", "日本人", "オタク", "カジュアル", "服", "衣服", "髪", "目",
  "顔", "手", "靴", "建物", "街", "家",
  "変容", "内側", "参考画像", "健康指数", "健康ミネラル", "日常", "前方", "後方",
  "側面", "中心", "端", "隅", "境界", "隙間", "周囲", "全体", "部分", "一部",
  "その他", "上記", "下記", "左", "右", "上", "下", "前", "後",
  "ロー・レス", "顔アップ", "顔毛", "アジア人", "白人", "黒人", "外国人", "容器",
  "お買い得品", "スペシャル報酬", "ワイドスクリーン", "ボディライティング", "東方",
  "雑誌", "料理", "報酬", "特典", "景品", "戦利品", "ドロップ", "リワード",
  "バウティー", "誕生の瞬間", "暗い場所の白金", "ウォーターマーク", "カバー", "アニメ化",
  "国境", "周囲保護", "白金", "瞬間", "ビンテージ", "レア", "ノーマル", "限定品",
  "グリン", "プレイド", "ドン", "悪夢の燃料", "二重ペルソナ", "複数のペルソナ",
  "シークエンキャップ", "ポヴ", "クレンド", "グッキ", "ハプロリネ", "カムドリップ",
  "エッブリーテイ", "ギラフィッド", "ムリド", "ヒリアン", "ビアル", "フェリス",
  "プーン", "ワン", "レイ", "ステ", "コミ", "サラ", "コン", "チン", "カレ",
  "ニュー", "ドンキー", "トイ", "マスター", "リーダー", "プロデューサー",
  "マイルストーン祝賀会", "記念日", "周年", "誕生日", "お祝い", "祝賀",
  "著作権の請求", "ブランド名模倣", "第三者ソース", "情報源要求", "素材配布",
  "複数図面チャレンジ", "胴体をトリミング", "スタイルパロディ", "公式美術",
  "色収差", "モザイク検閲", "メイク", "エフェクト", "処理", "加工", "編集",
]);

function isGoodTag(t) {
  if (!t || t.length < 2 || t.length > 10) return false;
  if (NUM_RE.test(t)) return false; // 年号・数字入り
  if (HIRA_TAIL_RE.test(t)) return false; // 助詞/活用で終わる文断片
  if (JUNK_START_RE.test(t)) return false; // 句読点/記号始まり
  if (/[()（）「」『』《》〈〉【】….]/.test(t)) return false; // 修飾付きタグ(雑誌(物)・病院... 等)
  if (/\s/.test(t)) return false; // 空白入り
  if (EXCLUDE_TAGS.has(t)) return false;
  if (!HAS_KATAKANA_OR_KANJI.test(t)) return false; // ひらがなのみ
  if (SENTENCE_TAIL_RE.test(t)) return false;
  if (META_RE.test(t)) return false;
  // ひらがなが3文字以上 = 文/説明系(例: きらきらした瞳)
  const hiraCount = (t.match(/[\u3040-\u309f]/g) || []).length;
  if (hiraCount >= 3) return false;
  // 「の」を2個以上含む = 説明文っぽい(例: 暗い場所の白金)
  if ((t.match(/の/g) || []).length >= 2) return false;
  return true;
}

// 漢字2-3文字の「状態/抽象」っぽい語(画像の対象でなく概念を指す)
const ABSTRACT_HANZI = new Set([
  "変容", "変化", "変形", "変異", "変質", "変身", "変遷", "変換",
  "中心", "内部", "外部", "表面", "裏面", "本質", "核心", "要点", "概要", "詳細",
  "概念", "現象", "状態", "状況", "様子", "姿", "形", "影", "色", "光", "闇",
  "日常", "非日常", "現実", "幻想", "想像", "記憶", "感情", "気分", "感覚",
  "思想", "哲学", "宗教", "文化", "社会", "経済", "政治", "歴史", "科学",
  "数学", "理論", "論理", "真実", "嘘", "正義", "悪", "善", "美", "醜",
  "意味", "理由", "原因", "結果", "目的", "目標", "計画", "未来", "過去", "現在",
  "運命", "偶然", "必然", "自由", "平等", "平和", "戦争", "勝利", "敗北",
  "幸福", "不幸", "喜び", "悲しみ", "怒り", "恐怖", "不安", "希望", "絶望",
  "愛情", "友情", "信頼", "裏切り", "執着", "解放", "束縛", "孤独", "団結",
  "努力", "才能", "運", "実力", "可能性", "限界", "無限", "永遠", "瞬間",
  "普遍", "個性", "アイデンティティ", "価値", "意味合い", "含み",
  "チャート", "グラフ", "データ", "情報", "指数", "数値", "確率", "統計",
]);

async function makeChallenge() {
  for (let i = 0; i < 30; i++) {
    const batch = await fetchRandomImageBatch(24);
    if (batch.length < GRID_SIZE) continue;

    // バッチ内タグの登場回数(精査フィルタ通過のみ)
    const counts = new Map();
    for (const p of batch) {
      for (const t of p.tags) {
        if (!isGoodTag(t)) continue;
        if (ABSTRACT_HANZI.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    // 3〜5枚に付くタグだけがお題候補(お手本1枚+タイル正解2枚以上を確保するため3枚以上)
    const candidates = [];
    for (const [tag, n] of counts) {
      if (n >= 3 && n <= 5) candidates.push({ tag, n });
    }
    if (!candidates.length) continue;

    // 重み付きランダム選択(出現数が多い方をやや優先)
    const roulette = [];
    for (const c of candidates) for (let k = 0; k < c.n; k++) roulette.push(c.tag);
    const tag = roulette[Math.floor(Math.random() * roulette.length)];
    const tagCount = counts.get(tag) || 3;

    const tagged = shuffle(batch.filter((p) => p.tags.has(tag))).slice(0, tagCount);
    if (tagged.length < 3) continue; // お手本1+正解2は必須

    // お手本(タイル外に表示・タグ名は出さない)と、タイルに載せる正解2〜3枚
    const sample = tagged[0];
    const targets = tagged.slice(1, Math.min(4, tagged.length)); // 2〜3枚
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

    return {
      id: randomBytes(8).toString("hex"),
      prompt: tag,
      sampleUrl: sample.url,
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
      sampleUrl: c.sampleUrl,
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
