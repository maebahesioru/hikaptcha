# テスト用デバッグコピーを作る(正解タイルを payload に含める)
# 本番 server.mjs にはバックドアを入れない。テスト専用ディレクトリにだけパッチする。
import os, shutil

ROOT = "C:/Users/maeba/Desktop/hikamani-captcha"
DST = "C:/Users/maeba/AppData/Local/Temp/vtest2"

if os.path.exists(DST):
    shutil.rmtree(DST)
os.makedirs(os.path.join(DST, "public"))

shutil.copy(os.path.join(ROOT, "server.mjs"), DST)
for name in os.listdir(os.path.join(ROOT, "public")):
    shutil.copy(os.path.join(ROOT, "public", name), os.path.join(DST, "public", name))

p = os.path.join(DST, "server.mjs")
s = open(p, encoding="utf-8").read()

old = "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}` })),"
new = "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}`, target: t.target })),"
assert old in s, "challenge payload pattern not found"
s = s.replace(old, new)

# デバッグコピーはポート3108
s = s.replace('const PORT = Number(process.env.PORT || 3107);', 'const PORT = Number(process.env.PORT || 3108);')

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("debug copy ready at", DST)
