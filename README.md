# ヒカマニCAPTCHA(単体版)

hikabooru([hikabooru.hikamers.app](https://hikabooru.hikamers.app))の実在画像で出題する**お手本マッチング式CAPTCHA**。
「お手本」の画像を1枚見せて、その下の9枚から**お手本と同じ種類の画像**を全部選んで人間確認する。依存パッケージゼロの単体サービス。

## 起動

```bash
node server.mjs          # http://localhost:3107
PORT=8080 node server.mjs
```

動作確認ページ: http://localhost:3107/ (出題→回答→トークン発行→消費まで実地テストできる)

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/challenge` | 出題 `{id, sampleUrl, tiles:[{id,url}×9]}`(お手本1枚+選択9枚) |
| POST | `/api/verify` | `{id, selected:[tileId...]}` → 正解なら `{ok:true, token}`(ワンタイム・5分) |
| POST | `/api/consume` | `{token}` → 埋め込み先サーバーが登録/投稿前に消費 `{ok:true}` |
| GET | `/api/health` | 生存確認 |
| GET | `/` `/captcha.js` | 動作確認ページ / 埋め込み用ウィジェットJS |

- 誤答は1出題につき3回まで。期限切れ/回数超過は新しい問題に自動で張り替わる
- IPクォータ: 出題+回答あわせ60回/10分(連打・量産抑止。テストで引っかかったらサーバー再起動でリセット)
- CORS: APIは `Access-Control-Allow-Origin: *`(別オリジン埋め込み可)

## 埋め込み方

```html
<div id="captcha"></div>
<script src="https://CAPTCHAサーバーのURL/captcha.js"></script>
<script>
  HikamaniCaptcha.render(document.getElementById("captcha"), {
    apiBase: "https://CAPTCHAサーバーのURL",   // 別オリジンの場合は必須
    onSolved: function (token) { /* 登録ボタンなどを有効化 */ },
  });
</script>
```

サーバー側(登録・投稿API)で、受け付ける前にトークンを**1回だけ消費**する:

```bash
curl -X POST https://CAPTCHAサーバー/api/consume \
  -H "Content-Type: application/json" \
  -d '{"token":"受け取ったトークン"}'
# → {"ok":true} なら人間確認済みとして処理
```

## 出題の仕組み

1. hikabooruのsafe画像(約30,500枚)をランダムなoffset位置から取得
2. その中で3〜5枚に付くタグをお題に選ぶ(メタ/数字/謎タグ/UI語等は機械フィルタで除外)
3. お題タグが付く画像から「お手本」を1枚、タイル用の正解を2〜3枚選ぶ
4. ダミーは同じバッチ内でお題タグが付かない画像
5. **タグ名はクライアントに見せない**。人間はお手本画像と見比べて「同じ種類の画像」を選ぶ
6. 正解情報(どのタイルがお題タグを持つか)はサーバー側のみ保持。クライアントへは画像URLと不透明IDのみ

## 注意・限界

- hikabooruのAPIは公開なので、**APIを逆引きできる本気のボットには解かれる**。用途は量産スクリプトの抑止+コミュニティの遊び
- メタタグだらけのbooruなので、たまに人間にも変なタグが出題される → 「別の問題にする」で回避
- メモリ保持・単一プロセス前提(スケールさせるならRedis等への置き換えが必要)

## Docker(デプロイ用)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```
