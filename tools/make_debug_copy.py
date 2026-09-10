# テスト用デバッグコピーを作る(正解タイル・元URLを payload に含める)
# 本番 server.mjs にはバックドアを入れない。テスト専用ディレクトリにだけパッチする。
import os, shutil

ROOT = "C:/Users/maeba/Desktop/hikamani-captcha"
DST = "C:/Users/maeba/AppData/Local/Temp/vtest2"

if os.path.exists(DST):
    shutil.rmtree(DST)
os.makedirs(os.path.join(DST, "public"))

shutil.copy(os.path.join(ROOT, "server.mjs"), DST)
# 品詞判定の除外リストも一緒にコピー(サーバーが読む)
shutil.copy(os.path.join(ROOT, "tag_reject.json"), DST)
for name in os.listdir(os.path.join(ROOT, "public")):
    shutil.copy(os.path.join(ROOT, "public", name), os.path.join(DST, "public", name))

p = os.path.join(DST, "server.mjs")
s = open(p, encoding="utf-8").read()

# 1) 正解タイルと元URLを payload に追加(検証スクリプトが答え合わせ・改変効果の測定に使う)
old = "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}` })),"
new = "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}`, target: t.target, originalUrl: t.url, tags: [...t.tags], src: t.src, postId: t.postId })),"
assert old in s, "challenge payload pattern not found"
s = s.replace(old, new)

# 2) 例外の内容を応答に含める(テスト専用。原因追跡のため)
old2 = 'res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました" }));'
new2 = 'res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました", debug: String(err && err.stack || err) }));'
assert old2 in s, "500 handler pattern not found"
s = s.replace(old2, new2)

# 2b) 429 のときに「どのIPでどう判定したか」を応答に含める(テスト専用)
old3 = '''    { error: `リクエストが多すぎます。あと約${sec}秒で再開できます`, retryAfterMs, retryAfterSec: sec },'''
new3 = '''    { error: `リクエストが多すぎます。あと約${sec}秒で再開できます`, retryAfterMs, retryAfterSec: sec },'''
assert old3 in s, "429 body pattern not found"

# 2b) 429時に「どのIPでどう判定したか」を記録して /api/health から見られるようにする(テスト専用)
old3 = 'function checkQuota(req) {\n  if (isExemptRequest(req)) return { ok: true, remaining: Infinity, retryAfterMs: 0, exempt: true };'
new3 = '''function checkQuota(req) {
  if (isExemptRequest(req)) return { ok: true, remaining: Infinity, retryAfterMs: 0, exempt: true };
  stats.lastQuota = { ip: clientIp(req), remote: req.socket && req.socket.remoteAddress, xff: req.headers["x-forwarded-for"] || null, xri: req.headers["x-real-ip"] || null };'''
assert old3 in s, "checkQuota pattern not found"
s = s.replace(old3, new3)

# 2) デバッグコピーはポート3108
s = s.replace('const PORT = Number(process.env.PORT || 3107);', 'const PORT = Number(process.env.PORT || 3108);')

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("debug copy ready at", DST)
