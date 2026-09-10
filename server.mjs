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
import { randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { Readable } from "node:stream";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
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
const IP_QUOTA = Number(process.env.IP_QUOTA || 60); // IPごとの出題+回答リクエスト上限
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
const MIN_SOLVE_MS = Number(process.env.MIN_SOLVE_MS || 1500); // サーバー実測の下限(画像を見て選ぶ時間)
const MIN_HUMAN_MS = 700; // PoW時間を差し引いた「人間の操作時間」の下限
const HONEYPOT_FIELD = "website"; // ボットが埋めがちな隠しフィールド名
const RISK_REJECT = 2; // リスク点がこれ以上なら拒否
const TICKET_TTL_MS = 5 * 60 * 1000;
// サーバーが観測できる事実に基づくしきい値(クライアント申告と違い偽装できない)
const IMG_FETCH_MIN_RATIO = 0.75; // 出題画像のうち最低これだけ実際に取得されていること
const CLAIM_SLACK_MS = 5000; // クライアント申告が実測より大きく超えたら不正とみなす余裕
// IPごとの「PoW仕事量」予算(期待試行数の累計)。突破速度そのものを頭打ちにする
const IP_WORK_BUDGET = Number(process.env.IP_WORK_BUDGET || 5000);
const IP_WORK_WINDOW_MS = 10 * 60 * 1000;

const challenges = new Map(); // id -> {prompt, createdAt, tiles, attempts, ip, pow, ticket, imgFetched}
const tokens = new Map(); // token -> {exp, ticket}
const ipCounts = new Map(); // ip -> {n, resetAt}
const ipSolved = new Map(); // ip -> 累計突破数(難易度の自動引き上げ用)
const ipWork = new Map(); // ip -> {work, resetAt} 累計PoW仕事量
const tickets = new Map(); // ticket -> {ip, exp}


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
function chargeWork(ip, bits) {
  const now = Date.now();
  const w = ipWork.get(ip);
  const cost = Math.pow(2, Math.max(0, Math.min(20, bits)));
  if (!w || now >= w.resetAt) {
    ipWork.set(ip, { work: cost, resetAt: now + IP_WORK_WINDOW_MS });
    return true;
  }
  if (w.work + cost > IP_WORK_BUDGET) return false;
  w.work += cost;
  return true;
}


// 突破実績の多いIPはPoWを重くする(自動化のコストを段階的に上げる)
function powBitsFor(ip) {
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
const ABSTRACT_WORD = /ビュー|アカウント|チャレンジ|凍結|誹謗|中傷|超大型|大型|物体|図面|アップ|ダウン|フォーカス|タイム|ゲーム|ニュー|リセット|ロード|セーブ|渋滞|検閲|モザイク|沈没|節足|鉛筆画|木材|青年|少女|少年|大人|強膜|瞳孔|網膜|血管|骨格|筋肉|内臓|器官|細胞|遺伝子|染色体|ウイルス|細菌|菌|カビ|北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|ok|焦点|配置|模倣|照準|集中|監視|隊員|群衆|容器|絵文字|サイン|チャート|グラフ|コンピューター|ゲーム機|ソース|グループ|ウィンドウ|静物画|美術|外側|内側|消防|株式会社|有限会社|写実|公式|製品|商品|景品|特典|報酬|対価|価格|金額|料金|費用|収支|利益|損失|数量|個数|面積|体積|距離|速度|温度|湿度|気圧|密度|濃度|割合|比率|確率|平均|最大|最小|合計|差分|増減|変化|変動|推移|予測|推計|統計|分析|評価|判定|診断|検証|検査|測定|調査|研究|学習|教育|訓練|練習|試行|実験|観察|記録|報告|発表|公開|掲示|提示|提出|申請|登録|認証|許可|承認|拒否|禁止|管理|処理|表示|操作|動作|行動|活動|作業|業務|事業|産業|組織|制度|体系|構造|構成|要素|成分|原料|材料|機能|性能|能力|効果|影響|理由|原因|結果|目的|手段|方法|方式|形式|種類|分類|属性|性質|特徴|傾向|程度|段階|範囲|領域|部門|状態|状況|様子|雰囲気|印象|感覚|感情|記憶|意識|精神|心理|思想|概念|理論|法則|原理|原則|方針|基準|規格|標準|規範|条件|要件|制限|制約|可能性|必要性|一般|特殊|普通|通常|基本|応用|実用|実際|現実|理想|目標|広告|宣伝|告知|案内|説明|解説|紹介|連絡|相談|質問|回答|返事|予定|計画|準備|確認|経験|実績|成果|実力|限界|環境|空間|時間|瞬間|期間|時代|現在|過去|未来|歴史|文化|社会|経済|政治|科学|数学|音楽|文学|芸術|宗教|哲学|伝統|習慣|風習|行事|儀式|祭典|イベント|大会|試合|競技|勝負|勝敗|勝利|敗北|順位|ランキング|得点|点数|スコア|レベル|ランク|クラス|称号|肩書|役職|地位|立場|関係|繋がり|結びつき|影響力|支配力|権力|権限|責任|義務|権利|自由|平等|平和|戦争|紛争|争い|喧嘩|口論|議論|討論|会議|集会|集まり|集合|集団|団体|仲間|同僚|友人|知人|家族|親戚|血縁|恋愛|結婚|離婚|出産|育児|介護|看護|医療|治療|診療|手術|投薬|処方|症状|病気|疾患|怪我|負傷|損傷|故障|不具合|誤作動|異常|正常|健全|不健全|健康|不健康|栄養|カロリー|ビタミン|ミネラル|タンパク|脂質|糖質|食物繊維/;
// 助詞を含むタグは文の断片(実測: 返信をポスト)。誤除外を避けて「を」「が」だけを対象にする
const PARTICLE_IN = /[をが]/;
const STOP_TAG = /ください|チェック|翻訳|依頼|解説|説明|聞いてみ|なので|じゃない|です|ます|ました|じゃん|ってしま|どうぞ|の巻|つけよう/;
// 広すぎる/抽象的すぎるタグ(ほぼ全画像につく等)はお題にしない
const EXCLUDE_TAGS = new Set([
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

function questionableTag(t, usages) {
  if (!usableTag(t)) return false;
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

// タイルは 3:2(横長)で表示する。実測で、正方形タイル+contain では横長画像(多数派)の
// 上下40%が余白になり、被写体がタイル面積の46%しか使えなかった。
// 1.5付近の画像だけを選べば、タイルを余白なしで埋められる(被写体が約1.8倍の面積になる)
function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0;
  const h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 1.35 && r <= 1.85; // 3:2を中心に±20%程度(タイルに余白なしで収まる範囲)
}

// 配信時の目標アスペクト比(タイルの 3:2 に合わせる)
const TARGET_ASPECT = Number(process.env.TARGET_ASPECT || 1.5);

// 画像プロキシ + 改変: 元URLにはhikabooruの投稿IDが含まれるため、そのまま渡すと
// 公開APIでタグを引いて正解を機械的に導出できてしまう。不透明IDに置き換えて中継する。
// さらに配信時に「余白付与+微小クロップ+回転+再圧縮」で改変する:
//   実測 pHash距離 20〜25/64 (元画像とは別物として扱われる) / バイト一致もしなくなる
//   → 事前にbooruを全件スクレイプして作った逆引き索引・完全一致キャッシュが使えなくなる
//   ※ 余白は控えめ(6〜9%)にして被写体の占有率を約85%確保し、タイルの見やすさを優先する
const images = new Map(); // imgId -> { url, exp, challengeId, buf, transformed }
const IMG_TTL_MS = CHALLENGE_TTL_MS + 120 * 1000;
const IMG_MAX = 6000; // 保持する画像の上限(メモリ保護)

// 改変パラメータ(環境変数で調整可)
const TRANSFORM = process.env.IMG_TRANSFORM !== "0"; // 0で無効化
const PAD_PCT_MIN = Number(process.env.PAD_MIN || 8);
const PAD_PCT_MAX = Number(process.env.PAD_MAX || 12);
const CROP_PCT_MAX = Number(process.env.CROP_MAX || 3);
const ROT_DEG_MAX = Number(process.env.ROT_MAX || 2.5);
const JPEG_Q = Number(process.env.JPEG_Q || 3);

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

// 改変: タイルの 3:2 に合わせて中央を(少しズラして)クロップし、
// 反転・回転・ガンマ・再圧縮を重ねる。実測に基づく設計:
//  - 余白(pad)は使わない → タイルを余白なしで埋められ、被写体が大きく見える
//  - クロップは「構図をずらす」効果があり、pHashを動かしつつ被写体は拡大される
//  - 反転は単独で距離が二桁動くが、反転を考慮する攻撃者には無効なので単独に頼らない
async function transformImage(buf) {
  if (!TRANSFORM || !hasFfmpeg()) return null;
  const id = (tmpSeq = (tmpSeq + 1) % 100000);
  const inp = path.join(TMP, `i${id}.jpg`);
  const out = path.join(TMP, `o${id}.jpg`);
  writeFileSync(inp, buf);
  const filters = [];

  // 1) 目標アスペクト(3:2)へクロップ。中心から少しズラして構図を変える
  //    (ズラしは短辺の最大4%まで=被写体をほぼ削らない)
  const shiftX = (Math.random() * 2 - 1) * 4; // %
  const shiftY = (Math.random() * 2 - 1) * 4;
  filters.push(
    `crop='min(iw,ih*${TARGET_ASPECT})*(1-${Math.abs(shiftX) / 200})':'min(ih,iw/${TARGET_ASPECT})*(1-${Math.abs(shiftY) / 200})':` +
    `'(iw-ow)*${(0.5 + shiftX / 200).toFixed(3)}':'(ih-oh)*${(0.5 + shiftY / 200).toFixed(3)}'`
  );

  // 2) 反転(50%。反転を考慮する攻撃者には単独では効かないが、他の手法との併用で効く)
  if (Math.random() < 0.5) filters.push("hflip");

  // 3) 微小回転(内容は保ったままブロック境界を崩す)
  const rot = (Math.random() * 2 - 1) * ROT_DEG_MAX;
  if (Math.abs(rot) > 0.2) {
    filters.push(`rotate=${((rot * Math.PI) / 180).toFixed(6)}:fillcolor=black`);
  }

  // 4) 明るさ・ガンマ(ピクセル統計を変える)
  const gamma = 0.93 + Math.random() * 0.14;
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

// 出題の形式:
//  単一タグ … 「◯◯の画像を全部選べ」(正解=そのタグを持つ画像)
//  2タグAND … 「◯◯と△△の両方が写っている画像を全部選べ」(正解=両方のタグを持つ画像)
// 実測で「お題タグは1つに限らなくてよい」という方針に基づき、2タグの組み合わせも出題する。
// これで出題のバリエーションが増え、ボット側は2つの対象を照合する必要があるため難度も上がる。
const PAIR_PROB = Number(process.env.PAIR_PROB || 0.5); // 2タグ出題にする確率

async function makeChallenge() {
  for (let i = 0; i < 16; i++) {
    const batch = await fetchRandomImageBatch(20);
    if (batch.length < GRID_SIZE) continue;

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

    // --- 2タグANDの候補を作る ---
    const pairCands = [];
    const tagList = [...byTag.entries()];
    for (let a = 0; a < tagList.length; a++) {
      for (let b = a + 1; b < tagList.length; b++) {
        const [ta, va] = tagList[a];
        const [tb, vb] = tagList[b];
        // 各タグが複数枚に付いていて、両方を持つ画像が1〜3枚ある組み合わせだけ
        if (va.imgs.size < 2 || vb.imgs.size < 2) continue;
        // 片方が他方を含む組み合わせは避ける(例: ライフル / アサルトライフル)。
        // 見た目で区別できず、片方だけの画像を引っかけにすると人間には不公平になる
        if (ta.includes(tb) || tb.includes(ta)) continue;
        let both = 0;
        for (const idx of va.imgs) if (vb.imgs.has(idx)) both++;
        if (both < 1 || both > 3) continue;
        const union = new Set([...va.imgs, ...vb.imgs]).size;
        if (union > 8) continue; // 広すぎる(ダミーが作れない)
        pairCands.push({ a: ta, b: tb, both, ua: va.usages, ub: vb.usages, union });
      }
    }

    // --- 単一タグの候補 ---
    const singleCands = [];
    for (const [tag, v] of byTag) {
      if (v.imgs.size >= 2 && v.imgs.size <= 4) singleCands.push({ tag, n: v.imgs.size, usages: v.usages });
    }

    const usePair = pairCands.length > 0 && (singleCands.length === 0 || Math.random() < PAIR_PROB);
    if (!usePair && !singleCands.length) continue;

    let promptTags = [];
    let targetIdxs = [];
    let trapIdxs = []; // どちらか片方だけを持つ画像(人間には引っかけとして機能する。正解ではない)

    if (usePair) {
      // 具体性の高い組み合わせを優先して抽選
      const roulette = [];
      for (const c of pairCands) {
        const w = Math.max(1, Math.round(c.both * Math.sqrt(concreteness(c.ua) * concreteness(c.ub)) * 10));
        for (let k = 0; k < w; k++) roulette.push(c);
      }
      const pick = roulette[Math.floor(Math.random() * roulette.length)];
      promptTags = [pick.a, pick.b];
      const setA = byTag.get(pick.a).imgs;
      const setB = byTag.get(pick.b).imgs;
      for (const idx of setA) if (setB.has(idx)) targetIdxs.push(idx);
      for (const idx of setA) if (!setB.has(idx)) trapIdxs.push(idx);
      for (const idx of setB) if (!setA.has(idx)) trapIdxs.push(idx);
    } else {
      const roulette = [];
      for (const c of singleCands) {
        const w = Math.max(1, Math.round(c.n * concreteness(c.usages) * 10));
        for (let k = 0; k < w; k++) roulette.push(c);
      }
      const pick = roulette[Math.floor(Math.random() * roulette.length)];
      promptTags = [pick.tag];
      targetIdxs = [...byTag.get(pick.tag).imgs];
    }

    if (!targetIdxs.length) continue;

    // 正解 = 条件を満たす画像 / ダミー = 条件を満たさない画像
    const targetSet = new Set(targetIdxs);
    const trapSet = new Set(trapIdxs.filter((x) => !targetSet.has(x)));
    const needs = GRID_SIZE - targetSet.size;
    if (needs < 1) continue;

    // ダミーは「片方だけ持つ画像(最大6割)」+「どちらも持たない画像」で構成
    const trapTake = shuffle([...trapSet]).slice(0, Math.min(trapSet.size, Math.ceil(needs * 0.6)));
    const rest = [];
    for (let idx = 0; idx < batch.length; idx++) {
      if (!targetSet.has(idx) && !trapTake.includes(idx)) rest.push(idx);
    }
    const need2 = needs - trapTake.length;
    if (rest.length < need2) continue;
    const distractorIdxs = [...trapTake, ...shuffle(rest).slice(0, need2)];

    const cid = randomBytes(8).toString("hex");

    const tiles = shuffle([
      ...[...targetSet].map((idx) => ({
        id: randomBytes(6).toString("hex"),
        postId: batch[idx].id,
        url: batch[idx].url,
        imgId: registerImage(batch[idx].url, cid), // クライアントには imgId 経由でのみ配信(投稿IDを隠す)
        target: true,
      })),
      ...distractorIdxs.map((idx) => ({
        id: randomBytes(6).toString("hex"),
        postId: batch[idx].id,
        url: batch[idx].url,
        imgId: registerImage(batch[idx].url, cid),
        target: false,
      })),
    ]);

    return {
      id: cid,
      prompt: promptTags.join(" × "), // 表示用(2タグなら「A × B」)
      tags: promptTags, // 機械可読な出題タグ
      mode: promptTags.length > 1 ? "and" : "single",
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
    // PoW課題(この出題専用)とチケット(トークン束縛用)を発行
    c.powBits = powBitsFor(ip);
    c.pow = randomBytes(16).toString("hex");
    c.powSalt = randomBytes(16).toString("hex"); // scrypt用ソルト(毎回ランダム)
    c.ticket = newTicket(ip);
    challenges.set(c.id, c);
    // 画像URLは自前プロキシ経由の不透明URLで返す(元URL=投稿IDを渡さない)
    const base = publicBase(req);
    return sendJson(res, 200, {
      id: c.id,
      prompt: c.prompt,
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
      minMs: MIN_SOLVE_MS,
    });
  }

  // 回答検証(全層を通過した時だけワンタイム解決トークンを発行)
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
    if (!chargeWork(ip, c.powBits)) {
      challenges.delete(id);
      return sendJson(res, 429, {
        ok: false,
        error: "計算認証の試行量が上限に達しました。しばらく待ってから再試行してください",
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
    if (serverElapsed < MIN_SOLVE_MS) {
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
  console.log(`  多層認証: 画像 + PoW(${POW_BITS}bit〜${POW_BITS_MAX}bit) + ハニーポット + 挙動判定 + チケット束縛`);
});

// 1件の失敗(画像取得のタイムアウト等)でCAPTCHAサービス全体を落とさない
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.message ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.message ? err.message : err);
});
