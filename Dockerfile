FROM node:22-bookworm-slim

# Toolchain por si better-sqlite3 necesita compilarse, y git/Python para el ofuscador
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-pip python3-click make g++ cmake \
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

# Ofuscador RealObfuscator (Rust, GPL-3.0, modo VM): se compila el binario desde su repo.
RUN (git clone --depth 1 https://github.com/linkoro57/RealObfuscator.git /opt/obfuscators/real \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && . "$HOME/.cargo/env" && cd /opt/obfuscators/real && cargo build --release) \
 || echo "[build] RealObfuscator no compilado: el ofuscador queda no disponible"

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
# Las dependencias quedan en /app/node_modules: backend y admin las resuelven igual.
# El directorio de trabajo sigue siendo /app (la base de datos y 'node admin/server.js' no cambian).
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend ./backend
COPY frontend ./frontend
COPY admin ./admin

# Ofuscador 4 (NextOfuscator): es la única fuente del motor. Se compila desde vanta-vs-protector en cada build
# y se deja en backend/lib/nextofuscator (que no está en el repo). Si la compilación falla, el build falla:
# Railway conserva el deploy anterior y nunca se sirve una versión vieja del motor sin aviso.
# El ADD usa la API de GitHub: cambia cuando entra un commit nuevo, así Docker no reutiliza una versión vieja de la caché.
ADD https://api.github.com/repos/leivagaonahernanely-web/vanta-vs-protector/commits/main /tmp/nextofuscator-rev.json
RUN git clone --depth 1 https://github.com/leivagaonahernanely-web/vanta-vs-protector.git /opt/nextofuscator-src \
 && mkdir -p /opt/nxbuild && cd /opt/nxbuild && npm install --no-save --silent typescript@5.9.3 @types/node@24 \
 && cd /opt/nextofuscator-src \
 && printf '%s' '{"compilerOptions":{"outDir":"/opt/nx-out","rootDir":"/opt/nextofuscator-src/server/obfuscator","module":"es2022","target":"es2022","moduleResolution":"bundler","skipLibCheck":true,"typeRoots":["/opt/nxbuild/node_modules/@types"],"types":["node"]},"files":["/opt/nextofuscator-src/server/obfuscator/build.ts"]}' > /opt/nx.tsconfig.json \
 && (/opt/nxbuild/node_modules/.bin/tsc -p /opt/nx.tsconfig.json || true) \
 && test -f /opt/nx-out/build.js \
 && sed -i -E 's#from "(\./[a-z]+)"#from "\1.js"#g' /opt/nx-out/*.js \
 && mkdir -p /app/backend/lib/nextofuscator \
 && cp /opt/nx-out/*.js /app/backend/lib/nextofuscator/ \
 && echo "[build] NextOfuscator compilado desde vanta-vs-protector: $(git -C /opt/nextofuscator-src rev-parse --short HEAD)"

EXPOSE 3000
CMD ["node", "backend/server.js"]
