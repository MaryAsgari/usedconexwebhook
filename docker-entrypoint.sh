#!/bin/sh
set -e

if [ -n "$GCP_SERVICE_ACCOUNT_JSON" ] && [ ! -f "/app/sa.json" ]; then
  printf "%s" "$GCP_SERVICE_ACCOUNT_JSON" > /app/sa.json
  export GOOGLE_APPLICATION_CREDENTIALS=/app/sa.json
fi

exec node index.js
