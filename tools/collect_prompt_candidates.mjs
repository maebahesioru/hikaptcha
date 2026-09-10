// お題タグ候補を大量収集して洗い出す(方式は変えない: ランダムバッチ+フィルタ)
//  現行の questionableTag を通り、かつ「同じバッチで2〜4枚に付く」= 実際にお題になり得るタグを集める
//  使用回数(usages)も記録し、良タグ/悪タグの傾向を測る
import { writeFileSync } from "node:fs";

const API = "https://hikabooru.hikamers.app/api";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// --- サーバーのフィルタを再現(現行版) ---
const HAS_JP = /[\u3040-\u30ff\u3400-\u9fff]/;
const HAS_KATAKANA_OR_KANJI = /[\u30a1-\u30f6\u3400-\u9fff]/;
const HAS_NUM = /[0-9０-９]/;
const HIRA = /[\u3040-\u309f]/;
const JUNK_START = /^[、。，「」（）()・\s\-_/\\@]/;
const HIRA_TAIL = /[\u3040-\u309f]$/;
const META_TAG = /上半身|バスト|胸像|クロースアップ|クローズアップ|全身|ポートレート|被写界深度|フレーム|コマ|ツイート|スクリーンショット|ハイレゾ|アルバム|タイムスタンプ|記号|テキスト|キャプション|字幕|ウェブ|アップロード|ダウンロード|チャンネル|ユーザー|ID|ロゴ|アイコン|ライブ|リフレクション|背景|動画|著作権|完成|日常|シンボル|スタンプ|スクショ/;
const JUNK_TAG = [/^[\d０-９]+$/, /^[0-9a-z]{1,3}$/i, /[()（）]/, /user/i, /https?:|www\.|\.com|\.net|youtube|pixiv/i, /@/, /^[\s\-_/\\]+$/];
const SYMBOL_ANY = /[・《》〈〉【】「」『』…‥.!！？?～~／/\\|｜＝=＋+＊*＠@＃#＄$％%＆&：:；;]/;
const NO_PARTICLE = /の/;
const ABSTRACT_WORD = /焦点|配置|模倣|照準|集中|監視|隊員|群衆|容器|絵文字|サイン|チャート|グラフ|コンピューター|ゲーム機|ソース|グループ|ウィンドウ|静物画|美術|外側|内側|消防|株式会社|有限会社|写実|公式|製品|商品|景品|特典|報酬|対価|価格|金額|料金|費用|収支|利益|損失|数量|個数|面積|体積|距離|速度|温度|湿度|気圧|密度|濃度|割合|比率|確率|平均|最大|最小|合計|差分|増減|変化|変動|推移|予測|推計|統計|分析|評価|判定|診断|検証|検査|測定|調査|研究|学習|教育|訓練|練習|試行|実験|観察|記録|報告|発表|公開|掲示|提示|提出|申請|登録|認証|許可|承認|拒否|禁止|管理|処理|表示|操作|動作|行動|活動|作業|業務|事業|産業|組織|制度|体系|構造|構成|要素|成分|原料|材料|機能|性能|能力|効果|影響|理由|原因|結果|目的|手段|方法|方式|形式|種類|分類|属性|性質|特徴|傾向|程度|段階|範囲|領域|部門|状態|状況|様子|雰囲気|印象|感覚|感情|記憶|意識|精神|心理|思想|概念|理論|法則|原理|原則|方針|基準|規格|標準|規範|条件|要件|制限|制約|可能性|必要性|一般|特殊|普通|通常|基本|応用|実用|実際|現実|理想|目標|広告|宣伝|告知|案内|説明|解説|紹介|連絡|相談|質問|回答|返事|予定|計画|準備|確認|経験|実績|成果|実力|限界|環境|空間|時間|瞬間|期間|時代|現在|過去|未来|歴史|文化|社会|経済|政治|科学|数学|音楽|文学|芸術|宗教|哲学|伝統|習慣|風習|行事|儀式|祭典|イベント|大会|試合|競技|勝負|勝敗|勝利|敗北|順位|ランキング|得点|点数|スコア|レベル|ランク|クラス|称号|肩書|役職|地位|立場|関係|繋がり|結びつき|影響力|支配力|権力|権限|責任|義務|権利|自由|平等|平和|戦争|紛争|争い|喧嘩|口論|議論|討論|会議|集会|集まり|集合|集団|団体|仲間|同僚|友人|知人|家族|親戚|血縁|恋愛|結婚|離婚|出産|育児|介護|看護|医療|治療|診療|手術|投薬|処方|症状|病気|疾患|怪我|負傷|損傷|故障|不具合|誤作動|異常|正常|健全|不健全|健康|不健康|栄養|カロリー|ビタミン|ミネラル|タンパク|脂質|糖質|食物繊維/;
const STOP_TAG = /ください|チェック|翻訳|依頼|解説|説明|聞いてみ|なので|じゃない|です|ます|ました|じゃん|ってしま|どうぞ|の巻|つけよう/;
const EXCLUDE_TAGS = new Set(["男性","女性","実写","現実の生活","現実的で","写真背景","複数の視点","字幕","ミーム","おじいちゃん向けコンテンツ","なんだって","食べ物","1人の少年","2人の男児","立ち姿","人物","人々","人間の","子供","少女","少年","動物","日本人","オタク","カジュアル","服","衣服","髪","目","顔","手","靴","建物","街","家","ポヴ","グリン","スミスカラ","モシャン","ユウギオ","ハゲ","悪夢の燃料","アジア人","白人","黒人","外国人","海兵隊員","監視者","デュエルモンスター","武器","風景","哺乳類","両生類","爬虫類","菌類","昆虫","植物","生物","ゲーム機","コンピューター","スマートフォン","マウスマスク","マスクプル","ボーダー","ソロフォーカス","物体焦点","製品配置","頭部照準像","食糧集中","チャート","グラフ","絵文字","サイン","ソース","グループ","ウィンドウ","アップル","ゼルダの伝説","クロスオーバー","アニメ化","静物画","公式美術","家具","照明","建築","装飾","模様","文字","数字","記号","標識","無表情","表面","四足動物","レストラン","開けるジャケット","キャラクター人形","ポブハンズ","バウティー","シークエンキャップ","ストリークヘア","ガチャ","カップル","チャットログ","ショップ","軍隊","プレイド","機械","惑星","キッチン","ホーム","警察","兄","兄弟","家族","成人","成熟したオス","肥満","暗い肌色","モーションブラー","ハグ","ミニ人","動物視点","年齢差","スカーリー","巾着型","ダブルV","ダブルバン","バラバラ","異色性","売春","トップレス","トップレス男性","表紙カバー","カバー","コスプレ","コスプレ写真","人型","アップ","胴体をトリミング","スケッチ","服装に文字","スタミナ","舞台照明","手鞭","元素生物","スピード","ハッピー","カード","テーマ","デザイン","スタイル","アディダス","サンリオ","マイクロソフト","ドラゴンボール","ニンテンドースイッチ","任天堂","ポケモン","艦隊コレクション","オリンピック","サッカー","野球",]);

function usableTag(t) {
  if (!t || t.length < 2) return false;
  if (!HAS_JP.test(t)) return false;
  return !JUNK_TAG.some((re) => re.test(t));
}
function questionableTag(t, usages) {
  if (!usableTag(t)) return false;
  const n = Number(usages) || 0;
  if (n < 10 || n > 3000) return false;
  if (t.length > 10) return false;
  if (HAS_NUM.test(t)) return false;
  if (JUNK_START.test(t)) return false;
  if (SYMBOL_ANY.test(t)) return false;
  if (/\s/.test(t)) return false;
  if (EXCLUDE_TAGS.has(t)) return false;
  if (NO_PARTICLE.test(t)) return false;
  if (ABSTRACT_WORD.test(t)) return false;
  if (!HAS_KATAKANA_OR_KANJI.test(t)) return false;
  if (HIRA_TAIL.test(t)) return false;
  if (META_TAG.test(t)) return false;
  if (STOP_TAG.test(t)) return false;
  if (HIRA.test(t) && (HIRA.test(t.slice(-2, -1)) || (t.match(/[\u3040-\u309f]/g) || []).length >= 3)) return false;
  return true;
}

async function fetchBatch(limit) {
  const off = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  const url = `${API}/posts?query=${q}&limit=${limit}&offset=${off}&fields=id,canvasWidth,canvasHeight,tags`;
  const r = await fetch(url, { headers: UA });
  const d = await r.json();
  return (d.results || []).filter((p) => {
    const w = p.canvasWidth || 0, h = p.canvasHeight || 0;
    return w && h && w / h >= 0.56 && w / h <= 1.78;
  });
}

const stats = new Map(); // tag -> {count(出現バッチ数), usages, images}
const BATCHES = Number(process.argv[2] || 60);

async function main() {
  let okBatches = 0;
  for (let i = 0; i < BATCHES; i++) {
    const b = await fetchBatch(24);
    if (b.length < 9) continue;
    okBatches++;
    const counts = new Map();
    for (const p of b) {
      for (const x of p.tags || []) {
        const name = (x.names || [""])[0];
        if (!name) continue;
        if (!questionableTag(name, x.usages)) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
        if (!stats.has(name)) stats.set(name, { batches: 0, usages: x.usages || 0 });
      }
    }
    for (const [tag, n] of counts) {
      // お題として実際に選ばれ得るのは 2〜4枚 のもの
      if (n >= 2 && n <= 4) stats.get(tag).batches++;
    }
    await new Promise((s) => setTimeout(s, 120));
  }
  console.log(`バッチ ${okBatches}/${BATCHES} で収集`);

  const cands = [...stats.entries()].filter(([, v]) => v.batches > 0);
  cands.sort((a, b) => b[1].batches - a[1].batches || b[1].usages - a[1].usages);
  console.log(`お題になり得たタグ: ${cands.length}種\n`);
  for (const [tag, v] of cands) {
    console.log(`${String(v.batches).padStart(3)}回 usages=${String(v.usages).padStart(5)}  ${tag}`);
  }
  writeFileSync("C:/Users/maeba/Desktop/hikamani-captcha/tools/prompt_candidates.txt",
    cands.map(([t, v]) => `${t}\t${v.batches}\t${v.usages}`).join("\n") + "\n");
  console.log("\n→ tools/prompt_candidates.txt に保存");
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
