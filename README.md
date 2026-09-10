# ヒカマニCAPTCHA

hikabooru([hikabooru.hikamers.app](https://hikabooru.hikamers.app))の**実在画像**で出題する多層認証CAPTCHA。
「◯◯の画像を全部選んで」の画像認証に、メモリハードPoW・ハニーポット・サーバー観測シグナル・
チケット束縛・画像改変を重ねる。Node 18+ のみ(ffmpegは任意。無ければ画像改変だけ無効)。

## 起動

```bash
node server.mjs                        # http://localhost:3107
PORT=8080 node server.mjs
POW_BITS=7 POW_N=2048 node server.mjs  # 計算認証を重くする
IMG_TRANSFORM=0 node server.mjs        # 画像改変を無効化(ffmpeg不要)
MIN_SOLVE_MS=1500 node server.mjs      # サーバー実測の下限
```

動作確認ページ: http://localhost:3107/

## 認証の層

| 層 | 内容 | 何を防ぐか | 実測 |
|---|---|---|---|
| 1. 画像認証 | hikabooruの9枚から「◯◯の画像」を全部選ぶ | 内容理解の要求 | — |
| 2. メモリハードPoW | scrypt(N=1024,r=8)出力の先頭ゼロビット探索を回答前に要求 | 量産・GPU突破の単価を上げる | sha256比 **1試行あたり約780倍**のコスト |
| 3. 画像改変 | 配信時に余白付与+微小クロップ+回転+再圧縮 | 逆画像検索・事前索引・完全一致キャッシュ | 元画像とのpHash距離 **平均32.6/64** |
| 4. 画像取得の実測 | 画像が実際に配信されたかをサーバーが記録し、未取得なら拒否 | 画像を見ないスクリプトの直叩き | 未取得は **拒否** |
| 5. 実測時間 | チャレンジ発行〜回答到達をサーバー時計で測り下限を強制 | 高速ソルバーの即答 | 即答は **拒否** |
| 6. チケット束縛 | 解決トークンを発行時のチケットへ固定、消費時に一致必須 | トークンの転売・横流し | 別チケットの消費は **拒否** |
| 7. 仕事量予算 | IPごとの累計PoW仕事量に上限 | 計算資源による総当たりの速度制限 | 上限超過は **429** |
| 8. ハニーポット | 人間に見えない入力欄 | フォーム自動入力型のボット | 記入は **即拒否** |
| 9. 適応難易度 | 突破実績の多いIPはPoWを段階的に強化 | 継続的な突破 | 3回突破で 6bit→7bit |
| 10. 挙動シグナル | 操作の有無・移動量・所要時間(補助) | 安価なボット | 操作ゼロは追加の減点 |

さらに:
- 画像URLは自前プロキシ(`/api/img/<不透明ID>`)経由。元の投稿IDを出さない
- IPクォータ(60回/10分)、同一IPの出題は最大10件保持(別タブ・NATで壊れない)
- 1件の失敗でサービス全体が落ちないよう unhandledRejection / uncaughtException をガード

## 実測した攻撃耐性

```
=== 多層認証テスト: 18 PASS / 0 FAIL ===
  ✅ PoWが解ける(481ms) / ソルトあり / scrypt方式
  ✅ 画像未取得(直叩き)は拒否
  ✅ ハニーポット記入は拒否
  ✅ 高速ソルバーの即答はサーバー実測で拒否
  ✅ 申告値と実測の矛盾は拒否
  ✅ PoW未完了は拒否 / チケット無しは拒否
  ✅ 画像URLに投稿ID/元ドメインが漏れない
  ✅ 配信画像は改変済み・再取得しても同一(出題中は安定)
  ✅ 全層通過でトークン発行 → 正しいチケットで消費成功
  ✅ 別チケットでの消費は拒否
  ✅ 突破実績でPoW難易度が上がる

=== 旧タグ逆引きボット(画像を一切見ない攻撃): 0/5 突破 ===

=== 画像改変の効果 ===
  配信 vs 元     : pHash距離 平均32.6/64 (大きい=逆検索が壊れる)
  中央同士の比較 : pHash距離 平均8.8/64  (小さい=被写体は保たれている)
  全画像でバイト列が元と不一致
```

## 残っている限界(正直なところ)

前バージョンから 4点を大幅に改善したが、**ゼロにはできていない**:

| 限界 | 状態 | 残るリスク |
|---|---|---|
| 画像認識ボット | **改善** | 事前索引・逆検索での突破は不可能になった(改変でpHash距離32.6)。ただし**リアルタイムで画像分類する**ボットは依然として解ける。改変は索引を壊すが、分類そのものは止められない |
| クライアント申告の偽装 | **大幅改善** | 主軸を「画像が実際に配信されたか」「サーバー実測時間」に移したので偽装不能。ただし挙動シグナル自体は依然として自己申告で、単独では信用していない(補助のみ) |
| ハニーポット無効なボット | **改善** | 埋めないボットはハニーポットを素通りするが、**画像取得の実測**が代わりに捕まえる(画像を取らずに回答はできない) |
| PoWの計算突破 | **大幅改善** | sha256→scryptでメモリハード化し1試行のコストを約780倍に。さらに仕事量予算で総量を頭打ち。ただし**時間をかければ突破は可能**で、上限を消すことはできない |

構造的な限界:
- **画像を実際に読む分類器には原理的に弱い**。これは画像CAPTCHA共通の限界(reCAPTCHA v2の画像課題も同様に解かれている)。対策するなら「分類器が苦手で人間は得意な課題」への転換が必要(例: 関係性・数の推論)
- **PoWは「壁」ではなく「コスト」**。攻撃者の計算資源をゼロにはできない
- クライアント側のシグナルは原理的に偽装可能なので、サーバー観測の項目(2,4,5,6,7)を主軸に据えている
- メモリ保持・単一プロセス前提(スケールさせるならRedis等へ)

## 設定(環境変数)

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | 3107 | 待受ポート |
| `POW_ALGO` | scrypt | `sha256` で旧方式(互換用) |
| `POW_N` / `POW_R` / `POW_P` | 1024 / 8 / 1 | scryptパラメータ(メモリ量) |
| `POW_BITS` / `POW_BITS_MAX` | 6 / 9 | PoW難易度(先頭ゼロビット)と適応上限 |
| `MIN_SOLVE_MS` | 1500 | サーバー実測の下限(速すぎる回答を拒否) |
| `IMG_TRANSFORM` | 1 | `0`で画像改変を無効化 |
| `PAD_MIN` / `PAD_MAX` | 10 / 20 | 余白付与の割合(%) |
| `CROP_MAX` | 5 | 微小クロップの最大(%) |
| `ROT_MAX` | 2 | 回転の最大角度(度) |
| `IP_WORK_BUDGET` | 5000 | IPごとの累計PoW仕事量(期待試行数) |

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/challenge` | 出題 `{id, prompt, tiles, ticket, pow:{algo,challenge,salt,bits,N,r,p}, honeypot, minMs}` |
| GET | `/api/img/<imgId>` | 画像プロキシ(改変配信+取得記録) |
| POST | `/api/verify` | `{id, selected, ticket, nonce, elapsedMs, signals, [honeypot]}` → 全層通過で `{ok:true, token, risk, serverElapsedMs, imagesFetched}` |
| POST | `/api/consume` | `{token, ticket}` → 埋め込み先が登録前に消費 `{ok:true}` |
| GET | `/api/health` | 生存確認 |

## 埋め込み方

```html
<div id="captcha"></div>
<script src="https://CAPTCHAサーバーのURL/captcha.js"></script>
<script>
  HikamaniCaptcha.render(document.getElementById("captcha"), {
    apiBase: "https://CAPTCHAサーバーのURL",
    onSolved: function (token, ticket) { /* 自サイトの登録フォームへ */ },
  });
</script>
```

サーバー側は受け付ける前に必ず消費する(呼ばないと認証が素通りします):

```bash
curl -X POST https://CAPTCHAサーバー/api/consume \
  -H "Content-Type: application/json" \
  -d '{"token":"...","ticket":"..."}'
```

## テスト

```bash
npm test                 # 多層認証(攻撃シナリオ別) 18項目
npm run test:parity      # ウィジェットscryptがNodeのscryptと一致するか(重要)
npm run test:transform   # 画像改変で「ハッシュは別物・被写体は保持」を実測
npm run debug-copy       # 正解付きテスト用コピー(:3108)を生成
```

## Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg   # 画像改変に使う(無いと改変だけ無効)
COPY package.json server.mjs ./
COPY public/ ./public/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```
