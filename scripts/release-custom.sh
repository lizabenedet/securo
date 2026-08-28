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

# A versao que a UI mostra nao pode ser a mesma string da tag da imagem.
# Em SemVer, `-custom.1` e um *pre-lancamento*: `isUpdateAvailable` conclui
# que v0.14.5 e mais nova que v0.14.5-custom.1 e acende o aviso de update
# para a versao que ja esta rodando. Com `+` vira build metadata, que a
# comparacao ignora — o aviso volta a aparecer so quando o upstream lancar
# de verdade. A tag da imagem nao pode usar `+` porque o Docker so aceita
# [a-zA-Z0-9._-], entao as duas strings andam separadas.
DISPLAY_VERSION="${TAG/-custom./+custom.}"

BACKEND="ghcr.io/$OWNER/securo-backend"
FRONTEND="ghcr.io/$OWNER/securo-frontend"

echo "==> build backend  $TAG"
docker build -f backend/Dockerfile -t "$BACKEND:$TAG" -t "$BACKEND:latest" backend

echo "==> build frontend $TAG (UI mostra $DISPLAY_VERSION)"
docker build -f frontend/Dockerfile \
  --build-arg "VITE_APP_VERSION=$DISPLAY_VERSION" \
  -t "$FRONTEND:$TAG" -t "$FRONTEND:latest" frontend

echo "==> push"
docker push "$BACKEND:$TAG"
docker push "$BACKEND:latest"
docker push "$FRONTEND:$TAG"
docker push "$FRONTEND:latest"

cat <<EOF

Publicado. Na VPS (os tres arquivos de compose: sem o vps.yml o Caddy some
e o celery-worker volta ao --concurrency=2, que estoura a RAM de la):

  cd ~/securo
  git fetch origin && git reset --hard origin/custom
  export SECURO_TAG=$TAG
  docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml -f docker-compose.vps.yml pull
  docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml -f docker-compose.vps.yml up -d
EOF
