# HIKAPTCHA

hikabooru(ヒカマニ関連の画像アーカイブ)の実在画像を使う画像選択型CAPTCHA。
画像認証に加えて、メモリハードPoW・ハニーポット・挙動シグナル・チケット束縛・画像改変を重ねた多層構成。

- 依存ゼロ(Node 18+のみ。ffmpegは任意で、無い場合は画像改変だけが無効になる)
- 他サイトへの埋め込みに対応(ウィジェット + HTTP API)
- 公開サーバー: **https://hikaptcha.hikamers.app**
- リポジトリ: [maebahesioru/hikaptcha](https://github.com/maebahesioru/hikaptcha)
- 管理者: [@maebahesioru2](https://x.com/maebahesioru2)(X)

## 特徴

| 機能 | 内容 |
|---|---|
| 画像認証 | 9枚の画像から条件に合うものを選ぶ(お題は自動生成) |
| 出題形式 | 9形式(全部選ぶ/◯枚だけ選ぶ/含まれないものを選ぶ/2語のOR・XOR・NOT OR・AかつBでない) |
| メモリハードPoW | scrypt(N=1024, r=8)の先頭ゼロビット探索を回答前に要求 |
| ハニーポット | 人間には見えない入力欄への記入を即時拒否 |
| チケット束縛 | 解決トークンを発行元セッションに固定(転売・横流し対策) |
| 画像改変 | 配信時に縮小+ガンマ+再圧縮(バイト一致を防ぐ) |
| 適応難易度 | 突破実績の多いIPはPoWを段階的に強化 |

## 使い方

サーバーは1つで、複数サイトから共用できる。埋め込み側の実装は「ウィジェットを置く」と
「トークンを消費する」の2点のみ。

```
あなたのサイト ──(captcha.js)──▶ https://hikaptcha.hikamers.app/api/*
```

### 1. ウィジェットを設置する(フロント側)

```html
<div id="captcha"></div>
<script src="https://hikaptcha.hikamers.app/captcha.js"></script>
<script>
  Hikaptcha.render(document.getElementById("captcha"), {
    apiBase: "https://hikaptcha.hikamers.app",
    onSolved: function (token, ticket) {
      // 自サイトのサーバーへ送る(この時点では未検証)
      fetch("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token, ticket: ticket, name: "..." }),
      });
    },
  });
</script>
```

ウィジェットの内部動作: 出題の取得 → 画像9枚の表示 → 選択UI → PoW(scrypt)の計算 →
`minMs` 待機 → `/api/verify` への送信 → 失敗時は新しい出題を自動取得。
描画は Shadow DOM の中で行うため、埋め込み先のCSSの影響を受けない。

### 2. トークンを消費する(サーバー側・必須)

```js
const r = await fetch("https://hikaptcha.hikamers.app/api/consume", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, ticket }),
});
const j = await r.json();
if (!j.ok) return res.status(400).json({ error: "認証に失敗しました" });
// ここから先が人間が通った処理(登録・投稿など)
```

```bash
curl -X POST https://hikaptcha.hikamers.app/api/consume \
  -H "content-type: application/json" \
  -d '{"token":"...","ticket":"..."}'
# => {"ok":true}
```

**注意事項**

- この呼び出しを省略すると認証は成立しない。トークンの有効期限は5分で、一度消費すると再利用できない。
- `ticket` は発行時のセッションと一致している必要がある(不一致は拒否)。
- クライアント側の表示だけで「認証済み」にしない。判定はサーバーが `/api/consume` に成功した時点で成立する。

### 動作確認

```bash
node tools/api_walkthrough.mjs https://hikaptcha.hikamers.app
```

出題から消費までの全リクエストを実行して応答を表示する(本番は正解を返さないため、正解付きで試す場合は
デバッグコピーを使う。→「セルフホスト」)。

## 認証フロー

```
ブラウザ                         CAPTCHAサーバー                 あなたのサーバー
  │ ①GET /api/challenge ──────────▶ 出題を生成(画像9枚+PoW課題+チケット)
  │ ◀── tiles[9] / pow / ticket / minMs
  │ ②GET /api/img/<id> ×9 ───────▶ 画像を配信(取得を記録)
  │ ③人が画像を選択
  │ ④PoW(scrypt)を計算
  │ ⑤minMs まで待機
  │ ⑥POST /api/verify ───────────▶ 以下の層を検証
  │ ◀── {ok:true, token, risk, serverElapsedMs, imagesFetched}
  │                                                         │
  │ ⑦POST /register {token,ticket} ───────────────────────▶ ⑧POST /api/consume
  │                                                         │ ◀── {ok:true}(ワンタイム)
  │ ◀──────── 登録完了(ここで認証が成立)
```

`/api/verify` の検証項目:

| # | 検証内容 | 不成立時の応答 |
|---|---|---|
| 1 | 選択が正解と完全一致 | 400(残り試行を返す)/ 3回失敗で410 |
| 2 | 画像が実際に配信されたか | 400 `画像が読み込まれていません` |
| 3 | サーバー実測の所要時間 | 400 `回答が速すぎます` |
| 4 | PoWのnonce | 410 `認証に失敗しました` |
| 5 | チケットの有効性 | 410 `認証セッションが無効です` |
| 6 | ハニーポット欄が空か | 400 `自動入力を検出しました` |
| 7 | 挙動シグナル(操作の有無・移動量) | 通過。`risk` に加点される(ソフト) |
| 8 | 申告時間と実測の整合 | 400 `申告値と実測値が一致しません` |

`risk` は0〜6程度の加点方式の指標で、通過可否の判定には使わない。
埋め込み先で「riskが高い場合は手動確認」といった運用に利用できる。

## APIリファレンス

`/api/*` はすべて `Content-Type: application/json`。CORSヘッダ(`Access-Control-Allow-Origin: *`)を
付与し、`OPTIONS` プリフライトにも応答する。

### GET /api/challenge

出題を1件生成する。パラメータは無し。**本番は正解(`target`)を返さない**(デバッグコピーのみ付与)。

```bash
curl -s https://hikaptcha.hikamers.app/api/challenge
```

応答例(デバッグコピーで正解を可視化したもの):

```json
{
  "id": "056ae9330ba4f6e6",
  "mode": "or",
  "ask": {
    "mode": "or",
    "tags": ["ボディスーツ", "上着"],
    "n": 0,
    "maxSelect": 0,
    "text": "「ボディスーツ」または「上着」が写っている画像を全部選んでください"
  },
  "tags": ["ボディスーツ", "上着"],
  "prompt": "「ボディスーツ」または「上着」が写っている画像を全部選んでください",
  "tiles": [
    { "id": "cc8d38f9a970", "url": "https://hikaptcha.hikamers.app/api/img/87e109dd625070e75935c5b8" }
  ],
  "ticket": "75d0ef125e92...(48字)",
  "pow": { "algo": "scrypt", "challenge": "ee27257df6cd...(32字)", "salt": "7dbbd3117261...(32字)",
           "bits": 6, "N": 1024, "r": 8, "p": 1 },
  "honeypot": "website",
  "minMs": 1500
}
```

| フィールド | 説明 |
|---|---|
| `id` | 出題ID。`/api/verify` にそのまま返す |
| `ask.text` | 画面に表示する文面。サーバーが組み立てるためクライアントでは生成しない |
| `ask.mode` | 出題形式(`single`/`pick`/`not`/`notpick`/`or`/`and`) |
| `ask.tags` | お題のタグ(1〜2語) |
| `ask.n` | `pick`/`notpick` の枚数 |
| `ask.maxSelect` | 選択できる枚数の上限。0は無制限 |
| `tiles[]` | タイルのIDと画像URL。URLは不透明ID経由で元投稿は分からない |
| `ticket` | 認証セッション。消費時にも必要 |
| `pow` | scryptのパラメータ。`leadingZeroBits(scrypt(challenge + ":" + nonce, salt)) >= bits` を満たす `nonce` を探す |
| `honeypot` | ハニーポット入力欄の `name`(既定 `website`)。記入があればボット判定 |
| `minMs` | 回答送信までの下限。待たずに送ると `回答が速すぎます` になる |

同一IPで保持する出題は最大10件で、超えた分は古いものから破棄される。

### GET /api/img/<imgId>

画像プロキシ。長辺640pxへの縮小・3:2への整形・再圧縮を行って配信する(`cache-control: no-store`)。
配信の有無をサーバーが記録し、未取得の回答は拒否される。

### POST /api/verify

```bash
curl -X POST https://hikaptcha.hikamers.app/api/verify -H "content-type: application/json" -d '{
  "id": "056ae9330ba4f6e6",
  "selected": ["cc8d38f9a970", "61635834b910"],
  "ticket": "75d0ef125e92...",
  "nonce": "127",
  "elapsedMs": 2677,
  "signals": { "interactionSeen": true, "pointerMoves": 24, "clicks": 2, "touchSeen": false, "powMs": 286 }
}'
```

成功時の応答:

```json
{ "ok": true, "token": "6a827406145deca2b3ff94fb54c9fd4ecb4e3178cc897805", "risk": 0,
  "serverElapsedMs": 2677, "imagesFetched": 9 }
```

| リクエスト | 説明 |
|---|---|
| `selected[]` | 選択したタイルの `id`。過不足なく一致しないと不正解 |
| `nonce` | PoWの解(文字列) |
| `elapsedMs` | クライアントが計測した所要時間(実測と大きく異なると拒否) |
| `signals.interactionSeen` | 操作が観測されたか |
| `signals.pointerMoves` | ポインタ移動の回数 |
| `signals.touchSeen` | タッチ操作だったか(移動量の判定を緩和する) |
| `signals.touchedHidden` | 隠し要素に触れたか(加点対象) |
| `signals.powMs` | PoWに要した時間 |
| `website` | ハニーポット(`challenge.honeypot` の名前で送る)。空で送る |

| レスポンス | 説明 |
|---|---|
| `token` | ワンタイム解決トークン(48字)。`/api/consume` に渡す |
| `risk` | ソフトなリスク値(0が最もクリーン) |
| `serverElapsedMs` | サーバー実測の所要時間 |
| `imagesFetched` | 実際に取得された画像の枚数 |

### POST /api/consume

```json
{ "ok": true }
```

### GET /api/health

```json
{ "ok": true, "stats": { "challenges": 12, "tagRejects": 5, "modes": {"single": 7} } }
```

`stats` には出題数・フィルタの却下数・形式の内訳・空振り理由(`fShortBatch` 等)が含まれる。
出題が遅い・出ない場合の調査はここから始める。

## エラー一覧

| ステータス | メッセージ | 意味 |
|---|---|---|
| 400 | 違う画像が混ざっています(あとN回)。選び直してください | 選択が不正解。`remaining` に残り試行回数 |
| 400 | 自動入力を検出しました。最初からやり直してください | ハニーポットに記入があった |
| 400 | 画像が読み込まれていません。ページを再読み込みしてもう一度お試しください | 画像を取得せずに回答した |
| 400 | 回答が速すぎます。もう一度やり直してください | 実測が `HARD_MIN_SOLVE_MS` 未満 |
| 400 | 申告値と実測値が一致しません。もう一度やり直してください | `elapsedMs` の申告が実測と大きく異なる |
| 400 | トークンがありません / トークンが無効です(期限切れ or 使用済み) | consumeの失敗 |
| 400 | トークンの期限が切れています | トークンの5分TTL切れ |
| 400 | トークンと認証セッションが一致しません | チケットの不一致 |
| 410 | 不正解です。新しい問題に挑戦してください | 3回失敗して出題を破棄 |
| 410 | 出題が見つかりません。もう一度やり直してください | 出題IDが無効 |
| 410 | 出題の期限が切れました。もう一度やり直してください | 出題のTTL切れ |
| 410 | 認証セッションが無効です。もう一度やり直してください | チケットが無効 |
| 429 | リクエストが多すぎます。あと約N秒で再開できます | レート制限(`IP_QUOTA` を設定した場合のみ) |
| 502 | 問題を準備できませんでした。少し待ってからもう一度お試しください | 出題生成の連続失敗 |

`410` は「その出題は無効」を意味するため、クライアントは新しい出題を取得する(同梱のウィジェットは自動で行う)。

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 認証が素通りする | `/api/consume` を呼んでいない |
| 毎回 `回答が速すぎます` になる | 自前実装時に `minMs` を待っていない |
| 毎回 `画像が読み込まれていません` になる | タイル画像を取得せずに `/api/verify` を呼んでいる |
| `429` が返る | `IP_QUOTA` を設定している場合のみ発生する(既定0=無制限) |
| 埋め込み先で見た目が崩れる | `apiBase` の指定を確認する(スタイルはShadow DOMで隔離されている) |
| 出題が返らない・遅い | `/api/health` の `stats` を確認する(`fShortBatch` 等の空振り理由) |
| 出題形式を固定して試したい | `FORCE_MODE=single node server.mjs` |
| 正解を見ながら試したい | `python tools/make_debug_copy.py` で正解付きコピーを生成 |

## 設定(環境変数)

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | 3107 | 待受ポート |
| `CHALLENGE_TTL_MS` | 300000 (5分) | 出題の有効期限 |
| `TOKEN_TTL_MS` | 300000 (5分) | 解決トークンの有効期限(消費されるまで) |
| `TICKET_TTL_MS` | 300000 (5分) | 認証セッション(チケット)の有効期限 |
| `MAX_ATTEMPTS` | 3 | 1出題あたりの回答試行回数 |
| `PUBLIC_BASE` | (なし) | 画像URLに使う公開URL(例 `https://hikaptcha.hikamers.app`)。未設定の場合はリクエストヘッダから推定する |
| `MODE_WEIGHTS` | single=3,not=3,notpick=1,pick=1,or=1,xor=1,notor=1,withnot=1,and=0 | 出題形式の重み(0で無効化) |
| `FORCE_MODE` | (なし) | 出題形式を固定する(検証用) |
| `TAG_MIN_USAGES` | 150 | お題タグの最低使用回数。低い値は品質が落ちるため通常は変更しない |
| `COMPANION_LIMIT` | 60 | 共起タグの算出に使う「タグ付き画像」の取得枚数 |
| `COMPANION_TIMEOUT_MS` | 1500 | 共起タグ取得の打ち切り時間。間に合わない場合はフィルタ無しで出題する |
| `SITE_POSTS` | 56000 | IDF計算の分母(サイト全体のおおよその枚数) |
| `RECENT_TAG_TTL_MS` | 900000 (15分) | 直近に使ったお題タグを避け続ける時間 |
| `RECENT_TAG_MAX` | 200 | 1IPあたりに記憶するタグ数 |
| `BATCH_LIMIT` | 60 | 1回に取得する画像の枚数(大きくすると候補が増えて空振りが減る。実測: 100にすると試行が17%減・所要時間は同等) |
| `SAMPLES_PER_BATCH` | 6 | バッチを構成する「離れたoffset」の数(枚数に合わせて増やす) |
| `VIS_FILTER` | 1 | `0` で視覚フィルタを無効化 |
| `VIS_MAX_DIST_RATIO` | 1.0 | 視覚フィルタの閾値(却下のたびに+0.12緩和) |
| `TARGET_ASPECT` | 1.5 | 配信画像の目標アスペクト比 |
| `POW_ALGO` | scrypt | `sha256` で旧方式(互換用) |
| `POW_N` / `POW_R` / `POW_P` | 1024 / 8 / 1 | scryptパラメータ |
| `POW_BITS` / `POW_BITS_MAX` | 6 / 9 | PoW難易度(先頭ゼロビット)と適応上限 |
| `POW_RAMP_EVERY` | 3 | 何回突破するごとにPoWを+1bitするか |
| `IP_SOLVED_DECAY_MS` | 1800000 (30分) | 突破実績を保持する時間(経過で0に戻る) |
| `MIN_SOLVE_MS` | 1500 | 人間が画像を見る時間の期待値(リスク加点と `minMs` に使用) |
| `HARD_MIN_SOLVE_MS` | MIN_SOLVE_MS と同じ | ハード拒否の下限 |
| `IMG_TRANSFORM` | 1 | `0` で画像改変を無効化 |
| `CROP_MAX` / `ROT_MAX` | 3 / 2.5 | 構図ズラし(%)と回転(度)の最大 |
| `JPEG_Q` | 3 | 再圧縮品質 |
| `IP_WORK_BUDGET` | 0 | PoWの累計仕事量の上限。0で無制限 |
| `IP_QUOTA` | 0 | レート制限のトークン数。0で無制限(運用例: `IP_QUOTA=120` + `IP_REFILL_MS=500` で毎分120回) |
| `IP_REFILL_MS` | 3000 | トークン1個が回復するまでの時間 |
| `IP_QUOTA_EXEMPT_LOCAL` | 1 | `0` でローカル/プライベートIPも制限する |
| `MAKE_CONCURRENCY` | 4 | 出題生成の同時実行数(超過分は順番待ち) |
| `DEBUG_MAKE` | (なし) | `1` で出題失敗の理由を `make-fail.log` に出力する |

## セルフホスト

### 起動

```bash
node server.mjs                        # http://localhost:3107
PORT=8080 node server.mjs
POW_BITS=7 POW_N=2048 node server.mjs  # PoWを重くする
IMG_TRANSFORM=0 node server.mjs        # 画像改変を無効化(ffmpeg不要)
```

- 動作確認ページ: `http://localhost:3107/`
- ドキュメントページ: `http://localhost:3107/docs`(このREADME.mdをその場でHTMLにして配信する)
- 正解付きのテスト用コピー: `python tools/make_debug_copy.py` → `PORT=3108 node <コピー先>/server.mjs`

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg   # 画像改変に使用(無い場合は改変が無効になる)
COPY package.json server.mjs tag_reject.json ./
COPY public/ ./public/
COPY lib/ ./lib/                # server.mjs が import する(/docs の生成)
COPY README.md ./               # /docs が実行時に参照する
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```

## テスト

```bash
node tools/test_multilayer.mjs             # 多層認証 20 PASS / 0 FAIL(要: 3107 と 3108)
python tools/embed-test/verify-embed.py    # 埋め込み 18 PASS / 0 FAIL(要: 模擬サイト :3200)
node tools/verify_docs.mjs                 # /docs 27 PASS / 0 FAIL(要: 3107)
python tools/verify-docs.py                # /docs 17 PASS / 0 FAIL(実ブラウザ)
python tools/api_walkthrough.mjs           # 全APIの実行と応答表示
python tools/probe_vocabulary.mjs          # 出題タグの多様性
python tools/probe_failure_rate.mjs        # 出題の失敗率と理由
```

```bash
npm test                 # 多層認証(攻撃シナリオ別)
npm run test:parity      # ウィジェットのscryptがNodeと一致するか
npm run test:transform   # 画像改変の確認
npm run debug-copy       # 正解付きテスト用コピー(:3108)の生成
```

タイミングに依存する検証は連続で複数回実行する(1回だけでは、外部ネットワークの所要時間変動により
実バグをフレークと誤認する)。

## 設計

### 認証の層

| 層 | 内容 | 対策対象 |
|---|---|---|
| 1. 画像認証 | 9枚から条件に合う画像を選択 | 内容理解の要求 |
| 2. メモリハードPoW | scrypt(N=1024, r=8)の先頭ゼロビット探索 | 量産コストの引き上げ |
| 3. 画像改変 | 縮小+ガンマ+再圧縮 | バイト一致による照合 |
| 4. 画像取得の記録 | 未取得の回答を拒否 | 直叩きスクリプト |
| 5. 実測時間 | 発行から回答までの下限を強制 | 高速ソルバー |
| 6. チケット束縛 | トークンを発行元セッションに固定 | トークンの転売・横流し |
| 7. 仕事量予算 | IPごとのPoW累計に上限(既定オフ) | 計算資源による総当たり |
| 8. ハニーポット | 不可視の入力欄 | フォーム自動入力 |
| 9. 適応難易度 | 突破実績の多いIPはPoWを強化 | 継続的な突破 |
| 10. 挙動シグナル | 操作の有無・移動量(ソフト) | 安価なボット |
| 11. 実行環境シグナル | webdriverフラグ・ソフトウェア描画・ブラウザAPIの有無 | 自動化ブラウザ(Playwright/Puppeteer等) |

画像URLは自前プロキシ(`/api/img/<不透明ID>`)経由で配信し、元の投稿IDを露出しない。

`risk` は加点方式で、**2点以上(補正後)で拒否**する。実行環境シグナルの加点は
「情報が無い」ことを罰しない(カスタム実装・API利用は正当なため)。敵性のある値だけを見る:

| シグナル | 加点 | 理由 |
|---|---|---|
| `webdriver === true` | +2 | 自動化フレームワークの既定値(実ブラウザでは立たない) |
| ソフトウェア描画(SwiftShader等) | +2 | ヘッドレスブラウザの典型 |
| `window.chrome` が無い | +1 | ブラウザAPIの欠落(ヘッドレスの目安) |

PoWの実コスト(scrypt N=1024, r=8、1試行2.1ms):

| bits | 期待試行数 | ネイティブ | ブラウザ目安(×3) |
|---|---|---|---|
| 6(既定) | 64 | 0.13秒 | 0.4秒 |
| 7 | 128 | 0.27秒 | 0.8秒 |
| 9 | 512 | 1.1秒 | 3.2秒 |
| 11(適応上限) | 2048 | 4.3秒 | 12.8秒 |

突破実績のあるIPは `POW_RAMP_EVERY` 回ごとに+1bit(上限 `POW_BITS_MAX`)。
実績は `IP_SOLVED_DECAY_MS` で失効するため、正規ユーザーが永久に高い難易度を負わない。

### 出題

方式は「ランダムな画像バッチ + 除外フィルタ」。お題タグはバッチ内のタグから選ぶ。

| 形式 | 文面 | 正解 |
|---|---|---|
| `single` | 「◯◯」の画像を全部選べ | タグを持つ画像 |
| `pick` | 「◯◯」が写っている画像をN枚だけ選べ | タグを持つ画像からN枚 |
| `not` | 「◯◯」が写っていない画像を全部選べ | タグを持たない画像 |
| `notpick` | 「◯◯」が写っていない画像をN枚だけ選べ | タグを持たない画像からN枚 |
| `or` | 「◯◯」または「△△」が写っている画像を全部選べ | どちらかを持つ画像 |
| `xor` | 「◯◯」か「△△」の片方だけが写っている画像を全部選べ | 片方だけを持つ画像 |
| `notor` | 「◯◯」も「△△」も写っていない画像を全部選べ | どちらも持たない画像 |
| `withnot` | 「◯◯」が写っていて「△△」が写っていない画像を全部選べ | ◯◯だけを持つ画像 |
| `and` | 「◯◯」と「△△」の両方が写っている画像を全部選べ | 両方を持つ画像(既定で無効) |

文面はサーバーが組み立て、クライアントは `ask.text` を表示するだけにする。
選択上限は `ask.maxSelect` で指定する(0は無制限)。

### タグの選別と品質

- 名前・品詞による選別: 記号入り、助詞入り、ひらがなのみ、抽象語、構図/メタ語を除外する。
- 使用回数による選別: 使用回数150未満のタグはOCRノイズが多いため除外する(帯域全体の約半数が該当)。
- 誤付与対策: 正解候補同士が意味のあるタグを共有するかを確認し、浮いた画像を除外する。
- 誤漏れ対策: 「◯◯の画像」に付く共起タグ(サイト全体の統計)を手がかりに、タグが無くても
  写っている可能性が高い画像を正解側に含める。逆に、共起タグが全く無いタグ付き画像は除外する。
- 見分けやすさ: 正解とダミーの画像類似度・タグ類似度を比較し、区別できない出題は破棄する。
- 多様性: 使用したタグを15分間記憶し、同じタグ・類似タグの連続使用を避ける。

### 既知の限界

| 限界 | 内容 |
|---|---|
| タグの誤り | タグはAIによる一括付与のため、個々の画像での正誤は保証されない。統計的な補正は行っているが完全ではない |
| 解ける必要がある | 正解が人間に見て分からない出題は破棄している(検出できない場合は不公平な出題が残る) |
| 単一プロセス | 状態をメモリに保持する。複数インスタンス化する場合はRedis等への移行が必要 |
| サイトキーなし | 誰でも埋め込める。トークンの流用は防止しているが、サイトの識別はできない |
| 知覚索引 | 画像改変はバイト一致を防ぐが、知覚ハッシュ等による照合には原理的に限界がある |

## 開発メモ

設計判断の根拠と実測記録は、リポジトリの `DEVNOTES.md` にまとめている。
