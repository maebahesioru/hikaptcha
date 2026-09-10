FROM node:22-alpine
WORKDIR /app
# ffmpeg: 画像改変(余白付与+再圧縮)に使う。無い場合は改変せず素通し配信になる
RUN apk add --no-cache ffmpeg
COPY package.json server.mjs tag_reject.json ./
COPY public/ ./public/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
