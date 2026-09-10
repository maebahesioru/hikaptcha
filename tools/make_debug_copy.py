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
new = "tiles: c.tiles.map((t) => ({ id: t.id, url: `${base}/api/img/${t.imgId}`, target: t.target, originalUrl: t.url })),"
assert old in s, "challenge payload pattern not found"
s = s.replace(old, new)

# デバッグコピーだけ: 配信画像に余白率をヘッダで付ける(検証スクリプトが内容保持を測るため)
old_pad = '''  const pad = PAD_PCT_MIN + Math.random() * Math.max(0, PAD_PCT_MAX - PAD_PCT_MIN);
  const dark = () => Math.floor(Math.random() * 90);
  const bg = `0x${dark().toString(16).padStart(2, "0")}${dark().toString(16).padStart(2, "0")}${dark().toString(16).padStart(2, "0")}`;
  filters.push(`pad=iw+2*iw*${(pad / 100).toFixed(3)}:ih+2*ih*${(pad / 100).toFixed(3)}:iw*${(pad / 100).toFixed(3)}:ih*${(pad / 100).toFixed(3)}:${bg}`);'''
new_pad = '''  const pad = PAD_PCT_MIN + Math.random() * Math.max(0, PAD_PCT_MAX - PAD_PCT_MIN);
  LAST_PAD = pad; // デバッグ用: 検証スクリプトが余白率を知るため
  const dark = () => Math.floor(Math.random() * 90);
  const bg = `0x${dark().toString(16).padStart(2, "0")}${dark().toString(16).padStart(2, "0")}${dark().toString(16).padStart(2, "0")}`;
  filters.push(`pad=iw+2*iw*${(pad / 100).toFixed(3)}:ih+2*ih*${(pad / 100).toFixed(3)}:iw*${(pad / 100).toFixed(3)}:ih*${(pad / 100).toFixed(3)}:${bg}`);'''
assert old_pad in s, "pad block not found"
s = s.replace(old_pad, new_pad)

# LAST_PAD 変数の宣言とヘッダ出力
s = s.replace("let tmpSeq = 0;", "let tmpSeq = 0;\nlet LAST_PAD = 0; // デバッグ用(直近の改変で使った余白率)")
old_hdr = '''      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=300",
        "access-control-allow-origin": "*",
        "x-hkc-transformed": transformed ? "1" : "0",
      });'''
new_hdr = '''      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=300",
        "access-control-allow-origin": "*",
        "x-hkc-transformed": transformed ? "1" : "0",
        "x-hkc-pad": String(LAST_PAD),
      });'''
assert old_hdr in s, "header block not found"
s = s.replace(old_hdr, new_hdr)

# デバッグコピーはポート3108
s = s.replace('const PORT = Number(process.env.PORT || 3107);', 'const PORT = Number(process.env.PORT || 3108);')

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("debug copy ready at", DST)
