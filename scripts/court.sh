#!/usr/bin/env bash
# 朝廷部署助手：init | build | up | down | logs [服务] | mock-up | ps | gen
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose "$@"; }

case "${1:-help}" in
  init)
    node scripts/init.mjs
    ;;
  gen)
    node scripts/gen-compose.mjs
    ;;
  build)
    [ -f docker-compose.yml ] || node scripts/gen-compose.mjs
    compose build
    ;;
  up)
    [ -f .env ] || node scripts/init.mjs
    [ -f docker-compose.yml ] || node scripts/gen-compose.mjs
    compose up -d --build
    echo "皇城已开：http://127.0.0.1:8001"
    ;;
  mock-up)
    [ -f .env ] || node scripts/init.mjs
    [ -f docker-compose.yml ] || node scripts/gen-compose.mjs
    LLM_MODE=mock compose up -d --build
    echo "皇城已开（mock 大脑，零成本）：http://127.0.0.1:8001"
    ;;
  down)
    compose down
    ;;
  logs)
    shift
    compose logs -f --tail=200 "$@"
    ;;
  ps)
    compose ps
    ;;
  *)
    echo "用法：scripts/court.sh init|build|up|down|logs [服务]|mock-up|ps|gen"
    exit 1
    ;;
esac
