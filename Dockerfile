FROM node:20-alpine

WORKDIR /app

# sqlite3 native modülü için prebuilt binary indirilemezse kaynaktan derlenebilsin
# diye geçici build araçları; kurulum bitince temizlenir (imaj şişmesin).
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY . .

ENV NODE_ENV=production
ENV PORT=5400
EXPOSE 5400

CMD ["node", "server.js"]
