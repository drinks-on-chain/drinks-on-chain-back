#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Drinks on Chain · backend · claves de la cadena del entorno de DESARROLLO
#
#   ~/doc-dev/current/deploy/dev/generar-claves-cadena.sh
#
# Genera EN EL SERVIDOR los secretos del custodio ENV (contrato O3 §2.1) que
# falten en ~/doc-dev/.env y los añade al final del archivo:
#
#   CHAIN_SECRET_OPERATIONS     semilla S… de la cuenta de operaciones
#   CHAIN_SECRET_ANCHOR         semilla S… de la cuenta de anclaje
#   CHAIN_DEV_WINERY_SEED       semilla maestra SEP-0005 de las bodegas (hex)
#   CHAIN_CONSUMER_MASTER_SEED  semilla maestra SEP-0005 de consumidores (hex)
#   CHAIN_CONSUMER_SEED_CHECK_ADDRESS  dirección pública G… del índice 0 (no es secreto)
#
# - NUNCA imprime un secreto: los valores van del generador al .env por un
#   archivo temporal con permisos 600; por pantalla solo salen las direcciones
#   públicas (G…), que son las que hay que fondear y comprobar.
# - Idempotente: una variable que ya tiene valor NO se toca (regenerarla
#   cambiaría las cuentas y dejaría huérfanas las de las bodegas). Repetirlo
#   solo vuelve a mostrar las direcciones.
# - Antes de escribir hace una copia: ~/doc-dev/.env.bak-<fecha> (600).
# - Solo testnet: se niega si STELLAR_NETWORK es PUBLIC (decisión del 08-10;
#   producción usa un custodio con claves no exportables, D7).
# - Usa la imagen de la release en marcha (node + SDK), sin red ni volúmenes.
#   No reinicia nada: después hay que desplegar (~/doc-dev/bin/deploy.sh <sha>)
#   para que el worker lea las claves.
#
# Variables opcionales: DOC_DEV_HOME (~/doc-dev) · CHAIN_KEYS_IMAGE (imagen con
# dist/scripts/chain-keys.js; por defecto, la de ~/doc-dev/current).
# -----------------------------------------------------------------------------
set -Eeuo pipefail
umask 077

log() { printf '[claves-cadena] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

BASE="${DOC_DEV_HOME:-$HOME/doc-dev}"
ENV_FILE="$BASE/.env"
SECRETS=(CHAIN_SECRET_OPERATIONS CHAIN_SECRET_ANCHOR CHAIN_DEV_WINERY_SEED CHAIN_CONSUMER_MASTER_SEED)

[[ -f "$ENV_FILE" ]] || die "falta $ENV_FILE"
command -v docker >/dev/null || die "docker no está instalado"

# Valor de una variable del .env sin ejecutarlo ni mostrarlo (última línea CLAVE=valor)
env_value() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"'" || true
}
# ¿Tiene valor de verdad? (vacía o `change-me` = sin definir)
is_set() {
  local value
  value="$(env_value "$1")"
  [[ -n "$value" && "$value" != "change-me" ]]
}

network="$(env_value STELLAR_NETWORK | tr '[:lower:]' '[:upper:]')"
case "${network:-TESTNET}" in
  PUBLIC|MAINNET) die "STELLAR_NETWORK=$network: las claves en el .env son solo para testnet" ;;
esac

if [[ -n "${CHAIN_KEYS_IMAGE:-}" ]]; then
  IMAGE="$CHAIN_KEYS_IMAGE"
else
  current="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  [[ -n "$current" && -d "$current" ]] || die "no hay release en marcha ($BASE/current)"
  IMAGE="drinks-on-chain-back:dev-$(basename "$current" | sed 's/^src-//')"
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no existe la imagen $IMAGE (despliega antes esta versión)"

# El generador: sin red, sin volúmenes y sin variables del entorno
chain_keys() {
  docker run --rm -i --network none --entrypoint node "$IMAGE" dist/scripts/chain-keys.js "$@"
}
chain_keys generate CHAIN_SECRET_ANCHOR >/dev/null 2>&1 \
  || die "la imagen $IMAGE no trae dist/scripts/chain-keys.js (necesita el paso 3.1 de la Ola 3)"

exec 9>"$BASE/.claves-cadena.lock"
flock -w 30 9 || die "otra ejecución sigue en curso"

missing=()
for name in "${SECRETS[@]}"; do
  is_set "$name" || missing+=("$name")
done

backed_up=0
backup() {
  (( backed_up == 1 )) && return 0
  local copy
  copy="$ENV_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$ENV_FILE" "$copy"
  chmod 600 "$copy"
  backed_up=1
  log "copia previa: $copy"
}

# Añade líneas CLAVE=valor al .env: quita antes las líneas vacías o `change-me`
# de esas mismas claves para que no queden duplicadas
append_lines() {
  local lines_file="$1" keys key
  keys="$(cut -d= -f1 "$lines_file")"
  for key in $keys; do
    sed -i -E "/^${key}=(change-me)?[[:space:]]*\$/d" "$ENV_FILE"
  done
  # El .env puede no terminar en salto de línea
  [[ -z "$(tail -c1 "$ENV_FILE")" ]] || printf '\n' >>"$ENV_FILE"
  cat "$lines_file" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

tmp="$(mktemp "$BASE/.claves-cadena.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if (( ${#missing[@]} > 0 )); then
  backup
  # La salida del generador va al archivo temporal, nunca a la pantalla
  chain_keys generate "${missing[@]}" >"$tmp"
  [[ "$(wc -l <"$tmp")" -eq "${#missing[@]}" ]] || die "el generador no devolvió todas las claves"
  append_lines "$tmp"
  : >"$tmp"
  log "generadas y añadidas a $ENV_FILE: ${missing[*]}"
else
  log "los cuatro secretos ya estaban definidos: no se genera nada"
fi

# Direcciones públicas: los secretos entran por la entrada estándar del
# contenedor (no por argumentos ni por variables) y solo salen las G…
addresses="$(grep -E "^($(IFS='|'; echo "${SECRETS[*]}"))=" "$ENV_FILE" | chain_keys addresses)"
address_of() { grep -E "^$1=" <<<"$addresses" | cut -d= -f2-; }

check="$(address_of CONSUMER_SEED_CHECK)"
[[ "$check" =~ ^G[A-Z2-7]{55}$ ]] || die "no se pudo leer la dirección de comprobación de la semilla de consumidores"
if ! is_set CHAIN_CONSUMER_SEED_CHECK_ADDRESS; then
  backup
  printf 'CHAIN_CONSUMER_SEED_CHECK_ADDRESS=%s\n' "$check" >"$tmp"
  append_lines "$tmp"
  : >"$tmp"
  log "añadida CHAIN_CONSUMER_SEED_CHECK_ADDRESS (dirección pública)"
elif [[ "$(env_value CHAIN_CONSUMER_SEED_CHECK_ADDRESS)" != "$check" ]]; then
  die "CHAIN_CONSUMER_SEED_CHECK_ADDRESS no corresponde a CHAIN_CONSUMER_MASTER_SEED: el worker no arrancará. No cambies ninguna de las dos sin avisar a la coordinación"
fi

log "direcciones públicas (lo único que se muestra):"
printf '  %-34s %s\n' \
  "operaciones (paga y despliega):" "$(address_of OPERATIONS)" \
  "anclaje:" "$(address_of ANCHOR)" \
  "primera bodega (m/44'/148'/0'):" "$(address_of FIRST_WINERY)" \
  "comprobación de consumidores:" "$check"
log "siguiente paso: define las variables no secretas (deploy/README.md §5) y despliega con ~/doc-dev/bin/deploy.sh <sha>"
