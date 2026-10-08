#!/bin/sh
# Puts the worker's Gmail pair (GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET on the
# roybal-worker app) live on Fly in one command, so nothing from the README
# can be pasted as a placeholder, and only together with worker code that
# has the 48-hour email limit. It is the LAST step of turning email on:
# migration 0019 applied, then roybal-notify deployed ("deploy roybal-notify"
# in the project), then this, on the Mac, from the repo root of an
# up-to-date main:
#
#   cd ~/roybal-restoration-app && git checkout main && git pull
#   sh services/worker/set-gmail-secret.sh
#
# Why roybal-notify first: email on is what makes the morning brief file its
# reminders on the spine and text "Reply YES n" for them, and a roybal-notify
# from before step 5 reads only the text lane's asks. It would answer that
# YES "doesn't match", and a bare YES would run whatever text-lane ask is
# live instead. So before fly is touched it asks the deployed roybal-notify
# (GET …/functions/v1/roybal-notify/version, no key, at the SUPABASE_URL in
# apps/field/js/config.js) and refuses unless it answers HTTP 200 with
# "spine" in its "answers"; the build before step 5 answers any GET 405.
#
# It stages the pair (fly secrets import --stage: set, no restart) and then
# deploys this checkout, so the image already on Fly never restarts with
# email on. The deploy uploads this working tree as it is, so before fly is
# touched it refuses anything but the root of a checkout on main that is
# GitHub's main exactly (git fetch, then HEAD = origin/main: a main older
# than the last worker deploy from GitHub would roll that deploy back), with
# no local changes, untracked files included, in what the image is built
# from (IMAGE_PATHS: services/worker and the four apps/field/js modules the
# Dockerfile copies, and .dockerignore, which picks the build context), and
# with staleEmailReason (adapters/email.mjs):
# an image without it would send an approved email days late and file its
# sent copy under no job.
#
# A staged pair goes live with ANY later restart of the app (a plain
# fly secrets set does one), and a restart keeps the image already on Fly.
# So if the deploy fails, or the run is stopped (Ctrl-C, the window closed)
# once fly has been handed the pair, it takes the pair back out the same
# way (fly secrets unset --stage; unsetting a name Fly does not have is no
# error), or, if that unset fails too, says the pair may still be staged
# and what turns it on. A fly whose unset cannot stage is refused up front.
# An import that fails is taken back out too: fly can fail after Fly took
# the pair (a lost answer, a config file it could not write). Taking the
# pair out never stops a worker already running with email: on a rerun
# that is the pair from the run before, and a deploy that fails after Fly
# started the new image leaves that image (the one with the limit) up with
# email. Either stays on until the worker's next restart, then goes off:
# the safe way round, and what the message says.
#
# The client id is public and already in the field app's config
# (apps/field/js/config.js, GMAIL_CLIENT_ID), so it is read from there and
# only the secret is asked for. It and SUPABASE_URL are read from the commit
# (git show HEAD:…), which the checks make GitHub's main, never from a
# config.js edited on this Mac. The secret must belong to that same OAuth
# client, because the office mailbox's refresh token is bound to it: the
# client_secret_….json saved when the client was made, or a second secret
# made with "Add secret" in Google Cloud. Never reset the existing one;
# gmail-proxy refreshes the office connection with it.
#
# The secret is typed with echo off, never printed, and never on a command
# line (where ps would show it): printf, a shell builtin, hands the pair to
# fly on stdin as NAME=VALUE lines. Every value the worker would refuse at
# boot (config.mjs: < >, quotes, spaces, … or PASTE_) is refused here first:
# a refused value would stop the worker at boot and take the text lane down
# with it.
#
# Exit status: 0 done, 1 refused or failed, 130 stopped.

set -eu

APP=roybal-worker
CONFIG=apps/field/js/config.js
EMAIL_ADAPTER=services/worker/adapters/email.mjs
FLY_TOML=services/worker/fly.toml
DOCKERFILE=services/worker/Dockerfile
# What the image is built from: every COPY source in the Dockerfile, and the
# .dockerignore that picks the build context (test/supa.test.mjs holds this
# list to the Dockerfile's COPY lines).
IMAGE_PATHS='services/worker apps/field/js/reconcile.js apps/field/js/dryingcalc.js apps/field/js/model.js apps/field/js/core.js .dockerignore'
UPDATE='cd ~/roybal-restoration-app && git checkout main && git pull'
RERUN='cd ~/roybal-restoration-app && sh services/worker/set-gmail-secret.sh'

say() { printf '%s\n' "$*"; }
warn() { printf 'set-gmail-secret: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
not_this_checkout() { die "$1. Run $UPDATE first, then run this again. Nothing was changed."; }

# A stop (Ctrl-C, the window closed, a kill) anywhere says so, puts the
# terminal's echo back, and exits 130. STAGED is set from the moment fly is
# handed the pair (maybe: fly may fail, or be stopped, after Fly took it;
# 1: fly said it took it) until the deploy has brought it live; while it is
# set, a failed import, a failed deploy or a stop takes the pair back out
# (unstage) before this exits.
STTY_SAVED=
STAGED=
restore_tty() {
  if [ -n "$STTY_SAVED" ]; then stty "$STTY_SAVED" 2>/dev/null || true; STTY_SAVED=; fi
}
unstage() {
  say "Taking the staged pair back out of $APP (fly secrets unset --stage), so no restart turns it on..."
  if "$FLY" secrets unset --stage -a "$APP" GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET; then
    STAGED=
    warn "took the staged pair back out of $APP, so no restart can turn email on in an older image. If email was already on before this run, or the deploy got far enough to start the new worker, it stays on until the worker's next restart, then goes off. Run this again: $RERUN"
  else
    if [ "$STAGED" = 1 ]; then HOW="is STILL STAGED"; else HOW="may still be staged"; fi
    warn "the pair $HOW on $APP (fly's message is above), not live. Until this script runs through, any fly secrets set or restart of $APP turns email on in the image already on Fly, which may not have the 48-hour limit. Run this again: $RERUN (or, only to take the pair back out: $FLY secrets unset --stage -a $APP GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET)"
  fi
}
stopped() {
  # Whatever fails from here (a closed window takes the terminal with it),
  # say where things stand and take the pair back out; a second Ctrl-C does
  # not cut this short.
  set +e
  trap '' INT TERM HUP
  restore_tty
  printf '\n' >&2
  if [ -n "$STAGED" ]; then
    warn "stopped."
    unstage
  else
    warn "stopped. Nothing was changed."
  fi
  exit 130
}
trap 'restore_tty' EXIT
trap 'stopped' INT TERM HUP

# The deploy below builds from this directory, so check it before fly is
# touched: the repo root, on main, nothing changed locally in what the
# image is built from, GitHub's main as of now (not as of the last pull),
# with the worker's 48-hour email limit.
[ -f "$CONFIG" ] || not_this_checkout "this is not the repo root ($CONFIG is not here)"
command -v git >/dev/null 2>&1 \
  || die "git is not installed, so the checkout the deploy builds from cannot be checked. Nothing was changed."
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || TOP=
[ -n "$TOP" ] && [ "$(cd "$TOP" && pwd -P)" = "$(pwd -P)" ] \
  || not_this_checkout "this is not the root of the git checkout"
BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null) || BRANCH=
[ "$BRANCH" = main ] \
  || not_this_checkout "this checkout is on ${BRANCH:-no branch}, not main, and the deploy builds from it"
# $IMAGE_PATHS unquoted on purpose: one argument per path
CHANGED=$(git status --porcelain --untracked-files=normal -- $IMAGE_PATHS 2>/dev/null) \
  || not_this_checkout "git could not read this checkout's status"
[ -z "$CHANGED" ] \
  || not_this_checkout "this checkout has local changes in services/worker, the field modules its image copies or .dockerignore (git status $IMAGE_PATHS lists them), and the deploy would build them into the image; undo them or get them merged"
git fetch -q origin main \
  || not_this_checkout "git could not fetch main from GitHub (its message is above), so this cannot tell whether this checkout is the latest main"
HEAD_AT=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || HEAD_AT=
MAIN_AT=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) || MAIN_AT=
[ -n "$HEAD_AT" ] && [ "$HEAD_AT" = "$MAIN_AT" ] \
  || not_this_checkout "this checkout is not GitHub's latest main (git fetch just looked), and the deploy would put what it has on Fly"
[ -f "$FLY_TOML" ] && [ -f "$DOCKERFILE" ] && grep -q staleEmailReason "$EMAIL_ADAPTER" 2>/dev/null \
  || not_this_checkout "this checkout's worker predates the 48-hour email limit, so deploying it would send late emails"

# roybal-notify must answer a spine YES before the brief can text one (see
# the top). No key: the function takes requests without one (verify_jwt is
# off), and /version reads nothing.
command -v curl >/dev/null 2>&1 \
  || die "curl is not installed, so this cannot check that roybal-notify is on the step-5 build. Nothing was changed."
# From the commit (GitHub's main, checked above), not the file on disk: a
# config.js edited here could point the check at another project.
COMMITTED_CONFIG=$(git show "HEAD:$CONFIG" 2>/dev/null) \
  || not_this_checkout "git could not read $CONFIG from this checkout's commit"
SUPABASE_URL=$(printf '%s\n' "$COMMITTED_CONFIG" | sed -n 's/^export const SUPABASE_URL = "\([^"]*\)";.*$/\1/p' | head -n 1)
printf '%s' "$SUPABASE_URL" | grep -Eq '^https://[a-z0-9]+\.supabase\.co$' \
  || die "SUPABASE_URL in $CONFIG is not an https://….supabase.co project address, so roybal-notify cannot be checked. Nothing was changed."
VERSION_URL="$SUPABASE_URL/functions/v1/roybal-notify/version"
NOTIFY=$(curl -sS --max-time 10 -w '%{http_code}' "$VERSION_URL") \
  || die "could not reach $VERSION_URL (curl's message is above), so this cannot tell whether roybal-notify is on the step-5 build. Check the internet connection, then run this again. Nothing was changed."
# The body, then the three-digit status -w put after it. Only a 200 whose
# "answers" array holds "spine" counts.
NOTIFY_STATUS=${NOTIFY#"${NOTIFY%???}"}
if [ "$NOTIFY_STATUS" != 200 ] \
  || ! printf '%s\n' "${NOTIFY%???}" | tr -d ' \t\r\n' | grep -Eq '"answers":\[("[^"]*",)*"spine"(,"[^"]*")*\]'; then
  die "roybal-notify isn't on the step-5 build yet. Say \"deploy roybal-notify\" in the project first, then run this again. ($VERSION_URL answered HTTP $NOTIFY_STATUS, not the step-5 answer.) Nothing was changed."
fi

if command -v fly >/dev/null 2>&1; then FLY=fly
elif command -v flyctl >/dev/null 2>&1; then FLY=flyctl
else die "the fly command is not installed. Install it (brew install flyctl), run fly auth login, then run this again."
fi

# Before the secret is typed, so it is never pasted only to be thrown away.
"$FLY" auth whoami >/dev/null 2>&1 \
  || die "fly is not logged in (or cannot reach Fly). Run fly auth login, then run this again. Nothing was changed."
# A fly that cannot stage would refuse the flag anyway; say so up front.
# The way back out after a failed deploy stages too: an unset that cannot
# would restart the image already on Fly, so do not start without it.
"$FLY" secrets import --help 2>&1 | grep -q -- '--stage' \
  || die "this fly is too old to stage secrets (fly secrets import has no --stage). Run brew upgrade flyctl, then run this again. Nothing was changed."
"$FLY" secrets unset --help 2>&1 | grep -q -- '--stage' \
  || die "this fly is too old to take a staged secret back out (fly secrets unset has no --stage). Run brew upgrade flyctl, then run this again. Nothing was changed."

CLIENT_ID=$(printf '%s\n' "$COMMITTED_CONFIG" | sed -n 's/^export const GMAIL_CLIENT_ID = "\([^"]*\)";.*$/\1/p' | head -n 1)
[ -n "$CLIENT_ID" ] || die "could not find GMAIL_CLIENT_ID in $CONFIG. Nothing was changed."
printf '%s' "$CLIENT_ID" | grep -Eq '^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$' \
  || die "GMAIL_CLIENT_ID in $CONFIG does not look like a Google OAuth client id. Nothing was changed."

say "This sets the Gmail pair on the Fly app $APP and then deploys the worker from this checkout."
say "It is the last step of turning email on: migration 0019 applied, roybal-notify deployed"
say "(it answers on the step-5 build, checked just now), then this."
say "Client id (public, from $CONFIG): $CLIENT_ID"
say "The client secret: use the one in the client_secret_….json saved when the client was made,"
say "or make a second one in Google Cloud (that OAuth client, Client secrets, Add secret)."
say "Do NOT reset, disable or delete the existing secret: gmail-proxy uses it and the inbox pull would break."
say ""

# Echo off while the secret is typed or pasted (restore_tty, above, puts it
# back however this exits).
if [ -t 0 ]; then
  STTY_SAVED=$(stty -g)
  stty -echo
fi
printf 'Paste the client secret (it will not show) and press Return: '
SECRET=
read -r SECRET || [ -n "$SECRET" ] || SECRET=
restore_tty
printf '\n'

# The same refusals as config.mjs's placeholder check, plus empty and
# anything that is not plain text.
case "$SECRET" in
  "") die "nothing was entered. Nothing was changed." ;;
  *[[:space:]]*) die "that has a space or a line break in it, so it is not a client secret. Nothing was changed." ;;
  *[\"\']*) die "that has a quote in it, so it is not a client secret (type no quotes). Nothing was changed." ;;
  *[\<\>]*) die "that has < or > in it, so it is a placeholder, not a client secret. Nothing was changed." ;;
  *…*|*PASTE_*) die "that looks like a placeholder (… or PASTE_), not a client secret. Nothing was changed." ;;
esac
# Anything but plain printable ASCII: config.mjs's \s also catches the
# non-breaking spaces a copy from a web page can carry. (printf is a shell
# builtin, so the secret goes down the pipe, never onto a command line.)
if printf '%s' "$SECRET" | LC_ALL=C grep -q '[^!-~]'; then
  die "that has a character that is not plain text (a hidden space from the copy?). Copy it again. Nothing was changed."
fi

case "$SECRET" in
  GOCSPX-*) ;;
  *)
    say "Heads up: Google client secrets start with GOCSPX-, and this one does not."
    say "It may be the client id, or part of the secret got cut off."
    printf 'Set it anyway? [y/N] '
    ANSWER=
    read -r ANSWER || true
    case "$ANSWER" in
      y|Y|yes|Yes|YES) ;;
      *) die "stopped. Nothing was changed." ;;
    esac
    ;;
esac

say "Staging GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (hidden) on $APP, without a restart..."
STAGED=maybe
printf 'GMAIL_CLIENT_ID=%s\nGMAIL_CLIENT_SECRET=%s\n' "$CLIENT_ID" "$SECRET" \
  | "$FLY" secrets import --stage -a "$APP" \
  || { warn "fly may not have taken the pair (its message is above). Not logged in? Run fly auth login."; unstage; exit 1; }
STAGED=1
SECRET=

DEPLOY="$FLY deploy -a $APP --config $FLY_TOML --dockerfile $DOCKERFILE --ha=false ."
say ""
say "Deploying the worker from this checkout, so the pair goes live together with the"
say "48-hour email limit. This takes a few minutes; fly prints its progress:"
say "  $DEPLOY"
if ! "$FLY" deploy -a "$APP" --config "$FLY_TOML" --dockerfile "$DOCKERFILE" --ha=false .; then
  warn "the deploy did not finish (its message is above)."
  unstage
  exit 1
fi
# Live with this checkout's worker: nothing to take back out any more.
STAGED=

say ""
say "Done. What to expect:"
say "- Fly now runs this checkout's worker with email on. To see it took: fly logs -a $APP"
say "  shows a new worker.start line with \"email\":true and \"channels\":[\"sms\",\"email\",\"qbo\"],"
say "  and no email.disabled line after it. Or open https://$APP.fly.dev/healthz and look for"
say "  \"channels\":[\"sms\",\"email\",\"qbo\"] (no \"qbo\" while RECEIPTS_QBO=off). The worker's"
say "  heartbeat reports the same channels within 30 seconds, which is how the apps learn email is on."
say "- Approved emails waiting in line go out now. Any that waited more than EMAIL_MAX_AGE_HOURS"
say "  (48 by default) are marked dead instead of going out late; the dead-letter text counts them."
say "- A wrong secret still boots. It shows up later in fly logs as outbox.failed with"
say "  \"Gmail token refresh failed\"; run this again with the right one."
