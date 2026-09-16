# テスト用デバッグコピーを作る(正解タイル・元URLを payload に含める)
#
# 方針: 本番 server.mjs には一切バックドアを入れない。
#       テスト専用ディレクトリにコピーしてから、そこだけにパッチを当てる。
#       パッチは「サーバー側の実装を変えたら壊れる」ので、assert で必ず検知する。
#       (実測: checkQuota を書き換えたときにアンカーが外れて気づけた)
import os
import shutil

ROOT = "C:/Users/maeba/Desktop/hikamani-captcha"
DST = "C:/Users/maeba/AppData/Local/Temp/vtest2"

if os.path.exists(DST):
    shutil.rmtree(DST)
os.makedirs(os.path.join(DST, "public"))

shutil.copy(os.path.join(ROOT, "server.mjs"), DST)
# 品詞判定の除外リストも一緒にコピー(サーバーが起動時に読む)
shutil.copy(os.path.join(ROOT, "tag_reject.json"), DST)
# server.mjs が import する lib/ も必要(/docs のレンダラ)。
# 忘れると ERR_MODULE_NOT_FOUND でデバッグコピーが起動しない(実測で踏んだ)。
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(DST, "lib"))
for name in os.listdir(os.path.join(ROOT, "public")):
    shutil.copy(os.path.join(ROOT, "public", name), os.path.join(DST, "public", name))

p = os.path.join(DST, "server.mjs")
s = open(p, encoding="utf-8").read()


def patch_once(text, old, new, label):
    """1回だけ置換する。見つからなければ何が変わったか分かる形で落とす。"""
    assert old in text, f"{label}: パターンが見つかりません(server.mjs側の変更に追随が必要)"
    assert text.count(old) == 1, f"{label}: パターンが複数箇所に一致しました"
    return text.replace(old, new)


# 1) 正解タイル・元URL・タグ・投稿者を payload に追加
#    検証スクリプトが答え合わせ・改変効果の測定・多様性の実測に使う
s = patch_once(
    s,
    "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}` })),",
    "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}`, "
    "target: t.target, rot: t.rot || 0, originalUrl: t.url, tags: [...t.tags], src: t.src, postId: t.postId })),",
    "チャレンジpayload",
)

# 2) 500 の内容を応答に含める(原因追跡用。ログが取りにくい環境でも一発で分かる)
s = patch_once(
    s,
    'res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました" }));',
    'res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました", debug: String(err && err.stack || err) }));',
    "500ハンドラ",
)

# 3) レート制限が有効なとき、どのIPでどう判定したかを /api/health から見られるようにする
s = patch_once(
    s,
    "  const ip = clientIp(req);\n  const now = Date.now();\n  let b = ipCounts.get(ip);",
    '  const ip = clientIp(req);\n'
    '  stats.lastQuota = { ip, remote: req.socket && req.socket.remoteAddress, '
    'xff: req.headers["x-forwarded-for"] || null, xri: req.headers["x-real-ip"] || null };\n'
    "  const now = Date.now();\n  let b = ipCounts.get(ip);",
    "checkQuota診断",
)

# 4) デバッグコピーの既定ポートは3108(env PORT が指定されればそちらが優先)
s = s.replace(
    "const PORT = Number(process.env.PORT || 3107);",
    "const PORT = Number(process.env.PORT || 3108);",
)

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("debug copy ready at", DST)
