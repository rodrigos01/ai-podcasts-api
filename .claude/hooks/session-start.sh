#!/bin/bash
set -euo pipefail

# GOOGLE_APPLICATION_CREDENTIALS_BASE64 (a base64-encoded GCP service account
# key, set as an environment variable in the Claude Code cloud environment
# settings) is only ever injected into the `claude` process's own
# environment -- never into the container entrypoint, environment-manager,
# or any "environment setup script" that runs before `claude` starts. So
# decoding it has to happen here, in a SessionStart hook, not in the
# environment's setup script.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install the gcloud CLI so deploy scripts (npm run deploy-source*) work out
# of the box. Idempotent -- skips if already installed from a prior resume of
# this same container (its filesystem persists across resumes).
#
# apt's Google Cloud SDK repo (packages.cloud.google.com) and the official
# installer (dl.google.com) are both blocked by this sandbox's egress proxy,
# but storage.googleapis.com -- which actually hosts the release tarballs --
# is reachable, so fetch from there directly and skip install.sh entirely
# (it only wires up optional components/completions via dl.google.com, which
# the bundled `gcloud` binary doesn't need to run).
if ! command -v gcloud >/dev/null 2>&1 && [ ! -x /opt/google-cloud-sdk/bin/gcloud ]; then
  GCLOUD_TARBALL="$(mktemp -u)/google-cloud-cli.tar.gz"
  mkdir -p "$(dirname "$GCLOUD_TARBALL")"
  if curl -fsSL -o "$GCLOUD_TARBALL" "https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-linux-x86_64.tar.gz"; then
    tar -xzf "$GCLOUD_TARBALL" -C /opt
    rm -rf "$(dirname "$GCLOUD_TARBALL")"
    ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
    ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil
  else
    echo "Could not download gcloud CLI (storage.googleapis.com unreachable?), skipping" >&2
  fi
fi

if [ -z "${GOOGLE_APPLICATION_CREDENTIALS_BASE64:-}" ]; then
  echo "GOOGLE_APPLICATION_CREDENTIALS_BASE64 not set, skipping GCP credential setup" >&2
  exit 0
fi

CRED_DIR="${HOME}/credentials"
CRED_FILE="${CRED_DIR}/service-account.json"

mkdir -p "$CRED_DIR"
chmod 700 "$CRED_DIR"

# -d works on GNU coreutils, -D on macOS/BSD base64
printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS_BASE64" \
  | base64 --decode > "$CRED_FILE" 2>/dev/null \
  || printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS_BASE64" | base64 -D > "$CRED_FILE"

chmod 600 "$CRED_FILE"

if ! grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$CRED_FILE"; then
  echo "Decoded content doesn't look like a service account key" >&2
  exit 1
fi

# Persist for the rest of this Claude Code session -- plain `export` here
# would only live in this hook's own process and vanish immediately.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export GOOGLE_APPLICATION_CREDENTIALS=\"$CRED_FILE\"" >> "$CLAUDE_ENV_FILE"
fi

# Belt-and-suspenders: also write it to backend/.env, which the app's own
# dotenv loader reads fresh on every `node server.js` start regardless of
# which shell or process launched it.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/backend/package.json" ]; then
  ENV_FILE="$CLAUDE_PROJECT_DIR/backend/.env"
  touch "$ENV_FILE"
  grep -v '^GOOGLE_APPLICATION_CREDENTIALS=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "GOOGLE_APPLICATION_CREDENTIALS=$CRED_FILE" >> "$ENV_FILE"
fi

echo "GOOGLE_APPLICATION_CREDENTIALS=$CRED_FILE"

# Some sandboxes set a placeholder CLOUDSDK_AUTH_ACCESS_TOKEN for their own
# proxied Google API calls; gcloud prefers that over an activated service
# account, which breaks auth against this project. deploy-source-helper.js
# clears it for its own gcloud calls, but activate the account here too so
# ad-hoc `gcloud` commands in the session work without that workaround.
if command -v gcloud >/dev/null 2>&1 || [ -x /opt/google-cloud-sdk/bin/gcloud ]; then
  env -u CLOUDSDK_AUTH_ACCESS_TOKEN gcloud config set project ai-audio-book >/dev/null 2>&1 || true
  env -u CLOUDSDK_AUTH_ACCESS_TOKEN gcloud auth activate-service-account --key-file="$CRED_FILE" >/dev/null 2>&1 || true
fi
