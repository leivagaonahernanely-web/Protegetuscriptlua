FROM node:22-bookworm-slim

# Toolchain por si better-sqlite3 necesita compilarse, y git/Python para el ofuscador
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-click make g++ cmake \
 && rm -rf /var/lib/apt/lists/*

# Ofuscadores 1 y 2 (CLI locales, no se usan sus webs)
# Ofuscador 1 = Clyde (Node/TypeScript). Necesita devDependencies para compilar, por eso no usa --omit=dev.
RUN mkdir -p /opt/obfuscators \
 && git clone --depth 1 https://github.com/sfr-development/Lua-Obfuscator-Clyde-Protection.git /opt/obfuscators/clyde \
 && cd /opt/obfuscators/clyde \
 && (for i in 1 2 3; do npm ci && break; sleep 5; done) \
 && (npm run build || test -f dist/cli/obfuscate.js)

# Compilador de Luau para validar la sintaxis antes de guardar. Es opcional: si no compila, el servidor no valida.
RUN (git clone --depth 1 https://github.com/luau-lang/luau.git /opt/luau \
 && cmake -S /opt/luau -B /opt/luau/build -DCMAKE_BUILD_TYPE=Release >/dev/null \
 && cmake --build /opt/luau/build --target Luau.Compile -j2 >/dev/null \
 && find /opt/luau/build -maxdepth 2 -name 'luau-compile' -type f -exec cp {} /usr/local/bin/luau-compile \;) \
 || echo "[build] luau-compile no disponible: sin validación de sintaxis"

# Ofuscador 2 = Obscura
RUN git clone --depth 1 https://github.com/vo3pal/obscura.git /opt/obfuscators/obscura

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
