#!/bin/sh
# Arranque de la imagen del backend.
# Con RUN_MIGRATIONS=true aplica las migraciones pendientes antes de arrancar
# la API; si fallan, el contenedor no arranca (y el despliegue lo detecta).
set -eu

# MIGRATE_DATABASE_URL (opcional): conexión del dueño de la base para las
# migraciones cuando la aplicación se conecta con un rol sin permisos de DDL ni
# de borrado sobre la trazabilidad (deploy/dev/sql/rol-app-sin-delete.sql).
# Vacía o sin definir: se migra con DATABASE_URL, como siempre.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  DATABASE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}" \
    ./node_modules/.bin/prisma migrate deploy --schema ./prisma/schema.prisma
fi

exec "$@"
