FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY service.js ./

# Cloud Run injects PORT; default for local docker runs
ENV PORT=8787
EXPOSE 8787

CMD ["node", "service.js"]
