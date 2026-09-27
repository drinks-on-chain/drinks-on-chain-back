#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Drinks on Chain · backend · despliegue al entorno de DESARROLLO
#
#   ~/doc-dev/bin/deploy.sh <sha>
#
# Espera el código en ~/doc-dev/releases/<sha>.tgz (lo sube deploy-dev.yml con
# `git archive`). Pasos:
#   1. Extrae la release en ~/doc-dev/src-<sha> (si ya existe, la reutiliza).
#   2. Apunta ~/doc-dev/current a esa carpeta (cambio atómico del enlace).
#   3. docker compose up -d --build --remove-orphans con ~/doc-dev/.env.
#   4. Espera a que la API y el worker estén healthy (API: /v1/health;
#      worker: latido reciente, dist/worker-healthcheck.js). Un servicio que
#      no exista en el compose de la release (releases antiguas sin worker) se
#      omite.
#   5. Si queda sana: escribe ~/doc-dev/DEPLOYED y conserva las 3 últimas
#      releases. Si no: vuelve al enlace anterior, relanza y sale con error.
#
# Idempotente: repetir el mismo <sha> no rompe nada. Un candado evita dos
# despliegues a la vez. Variables opcionales (entorno o ~/doc-dev/.env):
#   DOC_DEV_HOME (~/doc-dev) · DEPLOY_HEALTH_TIMEOUT (180) · DEPLOY_KEEP_RELEASES (3)
#   DEPLOY_HEALTH_SERVICES ("api worker")
# -----------------------------------------------------------------------------
set -Eeuo pipefail

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "uso: deploy.sh <sha> (hexadecimal de 7 a 40 caracteres)"

BASE="${DOC_DEV_HOME:-$HOME/doc-dev}"
RELEASES_DIR="$BASE/releases"
ENV_FILE="$BASE/.env"
CURRENT_LINK="$BASE/current"
TARBALL="$RELEASES_DIR/$SHA.tgz"
TARGET="$BASE/src-$SHA"
PROJECT="doc-dev"
COMPOSE_REL="deploy/dev/compose.yml"

# Lee una variable del .env sin ejecutarlo (solo líneas CLAVE=valor).
env_value() {
  local key="$1" default="$2" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"'" || true)"
  printf '%s' "${!key:-${value:-$default}}"
}

[[ -f "$ENV_FILE" ]] || die "falta $ENV_FILE (ver deploy/dev/.env.example)"
[[ -f "$TARBALL" || -d "$TARGET" ]] || die "no existe $TARBALL"
command -v docker >/dev/null || die "docker no está instalado"
docker compose version >/dev/null 2>&1 || die "falta el plugin docker compose"

HEALTH_TIMEOUT="$(env_value DEPLOY_HEALTH_TIMEOUT 180)"
KEEP="$(env_value DEPLOY_KEEP_RELEASES 3)"
HEALTH_SERVICES="$(env_value DEPLOY_HEALTH_SERVICES "api worker")"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "DEPLOY_HEALTH_TIMEOUT no es un número"
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 1 ]] || die "DEPLOY_KEEP_RELEASES debe ser >= 1"

# --- Un solo despliegue a la vez -------------------------------------------------
mkdir -p "$RELEASES_DIR"
exec 9>"$BASE/.deploy.lock"
flock -w 600 9 || die "otro despliegue sigue en curso"

compose() {
  # $1 = carpeta de la release; el resto, argumentos de docker compose
  local dir="$1"; shift
  RELEASE_SHA="$(basename "$dir" | sed 's/^src-//')" \
    docker compose -p "$PROJECT" -f "$dir/$COMPOSE_REL" --env-file "$ENV_FILE" "$@"
}

switch_link() {
  ln -sfn "$1" "$BASE/.current.tmp"
  mv -Tf "$BASE/.current.tmp" "$CURRENT_LINK"
}

# Servicios de DEPLOY_HEALTH_SERVICES que existen en el compose de la release
services_to_check() {
  local dir="$1" defined svc
  defined="$(compose "$dir" config --services 2>/dev/null || true)"
  for svc in $HEALTH_SERVICES; do
    grep -qx "$svc" <<<"$defined" && printf '%s\n' "$svc"
  done
  return 0
}

wait_healthy() {
  local dir="$1" deadline cid status restarts svc pending
  local -a services
  mapfile -t services < <(services_to_check "$dir")
  (( ${#services[@]} > 0 )) || { log "ningún servicio que comprobar"; return 1; }
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    pending=0
    for svc in "${services[@]}"; do
      cid="$(compose "$dir" ps -q "$svc" 2>/dev/null || true)"
      if [[ -z "$cid" ]]; then
        pending=1
        continue
      fi
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
      restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
      case "$status" in
        healthy) ;;
        exited|dead) log "$svc terminó ($status)"; return 1 ;;
        *) pending=1 ;;
      esac
      if (( restarts >= 3 )); then
        log "$svc se ha reiniciado $restarts veces"
        return 1
      fi
    done
    if (( pending == 0 )); then
      log "sanos: ${services[*]}"
      return 0
    fi
    sleep 3
  done
  log "${services[*]}: no quedaron healthy en ${HEALTH_TIMEOUT}s"
  return 1
}

# --- 1. Extraer ------------------------------------------------------------------
if [[ -f "$TARGET/.release-ok" ]]; then
  log "release $SHA ya extraída en $TARGET"
else
  log "extrayendo $TARBALL en $TARGET"
  rm -rf "$TARGET" "$TARGET.tmp"
  mkdir -p "$TARGET.tmp"
  tar -xzf "$TARBALL" -C "$TARGET.tmp"
  [[ -f "$TARGET.tmp/$COMPOSE_REL" ]] || { rm -rf "$TARGET.tmp"; die "la release no contiene $COMPOSE_REL"; }
  printf '%s\n' "$SHA" > "$TARGET.tmp/.release-ok"
  mv "$TARGET.tmp" "$TARGET"
fi

# --- 2. Enlace current -----------------------------------------------------------
PREVIOUS=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS="$(readlink -f "$CURRENT_LINK" || true)"
fi
switch_link "$TARGET"
touch "$TARGET"
log "current -> $TARGET${PREVIOUS:+ (antes: $PREVIOUS)}"

# --- 3 y 4. Levantar y esperar ---------------------------------------------------
if compose "$TARGET" up -d --build --remove-orphans && wait_healthy "$TARGET"; then
  printf 'sha=%s\ndate=%s\nprevious=%s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(basename "${PREVIOUS:-none}" | sed 's/^src-//')" > "$BASE/DEPLOYED"

  # --- 5. Conservar las últimas $KEEP releases -----------------------------------
  mapfile -t OLD < <(ls -1dt "$BASE"/src-* 2>/dev/null | grep -v '\.tmp$' | tail -n +"$((KEEP + 1))")
  for dir in "${OLD[@]}"; do
    [[ "$(readlink -f "$dir")" == "$(readlink -f "$CURRENT_LINK")" ]] && continue
    old_sha="$(basename "$dir" | sed 's/^src-//')"
    log "borrando release antigua $old_sha"
    rm -rf "$dir" "$RELEASES_DIR/$old_sha.tgz"
    docker image rm "drinks-on-chain-back:dev-$old_sha" >/dev/null 2>&1 || true
  done

  log "desplegado $SHA"
  echo "$SHA"
  exit 0
fi

# --- Fallo: volver a la release anterior -----------------------------------------
log "el despliegue de $SHA no quedó sano; últimos logs:"
mapfile -t CHECKED < <(services_to_check "$TARGET")
for svc in "${CHECKED[@]}"; do
  compose "$TARGET" logs --tail 80 "$svc" || true
done

if [[ -n "$PREVIOUS" && -d "$PREVIOUS" && "$PREVIOUS" != "$(readlink -f "$TARGET")" ]]; then
  log "rollback a $PREVIOUS"
  # Quitar primero los contenedores fallidos: uno en bucle de reinicios
  # puede hacer fallar la recreación.
  # (sin nombres, `rm -sf` pararía toda la pila, bases de datos incluidas)
  if (( ${#CHECKED[@]} > 0 )); then
    compose "$TARGET" rm -sf "${CHECKED[@]}" >/dev/null 2>&1 || true
  fi
  switch_link "$PREVIOUS"
  if compose "$PREVIOUS" up -d --build --remove-orphans && wait_healthy "$PREVIOUS"; then
    log "rollback completado: sigue desplegada $(basename "$PREVIOUS" | sed 's/^src-//')"
  else
    log "el rollback tampoco quedó sano: revisa el servidor"
  fi
else
  log "no hay release anterior a la que volver"
fi
die "despliegue de $SHA fallido"
