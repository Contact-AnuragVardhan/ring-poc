FROM node:20-bullseye

ENV TZ=UTC
RUN apt-get update && apt-get install -y \
    --no-install-recommends ffmpeg \
    python3 python3-pip python3-setuptools python3-wheel \
    build-essential pkg-config \
    libssl-dev \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY build-client.js ./build-client.js
RUN npm install

# Workaround: Meson "Clock skew detected" during mediasoup-worker build in Docker/WSL2.
# Touch everything in mediasoup worker tree after install, so timestamps are not "future".
RUN if [ -d node_modules/mediasoup/worker ]; then \
      find node_modules/mediasoup/worker -type f -exec touch {} + ; \
    fi

COPY server.js ./server.js
COPY ring-control.js ./ring-control.js
COPY server-ingest.js ./server-ingest.js
COPY public ./public

RUN npm run build:client

EXPOSE 3000
CMD ["npm", "run", "start:ingest"]
#CMD ["npm", "start"]
