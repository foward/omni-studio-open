# OmniStudio — container image for Google Cloud (Cloud Run / GCE / GKE)
# FFmpeg is installed in the image, so all the joining/encoding works in the cloud.
FROM node:22-bookworm-slim

# FFmpeg + fonts (drawtext title cards) + zip (publish packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fonts-dejavu-core zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Cloud Run injects PORT; the app already reads process.env.PORT
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
