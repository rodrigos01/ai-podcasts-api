#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Deploys the API to Cloud Run straight from source — Cloud Build detects
# Node via package.json's build/start scripts (no Dockerfile needed) and
# builds+deploys in one step.
#
# .env is the source of truth for runtime config, but it is NOT forwarded
# verbatim: a few keys are deliberately excluded because they either don't
# belong in a deployed environment or aren't read by the server at all.
#   - PORT: Cloud Run injects and reserves this itself; setting it manually
#     is rejected.
#   - FIREBASE_SERVICE_ACCOUNT_PATH: local-dev-only. The app falls back to
#     Application Default Credentials (Cloud Run's attached runtime service
#     account) when this is unset — see src/config/firebase.ts. Baking a
#     long-lived service-account key into the container image would be a
#     real secret sitting in every image layer; don't reintroduce that by
#     forwarding this.
#   - FIREBASE_WEB_API_KEY: not read by src/config/env.ts at all — only
#     ever used for manual local testing (minting ID tokens from a
#     terminal), not by the running server.
#
# The remaining values (FIREBASE_WEB_API_KEY excluded above, project id,
# storage bucket, Firestore database ids) are passed as plain Cloud Run env
# vars for simplicity. That means they're visible to anyone who can read
# this Cloud Run service's config (`gcloud run services describe`) — fine
# for a personal project. Text generation and TTS both authenticate via
# Application Default Credentials (the runtime's attached service account)
# rather than an API key, so there's no secret env var to move to Secret
# Manager here — but that service account does need the
# `roles/aiplatform.user` role for Vertex AI (text generation) to work.

ENV_FILE=".env"
SERVICE_NAME="${SERVICE_NAME:-ai-podcast-api}"
# Firestore (both named databases) and the Storage bucket are provisioned
# in the "US" / "nam5" multi-region, not a specific single region — pick a
# central single region for the Cloud Run service rather than guessing;
# override with REGION= if you want somewhere else.
REGION="${REGION:-us-central1}"
EXCLUDED_KEYS="PORT FIREBASE_SERVICE_ACCOUNT_PATH FIREBASE_WEB_API_KEY"
REQUIRED_KEYS="FIREBASE_PROJECT_ID FIREBASE_STORAGE_BUCKET"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE found in $(pwd) — nothing to deploy from." >&2
  exit 1
fi

is_excluded() {
  local key="$1"
  for excluded in $EXCLUDED_KEYS; do
    [ "$key" = "$excluded" ] && return 0
  done
  return 1
}

# YAML double-quoted scalar escaping (backslash and double-quote) — this is
# not shell-quoting (printf %q would produce backslash escapes that are
# meaningless, and wrong, inside a YAML value).
yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

TMP_ENV_YAML="$(mktemp)"
trap 'rm -f "$TMP_ENV_YAML"' EXIT

: > "$TMP_ENV_YAML"
while IFS='=' read -r key value; do
  case "$key" in
    ""|\#*) continue ;;
  esac
  is_excluded "$key" && continue
  printf '%s: "%s"\n' "$key" "$(yaml_escape "$value")" >> "$TMP_ENV_YAML"
done < <(grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -v '^[[:space:]]*$')

for required in $REQUIRED_KEYS; do
  grep -q "^${required}:" "$TMP_ENV_YAML" || {
    echo "Missing required env var in $ENV_FILE: $required" >&2
    exit 1
  }
done

PROJECT_ID="$(grep '^FIREBASE_PROJECT_ID:' "$TMP_ENV_YAML" | cut -d' ' -f2- | tr -d "'\"")"

echo "Deploying $SERVICE_NAME to Cloud Run"
echo "  project: $PROJECT_ID"
echo "  region:  $REGION"
echo "  env vars forwarded: $(cut -d: -f1 "$TMP_ENV_YAML" | tr '\n' ' ')"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --env-vars-file "$TMP_ENV_YAML"
