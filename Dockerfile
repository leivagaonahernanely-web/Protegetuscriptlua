FROM node:22-bookworm-slim

# Toolchain por si better-sqlite3 necesita compilarse, y git/Python para el ofuscador
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-click make g++ \
 && rm -rf /var/lib/apt/lists/*

# Ofuscador 3 = Obscura (CLI local, no se usa su web)
RUN mkdir -p /opt/obfuscators \
 && git clone --depth 1 https://github.com/vo3pal/obscura.git /opt/obfuscators/obscura

# Obscura necesita Python 3.12 (Debian trae 3.11). uv instala el intérprete y crea un venv
# propio para Obscura (el Python gestionado de uv no admite instalar paquetes directamente).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN uv python install 3.12 \
 && uv venv --python 3.12 /opt/obscura-venv \
 && uv pip install --python /opt/obscura-venv/bin/python -r /opt/obfuscators/obscura/requirements.txt

ENV NODE_ENV=production \
    OBFUSCATOR_DIR=/opt/obfuscators \
    OBSCURA_PYTHON=/opt/obscura-venv/bin/python

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
