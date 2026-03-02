FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

COPY data/property.json data/tile_catalog.json ./data/

ENV NODE_ENV=production
ENV PORT=4242
ENV HOST=0.0.0.0

EXPOSE 4242

CMD ["node", "server.js"]
