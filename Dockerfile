FROM node:22-bookworm-slim

# Lua para los ofuscadores (Prometheus usa 5.1, Hercules usa 5.4) y toolchain
# por si better-sqlite3 necesita compilarse.
RUN apt-get update \
 && apt-get install -y --no-install-recommends lua5.1 lua5.4 git ca-certificates python3 python3-click make g++ \
 && rm -rf /var/lib/apt/lists/*

# Ofuscador 1 = Prometheus, Ofuscador 2 = Hercules (CLIs locales, no se usa su web)
RUN mkdir -p /opt/obfuscators \
 && git clone --depth 1 https://github.com/prometheus-lua/Prometheus.git /opt/obfuscators/prometheus \
 && git clone --depth 1 https://github.com/zeusssz/hercules-obfuscator.git /opt/obfuscators/hercules \
 && git clone --depth 1 https://github.com/vo3pal/obscura.git /opt/obfuscators/obscura

# Obscura necesita Python 3.12 (Debian trae 3.11). uv instala el intérprete y las dependencias.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN uv python install 3.12 \
 && ln -s "$(uv python find 3.12)" /usr/local/bin/python312 \
 && uv pip install --python /usr/local/bin/python312 -r /opt/obfuscators/obscura/requirements.txt

ENV NODE_ENV=production \
    OBFUSCATOR_DIR=/opt/obfuscators

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
