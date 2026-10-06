#!/bin/sh
# Sets the worker's Gmail pair on Fly (GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET
# on the roybal-worker app) in one command, so nothing from the README can be
# pasted as a placeholder. Run it from the repo root on the Mac:
#
#   sh services/worker/set-gmail-secret.sh
#
# The client id is public and already in the field app's config
# (apps/field/js/config.js, GMAIL_CLIENT_ID), so it is read from there and
# only the secret is asked for. The secret must belong to that same OAuth
# client, because the office mailbox's refresh token is bound to it: the
# client_secret_….json saved when the client was made, or a second secret
# made with "Add secret" in Google Cloud. Never reset the existing one;
# gmail-proxy refreshes the office connection with it.
#
# The secret is typed with echo off and never printed. Every value the
# worker would refuse at boot (config.mjs: < >, quotes, spaces, … or PASTE_)
# is refused here first: a refused value would stop the worker at boot and
# take the text lane down with it.

set -eu

APP=roybal-worker
CONFIG=apps/field/js/config.js

say() { printf '%s\n' "$*"; }
die() { printf 'set-gmail-secret: %s\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "run this from the repo root (cd ~/roybal-restoration-app first) so $CONFIG is found. Nothing was changed."

if command -v fly >/dev/null 2>&1; then FLY=fly
elif command -v flyctl >/dev/null 2>&1; then FLY=flyctl
else die "the fly command is not installed. Install it (brew install flyctl), run fly auth login, then run this again."
fi

# Before the secret is typed, so it is never pasted only to be thrown away.
"$FLY" auth whoami >/dev/null 2>&1 \
  || die "fly is not logged in (or cannot reach Fly). Run fly auth login, then run this again. Nothing was changed."

CLIENT_ID=$(sed -n 's/^export const GMAIL_CLIENT_ID = "\([^"]*\)";.*$/\1/p' "$CONFIG" | head -n 1)
[ -n "$CLIENT_ID" ] || die "could not find GMAIL_CLIENT_ID in $CONFIG. Nothing was changed."
printf '%s' "$CLIENT_ID" | grep -Eq '^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$' \
  || die "GMAIL_CLIENT_ID in $CONFIG does not look like a Google OAuth client id. Nothing was changed."

say "This sets the Gmail pair on the Fly app $APP."
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

say "Setting GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (hidden) on $APP..."
"$FLY" secrets set -a "$APP" "GMAIL_CLIENT_ID=$CLIENT_ID" "GMAIL_CLIENT_SECRET=$SECRET" \
  || die "fly did not take it (its message is above). Not logged in? Run fly auth login, then run this again."
SECRET=

say ""
say "Done. What happens next:"
say "- Fly restarts the worker machine on its own within a minute or two; no deploy is needed."
say "- To see it took: fly logs -a $APP shows a new worker.start line with \"email\":true and"
say "  \"channels\":[\"sms\",\"email\"], and no email.disabled line after it. Or open"
say "  https://$APP.fly.dev/healthz and look for \"channels\":[\"sms\",\"email\"]. The worker's"
say "  heartbeat reports the same channels within 30 seconds, which is how the apps learn email is on."
say "- Approved emails waiting in line go out now. Any that waited more than EMAIL_MAX_AGE_HOURS"
say "  (48 by default) are marked dead instead of going out late; the dead-letter text counts them."
say "- A wrong secret still boots. It shows up later in fly logs as outbox.failed with"
say "  \"Gmail token refresh failed\"; run this again with the right one."
