# Roybal worker — build from the REPO ROOT so the shared files ride in at the
# same relative paths the imports use (the phone agent's pattern):
#   fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
FROM node:22-slim
WORKDIR /app

# The field modules the worker loads, at the paths its imports use:
#   the billing check: lanes/billing.mjs → reconcile.js → dryingcalc.js and
#     model.js → core.js, and scans.js, which imports nothing;
#   the carrier packet: packet/model.mjs → model.js, scans.js, core.js,
#     dryingcalc.js, fincalc.js, completeness.js (→ model.js), media.js,
#     thumbs.js (→ media.js) and meterphotos.js (→ core.js, model.js,
#     merge.js → thumbs.js); packet/pdfdoc.mjs → photopdf.js; dryingwatch.js
#     (→ scans.js) is named for it by the design.
# The root .dockerignore lets exactly these out of apps/field, and
# test/packaging.test.mjs walks the worker's imports and fails on any file
# this image would not hold. No package.json comes with them: node 22 reads
# their import/export as ES modules, as the phone agent's schedule.js is read.
COPY apps/field/js/reconcile.js apps/field/js/reconcile.js
COPY apps/field/js/dryingcalc.js apps/field/js/dryingcalc.js
COPY apps/field/js/model.js apps/field/js/model.js
COPY apps/field/js/core.js apps/field/js/core.js
COPY apps/field/js/scans.js apps/field/js/scans.js
COPY apps/field/js/dryingwatch.js apps/field/js/dryingwatch.js
COPY apps/field/js/meterphotos.js apps/field/js/meterphotos.js
COPY apps/field/js/merge.js apps/field/js/merge.js
COPY apps/field/js/thumbs.js apps/field/js/thumbs.js
COPY apps/field/js/media.js apps/field/js/media.js
COPY apps/field/js/fincalc.js apps/field/js/fincalc.js
COPY apps/field/js/completeness.js apps/field/js/completeness.js
COPY apps/field/js/photopdf.js apps/field/js/photopdf.js

# services/worker whole: server, lanes, adapters, and packet/ (the PDF writer,
# the document model, the renderer and the recipient pick).
COPY services/worker services/worker
WORKDIR /app/services/worker
# No npm dependencies: the worker talks to Supabase, Twilio and Gmail over
# fetch. Nothing to install, nothing to audit, nothing to drift.

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
