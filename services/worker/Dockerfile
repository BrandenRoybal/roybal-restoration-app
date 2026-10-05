# Roybal worker — build from the REPO ROOT so a later phase can COPY shared
# files at the same relative paths the imports use (the phone agent's pattern):
#   fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
FROM node:22-slim
WORKDIR /app

COPY services/worker services/worker
WORKDIR /app/services/worker
# No npm dependencies: the worker talks to Supabase, Twilio and Gmail over
# fetch. Nothing to install, nothing to audit, nothing to drift.

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
