# Servicio aparte del asistente. Contexto de build: la raíz del repo.
FROM node:22-bookworm-slim
WORKDIR /app/ai-service
COPY lib /app/lib
COPY ai-service/package.json ./
RUN npm install --omit=dev
COPY ai-service/server.js ai-service/index.html ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
