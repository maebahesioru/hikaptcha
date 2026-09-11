FROM node:22-alpine
WORKDIR /app
# ffmpeg: 画像改変(余白付与+再圧縮)に使う。無い場合は改変せず素通し配信になる
RUN apk add --no-cache ffmpeg
COPY package.json server.mjs tag_reject.json ./
COPY public/ ./public/
# server.mjs が ./lib/docs.mjs を import しているので必須(無いと起動時にERR_MODULE_NOT_FOUND)
COPY lib/ ./lib/
# lib/docs.mjs が実行時に README.md を読んで /docs を描画する(無いと /docs が500)
COPY README.md ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
