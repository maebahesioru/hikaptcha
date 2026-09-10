# ヒカマニCAPTCHA

hikabooru([hikabooru.hikamers.app](https://hikabooru.hikamers.app))の**実在画像**で出題する、多層認証のCAPTCHA。
9枚の画像から「◯◯の画像を全部選んで」に答える画像認証に、Proof-of-Work・ハニーポット・挙動判定・
チケット束縛を重ねる。依存パッケージゼロ(Node 18+のみ)の単体サービス。

## 起動

```bash
node server.mjs                        # http://localhost:3107
PORT=8080 node server.mjs              # ポート変更
POW_BITS=16 node server.mjs            # 計算認証を重くする
POW_BITS=12 POW_BITS_MAX=16 node server.mjs
```

動作確認ページ: http://localhost:3107/ (出題→回答→全層通過→トークン発行→消費まで実地テストできる)

## 認証の層

| 層 | 内容 | 何を防ぐか |
|---|---|---|
| 1. 画像認証 | hikabooruの画像9枚から「◯◯の画像」を全部選ぶ | 内容理解を要求(単純なスクリプト) |
| 2. Proof-of-Work | 回答前に sha256 の先頭ゼロビット探索(既定14bit≒平均16k回・約0.2〜1秒) | 大量試行の単価を上げる |
| 3. ハニーポット | 人間には見えない入力欄。埋められたら即拒否 | フォーム自動入力型のボット |
| 4. 挙動判定 | 操作の有無・ポインタ移動量・所要時間をスコア化(操作ゼロの直接POSTは即拒否) | ブラウザを介さない直叩き |
| 5. チケット束縛 | 解決トークンを発行時のチケットに固定。消費時に一致必須 | トークンの転売・横流し |
| 6. 適応難易度 | 突破実績の多いIPはPoWを最大 `POW_BITS_MAX` まで引き上げ | 継続的な突破のコスト増 |

さらに:
- **画像はサーバー側プロキシ経由**(`/api/img/<不透明ID>`)で配信。公開URLに元の投稿IDを出さない
  → 公開APIでタグを引いて正解を機械導出する攻撃を封じる
- IPクォータ(出題+回答あわせ60回/10分)、同一IPの出題は最大10件まで保持(別タブ・同一NATで壊れない)
- 1件の失敗でサービス全体が落ちないよう unhandledRejection / uncaughtException をガード

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/challenge` | 出題 `{id, prompt, tiles:[{id,url}×9], ticket, pow:{challenge,bits}, honeypot, minMs}` |
| GET | `/api/img/<imgId>` | 画像プロキシ(元URLを隠す) |
| POST | `/api/verify` | `{id, selected, ticket, nonce, elapsedMs, signals}` → 全層通過で `{ok:true, token, risk}` |
| POST | `/api/consume` | `{token, ticket}` → 埋め込み先サーバーが登録/投稿前に消費 `{ok:true}` |
| GET | `/api/health` | 生存確認 |
| GET | `/` `/captcha.js` | 動作確認ページ / 埋め込み用ウィジェットJS |

- 誤答は1出題につき3回まで。期限切れ/回数超過は新しい問題に自動で張り替わる
- 解決トークンは5分・ワンタイム。CORSは `Access-Control-Allow-Origin: *`(別オリジン埋め込み可)

## 埋め込み方

```html
<div id="captcha"></div>
<script src="https://CAPTCHAサーバーのURL/captcha.js"></script>
<script>
  HikamaniCaptcha.render(document.getElementById("captcha"), {
    apiBase: "https://CAPTCHAサーバーのURL",   // 別オリジンの場合は必須
    onSolved: function (token, ticket) {
      // token と ticket を自サイトの登録フォームに載せてサーバーで検証させる
    },
  });
</script>
```

サーバー側(登録・投稿API)で、受け付ける前にトークンを**1回だけ消費**する:

```bash
curl -X POST https://CAPTCHAサーバー/api/consume \
  -H "Content-Type: application/json" \
  -d '{"token":"受け取ったトークン","ticket":"受け取ったチケット"}'
# → {"ok":true} なら人間確認済みとして処理
```

⚠️ `consume` を必ず呼ぶこと。呼ばないサイトでは認証が素通りする。

## 出題の仕組み

1. hikabooruのsafe画像(約30,500枚)をランダムなoffset位置から16枚取得
2. その中で2〜4枚に付く**日本語タグ**をお題に選択(メタ/数値/ユーザー名/文章系/広すぎるタグは除外)
3. お題タグの画像=正解タイル、それ以外=ダミータイルで9枚グリッド
4. 正解情報(タグ/投稿ID)はサーバー側のみ保持。クライアントへは画像URLと不透明IDのみ

### 既知の限界(正直なところ)

- **画像認識ボットには弱い**。URLを隠しても、9枚を落として画像分類で「お題の単語」に合うものを選べば解ける。
  画像CAPTCHA共通の限界で、ここは未対策(対策するなら画像の再圧縮・微小回転等で逆検索を潰す)
- **クライアント申告のシグナルは偽装可能**。挙動シグナル・elapsedMs は自己申告なので、本気のボットは
  「人間らしい値」を送ってくる。検証可能なのは PoW・チケット・ハニーポット・レート制限のほう
- **ハニーポットは、埋めないボットには効かない**(安いボットを落とすだけ)
- **PoWは計算資源で突破される**(14bitは数秒で解ける)。上げればUXが悪化するトレードオフ
- メモリ保持・単一プロセス前提(スケールさせるならRedis等への置き換えが必要)
- メタタグだらけのbooruなので、たまに人間にも変なタグが出題される → 「別の問題にする」で回避

## テスト

```bash
node tools/test_multilayer.mjs        # 多層認証の検証(攻撃シナリオ別)
node tools/captcha_solver_bot.mjs     # 突破ボット(URL隠蔽の効果測定)
node tools/verify_proxy.mjs           # 画像プロキシと漏洩チェック
python tools/make_debug_copy.py       # 正解付きテスト用コピー(:3108)を作る
```

## Docker(デプロイ用)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```
