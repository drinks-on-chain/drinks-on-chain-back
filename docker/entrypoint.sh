#!/bin/sh
# Arranque de la imagen del backend.
# Con RUN_MIGRATIONS=true aplica las migraciones pendientes antes de arrancar
# la API; si fallan, el contenedor no arranca (y el despliegue lo detecta).
set -eu

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  ./node_modules/.bin/prisma migrate deploy --schema ./prisma/schema.prisma
fi

exec "$@"
