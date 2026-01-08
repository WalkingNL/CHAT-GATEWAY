#!/usr/bin/env bash
set -euo pipefail

# load shared secrets
set -a
source /etc/crypto_secrets/secrets.env
set +a

# run gateway
exec npm run dev
