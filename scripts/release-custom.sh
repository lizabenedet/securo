#!/usr/bin/env bash
# Builda e publica no GHCR as imagens do fork.
#
#   ./scripts/release-custom.sh v0.14.5-custom.1
#
# Pre-requisito (uma vez so, na maquina que builda):
#   echo "$GITHUB_PAT" | docker login ghcr.io -u lizabenedet --password-stdin
# O PAT (classic) precisa do escopo write:packages.
#
# A VPS e x86_64, igual a esta maquina, entao `docker build` normal ja produz
# a arquitetura certa: nao e preciso buildx --platform.
set -euo pipefail

OWNER="${GHCR_OWNER:-lizabenedet}"
TAG="${1:-}"

if [ -z "$TAG" ]; then
  echo "uso: $0 <tag>   (ex: v0.14.5-custom.1)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

BACKEND="ghcr.io/$OWNER/securo-backend"
FRONTEND="ghcr.io/$OWNER/securo-frontend"

echo "==> build backend  $TAG"
docker build -f backend/Dockerfile -t "$BACKEND:$TAG" -t "$BACKEND:latest" backend

echo "==> build frontend $TAG"
docker build -f frontend/Dockerfile \
  --build-arg "VITE_APP_VERSION=$TAG" \
  -t "$FRONTEND:$TAG" -t "$FRONTEND:latest" frontend

echo "==> push"
docker push "$BACKEND:$TAG"
docker push "$BACKEND:latest"
docker push "$FRONTEND:$TAG"
docker push "$FRONTEND:latest"

cat <<EOF

Publicado. Na VPS:

  cd ~/securo && git pull
  SECURO_TAG=$TAG docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml pull
  SECURO_TAG=$TAG docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml up -d
EOF
