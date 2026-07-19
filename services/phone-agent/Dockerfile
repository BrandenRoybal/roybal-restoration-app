# Roybal phone agent — build from the REPO ROOT so the shared files ride in
# at the same relative paths the imports use:
#   fly deploy --config services/phone-agent/fly.toml --dockerfile services/phone-agent/Dockerfile .
FROM node:22-slim
WORKDIR /app

# the one-brain registry + the board's pure scheduling engine (server-shared)
COPY supabase/functions/roybal-ai-office/personas.ts supabase/functions/roybal-ai-office/personas.ts
COPY apps/board/js/schedule.js apps/board/js/schedule.js

COPY services/phone-agent services/phone-agent
WORKDIR /app/services/phone-agent
RUN npm install --omit=dev

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "server.mjs"]
