#!/usr/bin/env bash
# Подгружает ключи из .env в окружение и запускает команду.
# Пример:  ./scripts/env.sh node server.js
#          source scripts/env.sh   (загрузить в текущую оболочку)
set -a
[ -f "$(dirname "$0")/../.env" ] && . "$(dirname "$0")/../.env"
set +a
[ "${BASH_SOURCE[0]}" = "$0" ] && [ $# -gt 0 ] && exec "$@"
