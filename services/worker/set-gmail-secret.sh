#!/bin/sh
# Puts the worker's Gmail pair (GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET on the
# roybal-worker app) live on Fly in one command, so nothing from the README
# can be pasted as a placeholder, and only together with worker code that
# has the 48-hour email limit. Run it on the Mac from the repo root of an
# up-to-date main:
#
#   cd ~/roybal-restoration-app && git checkout main && git pull
#   sh services/worker/set-gmail-secret.sh
#
# It stages the pair (fly secrets import --stage: set, no restart) and then
# deploys this checkout, so the image already on Fly never restarts with
# email on. An image older than staleEmailReason (adapters/email.mjs) would
# send an approved email days late and file its sent copy under no job, so
# it refuses unless this is the root of a checkout on main that has it.
#
# The client id is public and already in the field app's config
# (apps/field/js/config.js, GMAIL_CLIENT_ID), so it is read from there and
# only the secret is asked for. The secret must belong to that same OAuth
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

set -eu

APP=roybal-worker
CONFIG=apps/field/js/config.js
EMAIL_ADAPTER=services/worker/adapters/email.mjs
FLY_TOML=services/worker/fly.toml
DOCKERFILE=services/worker/Dockerfile
UPDATE='cd ~/roybal-restoration-app && git checkout main && git pull'

say() { printf '%s\n' "$*"; }
die() { printf 'set-gmail-secret: %s\n' "$*" >&2; exit 1; }
not_this_checkout() { die "$1. Run $UPDATE first, then run this again. Nothing was changed."; }

# The deploy below builds from this directory, so check it before fly is
# touched: the repo root, on main, with the worker's 48-hour email limit.
[ -f "$CONFIG" ] || not_this_checkout "this is not the repo root ($CONFIG is not here)"
command -v git >/dev/null 2>&1 \
  || die "git is not installed, so the checkout the deploy builds from cannot be checked. Nothing was changed."
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || TOP=
[ -n "$TOP" ] && [ "$(cd "$TOP" && pwd -P)" = "$(pwd -P)" ] \
  || not_this_checkout "this is not the root of the git checkout"
BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null) || BRANCH=
[ "$BRANCH" = main ] \
  || not_this_checkout "this checkout is on ${BRANCH:-no branch}, not main, and the deploy builds from it"
[ -f "$FLY_TOML" ] && [ -f "$DOCKERFILE" ] && grep -q staleEmailReason "$EMAIL_ADAPTER" 2>/dev/null \
  || not_this_checkout "this checkout's worker predates the 48-hour email limit, so deploying it would send late emails"

if command -v fly >/dev/null 2>&1; then FLY=fly
elif command -v flyctl >/dev/null 2>&1; then FLY=flyctl
else die "the fly command is not installed. Install it (brew install flyctl), run fly auth login, then run this again."
fi

# Before the secret is typed, so it is never pasted only to be thrown away.
"$FLY" auth whoami >/dev/null 2>&1 \
  || die "fly is not logged in (or cannot reach Fly). Run fly auth login, then run this again. Nothing was changed."
# A fly that cannot stage would refuse the flag anyway; say so up front.
"$FLY" secrets import --help 2>&1 | grep -q -- '--stage' \
  || die "this fly is too old to stage secrets (fly secrets import has no --stage). Run brew upgrade flyctl, then run this again. Nothing was changed."

CLIENT_ID=$(sed -n 's/^export const GMAIL_CLIENT_ID = "\([^"]*\)";.*$/\1/p' "$CONFIG" | head -n 1)
[ -n "$CLIENT_ID" ] || die "could not find GMAIL_CLIENT_ID in $CONFIG. Nothing was changed."
printf '%s' "$CLIENT_ID" | grep -Eq '^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$' \
  || die "GMAIL_CLIENT_ID in $CONFIG does not look like a Google OAuth client id. Nothing was changed."

say "This sets the Gmail pair on the Fly app $APP and then deploys the worker from this checkout."
say "Client id (public, from $CONFIG): $CLIENT_ID"
say "The client secret: use the one in the client_secret_….json saved when the client was made,"
say "or make a second one in Google Cloud (that OAuth client, Client secrets, Add secret)."
say "Do NOT reset, disable or delete the existing secret: gmail-proxy uses it and the inbox pull would break."
say ""

# Echo off while the secret is typed or pasted, and back on however this
# exits (done, refused, or Ctrl-C).
STTY_SAVED=
restore_tty() {
  if [ -n "$STTY_SAVED" ]; then stty "$STTY_SAVED" 2>/dev/null || true; STTY_SAVED=; fi
}
trap 'restore_tty' EXIT
trap 'restore_tty; printf "\n"; exit 130' INT TERM HUP
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
printf 'GMAIL_CLIENT_ID=%s\nGMAIL_CLIENT_SECRET=%s\n' "$CLIENT_ID" "$SECRET" \
  | "$FLY" secrets import --stage -a "$APP" \
  || die "fly did not take it (its message is above). Not logged in? Run fly auth login, then run this again."
SECRET=

DEPLOY="$FLY deploy -a $APP --config $FLY_TOML --dockerfile $DOCKERFILE --ha=false ."
say ""
say "Deploying the worker from this checkout, so the pair goes live together with the"
say "48-hour email limit. This takes a few minutes; fly prints its progress:"
say "  $DEPLOY"
"$FLY" deploy -a "$APP" --config "$FLY_TOML" --dockerfile "$DOCKERFILE" --ha=false . \
  || die "the deploy did not finish (its message is above). The pair is staged on $APP, not live yet; it goes live with the next deploy. Run it again from here: $DEPLOY"

say ""
say "Done. What to expect:"
say "- Fly now runs this checkout's worker with email on. To see it took: fly logs -a $APP"
say "  shows a new worker.start line with \"email\":true and \"channels\":[\"sms\",\"email\"],"
say "  and no email.disabled line after it. Or open https://$APP.fly.dev/healthz and look for"
say "  \"channels\":[\"sms\",\"email\"]. The worker's heartbeat reports the same channels within"
say "  30 seconds, which is how the apps learn email is on."
say "- Approved emails waiting in line go out now. Any that waited more than EMAIL_MAX_AGE_HOURS"
say "  (48 by default) are marked dead instead of going out late; the dead-letter text counts them."
say "- A wrong secret still boots. It shows up later in fly logs as outbox.failed with"
say "  \"Gmail token refresh failed\"; run this again with the right one."
