// HIKAPTCHA 単体サーバー
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
//     Hikaptcha.render(document.getElementById("hmc-captcha"), {
//       onSolved: (token) => { /* 登録ボタン等を有効化 */ },
//     });
//   </script>
//   サーバー側(登録API)でトークンを1回だけ消費:
//     POST /api/consume  {"token":"..."}  →  {"ok":true}
//
// 依存パッケージゼロ(Node 18+)。メモリ保持=単一プロセス前提。
// hikabooru APIは公開なので、本気のボットには解ける(量産スクリプト抑止+コミュニティの遊び目的)。
import http from "node:http";
import { randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { Readable } from "node:stream";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocsPage } from "./lib/docs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const HIKABOORU_BASE = process.env.HIKABOORU_BASE || "https://hikabooru.hikamers.app";
const HIKABOORU_API = HIKABOORU_BASE + "/api";
const PORT = Number(process.env.PORT || 3107);

const GRID_SIZE = 9;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 出題の有効期限
const MAX_ATTEMPTS = 3; // 1出題あたりの回答試行回数
const TOKEN_TTL_MS = 5 * 60 * 1000; // 解決トークンの有効期限(消費されるまで)
// IPごとの出題+回答の上限。固定窓だと「使い切ったら窓が終わるまで全拒否」で
// 待ち時間が最大10分になり、人間の試行錯誤でも詰まる(実測で自分でも踏んだ)。
// → トークンバケットにして**使った分が少しずつ回復する**方式にした(崖を作らない)。
// レート制限は既定で無効(0=無制限)。仕組みは残してあり、IP_QUOTA を入れれば有効化できる。
// 以前は「10分で100回」で運用していたが、自分の検証や通常利用で引っかかるだけで不要だった。
const IP_QUOTA = Number(process.env.IP_QUOTA || 0); // 0 で無制限
const IP_REFILL_MS = Number(process.env.IP_REFILL_MS || 3000); // 1トークン回復する間隔(既定3秒=20回/分)
// 開発・検証はローカル/プライベートIPからなので、そこは制限しない(自分で詰まらせないため)。
// 公開時はリバースプロキシが X-Forwarded-For を付けるので、外からのアクセスには効く。
const IP_QUOTA_EXEMPT_LOCAL = process.env.IP_QUOTA_EXEMPT_LOCAL !== "0";
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_CHALLENGES = 2000;
const MAX_PER_IP = 10; // 同一IPで同時に保持する出題の上限(別タブ・同一NAT対策)

// ---- 多層認証のパラメータ ----
// PoWは「メモリハード」なscryptを使う(SHA256はGPUで毎秒10^10回規模だが、
// scryptはメモリ帯域律速のためGPU優位が数桁縮む)。実測(Node):
//   sha256 120,000回/秒 ⇔ scrypt(N=1024,r=8) 154回/秒 = 1試行あたり約780倍のコスト
const POW_ALGO = process.env.POW_ALGO || "scrypt"; // scrypt | sha256(後方互換)
const POW_N = Number(process.env.POW_N || 1024); // scryptのメモリコスト(1MB)
const POW_R = Number(process.env.POW_R || 8);
const POW_P = Number(process.env.POW_P || 1);
const POW_BITS = Number(process.env.POW_BITS || 6); // scrypt出力の先頭ゼロビット
const POW_BITS_MAX = Number(process.env.POW_BITS_MAX || 9);
const MIN_SOLVE_MS = Number(process.env.MIN_SOLVE_MS || 1500); // 人間が画像を見て選ぶ時間の期待値(ソフトなリスク加点に使う)
// ハード拒否の下限。既定は MIN_SOLVE_MS と同じ値にして「人間には不可能な速さ」を確実に弾く。
// ⚠️ 以前はウィジェットが minMs を待たずに送信していたため、この値で正当な回答まで弾かれていた
//    (画像がキャッシュ済みの再訪などで 1500ms を割った)。いまはウィジェットが minMs を待つので
//    人間の回答は必ず下限を超える。カスタム実装に寛容にしたい場合だけ下げる。
const HARD_MIN_SOLVE_MS = Number(process.env.HARD_MIN_SOLVE_MS || MIN_SOLVE_MS);
const MIN_HUMAN_MS = 700; // PoW時間を差し引いた「人間の操作時間」の下限
const HONEYPOT_FIELD = "website"; // ボットが埋めがちな隠しフィールド名
const RISK_REJECT = 2; // リスク点がこれ以上なら拒否
const TICKET_TTL_MS = 5 * 60 * 1000;
// サーバーが観測できる事実に基づくしきい値(クライアント申告と違い偽装できない)
const IMG_FETCH_MIN_RATIO = 0.75; // 出題画像のうち最低これだけ実際に取得されていること
const CLAIM_SLACK_MS = 5000; // クライアント申告が実測より大きく超えたら不正とみなす余裕
// IPごとの「PoW仕事量」予算(期待試行数の累計)。突破速度そのものを頭打ちにする
// PoWの累計仕事量の予算。既定は無制限(0=無制限)。IP_QUOTA と同じく必要時のみ有効化する。
const IP_WORK_BUDGET = Number(process.env.IP_WORK_BUDGET || 0); // 0 で無制限
const IP_WORK_WINDOW_MS = 10 * 60 * 1000;

const challenges = new Map(); // id -> {prompt, createdAt, tiles, attempts, ip, pow, ticket, imgFetched}
const tokens = new Map(); // token -> {exp, ticket}
const ipCounts = new Map(); // ip -> {n, resetAt}
const ipSolved = new Map(); // ip -> 累計突破数(難易度の自動引き上げ用)
const ipWork = new Map(); // ip -> {work, resetAt} 累計PoW仕事量
const tickets = new Map(); // ticket -> {ip, exp}


// ---------- hikabooru API ----------

async function hkFetch(p, timeoutMs = 8000) {
  try {
    const res = await fetch(HIKABOORU_API + p, {
      headers: { "user-agent": "hikamani-captcha/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
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

// ---------- 多層認証 ----------
// 画像認証だけでは弱い(公開APIのタグで機械的に解ける)ため、以下を重ねる:
//  1) 画像認証       … 何を選ぶか(内容理解)
//  2) Proof-of-Work  … 回答前に計算コストを要求(量産の単価を上げる)
//  3) ハニーポット   … 隠しフィールドを埋めたら即ボット
//  4) 挙動シグナル   … ポインタ移動量・所要時間・操作の有無をスコア化
//  5) チケット束縛   … 解決トークンを発行時のチケットに紐づけ(他人への転売を防ぐ)
//  6) 適応難易度     … 突破実績の多いIPにはPoWを重くする

// 先頭ゼロビット数を数える(sha256ダイジェストの難易度判定)
function leadingZeroBits(buf) {
  let zeros = 0;
  for (const b of buf) {
    if (b === 0) { zeros += 8; continue; }
    zeros += Math.clz32(b) - 24;
    break;
  }
  return zeros;
}

function powOk(challenge, nonce, bits) {
  if (typeof challenge !== "string" || typeof nonce !== "string") return false;
  if (nonce.length > 24 || challenge.length > 128) return false;
  if (!/^\d+$/.test(nonce)) return false;
  const h = createHash("sha256").update(challenge + ":" + nonce).digest();
  return leadingZeroBits(h) >= bits;
}

// メモリハードPoW(scrypt)の検証。クライアントは同じ計算を純JSで行い、
// サーバーは1回だけ計算して確認する(1試行あたり約780倍のコスト差を作る)
function powScryptOk(challenge, nonce, salt, bits, N, r, p) {
  if (typeof challenge !== "string" || typeof nonce !== "string") return false;
  if (typeof salt !== "string" || !/^[0-9a-f]{32}$/.test(salt)) return false;
  if (!/^\d{1,8}$/.test(nonce)) return false;
  const bitsSafe = Math.max(1, Math.min(20, Number(bits) || 1));
  const Nsafe = Math.max(2, Math.min(65536, Number(N) || 1024));
  const rsafe = Math.max(1, Math.min(16, Number(r) || 8));
  const psafe = Math.max(1, Math.min(4, Number(p) || 1));
  try {
    const dk = scryptSync(challenge + ":" + nonce, Buffer.from(salt, "hex"), 32, {
      N: Nsafe, r: rsafe, p: psafe, maxmem: 256 * 1024 * 1024,
    });
    return leadingZeroBits(dk) >= bitsSafe;
  } catch {
    return false;
  }
}

// 累計PoW仕事量(期待試行数)を記録し、予算超過を判定する。
// 計算資源で突破されても、IPあたりの総仕事量を頭打ちにすれば速度を制限できる
// 計算認証の累計仕事量の予算。上限に達したら「いつ回復するか」も返す。
function chargeWork(ip, bits, exempt) {
  if (IP_WORK_BUDGET <= 0) return { ok: true }; // 無制限(既定)
  const now = Date.now();
  const cost = Math.pow(2, Math.max(0, Math.min(20, bits)));
  if (exempt) return { ok: true };
  const w = ipWork.get(ip);
  if (!w || now >= w.resetAt) {
    ipWork.set(ip, { work: cost, resetAt: now + IP_WORK_WINDOW_MS });
    return { ok: true };
  }
  if (w.work + cost > IP_WORK_BUDGET) {
    return { ok: false, retryAfterMs: Math.max(1000, w.resetAt - now) };
  }
  w.work += cost;
  return { ok: true };
}


// 突破実績の多いIPはPoWを重くする(自動化のコストを段階的に上げる)
function powBitsFor(ip, exempt) {
  if (exempt) return POW_BITS; // ローカル検証では難易度を上げない
  const solved = ipSolved.get(ip) || 0;
  const extra = Math.min(POW_BITS_MAX - POW_BITS, Math.floor(solved / 3));
  return POW_BITS + extra;
}

function newTicket(ip) {
  const t = randomBytes(16).toString("hex");
  tickets.set(t, { ip, exp: Date.now() + TICKET_TTL_MS });
  return t;
}

function ticketOk(ticket, ip) {
  if (typeof ticket !== "string" || !/^[0-9a-f]{32}$/.test(ticket)) return false;
  const t = tickets.get(ticket);
  if (!t) return false;
  if (Date.now() > t.exp) { tickets.delete(ticket); return false; }
  // 同一チケットの使い回しをIP不一致で弾く(他人のトークン流用を防ぐ)
  if (t.ip !== ip) return false;
  return true;
}

// 挙動シグナルを評価してリスク点を返す(0が人間らしい)
// 誤検知を避ける方針: 「一切の操作が無い自動POST」を強く弾き、
// 操作が観測できている場合はマウス固有の指標(移動量)で減点しない(タッチ操作の人間を救う)
function riskScore(ch, signals, elapsedMs) {
  let risk = 0;
  const reasons = [];
  const s = signals && typeof signals === "object" ? signals : {};

  // 画像を読んで選ぶ時間が無い
  if (elapsedMs < MIN_SOLVE_MS) { risk += 2; reasons.push("回答が速すぎる"); }
  else {
    const powMs = Number(s.powMs) || 0;
    if (powMs > 0 && elapsedMs - powMs < MIN_HUMAN_MS) {
      risk += 1;
      reasons.push("操作時間が短すぎる");
    }
  }

  // 操作が一切観測されていない = スクリプトからの直接POST
  const interacted = s.interactionSeen === true || Number(s.pointerMoves) > 0 || Number(s.clicks) > 0;
  if (!interacted) {
    risk += 2;
    reasons.push("操作が一切観測されていない");
  } else if (s.touchSeen !== true && (Number(s.pointerMoves) || 0) < 3) {
    // マウス操作なのに移動が少ない(タッチなら対象外)
    risk += 1;
    reasons.push("ポインタ移動が少なすぎる");
  }

  // 隠し要素への接触
  if (s.touchedHidden === true) { risk += 2; reasons.push("隠し要素への接触"); }

  return { risk, reasons };
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
const META_TAG = /高角視野|グリーンテーマ|リーチング|ミニマリズム|上半身|バスト|胸像|クロースアップ|クローズアップ|全身|ポートレート|被写界深度|フレーム|コマ|ツイート|スクリーンショット|ハイレゾ|アルバム|タイムスタンプ|記号|テキスト|キャプション|字幕|ウェブ|アップロード|ダウンロード|チャンネル|ユーザー|ID|ロゴ|アイコン|ライブ|リフレクション|背景|動画|著作権|完成|日常|シンボル|スタンプ|スクショ/;
const JUNK_TAG = [
  /^[\d０-９]+$/,
  /^[0-9a-z]{1,3}$/i,
  /[()（）]/,
  /user/i,
  /https?:|www\.|\.com|\.net|youtube|pixiv/i,
  /@/,
  /^[\s\-_/\\]+$/,
];
// 記号類が含まれるタグは排除。個別列挙だと漏れる(●_豆獣石× / 野菜、野菜 / “原始衝撃” / 《腕輪》 / 靴... / グレイ・フーディー)
// ので「ひらがな・カタカナ・漢字・英字・々以外の文字を含むタグは全部落とす」構造ルールにする
const NON_WORD = /[^\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3005A-Za-z]/;
// ⚠️ 「・」(U+30FB)はカタカナブロックの中に居るので上の NON_WORD をすり抜ける(実測)
//    同じく中点・繰り返し記号・長音でない約物は個別に落とす
const KATAKANA_PUNCT = /[・゠ヽヾヿ・]/;
// 抽象化・分類を表す語尾で終わるタグ(実測: バランス型 / 擬人化 / 写実的 / 監視者 / 海兵隊員 / 鳥類)
const SUFFIX_ABSTRACT = /(化|型|風|系|調|的|性|感|式|者|員|類|群|別|側|内|外|中|上|下)$/;
// 「〜の〜」形式は説明文になりやすい(実測: 手のジェスチャー / ゼルダの伝説 / ブランド名模倣 / 目の下のモグラ)
const NO_PARTICLE = /の/;
// 抽象・状態・分類を表す語(実測でお題として出た不正タグの語尾/語幹から抽出)
const ABSTRACT_WORD = /シュール|略語|無料|シェア|ヒント|ポーズ|表情|一人|文字中心|二次元情報源|型破りなメディア|マイルストーン祝賀会|スタッフ|アプライアンス|ハイパー|バリアントセット|三ツ|ジトメ|ビュー|アカウント|チャレンジ|凍結|誹謗|中傷|超大型|大型|物体|図面|アップ|ダウン|フォーカス|タイム|ゲーム|ニュー|リセット|ロード|セーブ|渋滞|検閲|モザイク|沈没|節足|鉛筆画|木材|青年|少女|少年|大人|強膜|瞳孔|網膜|血管|骨格|筋肉|内臓|器官|細胞|遺伝子|染色体|ウイルス|細菌|菌|カビ|北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|ok|焦点|配置|模倣|照準|集中|監視|隊員|群衆|容器|絵文字|サイン|チャート|グラフ|コンピューター|ゲーム機|ソース|グループ|ウィンドウ|静物画|美術|外側|内側|消防|株式会社|有限会社|写実|公式|製品|商品|景品|特典|報酬|対価|価格|金額|料金|費用|収支|利益|損失|数量|個数|面積|体積|距離|速度|温度|湿度|気圧|密度|濃度|割合|比率|確率|平均|最大|最小|合計|差分|増減|変化|変動|推移|予測|推計|統計|分析|評価|判定|診断|検証|検査|測定|調査|研究|学習|教育|訓練|練習|試行|実験|観察|記録|報告|発表|公開|掲示|提示|提出|申請|登録|認証|許可|承認|拒否|禁止|管理|処理|表示|操作|動作|行動|活動|作業|業務|事業|産業|組織|制度|体系|構造|構成|要素|成分|原料|材料|機能|性能|能力|効果|影響|理由|原因|結果|目的|手段|方法|方式|形式|種類|分類|属性|性質|特徴|傾向|程度|段階|範囲|領域|部門|状態|状況|様子|雰囲気|印象|感覚|感情|記憶|意識|精神|心理|思想|概念|理論|法則|原理|原則|方針|基準|規格|標準|規範|条件|要件|制限|制約|可能性|必要性|一般|特殊|普通|通常|基本|応用|実用|実際|現実|理想|目標|広告|宣伝|告知|案内|説明|解説|紹介|連絡|相談|質問|回答|返事|予定|計画|準備|確認|経験|実績|成果|実力|限界|環境|空間|時間|瞬間|期間|時代|現在|過去|未来|歴史|文化|社会|経済|政治|科学|数学|音楽|文学|芸術|宗教|哲学|伝統|習慣|風習|行事|儀式|祭典|イベント|大会|試合|競技|勝負|勝敗|勝利|敗北|順位|ランキング|得点|点数|スコア|レベル|ランク|クラス|称号|肩書|役職|地位|立場|関係|繋がり|結びつき|影響力|支配力|権力|権限|責任|義務|権利|自由|平等|平和|戦争|紛争|争い|喧嘩|口論|議論|討論|会議|集会|集まり|集合|集団|団体|仲間|同僚|友人|知人|家族|親戚|血縁|恋愛|結婚|離婚|出産|育児|介護|看護|医療|治療|診療|手術|投薬|処方|症状|病気|疾患|怪我|負傷|損傷|故障|不具合|誤作動|異常|正常|健全|不健全|健康|不健康|栄養|カロリー|ビタミン|ミネラル|タンパク|脂質|糖質|食物繊維/;
// 助詞を含むタグは文の断片(実測: 返信をポスト)。誤除外を避けて「を」「が」だけを対象にする
const PARTICLE_IN = /[をが]/;
const STOP_TAG = /ください|チェック|翻訳|依頼|解説|説明|聞いてみ|なので|じゃない|です|ます|ました|じゃん|ってしま|どうぞ|の巻|つけよう/;
// 広すぎる/抽象的すぎるタグ(ほぼ全画像につく等)はお題にしない
const EXCLUDE_TAGS = new Set([
  // 下限を80に緩めた実測で入ってきた、お題にすると意味が取れないタグ
  "一発ゲイマスオ", "ヒカマニ歌唱リンク", "ヒカマニCMリンク", "ヒカマーmadリンク",
  "パンパンアンパンパン", "タチウオパーキング", "チョウザメ造船", "ブンブンハロー",
  "ヒカキ", "泉陽咲也", "世羅福", "カニンガム犬", "フェリス",
  // 素材・抽象語は「付随的に写る」ため誤判定を生む。
  // 実測: 「ガラス」→ 真実2枚に対しvisionは5枚を該当と判定
  //       (水槽=アクリル/窓/テレビ画面/瓶まで拾ってしまう)。
  //       「ハート」も髪飾り等の微小な要素で判定が割れた。
  "ガラス", "透明", "金属", "プラスチック", "木材", "素材", "質感", "光", "影",
  "反射", "柄", "模様", "文字", "テキスト", "ロゴ", "記号", "色", "線", "背景",
  "男性", "女性", "実写", "現実の生活", "現実的で", "写真背景", "複数の視点",
  "字幕", "ミーム", "おじいちゃん向けコンテンツ", "なんだって", "食べ物",
  "1人の少年", "2人の男児", "立ち姿", "人物", "人々", "人間の", "子供", "少女",
  "少年", "動物", "日本人", "オタク", "カジュアル", "服", "衣服", "髪", "目",
  "顔", "手", "靴", "建物", "街", "家",
  // 実測でお題として出た不正タグ(752候補の洗い出しから)
  "ポヴ", "グリン", "スミスカラ", "モシャン", "ユウギオ", "ハゲ", "悪夢の燃料",
  "アジア人", "白人", "黒人", "外国人", "海兵隊員", "監視者", "デュエルモンスター",
  "武器", "風景", "哺乳類", "両生類", "爬虫類", "菌類", "昆虫", "植物", "生物",
  "ゲーム機", "コンピューター", "スマートフォン", "マウスマスク", "マスクプル",
  "ボーダー", "ソロフォーカス", "物体焦点", "製品配置", "頭部照準像", "食糧集中",
  "チャート", "グラフ", "絵文字", "サイン", "ソース", "グループ", "ウィンドウ",
  "アップル", "ゼルダの伝説", "クロスオーバー", "アニメ化", "静物画", "公式美術",
  "家具", "照明", "建築", "装飾", "模様", "文字", "数字", "記号", "標識",
  // 2周目の実測(658候補の点検から)
  "無表情", "表面", "四足動物", "レストラン", "開けるジャケット", "キャラクター人形",
  "ポブハンズ", "バウティー", "シークエンキャップ", "ストリークヘア", "ガチャ",
  "カップル", "チャットログ", "ショップ", "軍隊", "プレイド", "機械", "惑星",
  "キッチン", "ホーム", "警察", "兄", "兄弟", "家族", "成人", "成熟したオス", "肥満",
  "暗い肌色", "モーションブラー", "ハグ", "ミニ人", "動物視点", "年齢差", "スカーリー",
  "巾着型", "ダブルV", "ダブルバン", "バラバラ", "異色性", "売春", "トップレス",
  "トップレス男性", "表紙カバー", "カバー", "コスプレ", "コスプレ写真", "人型", "アップ",
  "胴体をトリミング", "スケッチ", "服装に文字", "スタミナ", "舞台照明", "手鞭",
  "元素生物", "スピード", "ハッピー", "カード", "テーマ", "デザイン", "スタイル",
  "アディダス", "サンリオ", "マイクロソフト", "ドラゴンボール", "ニンテンドースイッチ",
  "任天堂", "ポケモン", "艦隊コレクション", "オリンピック", "サッカー", "野球",
  // 3周目(537候補の点検から)
  "ボカロ", "赤面シール", "ワイドスクリーン", "融合", "メイク", "カニス", "図面",
  "マリオ", "ルイージ", "マーベル", "ガンダム", "コカコーラ", "日本神話", "デブ",
  "タイトル", "ミニガール", "一片", "シルエット", "別種", "対話箱", "開口部", "履物",
  "車両", "間接兵器", "セイキン", "フィールド", "天使", "声優", "ゲームCG", "スパイクス",
  "トレーディングカード", "ちびインセット", "正面図", "抽象的", "獲得アイテム", "超絶",
  "獲得ゴールド", "ジェンダースワップ", "型破り", "ハロ", "アンデッド", "クリスマス",
  "衣装", "キャラクター", "小物", "雑貨", "用品", "器具", "器材", "備品",
  // 4周目(実サーバー130サンプルの点検から)
  "正面", "デュアルショック", "肩甲骨筋", "エッチキン", "アクエアイズ", "返信", "共有",
  "修羅場", "ビデオゲーム", "インクリング", "マスコット", "ボイス", "サウンド", "ミュージック",
  "ホームページ", "メッセージ", "コメント", "リアクション", "スタンプ", "シール",
  // 5周目(実サーバー220サンプルの点検から)
  "ドウギ", "クリーン", "切亜未マリーサ", "フレント", "ニセキン", "内部", "弱点", "攻撃",
  "ヒカ", "ヒカクラン", "ヒカル", "下着", "公園", "バブル", "メリークリスマス", "敬礼",
  // 8周目(2タグ出題の点検から)
  "バラエティ", "ペルソナ", "開放服", "ブルーフーディー", "ヒカマーズアルカイダ", "ホモウンチ",
  "無限", "オート再生", "ヒカギン", "着色眼鏡", "怪物", "消防マーク", "二重ペルソナ",
  "商品券", "割引券", "領収書", "明細書", "申請書", "報告書", "議事録", "資料", "文書",
  "バリエーション", "シチュエーション", "コミュニケーション", "コレクション",
  // 9周目(単一+2タグの最終点検から)
  "マイクロ", "vアームズ", "スウェットドロップ", "ヒューマノイド", "ポケモーフォルム",
  "学生", "バーニング", "鈍い前髪", "日本語", "セカクラン", "カプコン", "触角", "前髪",
  "ロングヘア", "ショートヘア", "ミディアムヘア", "髪型", "ヘアスタイル", "毛量",
  "ポケモン", "ブルーアーカイブ", "ウマ娘", "東方", "アイドルマスター", "艦これ",
  // 6周目(240サンプルの点検から)
  "画像", "デジタルアート", "マインクラフト", "保存", "チャーリザード", "反応画像", "今日",
  "山田亮", "プライドカラー", "サイズ差", "デジタル", "イラスト", "運転", "友情コンボ",
  "ブラウンテーマ", "催眠術", "頂点伝説", "素材配布", "コラージュ", "色収差", "フェリス車輪",
  "触手毛", "マウスホールド", "パンティーホース", "ケツ", "体重", "クラウド", "ウマ娘",
  "フォートナイト", "ヒカマー新聞", "ローズンメイデン", "オーラ", "ワシ科", "楽器",
  "青色アーカイブ", "グレーススーツ", "ホリデー", "コンドーム", "ブラ", "スポーツウェア",
  "コンビニエンスストア", "東方", "厚味噌", "周囲保護", "ベイビー", "デフォルメ",
  // 7周目(240サンプルの点検から。具体性の重み付けで大きく改善した後の残り)
  "デカキン", "コスト", "リンク", "最新", "女子", "カラフル", "グロ", "水泳輪", "田中聡太",
  "メタ", "コンサート", "サムネイル", "モノクロ", "再生リスト", "貧血", "部屋", "週刊",
  "詳細", "先生", "人気", "リリーパッド", "ヒューマノイド", "ロック", "フェラーリ",
  "ジャージー", "手扇子", "紙扇", "ヒカキン", "デカキン", "ニセキン", "カスペ",
]);


function usableTag(t) {
  if (!t || t.length < 2) return false;
  if (!HAS_JP.test(t)) return false;
  return !JUNK_TAG.some((re) => re.test(t));
}

// 辞書(UniDic)の品詞判定で機械的に洗い出した除外タグ。
// tools/build_pos_reject.py が生成する(方式は変えず、除外の根拠を辞書で強化するだけ):
//   形状詞(必要/シュール/コミカル)・サ変可能な名詞(キャンセル/退出/制作)・
//   固有名詞の地名/人名(東京/仙台/浜口) = 画像を見て判別できない語
let POS_REJECT = new Set();
try {
  const obj = JSON.parse(readFileSync(path.join(__dirname, "tag_reject.json"), "utf8"));
  POS_REJECT = new Set(Object.keys(obj || {}));
} catch {
  console.warn("[warn] tag_reject.json が読めません(品詞による除外なしで続行)");
}

// お題タグ T と「別物だが関連する」タグの判定。
// AIタガーは同じ概念を別タグで付けることがある(シャツ / 灰色のシャツ / ワイシャツ)。
// そういう画像は「Tが写っているか?」が人間には判断できない(選ぶと不正解になる)ので、
// 出題から外す。辞書を使わない構造的な判定(文字列の包含 / 3文字以上の連続一致)。
// ⚠️ 2文字一致まで許すと「ローブ vs テーブル」「ジャケット vs ヘルメット」を誤検出する(実測)。
function relatedTag(a, b) {
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return true; // シャツ ⊂ 灰色のシャツ / ギター ⊂ エレクトリックギター
  const jp = /[\u30a0-\u30ff\u4e00-\u9faf]/;
  const min = Math.min(a.length, b.length);
  for (let len = min; len >= 3; len--) { // 3文字以上(2文字は偶然一致が多い)
    for (let i = 0; i + len <= a.length; i++) {
      const sub = a.slice(i, i + len);
      if (!jp.test(sub)) continue;
      if (b.includes(sub)) return true;
    }
  }
  return false;
}

// ---------- 直近に使ったお題タグの記憶(同じタグが続けて出るのを避ける) ----------
// 実測: 40問で延べ45回・異なり31種 = 再出率31%(半袖×4 / アルコール×4 / 茶髪×3)。
// バッチ内で多く付いているタグを優先する重みの副作用で、同じタグが何度も出ていた。
// IPごとに直近のお題を覚えておき、同じタグとその類似タグ(リボン / ヘアリボン)を避ける。
const RECENT_TAG_TTL_MS = Number(process.env.RECENT_TAG_TTL_MS || 15 * 60 * 1000);
const RECENT_TAG_MAX = Number(process.env.RECENT_TAG_MAX || 200); // 1IPあたり覚えておくタグ数
const recentTagsByIp = new Map(); // ip -> Map(tag -> 最終使用時刻)

// 短いタグ用の緩い類似判定(直近タグを避ける時だけ使う)。
// 「金髪 / 黒髪」「半袖 / 長袖」のように**末尾の漢字が同じ**ものは、同じ系統の質問に見える。
// ⚠️ これを出題タグ同士の判定(relatedTag)に使うと誤検出するので、ここ専用にする。
function similarForVariety(a, b) {
  if (a === b) return true;
  if (relatedTag(a, b)) return true;
  if (a.length <= 4 && b.length <= 4) {
    const ca = a[a.length - 1], cb = b[b.length - 1];
    if (ca === cb && /[\u4e00-\u9faf]/.test(ca)) return true;
  }
  return false;
}

function recentTagsOf(ip) {
  const now = Date.now();
  const m = recentTagsByIp.get(ip);
  if (!m) return [];
  for (const [t, at] of m) if (now - at >= RECENT_TAG_TTL_MS) m.delete(t);
  if (!m.size) { recentTagsByIp.delete(ip); return []; }
  return [...m.keys()];
}

function rememberTags(ip, tags) {
  let m = recentTagsByIp.get(ip);
  if (!m) { m = new Map(); recentTagsByIp.set(ip, m); }
  const now = Date.now();
  for (const t of tags) m.set(t, now);
  // 念のための上限(溢れたら古い順に捨てる)
  if (m.size > RECENT_TAG_MAX) {
    const oldest = [...m.entries()].sort((a, b) => a[1] - b[1]).slice(0, m.size - RECENT_TAG_MAX);
    for (const [t] of oldest) m.delete(t);
  }
  if (recentTagsByIp.size > 2000) recentTagsByIp.clear();
}

function isRecentSimilar(tag, recent) {
  for (const r of recent) if (similarForVariety(tag, r)) return true;
  return false;
}

// そのタグを最後に使った時刻(未使用は0=最古扱い)
function lastUsedAtOf(ip, tag) {
  const m = recentTagsByIp.get(ip);
  return (m && m.get(tag)) || 0;
}

// 候補が全部「直近と似ている」時の選び方。
// ⚠️ 以前は重み付き抽選に戻していたため、最も人気のタグ(実測: 茶髪が9回)が繰り返し選ばれていた。
//    最後に使ってから一番古い候補を優先する(使ったばかりのタグは最後に回る)。
function pickLeastRecent(cands, ip) {
  // ⚠️ ここは [キー, 候補] の配列を返す必要がある。カンマ式にすると Map のエントリにならず、
  //    戻り値が undefined になって「Cannot read properties of undefined」で500になった(実測)
  const uniq = [...new Map(cands.map((c) => [c.tag || c.a + "\u0000" + c.b, c])).values()];
  uniq.sort((x, y) => {
    const tx = Math.max(lastUsedAtOf(ip, x.tag || x.a), lastUsedAtOf(ip, x.tag || x.b));
    const ty = Math.max(lastUsedAtOf(ip, y.tag || y.a), lastUsedAtOf(ip, y.tag || y.b));
    return tx - ty;
  });
  // ⚠️ 「古い方から5件をランダム」だと、候補が少ないバッチで同じタグ(茶髪×8)が繰り返し当たった。
  //    一番古い候補を選ぶ(同着はランダム)。結果的に候補を順番に使い回す動きになる。
  const oldest = uniq[0];
  const ties = uniq.filter((c) => {
    const t = (x) => Math.max(lastUsedAtOf(ip, x.tag || x.a), lastUsedAtOf(ip, x.tag || x.b));
    return t(c) === t(oldest);
  });
  return ties[Math.floor(Math.random() * ties.length)];
}

// ---------- 共起タグによる「その画像にTが写っていそうか」の推定 ----------
// AIタガーは個々の画像で誤る(誤付与・誤漏れ)。タグそのものは信用できないが、
// 「Tが付いた画像群に共通して現れる珍しいタグ(=Tらしい文脈)」はサイト全体の統計として使える。
// 実測(眼鏡・visionで検証):
//   ・Tなしでも共起スコアが高い画像 6枚中5枚に実際に眼鏡が写っていた(=誤漏れの検出)
//   ・Tありでも共起スコア0の画像 6枚中4枚には眼鏡が写っていなかった(=誤付与の検出)
// 方式(ランダムバッチ+除外フィルタ)は変えず、除外の判断材料を1つ増やすだけ。
const COMPANION_TTL_MS = 10 * 60 * 1000;
const COMPANION_LIMIT = Number(process.env.COMPANION_LIMIT || 60); // 共起を測るために取るT付き画像の枚数
const COMPANION_TIMEOUT_MS = Number(process.env.COMPANION_TIMEOUT_MS || 1500); // 間に合わなければフィルタ無しで出題
const COMPANION_RETRY_MS = 60 * 1000; // 取得に失敗したタグを再挑戦するまで
const COMPANION_MIN_RATIO = 0.3; // T付き画像の何割に現れれば「共起」とみなすか
const COMPANION_MIN_IDF = 0.5; // これ未満は汎用すぎて使わない
const COMPANION_THRESHOLD = 0.45; // T付き画像の中央値に対してこの割合以上なら「写っていそう」
const SITE_POSTS = Number(process.env.SITE_POSTS || 56000); // IDFの分母(サイト全体の枚数)
const companionCache = new Map(); // tag -> {comps, idfSum, ref, at}

function compScore(tagNames, comps, idfSum) {
  if (!comps || !idfSum) return 0;
  let sum = 0;
  for (const t of tagNames) {
    const w = comps.get(t);
    if (w) sum += w;
  }
  return sum / idfSum;
}

async function getCompanions(tag) {
  const hit = companionCache.get(tag);
  if (hit && Date.now() - hit.at < COMPANION_TTL_MS) return hit;
  let out = { comps: null, idfSum: 0, ref: 0, at: Date.now() };
  // ⚠️ 共起タグの取得が遅いと出題そのものが遅くなる。上限を切って、間に合わなければ
  //    「フィルタ無し」で先に進む(品質より可用性を落とさない)。失敗は短時間だけ記憶する。
  const res = await hkFetch(`/posts?query=${encodeURIComponent(tag)}&limit=${COMPANION_LIMIT}&fields=id,tags`, COMPANION_TIMEOUT_MS);
  if (!res) {
    const fail = { comps: null, idfSum: 0, ref: 0, at: Date.now() - COMPANION_TTL_MS + COMPANION_RETRY_MS };
    companionCache.set(tag, fail);
    return fail;
  }
  const posts = (res && res.results) || [];
  if (posts.length >= 20) {
    const freq = new Map();
    const usagesOf = new Map();
    for (const p of posts) {
      for (const t of p.tags || []) {
        const n = t.names[0];
        freq.set(n, (freq.get(n) || 0) + 1);
        usagesOf.set(n, t.usages);
      }
    }
    const comps = new Map();
    let idfSum = 0;
    for (const [n, c] of freq) {
      if (n === tag) continue;
      if (c / posts.length < COMPANION_MIN_RATIO) continue;
      const idf = Math.max(0, Math.log(SITE_POSTS / Math.max(1, usagesOf.get(n) || 1)));
      if (idf <= COMPANION_MIN_IDF) continue;
      comps.set(n, idf);
      idfSum += idf;
    }
    if (idfSum > 0 && comps.size >= 3) {
      const scores = posts.map((p) => compScore((p.tags || []).map((t) => t.names[0]), comps, idfSum)).sort((a, b) => a - b);
      out = { comps, idfSum, ref: scores[Math.floor(scores.length / 2)] || 0, at: Date.now() };
    }
  }
  if (companionCache.size > 400) companionCache.clear();
  companionCache.set(tag, out);
  return out;
}

// お題の語として出したくない語(画像は safety:safe でも、CAPTCHAの文面に出る)。
// 実測: 現行の帯域にも「多性器(421)」「二重肛門(437)」「セックストイ(239)」、
//       80〜149 の帯域には「ヌード(98)」「セックス(149)」「性器(106)」が存在した。
const NSFW_TAG = /性器|陰部|陰茎|陰嚢|睾丸|膣|肛門|乳首|乳輪|おっぱい|ちんこ|まんこ|ペニス|ヴァギナ|ふたなり|ディルドー|性行為|セックス|射精|精液|勃起|ヌード|全裸|半裸|裸体|排泄|放尿|糞|淫|痴|孕|妊娠|出産/;

function questionableTag(t, usages) {
  if (!usableTag(t)) return false;
  if (NSFW_TAG.test(t)) return false; // 文面に出すと不適切な語
  const n = Number(usages) || 0;
  if (n < 10 || n > 3000) return false; // ノイズ/メタ排除
  if (t.length > 10) return false;
  if (HAS_NUM.test(t)) return false; // 年号・数字入りを排除
  if (JUNK_START.test(t)) return false; // 句読点/記号始まり
  if (NON_WORD.test(t)) return false; // 記号・約物を含む(●_豆獣石× / 野菜、野菜 / “原始衝撃” 等)
  if (KATAKANA_PUNCT.test(t)) return false; // ・等(カタカナブロック内の約物)
  if (/\s/.test(t)) return false; // 空白入りはクエリ区切りと解釈される
  if (EXCLUDE_TAGS.has(t)) return false;
  if (POS_REJECT.has(t)) return false; // 品詞判定で除外(動詞的/形容動詞的/地名/人名)
  if (NO_PARTICLE.test(t)) return false; // 「〜の〜」の説明文(手のジェスチャー等)
  if (ABSTRACT_WORD.test(t)) return false; // 抽象・状態・分類を表す語
  if (SUFFIX_ABSTRACT.test(t)) return false; // 抽象化・分類の語尾
  if (PARTICLE_IN.test(t)) return false; // 助詞入り=文の断片
  if (!HAS_KATAKANA_OR_KANJI.test(t)) return false; // ひらがなのみ除外
  if (HIRA_TAIL.test(t)) return false; // 「黒地に」等の助詞/活用終端を除外
  if (META_TAG.test(t)) return false; // 構図/技術/メタ語
  if (STOP_TAG.test(t)) return false;
  if (HIRA.test(t) && (HIRA.test(t.slice(-2, -1)) || (t.match(/[\u3040-\u309f]/g) || []).length >= 3)) return false; // 文系キャプション
  return true;
}

// お題の「具体性スコア」: 一般によく使われる語(=ありふれた具体物)ほど高くする。
// 実測で、使用回数が多いタグは テレビ/カメラ/バッグ のような具体物、
// 少ないタグは 造語・抽象語(素材配布/型破りなメディア/ニセキン 等)に偏っていた。
// 具体物寄りに強く傾けるため平方根スケールで重み付けする
function concreteness(usages) {
  const u = Math.max(10, Number(usages) || 10);
  return Math.sqrt(u / 100); // 10→0.32, 100→1.0, 1000→3.16, 3000→5.48
}


// ---------- 出題生成 ----------

// 配信は contain(クロップなし)なので、極端に細長い画像以外は受け入れる。
// クロップをやめたので、以前のような「3:2付近しか使えない(全体の2.8%)」制約は不要。
function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0;
  const h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 1.0 && r <= 2.2; // 正方形〜横長(タイル3:2にcontainで収まる範囲)
}

// 画像プロキシ + 改変: 元URLにはhikabooruの投稿IDが含まれるため、そのまま渡すと
// 公開APIでタグを引いて正解を機械的に導出できてしまう。不透明IDに置き換えて中継する。
// さらに配信時に「余白付与+微小クロップ+回転+再圧縮」で改変する:
//   実測 pHash距離 20〜25/64 (元画像とは別物として扱われる) / バイト一致もしなくなる
//   → 事前にbooruを全件スクレイプして作った逆引き索引・完全一致キャッシュが使えなくなる
//   ※ 余白は控えめ(6〜9%)にして被写体の占有率を約85%確保し、タイルの見やすさを優先する
const images = new Map(); // imgId -> { url, exp, challengeId, buf, transformed }
// 視覚フィルタで事前取得した画像のキャッシュ(url -> {buf, exp})。
// フィルタのダウンロードを無駄にせず、クライアント配信時はここから返して即応答にする。
const prefetched = new Map();

// 品質フィルタの効き具合を測るための統計(チューニング用。/api/health で見られる)
const stats = {
  challenges: 0, tagRejects: 0, visRejects: 0, relaxedUsed: 0, visChecked: 0, lastVis: [], modes: {},
  // 出題生成の失敗理由(チューニング用。attempts=試行回数の合計)
  attempts: 0, fShortBatch: 0, fNoPair: 0, fNoTag: 0, fNotpickShape: 0, fNotShape: 0, fNoTarget: 0, fNeeds: 0, fPool: 0, dupRejects: 0, relatedExcluded: 0, relatedPromoted: 0, compChecked: 0, compDropped: 0, compRanked: 0, compSkipped: 0, fRecentEmpty: 0, recentDown: 0,
};
const IMG_TTL_MS = CHALLENGE_TTL_MS + 120 * 1000;
const IMG_MAX = 6000; // 保持する画像の上限(メモリ保護)

// 改変パラメータ(環境変数で調整可)
const TRANSFORM = process.env.IMG_TRANSFORM !== "0"; // 0で無効化
const JPEG_Q = Number(process.env.JPEG_Q || 3); // 再圧縮品質
const IMG_LONG_EDGE = Number(process.env.IMG_LONG_EDGE || 640); // 長辺のピクセル数

let FFMPEG = null; // 遅延判定(無ければ改変せず素通し)
function hasFfmpeg() {
  if (FFMPEG !== null) return FFMPEG;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    FFMPEG = true;
  } catch {
    FFMPEG = false;
    if (TRANSFORM) console.warn("[warn] ffmpeg が見つかりません。画像改変を無効化します(素通し配信)");
  }
  return FFMPEG;
}

const execFileP = promisify(execFile);
const TMP = mkdtempSync(path.join(tmpdir(), "hkc-img-"));
let tmpSeq = 0;

// 改変の方針(実測に基づく):
//  - クロップはしない(contain配信)。3:2に近い画像は全体の2.8%しかなく、
//    無理にクロップすると被写体が端で切れて「見づらい」原因になる(実測で確認)
//  - 反転は使わない。反転を考慮する攻撃者には距離0.2で無効(実測)なうえ、
//    日本語テキストが鏡像になって読みにくくなる(見づらさの原因)
//  - 回転も使わない(黒い三角が出る・幾何変換は適応的攻撃者に効かない)
//  残るのは再圧縮と微小なガンマのみ。バイト一致は防げるが知覚索引には弱い(README参照)。
async function transformImage(buf) {
  if (!TRANSFORM || !hasFfmpeg()) return null;
  const id = (tmpSeq = (tmpSeq + 1) % 100000);
  const inp = path.join(TMP, `i${id}.jpg`);
  const out = path.join(TMP, `o${id}.jpg`);
  writeFileSync(inp, buf);
  const filters = [];

  // 長辺を IMG_LONG_EDGE に揃える(タイル表示に十分・ファイルサイズも抑える)
  filters.push(`scale='if(gt(iw,ih),${IMG_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${IMG_LONG_EDGE})'`);

  // ガンマの微小変更(ピクセル統計をわずかに変える。見た目は保つ)
  const gamma = 0.97 + Math.random() * 0.06;
  filters.push(`eq=gamma=${gamma.toFixed(3)}`);

  try {
    await execFileP("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-vf", filters.join(","), "-q:v", String(JPEG_Q), out], { timeout: 8000 });
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    try { unlinkSync(inp); } catch {}
    try { unlinkSync(out); } catch {}
  }
}

function registerImage(upstreamUrl, challengeId) {
  const id = randomBytes(12).toString("hex");
  images.set(id, { url: upstreamUrl, exp: Date.now() + IMG_TTL_MS, challengeId, buf: null, transformed: null });
  if (images.size > IMG_MAX) {
    // 期限切れ→古い順に捨てる
    const arr = [...images.entries()].sort((a, b) => a[1].exp - b[1].exp);
    for (const [k] of arr.slice(0, images.size - IMG_MAX)) images.delete(k);
  }
  return id;
}

// リクエストのホストから公開ベースURLを作る(埋め込み先が別オリジンでも絶対URLで返す)
// 画像URLの組み立て。プロキシ配下では x-forwarded-proto を見るが、
// Cloudflare Tunnel 経由だと付かないことがある(実測: タイルURLがhttpになり、
// 混在コンテンツ扱いで余計な301が9回発生していた)。PUBLIC_BASE を設定すればそれを使う。
const PUBLIC_BASE = (process.env.PUBLIC_BASE || "").replace(/\/+$/, "");

function publicBase(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const fwd = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  // Cloudflare経由(cf-ray あり)なら https とみなす
  const proto = fwd || (req.headers["cf-ray"] ? "https" : "http");
  return `${proto}://${host}`;
}

// スクリーンショット/画面UIの画像を出題プールから除外する。
// 実測: 安全画像の約51%がスクリーンショット系タグ付き(最多は「日本語のテキスト」)。
// こうした画像はお題の被写体が「画面の小さなアバター」として写っていることが多く、
// タグは正しくても人間には判定できない(実測でXプロフィールのスクショが出題されていた)。
const SCREENSHOT_TAGS = new Set([
  "日本語のテキスト", "対話箱", "文字の壁", "プロフィール", "凍結済みアカウント",
  "スクリーンショット", "偽のスクリーンショット", "スクショ", "スクリーンキャプチャ",
  "ツイート", "twitter", "x", "タイムライン", "リツイート", "トレンド", "通知",
  "テロップ", "チャットログ", "メニュー", "チャンネル", "検索結果", "投稿画面",
  "アップロード", "アプリ", "ブラウザ", "ウェブサイト", "サイト", "ウィンドウ",
  "ui", "エクセル", "ワード", "字幕", "文字", "ロゴ", "タイトル", "見出し",
  "キャプション", "テキスト", "一覧", "画面", "スクリーン", "モニター",
]);

// 1枚あたりのタグ数が多い画像は「要素が多すぎる雑然とした画像」。
// 実測: 中央値28タグ。少ない画像ほど被写体が絞られている(<=25で41%)。
const MAX_TAGS_PER_IMAGE = Number(process.env.MAX_TAGS_PER_IMAGE || 26);

// 1つのoffsetから「連続した投稿」を取得する(内部用)。バッチ構築は下の fetchRandomImageBatch。
async function fetchSlice(offset, limit, level = 0) {
  const q = encodeURIComponent("safety:safe type:image");
  const d = await hkFetch(`/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags,source`);
  return (d?.results || [])
    .filter((p) => {
      if (!p || !p.id || !p.thumbnailUrl || !goodAspect(p)) return false;
      if (level >= 2) return true; // 緩和段階2: スクリーンショットも許容(出題不能を避ける)
      const names = (p.tags || []).map((x) => ((x.names && x.names[0]) || "").toLowerCase());
      if (names.some((n) => SCREENSHOT_TAGS.has(n))) return false; // 画面キャプチャ除外
      if (level === 0 && names.length > MAX_TAGS_PER_IMAGE) return false; // 雑然とした画像を除外
      return true;
    })
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
        tagCount: tagU.size,
        // 元ネタ(出題の多様性チェック用。表示には使わない)
        // 投稿者単位まで切り出す("x.com/hikakin" 等)。同じ人の連投を検出するため
        src: String(p.source || "").replace(/^https?:\/\//, "").split("/").slice(0, 2).join("/"),
      };
    });
}

// バッチ取得: **複数の離れたoffsetから小分けに取って混ぜる**。
// ⚠️ 実測(2026-09): 1回の連続取得(limit=60&offset=N)だと、その60件は
//    投稿IDが連番(間隔平均1.0)の「アップロード順の塊」になる。同じ投稿者が同じ元ネタを
//    連投していると、塊全体が同じ撮影/同じチャンネルになり、隣接画像のタグ類似が0.49まで上がる。
//    → 9枚のグリッドが同じ人物の別カットばかりになり「全部の画像が似通って見える」。
//    離れたoffsetから小分けに取るとID間隔が平均394まで広がり、隣接類似が0.27に下がる。
//    (hikabooruの構成自体も83%がx.com・37%がサムネイル系タグなので、元データ側の偏りは残る)
async function fetchRandomImageBatch(limit, level = 0) {
  const slices = Math.max(1, Math.min(SAMPLES_PER_BATCH, limit));
  const per = Math.max(1, Math.ceil(limit / slices));
  const offsets = [];
  while (offsets.length < slices) {
    const o = Math.floor(Math.random() * 29500);
    if (!offsets.includes(o)) offsets.push(o);
  }
  const parts = await Promise.all(offsets.map((o) => fetchSlice(o, per, level).catch(() => [])));
  const seen = new Set();
  const merged = [];
  for (const part of parts) {
    for (const p of part) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      merged.push(p);
    }
  }
  return merged;
}

// 出題の形式:
//  単一タグ … 「◯◯の画像を全部選べ」(正解=そのタグを持つ画像)
//  2タグAND … 「◯◯と△△の両方が写っている画像を全部選べ」(正解=両方のタグを持つ画像)
// 実測で「お題タグは1つに限らなくてよい」という方針に基づき、2タグの組み合わせも出題する。
// これで出題のバリエーションが増え、ボット側は2つの対象を照合する必要があるため難度も上がる。
// 実測(2026-09): 2タグAND出題は vision検証4件すべてで成立しなかった。
//   「ビーニー×野球帽」→ 真実2枚に対しvisionは7枚が該当(誤漏れ5枚)
//   「ジュースボックス×モグラ」→ 真実2枚ともvisionは「該当なし」(誤付与)
//   AIタグ付けの誤付与どうしの重なりで作られるため、両方が本当に写っている画像はほぼ無い。
// 解けないCAPTCHAはロボットより人間を弾くので、既定では無効にする。
// PAIR_PROB=0.2 のように環境変数で有効化できる(品質よりバリエーションを優先する場合)。
// --- 出題形式(種類) ---
// 出題の種類 = {タグを持つ|持たない} × {全部|N枚} と、2タグの AND / OR。
//   single 「◯◯の画像を全部選べ」          … 持つ × 全部
//   pick   「◯◯が写っている画像を◯枚だけ」 … 持つ × N枚
//   not    「◯◯が写っていない画像を全部」   … 持たない × 全部
//   notpick「◯◯が写っていない画像を◯枚だけ」… 持たない × N枚
//   or     「◯◯または△△が写っている画像を全部」
//   and    「◯◯と△△の両方が写っている画像を全部」(実測で成立しなかったため既定0)
// 重みは MODE_WEIGHTS="single=3,not=2,pick=2,or=1" で調整できる(重み0で無効化)。
// 実測(2026-09): 形式ごとに人間が解けるかをvisionで採点して重みを決めている(README参照)。
const MODE_WEIGHTS = (() => {
  // 既定の重みは実測(各形式をvisionで採点)に基づく:
  //   not    … 実測2件で良好(8枚中8枚一致/7枚一致+ダミーを正しく指摘)。ダミー1枚を探す形は人間に明確
  //   single … 従来の基準形式
  //   notpick… 「1枚だけ◯◯がない」は仲間外れとして視覚的に明確(完全一致)。ただし誤漏れに弱い
  //   pick   … 「◯枚だけ」は枚数固定のためタグ1つの誤りが即不正解(実測3件すべてで1枚ずれ)
  //   or     … ダミーが2つのタグ両方を持たない必要があり、誤漏れに弱い(実測で余分な正解が出た)
  //   and    … AIタグ付けでは成立しない(過去に実測4件すべて失敗)
  // pick / or / and を増やしたい場合は MODE_WEIGHTS を指定する
  const raw = process.env.MODE_WEIGHTS || "single=3,not=3,notpick=1,pick=1,or=1,and=0";
  const m = new Map();
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    if (k && k.trim()) m.set(k.trim(), Math.max(0, Number(v || 0)));
  }
  // 旧名(互換): PAIR_PROB は and の重み(×10)として扱う
  if (process.env.PAIR_PROB !== undefined) m.set("and", Math.round(Number(process.env.PAIR_PROB) * 10));
  return m;
})();
const FORCE_MODE = process.env.FORCE_MODE || null; // 検証用に形式を固定する

// お題タグの最低使用回数。実測(40バッチ・11855件)で「バッチ内1〜3枚に付くタグ」の
// 半数は usages≦53 のOCRノイズ(例: 明治安B / グラタ / Mondu)だった。
// そうしたタグは画像と対応しておらず解けない問題になるので、候補から外す。
// 実測: 150 で約55%のタグが消えるが、候補数は十分残る(4枚以上の帯は中央3631)。
// 実測: 下限150で使えるタグは316個(帯域1413)。80に下げると525個まで増えるが、
// vision採点でタイル誤り率が 16.7% → 31.9% に悪化した(珍しいタグは付与が不整合で不公平な出題になる)。
// 多様性より公平さを優先して150を既定にする(変えたい時は TAG_MIN_USAGES=80)。
const TAG_MIN_USAGES = Number(process.env.TAG_MIN_USAGES || 150);

// 1回に取る画像の枚数。フィルタで落ちる分を見込んで多めに取る
// (実測: 20枚だと9枚に足りない空振りが多発し、API往復で出題が遅くなっていた)。
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 60);

// 1バッチを何個の「離れたoffset」から集めるか。
// 1にすると連続した塊を引いてしまい、9枚が同じ撮影/同じチャンネルになる(実測で確認)。
const SAMPLES_PER_BATCH = Number(process.env.SAMPLES_PER_BATCH || 6);

function chooseMode() {
  if (FORCE_MODE) return FORCE_MODE;
  const roulette = [];
  for (const [m, w] of MODE_WEIGHTS) for (let i = 0; i < w; i++) roulette.push(m);
  if (!roulette.length) return "single";
  return roulette[Math.floor(Math.random() * roulette.length)];
}

// 出題の「聞き方」。クライアントはこの文面をそのまま表示する(埋め込み側の見た目も揃う)
function buildAsk(mode, tags, n) {
  const [a, b] = tags;
  switch (mode) {
    case "not":
      return { mode, tags, n: 0, maxSelect: 0, text: `「${a}」が写っていない画像を全部選んでください` };
    case "pick":
      return { mode, tags, n, maxSelect: n, text: `「${a}」が写っている画像を${n}枚だけ選んでください` };
    case "notpick":
      return { mode, tags, n, maxSelect: n, text: `「${a}」が写っていない画像を${n}枚だけ選んでください` };
    case "or":
      return { mode, tags, n: 0, maxSelect: 0, text: `「${a}」または「${b}」が写っている画像を全部選んでください` };
    case "and":
      return { mode, tags, n: 0, maxSelect: 0, text: `「${a}」と「${b}」の両方が写っている画像を全部選んでください` };
    default:
      return { mode: "single", tags, n: 0, maxSelect: 0, text: `「${a}」の画像を全部選んでください` };
  }
}


// --- 視覚的な見分けやすさフィルタ ---
// タグの重なりでは検出できない不公平を、画像そのものの類似度で捕まえる。
//  実測の失敗例: 「長袖」で同じ人物の雪山ジャケット連続写真8枚のうちタグは2枚だけ。
//  visionは8枚すべてを長袖と判定 → 人間には区別できず、正解を選べない。
// 画像を8x8グレースケールの64bit署名にしてハミング距離で比べ、
//  「ダミーが正解同士より似ている(距離比>=1.0)」出題は捨てる。
// 依存ゼロを維持するため ffmpeg の rawvideo 出力だけを使う。
const VIS_FILTER = process.env.VIS_FILTER !== "0"; // VIS_FILTER=0 で無効化
const VIS_MAX_DIST_RATIO = Number(process.env.VIS_MAX_DIST_RATIO || 1.0);

// 9枚を「1回のffmpeg」でまとめて8x8署名にする(9プロセス起動は約700msかかるため)。
// 縦に連結(vstack)して576バイトを一括で受け取り、64バイトずつ切り分ける。
function sigs8x8Batch(bufs) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hkcvis-"));
    try {
      const files = bufs.map((b, i) => {
        const f = path.join(dir, `i${i}.jpg`);
        writeFileSync(f, b);
        return f;
      });
      const args = ["-v", "error"];
      for (const f of files) args.push("-i", f);
      const parts = bufs.map((_, i) => `[${i}:v]scale=8:8,format=gray[a${i}]`).join(";");
      const stack = bufs.map((_, i) => `[a${i}]`).join("") + `vstack=inputs=${bufs.length}[out]`;
      args.push(
        "-filter_complex", `${parts};${stack}`,
        "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
      );
      const p = spawn("ffmpeg", args);
      const chunks = [];
      p.stdout.on("data", (d) => chunks.push(d));
      p.on("close", (code) => {
        const out = Buffer.concat(chunks);
        const need = bufs.length * 64;
        if (code !== 0 || out.length < need) return resolve(null);
        const sigs = [];
        for (let i = 0; i < bufs.length; i++) {
          const px = [...out.subarray(i * 64, i * 64 + 64)];
          const mean = px.reduce((a, c) => a + c, 0) / 64;
          sigs.push(px.map((v) => (v > mean ? 1 : 0)));
        }
        resolve(sigs);
      });
      p.on("error", () => resolve(null));
    } catch {
      resolve(null);
    } finally {
      setTimeout(() => {
        try {
          for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f));
          rmdirSync(dir);
        } catch {}
      }, 3000);
    }
  });
}

// 距離比(大きいほど見分けにくい)を返す。判定不能なら null(フィルタは素通し)。
async function distanceRatio(pairs) {
  if (!VIS_FILTER || pairs.length !== 9) return null;
  try {
    const bufs = await Promise.all(
      pairs.map(async (p) => {
        try {
          const r = await fetch(p.url, {
            headers: { "user-agent": "hikamani-captcha/1.0" },
            signal: AbortSignal.timeout(4000),
            cache: "no-store",
          });
          if (!r.ok) return null;
          const b = Buffer.from(await r.arrayBuffer());
          // 事前取得分をキャッシュして、配信時に使い回す(無駄な再ダウンロードを防ぐ)
          if (prefetched.size > 400) prefetched.clear();
          prefetched.set(p.url, { buf: b, exp: Date.now() + 120000 });
          return b;
        } catch {
          return null;
        }
      })
    );
    if (bufs.some((b) => !b)) return null;
    const sigs = await sigs8x8Batch(bufs);
    if (!sigs || sigs.some((s) => !s)) return null;
    const ham = (a, b) => {
      let d = 0;
      for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
      return d;
    };
    const tg = pairs.map((p, i) => (p.target ? i : -1)).filter((i) => i >= 0);
    const dm = pairs.map((p, i) => (p.target ? -1 : i)).filter((i) => i >= 0);
    if (!tg.length || !dm.length) return null;
    // ① 正解同士の平均距離と、ダミーが正解に寄る距離の比(平均ベース)
    let tt = 0, n = 0, minTT = 999;
    for (let a = 0; a < tg.length; a++)
      for (let b = a + 1; b < tg.length; b++) {
        const d = ham(sigs[tg[a]], sigs[tg[b]]);
        tt += d; n++;
        if (d < minTT) minTT = d;
      }
    tt = n ? tt / n : 0;
    // ② 最短ペアでの比較(平均は「同じ画像が複数ある」場合に歪むため、最短で見る)
    let dd = 0, minDT = 999;
    for (const d of dm) {
      let m = 999;
      for (const t of tg) m = Math.min(m, ham(sigs[d], sigs[t]));
      dd += m;
      if (m < minDT) minDT = m;
    }
    dd = dd / dm.length;
    const meanRatio = tt / Math.max(1, dd);
    // グリッド内に(ほぼ)同一の画像が2枚あると不公平。
    // 同じ絵なのに片方だけ正解/不正解になる(実測: 同一画像が並ぶと距離0)。
    let minAll = 999;
    for (let a = 0; a < sigs.length; a++)
      for (let b = a + 1; b < sigs.length; b++) {
        const d = ham(sigs[a], sigs[b]);
        if (d < minAll) minAll = d;
      }
    if (minAll <= 2) {
      stats.dupRejects++;
      stats.lastVis.push({ dup: minAll, unfair: true });
      if (stats.lastVis.length > 15) stats.lastVis.shift();
      return 3.0; // 深刻度を高く返して却下させる
    }

    // 見分け不能と判定する条件(実測で調整):
    //   ⚠️ 最小値同士の比較は統計的に歪む(ダミーは63ペア、正解同士は1ペア →
    //      最小値は必ずダミー側が小さくなる)。平均同士で比べる。
    //   ⚠️ 閾値を厳しくしすぎると大半の出題が弾かれ、緩和レベル(品質フィルタOFF)に
    //      落ちて実質無効になる(実測: 0.9で却下が94%、緩和レベルに22/30が流出)。
    //      明らかに不公平な場合だけ落とす控えめな値にする(実測0.7で約1割)。
    //   a) ダミーの「最も近い正解との距離」の平均が、正解同士の平均距離より明確に近い
    //      (= ダミーは正解と同程度に似ている → 人間には区別できない)
    //   b) ダミーが正解とほぼ同一画像(距離3以下)
    // 正解が1枚だけの形式は、その1枚が他の8枚と視覚的に区別できることを要求する
    // (区別できなければ人間には探せず「解けないCAPTCHA」になる)。
    const singleTargetUnfair = tg.length === 1 && minDT < 10;
    const unfair = dd < tt * 0.7 || minDT <= 3 || singleTargetUnfair;
    // チューニング用: 実際の距離の値を残す(/api/health の stats.lastVis で見られる)
    stats.lastVis.push({ tt: +tt.toFixed(1), dd: +dd.toFixed(1), minDT, minTT, unfair });
    if (stats.lastVis.length > 15) stats.lastVis.shift();
    if (!unfair) return null;
    return Math.max(1.0, meanRatio, minDT <= 3 ? 2.0 : 0);
  } catch {
    return null; // 取得失敗時はフィルタせず出題する(可用性優先)
  }
}

// 投稿者(元ネタ)が偏らないように選ぶ。各投稿者から1枚ずつ巡回して取る(ラウンドロビン)。
// 実測: 連続取得では9枚すべてが同じ投稿者だった(=「全部なんとなく似てる」の正体)。
// 投稿者を巡回させると元ネタ種類が1種→4〜6種に増える。
function pickBySrcDiversity(pool, count, srcOf) {
  const groups = new Map();
  for (const idx of pool) {
    const s = srcOf(idx) || "(なし)";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(idx);
  }
  const lists = shuffle([...groups.values()]).map((g) => shuffle(g));
  const out = [];
  let added = true;
  while (out.length < count && added) {
    added = false;
    for (const g of lists) {
      if (out.length >= count) break;
      if (g.length) { out.push(g.pop()); added = true; }
    }
  }
  return out;
}

// ダミーを「タグが似ていない順」に選ぶ(グリッド全体が似通うのを防ぐ)。
// 実測: 同じ撮影の別カットが並ぶと「全部の画像が似通って見える」。
// 画像そのものの類似は視覚フィルタが別途見るので、ここはタグの多様性だけで選ぶ(追加コスト0)。
function pickDiverse(pool, count, sets, already, srcOf, usedSrc) {
  const chosen = [];
  const picked = [...already];
  const rest = [...pool];
  const used = new Set(usedSrc || []);
  while (chosen.length < count && rest.length) {
    let bestI = 0, bestScore = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const A = sets.get(rest[i]) || new Set();
      let m = 0;
      for (const P of picked) {
        const B = P instanceof Set ? P : (sets.get(P) || new Set());
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        const u = new Set([...A, ...B]).size;
        const j = u ? inter / u : 0;
        if (j > m) m = j;
      }
      // 同じ投稿者の画像には大きなペナルティ(タグ類似より優先)。
      // 実測: 連続取得だと9枚すべてが同じ投稿者だった(=「全部なんとなく似てる」の正体)。
      // ここで投稿者を分散させると、元ネタ種類が1種→5種程度まで増える。
      const s = srcOf(rest[i]);
      const penalty = s && used.has(s) ? 1.0 : 0;
      const score = m + penalty;
      if (score < bestScore) { bestScore = score; bestI = i; }
    }
    const pick = rest.splice(bestI, 1)[0];
    chosen.push(pick);
    picked.push(sets.get(pick) || new Set());
    const ps = srcOf(pick);
    if (ps) used.add(ps);
  }
  return chosen;
}

// 出題生成の同時実行数。booru API と ffmpeg を叩くので、無制限に並走させると
// 自分のリソースで詰まって 502(問題を準備できませんでした)が多発する
// (実測: 同時130発で68件が502)。
// → 同時実行だけ絞って**順番待ちは無制限**にする(拒否しない)。
//    負荷が来たら「エラーで弾く」のではなく「時間がかかる」方向に倒す。
//    レート制限は既定で無効なので、これが唯一の流量調整になる。
const MAKE_CONCURRENCY = Number(process.env.MAKE_CONCURRENCY || 4);
let makeRunning = 0;
const makeQueue = [];

async function withMakeSlot(fn) {
  if (makeRunning >= MAKE_CONCURRENCY) {
    await new Promise((res) => makeQueue.push({ res }));
  }
  makeRunning++;
  try {
    return await fn();
  } finally {
    makeRunning--;
    const next = makeQueue.shift();
    if (next) next.res();
  }
}

async function makeChallenge(ip = "") {
  // フィルタを段階的に緩める(厳しいフィルタで出題できない場合に品質より可用性を優先)。
  // 段階0=厳しい(スクショ除外+タグ数制限) / 1=スクショ除外のみ / 2=制限なし+候補条件も緩和
  const LEVELS = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2];
  let visRejects = 0; // 視覚フィルタで却下した回数(閾値を段階的に緩めるのに使う)
  for (let i = 0; i < LEVELS.length; i++) {
    const level = LEVELS[i];
    const relaxed = level >= 2;
    // 形式を先に決めてからバッチを取る。notpick は「タグがグリッドをほぼ埋める」画像が要るため多めに取る
    const mode = chooseMode();
    const firstLimit = mode === "notpick" ? Math.max(60, BATCH_LIMIT) : BATCH_LIMIT;
    let batch = await fetchRandomImageBatch(firstLimit, level);
    stats.attempts++;
    // 実測: フィルタ通過率が低く、30枚取っても9枚に足りないことが多い(空振りの53%)。
    // 足りないときは1回だけ取得枚数を倍にして取り直す(level 0〜1の再利用で往復を減らす)。
    if (batch.length < GRID_SIZE) {
      stats.fShortBatch++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fShortBatch" + " mode=" + mode + "\n");
      batch = await fetchRandomImageBatch(Math.max(100, firstLimit * 2), level);
      stats.attempts++;
      if (batch.length < GRID_SIZE) { stats.fShortBatch++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fShortBatch" + " mode=" + mode + "\n"); continue; }
    }
    // 投稿者(元ネタ)の識別: 同じ人の連投が並ぶのを避ける選択に使う
    const srcOf = (idx) => batch[idx] && batch[idx].src;

    // タグごとに「どの画像に付いているか」を保持(2タグの組み合わせ判定に使う)
    const byTag = new Map(); // tag -> {usages, imgs:Set<index>}
    for (let idx = 0; idx < batch.length; idx++) {
      const p = batch[idx];
      for (const t of p.tags) {
        const usages = p.tagU.get(t) || 0;
        if (!questionableTag(t, usages)) continue;
        const cur = byTag.get(t);
        if (cur) cur.imgs.add(idx);
        else byTag.set(t, { usages, imgs: new Set([idx]) });
      }
    }

    // --- 出題形式を決めて、正解とダミー候補を作る ---
    let promptTags = [];
    let targetIdxs = [];
    let distractorPool = [];
    let askN = 0;

    if (mode === "and" || mode === "or") {
      // 2タグ: AND=両方を持つ画像 / OR=どちらかを持つ画像が正解
      const pairCands = [];
      const tagList = [...byTag.entries()];
      for (let a = 0; a < tagList.length; a++) {
        for (let b = a + 1; b < tagList.length; b++) {
          const [ta, va] = tagList[a];
          const [tb, vb] = tagList[b];
          // 片方が他方を含む組み合わせは避ける(例: ライフル / アサルトライフル)。
          // 見た目で区別できず、片方だけの画像を引っかけにすると人間には不公平になる
          if (ta.includes(tb) || tb.includes(ta)) continue;
          // OCRノイズのような低品質タグを除外する(画像と対応していない)
          if (va.usages < TAG_MIN_USAGES || vb.usages < TAG_MIN_USAGES) continue;
          let both = 0;
          for (const idx of va.imgs) if (vb.imgs.has(idx)) both++;
          const union = new Set([...va.imgs, ...vb.imgs]).size;
          if (mode === "and") {
            if (va.imgs.size < 2 || vb.imgs.size < 2) continue;
            if (both < 2 || both > (relaxed ? 4 : 3)) continue; // 両方を持つ画像が2〜3枚
            if (!relaxed && union > 8) continue; // 広すぎる(ダミーが作れない)
          } else {
            // OR: 両方を持つ画像があると「どちらか」の答えが紛れるので避ける
            if (both >= 1) continue;
            if (va.imgs.size < 2 || vb.imgs.size < 2) continue;
            if (union > 6) continue;
          }
          pairCands.push({ a: ta, b: tb, both, ua: va.usages, ub: vb.usages, union });
        }
      }
      if (!pairCands.length) { stats.fNoPair++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNoPair" + " mode=" + mode + "\n"); continue; }
      // 具体性の高い組み合わせを優先して抽選(両方を持つ画像が多い=主題らしい)
      const recentPair = recentTagsOf(ip);
      const pairPickable = pairCands.filter((c) => !isRecentSimilar(c.a, recentPair) && !isRecentSimilar(c.b, recentPair));
      let pick;
      if (pairPickable.length) {
        const roulette = [];
        for (const c of pairPickable) {
          const w = Math.max(1, Math.round((c.both || 1) ** 1.5 * Math.sqrt(Math.sqrt(concreteness(c.ua) * concreteness(c.ub))) * 10));
          for (let k = 0; k < w; k++) roulette.push(c);
        }
        pick = roulette[Math.floor(Math.random() * roulette.length)];
      } else {
        pick = pickLeastRecent(pairCands, ip) || pairCands[0];
        stats.fRecentEmpty = (stats.fRecentEmpty || 0) + 1;
      }
      promptTags = [pick.a, pick.b];
      const setA = byTag.get(pick.a).imgs;
      const setB = byTag.get(pick.b).imgs;
      if (mode === "or") {
        targetIdxs = [...new Set([...setA, ...setB])];
      } else {
        for (const idx of setA) if (setB.has(idx)) targetIdxs.push(idx);
      }
      // ダミー: ANDは「片方だけ持つ画像」を優先的に引っかけにする。ORは「どちらも持たない画像」だけ
      // お題タグと関連する別タグを持つ画像は、人間には「写っている」と見えるので除外する
      const relPair = new Set();
      for (const t of promptTags) for (const [tag] of byTag) if (relatedTag(t, tag)) relPair.add(tag);
      const ambPair = (idx) => [...batch[idx].tags].some((t) => relPair.has(t) && !promptTags.includes(t));
      const tset = new Set(targetIdxs);
      const trap = [];
      const rest = [];
      for (let idx = 0; idx < batch.length; idx++) {
        if (tset.has(idx)) continue;
        if (relPair.size && ambPair(idx)) { stats.relatedExcluded++; continue; }
        if (setA.has(idx) || setB.has(idx)) trap.push(idx);
        else rest.push(idx);
      }
      distractorPool = [...shuffle(trap), ...shuffle(rest)];
    } else {
      // 単一タグ: {持つ|持たない} × {全部|N枚}
      const wantsAbsent = mode === "not" || mode === "notpick";
      // 出現回数(=同じバッチで何枚に付いているか)が多いタグほど「その画像の主題」である確率が高い。
      // 実測: 出現2枚のタグは誤付与(例: 電車の画像に「バッグ」)が混ざり、正解が人間に見て分からない問題になった。
      // 「◯枚だけ選べ」の枚数(1〜3枚)。タグが何枚に付いていても、グリッドに出す枚数で決める
      const pickN = 1 + Math.floor(Math.random() * 3);
      // グリッドに入れる正解の最大枚数(多すぎると選ぶのが大変になる)
      const targetMax = relaxed ? 6 : 5;
      const roulette = [];
      const recentTags = recentTagsOf(ip);
      for (const [tag, v] of byTag) {
        const n = v.imgs.size;
        if (v.usages < TAG_MIN_USAGES) continue; // OCRノイズのような低品質タグを除外する
        let w = 0;
        // ⚠️ 以前は「タグがちょうどN枚に付いている」ことを条件にしていたが、取得枚数を増やすと
        //    候補が枯れる(実測: 空振りが増えた)。グリッドに出す枚数はこちらで選べるので、
        //    「タグを持つ画像がN枚以上ある」ことだけを条件にする。
        // ⚠️ 以前は n² × concreteness(usages) で重み付けしていたが、これだと
        //    「バッチに5枚あって使用回数も多いタグ」が他より24倍有利になり、
        //    礼服×10 / 茶髪×8 のように同じタグばかり出ていた(実測: 120問で再出率40%)。
        //    平方根スケールに平坦化して、珍しいが有効なタグにも十分な確率を渡す。
        const flatW = (nn) => Math.min(nn, targetMax) ** 1.5 * Math.sqrt(concreteness(v.usages)) * 10;
        if (mode === "pick") {
          if (n >= pickN) w = Math.max(1, Math.round(flatW(Math.min(n, pickN))));
        } else if (mode === "notpick") {
          // 「◯枚だけ持たない」= グリッドのほとんどがそのタグで埋まる必要がある
          if (n >= GRID_SIZE - 2) w = Math.max(1, Math.round(concreteness(v.usages) * 10));
        } else if (wantsAbsent) {
          // not: タグを持つ画像をダミー(1〜3枚)としてグリッドに入れる
          if (n >= 1) w = Math.max(1, Math.round(concreteness(v.usages) * 10));
        } else {
          // single: 正解2枚以上(出現数の多いタグを優先=主題らしい)
          if (n >= 2) w = Math.max(1, Math.round(flatW(n)));
        }
        // 直近で出したタグ(とその類似タグ)は重みを1/20に落とす。
        // ⚠️ 除外にすると候補が尽きて「記憶を無視して再出」が27%起きたので、必ず候補には残す
        if (w > 0) for (let k = 0; k < w; k++) roulette.push({ tag, n, usages: v.usages });
        if (w > 0) stats.wSum = (stats.wSum || 0) + w;
      }
      if (!roulette.length) { stats.fNoTag++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNoTag" + " mode=" + mode + "\n"); continue; }
      // 直近に出したタグ(とその類似タグ)は避ける。避けた結果ゼロなら全体から選ぶ
      // ⚠️ 重みを下げる方式では人気タグが結局勝っていた(実測: 礼服×10)ので、除外に切り替える
      let pick = null;
      const pool = roulette.filter((r) => !isRecentSimilar(r.tag, recentTags));
      if (pool.length) {
        pick = pool[Math.floor(Math.random() * pool.length)];
      } else {
        pick = pickLeastRecent(roulette, ip) || roulette[0];
        stats.fRecentEmpty = (stats.fRecentEmpty || 0) + 1;
      }
      promptTags = [pick.tag];
      const tagSet = byTag.get(pick.tag).imgs;
      const absent = [];
      for (let idx = 0; idx < batch.length; idx++) if (!tagSet.has(idx)) absent.push(idx);
      // --- 関連タグによる曖昧さの排除 ---
      // AIタガーは同じ概念を別タグで付ける(シャツ / 灰色のシャツ / ワイシャツ)。
      // そういう画像は「Tが写っているか」を人間が判断できない(選べば不正解)ので、
      // 正解にもダミーにも使わない。実測で36%の出題に該当していた=誤漏れの主要因。
      const related = new Set();
      for (const [tag] of byTag) if (relatedTag(pick.tag, tag)) related.add(tag);
      const isAmbiguous = (idx) => [...batch[idx].tags].some((t) => related.has(t));

      // --- 共起タグによる「写っていそう」の推定(タグの誤りを統計で補正する) ---
      // AIタガーの誤りで一番困るのは「人間には写って見えるのに正解に入っていない画像(誤漏れ)」。
      // タグが無くても、そのタグの画像群に共通して現れる珍しいタグを持っていれば
      // 「実は写っている」可能性が高い(実測: 該当画像6枚中5枚に実際に写っていた)。
      const comp = await getCompanions(pick.tag);
      const likelyHas = new Set();
      if (comp.comps) {
        const thr = comp.ref * COMPANION_THRESHOLD;
        for (let idx = 0; idx < batch.length; idx++) {
          if (compScore(batch[idx].tags, comp.comps, comp.idfSum) >= thr) likelyHas.add(idx);
        }
        stats.compChecked = (stats.compChecked || 0) + 1;
      } else {
        stats.compSkipped = (stats.compSkipped || 0) + 1;
      }
      // 共起スコアを「閾値」ではなく「順位」として使う:
      // ダミーはスコアの低い側から、正解は高い側から選ぶ。閾値で切るより頑健
      // (実測: スコア上位のタグ無し画像6枚中5枚に実際に写っていた/スコア0の画像は写っていない)
      const scoreOf = (idx) => (comp.comps ? compScore(batch[idx].tags, comp.comps, comp.idfSum) : 0);
      const preferByScore = (idxs, n, desc) => {
        if (!comp.comps || idxs.length <= n) return idxs;
        const sorted = idxs.slice().sort((a, b) => (desc ? scoreOf(b) - scoreOf(a) : scoreOf(a) - scoreOf(b)));
        return sorted.slice(0, Math.max(n, Math.min(sorted.length, n * 3))); // 上位3倍から多様性で選ぶ余地を残す
      };

      // 誤漏れ側: 関連タグ持ち or 共起スコアが高い「タグ無し画像」は人間には写って見える
      const looksLikeT = (idx) => (related.size && isAmbiguous(idx)) || likelyHas.has(idx);
      const absentSafe = absent.filter((idx) => !looksLikeT(idx));
      if (absentSafe.length < absent.length) stats.relatedExcluded += absent.length - absentSafe.length;
      const usable = absentSafe;
      if (wantsAbsent) {
        // 正解 = タグを持たない画像(グリッド内で「持たない」のは正解だけ) / ダミー = タグを持つ画像
        // ⚠️ ダミー(=「◯◯が写っている」側)もタグが信用できない。誤付与された画像をダミーに置くと、
        //    人間は「写っていない」と判断して選ばないので不正解になる(共起スコアで選別する)
        // ⚠️ ここは「削除」ではなく「並べ替え」に留める。ダミーはグリッドの大半を埋めるので、
        //    削ると出題そのものが作れなくなる(実測: notpick が fPool で全滅した)
        const decoyPool = [...tagSet];
        if (mode === "notpick") {
          const N = Math.max(1, Math.min(2, GRID_SIZE - tagSet.size));
          if (usable.length < N || tagSet.size < GRID_SIZE - N) { stats.fNotpickShape++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNotpickShape" + " mode=" + mode + "\n"); continue; }
          targetIdxs = pickBySrcDiversity(preferByScore(usable, N, false), N, srcOf);
          distractorPool = shuffle(preferByScore(decoyPool, GRID_SIZE - N, true)).slice(0, GRID_SIZE - N);
          askN = N;
        } else {
          const k = Math.max(1, Math.min(tagSet.size, 1 + Math.floor(Math.random() * 3)));
          if (usable.length < GRID_SIZE - k) { stats.fNotShape++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNotShape" + " mode=" + mode + "\n"); continue; }
          targetIdxs = pickBySrcDiversity(preferByScore(usable, GRID_SIZE - k, false), GRID_SIZE - k, srcOf);
          distractorPool = shuffle(preferByScore(decoyPool, k, true)).slice(0, k);
        }
      } else {
        // 正解 = タグを持つ画像 + 関連タグを持つ画像から必要枚数だけグリッドに入れる
        // ⚠️ 関連タグ持ち(例: お題「シャツ」に対し「灰色のシャツ」が付いた画像)は、
        //    人間には「シャツが写っている」と見えるので**正解側に入れる**のが正しい。
        //    ダミー側に置くと「選べば不正解」になり、これが誤漏れによる不公平の主因だった。
        //    除外だけでは「正解が減る」だけで、人間が見て選ぶ画像が答えから漏れたままになる。
        const relatedImgs = absent.filter(looksLikeT);
        if (relatedImgs.length) stats.relatedPromoted = (stats.relatedPromoted || 0) + relatedImgs.length;
        // 誤付与側: タグが付いていても共起スコアが極端に低い画像は、タグが間違っている可能性が高い
        // (実測: 共起スコア0の「眼鏡」付き画像6枚中4枚には眼鏡が写っていなかった)
        // ⚠️ 削除は「スコア0(=そのタグの文脈がまったく無い)」に限定し、正解が2枚以上残る時だけ。
        //    実測(眼鏡): スコア0のタグ付き画像6枚中4枚には写っていなかった
        let tagSetUsed = [...tagSet];
        if (comp.comps && comp.ref > 0) {
          const noCtx = tagSetUsed.filter((idx) => scoreOf(idx) <= 0);
          const kept = tagSetUsed.filter((idx) => scoreOf(idx) > 0);
          if (noCtx.length && kept.length >= 2) {
            stats.compDropped = (stats.compDropped || 0) + noCtx.length;
            tagSetUsed = kept;
          }
        }
        const targetPool = [...tagSetUsed, ...relatedImgs];
        const want = mode === "pick" ? pickN : Math.min(targetMax, targetPool.length);
        targetIdxs = pickBySrcDiversity(preferByScore(targetPool, want, true), Math.min(want, targetPool.length), srcOf);
        // ダミーは「写っていない確度が高い」= 共起スコアの低い画像から選ぶ(誤漏れ対策の本命)
        distractorPool = shuffle(preferByScore(usable, GRID_SIZE, false));
        if (comp.comps) stats.compRanked = (stats.compRanked || 0) + 1;
        askN = mode === "pick" ? targetIdxs.length : 0;
      }
    }


    if (!targetIdxs.length) { stats.fNoTarget++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNoTarget" + " mode=" + mode + "\n"); continue; }
    rememberTags(ip, promptTags);

    // --- 一貫性フィルタ: 正解候補から「浮いた1枚」を除く ---
    // AIタグ付けの誤付与(例: 商品の箱だけの画像に「カーディガン」)は、
    // 他の正解画像と「意味のあるタグ」を共有しないことが多い(実測で確認)。
    // ⚠️ 実測の落とし穴: ゴミタグ(11 / なんだって / おじいちゃん向けコンテンツ 等)は
    //    ほぼ全画像に付くため、それを共通タグとして数えるとフィルタが機能しない。
    //    お題タグと同じ基準(questionableTag)を通る意味のあるタグだけを使う。
    const meaningful = (p) => [...p.tags].filter((t) => questionableTag(t, p.tagU.get(t) || 0));
    // ⚠️ not / notpick は正解が「タグを持たない画像」の寄せ集めで、共通タグを持つ前提が無い。
    //    ここで正解を削ると、ダミー(タグを持つ画像)の枚数と辻褄が合わなくなり出題が壊れる
    //    (実測: not で Pool:10 の空振りが出ていた)。
    if (targetIdxs.length >= 3 && mode !== "not" && mode !== "notpick") {
      const sets = targetIdxs.map((idx) => new Set(meaningful(batch[idx]).filter((t) => !promptTags.includes(t))));
      const jac = (A, B) => {
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        return inter / new Set([...A, ...B]).size;
      };
      const avgs = sets.map((s, i) => {
        let sum = 0;
        for (let j = 0; j < sets.length; j++) if (j !== i) sum += jac(s, sets[j]);
        return sum / (sets.length - 1);
      });
      const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
      if (mean > 0) {
        // 平均の60%未満しか似ていない正解は「浮いた1枚」として落とす
        const kept = targetIdxs.filter((_, i) => avgs[i] >= mean * 0.6);
        if (kept.length >= 2) targetIdxs = kept;
      }
    }
    if (!targetIdxs.length) continue;

    // 正解 = 条件を満たす画像 / ダミー = 条件を満たさない画像
    const targetSet = new Set(targetIdxs);
    const needs = GRID_SIZE - targetSet.size;
    if (needs < 1) { stats.fNeeds++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fNeeds" + " mode=" + mode + "\n"); continue; }
    // ダミー候補(形式ごとに構成済み)から、正解と重複しないように必要枚数を取る
    const pool = distractorPool.filter((idx) => !targetSet.has(idx));
    if (pool.length < needs) { stats.fPool++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fPool" + " mode=" + mode + "\n"); continue; }

    // --- 見分けやすさフィルタ(実測で導入) ---
    // ダミー画像が正解とタグを同程度共有していると、人間には見分けがつかない。
    // (実測: 「青いシャツ」で同じキャラの紺Tシャツが7枚あるのにタグは2枚だけ →
    //  visionは7枚を正解と判定し真実と食い違った。この比が1.02〜1.23だった)
    // 正解同士の平均類似度に対するダミーの類似度の比が高すぎる出題は捨てる。
    // ⚠️ not / notpick は正解が「タグを持たない画像」の寄せ集めで共通タグを持たず、
    //    このフィルタの前提(正解同士が似ている)が成り立たないので適用しない。
    if (
      targetIdxs.length >= 2 && !relaxed &&
      (mode === "single" || mode === "pick" || mode === "and" || mode === "or")
    ) {
      const jac = (a, b) => {
        const A = new Set(a), B = new Set(b);
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        return inter / new Set([...A, ...B]).size;
      };
      // ゴミタグを除外して比較する(全画像共通のタグで誤判定しないため)
      const strip = (p) => meaningful(p).filter((t) => !promptTags.includes(t));
      const tSets = targetIdxs.map((idx) => strip(batch[idx]));
      let tt = 0, ttN = 0;
      for (let a = 0; a < tSets.length; a++) {
        for (let b = a + 1; b < tSets.length; b++) { tt += jac(tSets[a], tSets[b]); ttN++; }
      }
      tt = ttN ? tt / ttN : 0;
      let dm = 0;
      for (const idx of pool) {
        const d = strip(batch[idx]);
        let m = 0;
        for (const t of tSets) m = Math.max(m, jac(d, t));
        dm += m;
      }
      dm = dm / pool.length;
      const unfair = dm / Math.max(0.02, tt);
      if (unfair >= 0.85) { stats.tagRejects++; continue; } // 見分け不能な出題は捨てて次のバッチへ
    }

    // ダミーは「タグが似ていない順」に選ぶ(グリッドが同じ撮影/同じ話題で埋まるのを防ぐ)。
    // ⚠️ notpick はダミー=タグを持つ画像をちょうど GRID_SIZE-N 枚出す必要があるので、
    //    プールをそのまま使う(選び直すと出題が成立しない)。
    // ダミーも「投稿者が偏らない」ように選ぶ。正解と同じ投稿者は最後に回るよう、
    // 正解が使った投稿者を先に除外してからラウンドロビンする。
    const targetSrcs = new Set(targetIdxs.map(srcOf).filter(Boolean));
    const freshPool = pool.filter((idx) => !targetSrcs.has(srcOf(idx)));
    let distractorIdxs = pickBySrcDiversity(freshPool, needs, srcOf);
    if (distractorIdxs.length < needs) {
      // 別投稿者だけでは足りない場合は、同じ投稿者から補充する(可用性優先)
      const rest = pool.filter((idx) => !distractorIdxs.includes(idx));
      distractorIdxs = distractorIdxs.concat(pickBySrcDiversity(rest, needs - distractorIdxs.length, srcOf));
    }
    if (distractorIdxs.length < needs) { stats.fPool++; if (process.env.DEBUG_MAKE === "1") appendFileSync("make-fail.log", "[make-fail] fPool" + " mode=" + mode + "\n"); continue; }

    // --- 視覚フィルタ: 画像そのものが似すぎている出題を捨てる ---
    // タグの重なり(上のフィルタ)では捕まらない型の不公平をここで落とす。
    // 判定不能(null)なら素通しする(可用性優先)。
    // 段階2(緩和レベル)では外す(4回の緩和試行があるので必ず出題できる)。
    // それでも却下が続く場合は閾値を段階的に緩める(1.0→1.12→1.24…)。
    if (!relaxed) {
      const visPairs = [
        ...[...targetSet].map((idx) => ({ url: batch[idx].url, target: true })),
        ...distractorIdxs.map((idx) => ({ url: batch[idx].url, target: false })),
      ];
      const dr = await distanceRatio(visPairs);
      if (dr !== null) stats.visChecked++;
      // dr は「見分け不能」と判定されたときだけ 1.0以上 の深刻度で返る。
      // 却下が続く場合は閾値を段階的に緩める(1.0→1.12→1.24…)ので最後は通る。
      if (dr !== null && dr >= VIS_MAX_DIST_RATIO + 0.12 * visRejects) {
        visRejects++;
        stats.visRejects++;
        continue;
      }
    }

    const cid = randomBytes(8).toString("hex");

    const tiles = shuffle([
      ...[...targetSet].map((idx) => ({
        id: randomBytes(6).toString("hex"),
        postId: batch[idx].id,
        url: batch[idx].url,
        imgId: registerImage(batch[idx].url, cid), // クライアントには imgId 経由でのみ配信(投稿IDを隠す)
        target: true,
        // 診断用にタグ・元ネタを保持する。応答には含めない(本番のpayloadはid/urlのみ)。
        // テスト用コピーだけがこれを応答に載せ、精度・多様性の検証に使う。
        tags: [...batch[idx].tags],
        src: batch[idx].src,
      })),
      ...distractorIdxs.map((idx) => ({
        id: randomBytes(6).toString("hex"),
        postId: batch[idx].id,
        url: batch[idx].url,
        imgId: registerImage(batch[idx].url, cid),
        target: false,
        tags: [...batch[idx].tags],
        src: batch[idx].src,
      })),
    ]);

    stats.challenges++;
    stats.modes[mode] = (stats.modes[mode] || 0) + 1;
    if (relaxed) stats.relaxedUsed++;
    const ask = buildAsk(mode, promptTags, askN);
    return {
      id: cid,
      prompt: ask.text, // 表示用の文面(形式ごとに変わる)
      ask, // 形式・タグ・選択枚数。クライアントはこれを見て表示する
      tags: promptTags, // 機械可読な出題タグ
      mode,
      createdAt: Date.now(),
      tiles,
      attempts: 0,
      imgFetched: new Set(), // サーバーが実際に画像配信したタイルID(偽装不能なシグナル)
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
  for (const [t, v] of tickets) if (now > v.exp) tickets.delete(t);
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

// ローカル/プライベートIPか(開発・検証は制限しない)
function isLocalIp(ip) {
  const s = String(ip || "");
  if (!s) return true;
  if (s === "local" || s === "::1" || s === "127.0.0.1" || s.startsWith("127.")) return true;
  if (s.startsWith("::ffff:127.")) return true;
  if (s.startsWith("192.168.") || s.startsWith("10.") || s.startsWith("::ffff:192.168.") || s.startsWith("::ffff:10.")) return true;
  // 172.16.0.0/12
  const m = s.match(/^(?:::ffff:)?172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80:")) return true; // ULA / リンクローカル
  return false;
}

// トークンバケット方式のレート制限。超過時は「何秒待てば再開できるか」も返す。
// ⚠️ ローカル除外は「プロキシを経由していない」ことが条件。
//    X-Forwarded-For が付いている = 外部のクライアントがリバースプロキシ越しに来ているので、
//    除外すると本番で無制限になってしまう(プロキシがlocalhostから転送してくるため)。
// 「開発・検証のローカルアクセスか」。プロキシ経由(X-Forwarded-For付き)は除外しない。
function isExemptRequest(req) {
  if (!IP_QUOTA_EXEMPT_LOCAL) return false;
  const forwarded = !!req.headers["x-forwarded-for"] || !!req.headers["x-real-ip"];
  if (forwarded) return false;
  return isLocalIp(clientIp(req)) || isLocalIp(req.socket && req.socket.remoteAddress);
}

function checkQuota(req) {
  // レート制限なし(既定)。仕組み自体は残してあるので IP_QUOTA を入れれば効く。
  if (IP_QUOTA <= 0) return { ok: true, remaining: Infinity, retryAfterMs: 0 };
  if (isExemptRequest(req)) return { ok: true, remaining: Infinity, retryAfterMs: 0, exempt: true };
  const ip = clientIp(req);
  const now = Date.now();
  let b = ipCounts.get(ip);
  if (!b) {
    b = { tokens: IP_QUOTA, last: now };
    ipCounts.set(ip, b);
  } else {
    // 経過時間に応じてトークンを補充する(上限 IP_QUOTA)
    const gained = Math.floor((now - b.last) / IP_REFILL_MS);
    if (gained > 0) {
      b.tokens = Math.min(IP_QUOTA, b.tokens + gained);
      b.last += gained * IP_REFILL_MS;
    }
  }
  if (b.tokens < 1) {
    return { ok: false, remaining: 0, retryAfterMs: Math.max(1000, b.last + IP_REFILL_MS - now) };
  }
  b.tokens -= 1;
  return { ok: true, remaining: b.tokens, retryAfterMs: 0 };
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// 429 は「いつ再開できるか」を必ず添える(待ち時間が分からないとユーザーは詰む)。
// UX的には st429 とクライアントの文言を固定する。
function sendTooMany(res, retryAfterMs, extra) {
  const sec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const body = Object.assign(
    { error: `リクエストが多すぎます。あと約${sec}秒で再開できます`, retryAfterMs, retryAfterSec: sec },
    extra || {}
  );
  const text = JSON.stringify(body);
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "retry-after": String(sec),
  });
  res.end(text);
}

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
    return sendJson(res, 200, { ok: true, stats });
  }

  // 画像配信: hikabooruのサムネイルを中継する
  //  1) URLから投稿IDを隠す(自前の不透明IDで配信)
  //  2) 配信時に余白付与+微小クロップ+回転+再圧縮で改変(逆検索・事前索引を無効化)
  //  3) 「この画像が実際に配信された」事実をサーバー側で記録(偽装不能なシグナル)
  if (url.pathname.startsWith("/api/img/") && req.method === "GET") {
    const imgId = url.pathname.slice("/api/img/".length);
    const img = images.get(imgId);
    if (!img || Date.now() > img.exp) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    // サーバー観測: この画像が配信されたことを出題に記録する
    const owner = img.challengeId ? challenges.get(img.challengeId) : null;
    if (owner && owner.imgFetched) owner.imgFetched.add(imgId);

    // 改変済みがあればそれを使う(1回だけ生成して使い回す)
    if (img.buf) {
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=300",
        "access-control-allow-origin": "*",
      });
      return res.end(img.buf);
    }
    try {
      // 視覚フィルタで事前取得済みならそれを使う(再ダウンロードしない)
      const pf = prefetched.get(img.url);
      if (pf && Date.now() < pf.exp) {
        const transformed = await transformImage(pf.buf);
        const body = transformed || pf.buf;
        img.buf = body;
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "cache-control": "private, max-age=300",
          "access-control-allow-origin": "*",
          "x-hkc-transformed": transformed ? "1" : "0",
          "x-hkc-prefetched": "1",
        });
        return res.end(body);
      }
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
      const orig = Buffer.from(await up.arrayBuffer());
      const transformed = await transformImage(orig);
      const body = transformed || orig;
      img.buf = body; // キャッシュ(同じ出題中は同じ画像を返す)
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=300",
        "access-control-allow-origin": "*",
        "x-hkc-transformed": transformed ? "1" : "0",
      });
      return res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      return res.end("upstream error");
    }
  }

  // 出題
  if (url.pathname === "/api/challenge" && req.method === "GET") {
    const ip = clientIp(req);
    const q = checkQuota(req);
    if (!q.ok) return sendTooMany(res, q.retryAfterMs);
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
    // 順番待ちは無制限なので、混雑時は「遅くなる」だけで拒否しない
    const c = await withMakeSlot(() => makeChallenge(ip));
    if (!c) {
      return sendJson(res, 502, { error: "問題を準備できませんでした。少し待ってからもう一度お試しください" });
    }
    c.ip = ip;
    // PoW課題(この出題専用)とチケット(トークン束縛用)を発行
    c.powBits = powBitsFor(ip, q.exempt); // ローカル検証では難易度を上げない
    c.pow = randomBytes(16).toString("hex");
    c.powSalt = randomBytes(16).toString("hex"); // scrypt用ソルト(毎回ランダム)
    c.ticket = newTicket(ip);
    challenges.set(c.id, c);
    // 画像URLは自前プロキシ経由の不透明URLで返す(元URL=投稿IDを渡さない)
    const base = publicBase(req);
    return sendJson(res, 200, {
      id: c.id,
      prompt: c.prompt,
      ask: c.ask, // 形式(mode)・タグ・選択枚数。クライアントはこれを見て文面と選択上限を決める
      tags: c.tags || [c.prompt],
      mode: c.mode || "single",
      tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}` })),
      ticket: c.ticket,
      // メモリハードPoW(scrypt)のパラメータ。クライアントは純JSで同じ計算をする
      pow: {
        algo: POW_ALGO,
        challenge: c.pow,
        salt: c.powSalt,
        bits: c.powBits,
        N: POW_N,
        r: POW_R,
        p: POW_P,
      },
      honeypot: HONEYPOT_FIELD,
      minMs: MIN_SOLVE_MS, // クライアントはこれを待ってから回答を送る(ウィジェットが実装済み)
    });
  }

  // 回答検証(全層を通過した時だけワンタイム解決トークンを発行)
  if (url.pathname === "/api/verify" && req.method === "POST") {
    const ip = clientIp(req);
    const q = checkQuota(req);
    if (!q.ok) return sendTooMany(res, q.retryAfterMs, { ok: false });
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

    // --- 層1: ハニーポット(隠しフィールドに値が入っていたら即ボット) ---
    const hp = body && body[HONEYPOT_FIELD] != null ? String(body[HONEYPOT_FIELD]) : "";
    if (hp.trim() !== "") {
      challenges.delete(id);
      return sendJson(res, 400, { ok: false, error: "自動入力を検出しました。最初からやり直してください", expired: true });
    }

    // --- 層2: チケット束縛(出題時に発行したチケットと一致するか) ---
    if (!ticketOk(String(body?.ticket || ""), ip)) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "認証セッションが無効です。もう一度やり直してください", expired: true });
    }

    // --- 層3: Proof-of-Work(メモリハード/scrypt で計算コストを課す) ---
    const powFun = POW_ALGO === "sha256"
      ? () => powOk(c.pow, String(body?.nonce ?? ""), c.powBits)
      : () => powScryptOk(c.pow, String(body?.nonce ?? ""), c.powSalt, c.powBits, POW_N, POW_R, POW_P);
    if (!powFun()) {
      c.attempts += 1;
      const remaining = MAX_ATTEMPTS - c.attempts;
      if (remaining <= 0) {
        challenges.delete(id);
        return sendJson(res, 410, { ok: false, error: "認証に失敗しました。新しい問題に挑戦してください", expired: true });
      }
      return sendJson(res, 400, {
        ok: false,
        error: `計算認証(Proof-of-Work)が未完了です(あと${remaining}回)`,
        remaining,
        powRequired: true,
      });
    }

    // --- 層3b: PoW仕事量の予算(計算資源で突破されても総量を頭打ちにする) ---
    const wq = chargeWork(ip, c.powBits, q.exempt);
    if (!wq.ok) {
      challenges.delete(id);
      // 「しばらく待って」ではなく具体的な待ち時間を返す(ブラウザ側でカウントダウンできる)
      return sendTooMany(res, wq.retryAfterMs, {
        ok: false,
        error: `計算認証の試行量が上限に達しました。あと約${Math.max(1, Math.ceil(wq.retryAfterMs / 1000))}秒で再開できます`,
        expired: true,
      });
    }

    // --- 層4: サーバーが観測した事実(クライアント申告と違い偽装できない) ---
    // 4a. 画像が実際に配信されたか(スクリプトからの直接POSTは画像を取りに来ない)
    const fetched = c.imgFetched ? c.imgFetched.size : 0;
    const needFetch = Math.max(1, Math.ceil(c.tiles.length * IMG_FETCH_MIN_RATIO));
    if (fetched < needFetch) {
      challenges.delete(id);
      return sendJson(res, 400, {
        ok: false,
        error: "画像が読み込まれていません。ページを再読み込みしてもう一度お試しください",
        risk: RISK_REJECT,
        expired: true,
      });
    }
    // 4b. サーバー実測の経過時間(チャレンジ発行→回答到達)。クライアントは偽装できない
    const serverElapsed = Date.now() - c.createdAt;
    if (serverElapsed < HARD_MIN_SOLVE_MS) {
      challenges.delete(id);
      return sendJson(res, 400, {
        ok: false,
        error: "回答が速すぎます。もう一度やり直してください",
        risk: RISK_REJECT,
        expired: true,
      });
    }
    // 4c. クライアント申告と実測の矛盾(申告が実測を大きく超えるのは改ざんの証拠)
    const claimed = Number(body?.elapsedMs) || 0;
    if (claimed > serverElapsed + CLAIM_SLACK_MS) {
      challenges.delete(id);
      return sendJson(res, 400, {
        ok: false,
        error: "申告値と実測値が一致しません。もう一度やり直してください",
        risk: RISK_REJECT,
        expired: true,
      });
    }

    // --- 層5: 挙動シグナル(補助。偽装可能なので単独では拒否理由にしない) ---
    const { risk, reasons } = riskScore(c, body?.signals, serverElapsed);
    // サーバー観測で人間と確認できている場合は、クライアント申告の不足を重く見ない
    const adjustedRisk = Math.max(0, risk - 1);
    if (adjustedRisk >= RISK_REJECT) {
      challenges.delete(id);
      return sendJson(res, 400, {
        ok: false,
        error: `機械的な操作を検出しました(${reasons.join("・")})。もう一度やり直してください`,
        risk: adjustedRisk,
        expired: true,
      });
    }

    // --- 層6: 画像認証(本題) ---
    if (c.attempts >= MAX_ATTEMPTS) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "試行回数を超えました。新しい問題に挑戦してください", expired: true });
    }
    const expected = new Set(c.tiles.filter((t) => t.target).map((t) => t.id));
    const got = new Set(selected);
    const correct = expected.size === got.size && [...expected].every((x) => got.has(x));

    if (correct) {
      challenges.delete(id);
      tickets.delete(String(body?.ticket || "")); // チケットは使い切り
      const token = randomBytes(24).toString("hex");
      // トークンをチケットに束縛(他人のトークンを流用しても消費できない)
      tokens.set(token, { exp: Date.now() + TOKEN_TTL_MS, ticket: String(body?.ticket || "") });
      ipSolved.set(ip, (ipSolved.get(ip) || 0) + 1);
      return sendJson(res, 200, { ok: true, token, risk: adjustedRisk, serverElapsedMs: serverElapsed, imagesFetched: fetched });
    }

    c.attempts += 1;
    const remaining = MAX_ATTEMPTS - c.attempts;
    if (remaining <= 0) {
      challenges.delete(id);
      return sendJson(res, 410, { ok: false, error: "不正解です。新しい問題に挑戦してください", expired: true });
    }
    return sendJson(res, 400, { ok: false, error: `違う画像が混ざっています(あと${remaining}回)。選び直してください`, remaining });
  }

  // トークン消費(埋め込み先のサーバーが登録/投稿前に呼ぶ。ワンタイム+チケット一致必須)
  if (url.pathname === "/api/consume" && req.method === "POST") {
    const body = await readBody(req);
    const token = String(body?.token || "");
    const ticket = String(body?.ticket || "");
    if (!token) return sendJson(res, 400, { ok: false, error: "トークンがありません" });
    sweep();
    const t = tokens.get(token);
    if (!t) return sendJson(res, 400, { ok: false, error: "トークンが無効です(期限切れ or 使用済み)" });
    tokens.delete(token); // 一度使ったら即無効
    if (Date.now() > t.exp) return sendJson(res, 400, { ok: false, error: "トークンの期限が切れています" });
    // 発行時に束縛したチケットと一致しないトークンは拒否(転売・横流し対策)
    if (!t.ticket || t.ticket !== ticket) {
      return sendJson(res, 400, { ok: false, error: "トークンと認証セッションが一致しません" });
    }
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

    // ドキュメント: README.md をその場でHTMLにして配信する。
    // (手書きのdocを別に持つとREADMEと必ず食い違うため、READMEを唯一の情報源にする)
    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      const html = renderDocsPage(__dirname);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(html);
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
  } catch (err) {
    // APIの例外を「404 not found」で隠していた(原因追跡が不可能になる)ので修正。
    // ログに出し、APIには500を返す(静的ファイルのみ404)。
    const isApi = url.pathname.startsWith("/api/");
    console.error("[request error]", url.pathname, err && err.stack ? err.stack.split("\n")[0] : err);
    if (process.env.DEBUG_MAKE === "1") {
      try { appendFileSync("make-fail.log", "[error] " + url.pathname + " " + (err && err.stack ? err.stack : String(err)) + "\n"); } catch {}
    }
    if (!res.headersSent) {
      if (isApi) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました" }));
      } else {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      }
    } else {
      res.end();
    }
  }
});

// ---------- タグ語彙の監査(TAG_AUDIT=1 で起動したときだけ) ----------
// 「使えるタグがどれくらいあるのか」を実測する。フィルタを通るタグの数が語彙の上限になる。
if (process.env.TAG_AUDIT === "1") {
  const out = [];
  const bands = [
    ["usages:150..3000", "現行の帯域(150〜3000)"],
    ["usages:80..3000", "下限を80に緩めた場合"],
    ["usages:150..10000", "上限を10000に緩めた場合"],
    ["usages:80..149", "下限緩和で新たに加わる帯域"],
  ];
  for (const [query, label] of bands) {
    const passedNames = [];
    let offset = 0;
    let total = 0;
    let passU = 0;
    let passQ = 0;
    const rejected = [];
    while (offset < 3000) {
      const d = await hkFetch(`/tags?query=${encodeURIComponent(query)}&limit=100&offset=${offset}`);
      const res = (d && d.results) || [];
      if (!res.length) break;
      total = d.total || total;
      for (const t of res) {
        const name = (t.names && t.names[0]) || "";
        const u = Number(t.usages) || 0;
        if (u >= Number(process.env.TAG_MIN_USAGES || 150)) passU++;
        if (questionableTag(name, u)) { passQ++; passedNames.push(`${name}(${u})`); }
        else if (rejected.length < 30) rejected.push(`${name}(${u})`);
      }
      offset += 100;
      if (offset >= total) break;
    }
    out.push(`${label} [${query}]`);
    if (query === "usages:80..149") {
      writeFileSync("tag-band-80-149.txt", passedNames.join("\n"));
    }
    out.push(`  帯域のタグ総数: ${total}`);
    out.push(`  usages下限(${process.env.TAG_MIN_USAGES || 150})通過: ${passU}`);
    out.push(`  名前フィルタ(questionableTag)通過: ${passQ}`);
    out.push(`  弾かれた例: ${rejected.slice(0, 14).join(" / ")}`);
    out.push("");
  }
  // 個別の語がフィルタを通るかどうかも出す(フィルタが効いているかの確認)
  out.push("");
  out.push("個別チェック:");
  for (const w of ["シュール", "無料", "ヒント", "ポーズ", "ディルドー", "スタッフ", "高角視野", "ヨガマット", "魚礁", "包丁", "浴衣"]) {
    out.push(`  ${w} -> ${questionableTag(w, 120) ? "通す" : "除外"}`);
  }
  writeFileSync("tag-audit.txt", out.join("\n"));
  console.log(out.join("\n"));
  process.exit(0);
}

server.listen(PORT, () => {
  console.log(`HIKAPTCHA ready on http://localhost:${PORT} (hikabooru: ${HIKABOORU_BASE})`);
  console.log(`  多層認証: 画像 + PoW(${POW_BITS}bit〜${POW_BITS_MAX}bit) + ハニーポット + 挙動判定 + チケット束縛`);
  // 自己診断: SELFTEST=1 で出題生成を1回だけ試して結果を出し、終了する
  // (本番を起動せずに出題ロジックの異常を検知できる)
  if (process.env.SELFTEST === "1") {
    makeChallenge()
      .then((c) => {
        if (!c) {
          console.error("[selftest] 出題を生成できませんでした(候補不足)");
          process.exit(2);
        }
        console.log(`[selftest] OK: ${c.prompt} / mode=${c.mode} / 正解${c.tiles.filter((t) => t.target).length}枚/9`);
        process.exit(0);
      })
      .catch((err) => {
        console.error("[selftest] 例外:", err && err.stack ? err.stack : err);
        process.exit(3);
      });
  }
});

// 1件の失敗(画像取得のタイムアウト等)でCAPTCHAサービス全体を落とさない
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.message ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.message ? err.message : err);
});
