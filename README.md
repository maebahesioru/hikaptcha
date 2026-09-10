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

1. hikabooruのsafe画像(約30,500枚)を**ランダムなoffset位置**から24枚取得(出題のバラエティを担保)
2. その中で**2〜3枚に付くタグ**をお題候補に。ただし**`allowed_tags.json`に載っているタグだけ**
3. 正解=お題タグが付く画像(2〜3枚) / ダミー=同じバッチ内でお題タグが付かない画像
4. 正解情報(どのタイルがお題タグを持つか)はサーバー側のみ保持。クライアントへは画像URLと不透明IDのみ
5. 直近60件で使ったタグは避ける(同じタグが続かない)

### allowed_tags.json とは

hikabooruのタグはAIによる一括付与が大半で、造語(ポヴ/バウティー/グッキ)・文の断片(黒地に)・
メタ語(ロー・レス/クローズアップ)・動作性名詞(変換/送信)が大量に混ざる。名前を見ても人間には判別できない。

そこで **hikabooruの全タグ(usages>=10, 10,806件)を日本語辞書で機械的に検証**し、
「画像を見て判別できる一般名詞」だけを残したリスト(現在380件):

- **JMdict(EDICT)の常用名詞**に載っている(造語・謎タグを排除)
- **UniDic**で単独形態素なら「名詞/普通名詞/一般」と判定される
  → サ変可能名詞(変換/編集/送信)・形状詞可能名詞(安全/透明/最新)・固有名詞(人名/地名/年号)を排除
- 構造フィルタ(数字/記号/括弧/空白/長さ/助詞終端/「の」入り)
- 手動ブラックリスト(範囲が広すぎる語・抽象語・成人向け)

**手選定ではなく辞書から自動生成**したリスト。再生成は:

```bash
# 1) JMdictを取得して辞書セットを作る(常用名詞 / 全名詞)
#    http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz を解凍し tools/build_vocab.py の SRC を合わせて実行
# 2) hikabooruの全タグを辞書+POSで検証して allowed_tags.json を生成
python tools/build_allowlist.py
```

辞書で拾えない「判別しやすいタグ」(例: お椀)を増やしたい場合は
`tools/tag_blacklist.json` の調整か、辞書側(JMdict)を増強する。

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
