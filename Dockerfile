FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs public/ ./public/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
