# Roybal worker — build from the REPO ROOT so the shared files ride in at the
# same relative paths the imports use (the phone agent's pattern):
#   fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
FROM node:22-slim
WORKDIR /app

# the billing check's detector and the field modules it loads
# (lanes/billing.mjs → reconcile.js → dryingcalc.js + model.js → core.js,
# and scans.js, which imports nothing; none imports anything else). The root
# .dockerignore lets exactly these five out of apps/field. No package.json
# comes with them: node 22 reads their import/export as ES modules, as the
# phone agent's schedule.js is read.
COPY apps/field/js/reconcile.js apps/field/js/reconcile.js
COPY apps/field/js/dryingcalc.js apps/field/js/dryingcalc.js
COPY apps/field/js/model.js apps/field/js/model.js
COPY apps/field/js/core.js apps/field/js/core.js
COPY apps/field/js/scans.js apps/field/js/scans.js

COPY services/worker services/worker
WORKDIR /app/services/worker
# No npm dependencies: the worker talks to Supabase, Twilio and Gmail over
# fetch. Nothing to install, nothing to audit, nothing to drift.

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
