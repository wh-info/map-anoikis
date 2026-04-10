# Minimal production image for the Anoikis fan-out worker.
# Railway builds from this; local dev uses `npm run dev` directly.
FROM node:20-alpine

WORKDIR /app

# Copy manifest first so the install layer caches across code changes.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
