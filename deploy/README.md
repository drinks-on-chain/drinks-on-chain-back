# Despliegue del backend

Por ahora solo existe el entorno de **desarrollo** (servidor compartido). Staging y producción llegan en la Ola 6.

| Archivo | Qué es |
|---|---|
| `dev/compose.yml` | Pila de desarrollo: `api` (construida desde la propia release), `worker` (misma imagen, `node dist/worker.js`), Postgres 16, Redis 7 con contraseña, Mailpit y MinIO en una red interna |
| `dev/.env.example` | Plantilla de `~/doc-dev/.env` en el servidor (secretos, orígenes CORS, nombres de volúmenes) |
| `dev/deploy.sh` | Script de despliegue idempotente con rollback; en el servidor vive en `~/doc-dev/bin/deploy.sh` |

## Cómo llega un cambio a desarrollo

```mermaid
flowchart LR
  A[push a dev] --> B[CI: lint, tipos, pruebas, e2e, migraciones, docker build, auditoría]
  B -->|verde| C[deploy-dev: git archive del commit]
  C -->|scp| D["~/doc-dev/releases/SHA.tgz"]
  D -->|ssh| E["~/doc-dev/bin/deploy.sh SHA"]
  E --> F["docker compose up -d --build"]
  F -->|api y worker healthy| G["~/doc-dev/DEPLOYED"]
  F -->|no sana| H[rollback a la release anterior]
```

1. Un push a `dev` ejecuta `.github/workflows/ci.yml`. Si todo pasa, el job `deploy-dev` llama a `.github/workflows/deploy-dev.yml` (también se puede lanzar a mano con *Run workflow*).
2. `deploy-dev` empaqueta el commit con `git archive` (el servidor no necesita acceso git al repo privado), lo sube por `scp` a `~/doc-dev/releases/<sha>.tgz` y ejecuta `~/doc-dev/bin/deploy.sh <sha>` por SSH. Un grupo de `concurrency` impide dos despliegues a la vez (y `deploy.sh` usa además un candado `flock`).
3. `deploy.sh`:
   - extrae la release en `~/doc-dev/src-<sha>` (si ya existe, la reutiliza);
   - cambia el enlace `~/doc-dev/current` a esa carpeta (cambio atómico);
   - ejecuta `docker compose -p doc-dev -f current/deploy/dev/compose.yml --env-file ~/doc-dev/.env up -d --build --remove-orphans`;
   - espera a que los contenedores `api` y `worker` estén *healthy* (`DEPLOY_HEALTH_SERVICES`; la API por el `HEALTHCHECK` de la imagen, que llama a `/v1/health` y exige Postgres y Redis; el worker por `node dist/worker-healthcheck.js`, que exige un latido reciente, que solo se escribe con Postgres, Redis, el relay del outbox y las colas en marcha). Un servicio que no exista en el compose de la release (una release antigua sin worker) se omite. Falla antes si alguno se reinicia 3 veces;
   - si queda sana, escribe `~/doc-dev/DEPLOYED` (sha, fecha, anterior), conserva las 3 últimas releases y borra las demás (carpeta, tarball e imagen `drinks-on-chain-back:dev-<sha>`), y si la release trae otro `deploy/dev/deploy.sh` lo instala en `~/doc-dev/bin/deploy.sh`;
   - si no, muestra los logs de la API y del worker, vuelve el enlace a la release anterior, la relanza y sale con error (el job de GitHub queda en rojo).

> El worker arranca cuando la API está sana (la API aplica las migraciones; el worker no) y tiene 30 s de gracia al parar para terminar los trabajos en curso. Ver [`docs/arquitectura/outbox.md`](../docs/arquitectura/outbox.md).

Si la secret `DEV_SSH_HOST` no existe, el job de despliegue se salta sin fallar (la CI sigue en verde hasta la puesta en marcha).

### Estructura en el servidor

```text
~/doc-dev/
├── .env                 # secretos del entorno (chmod 600), fuera del código
├── bin/deploy.sh        # copia de deploy/dev/deploy.sh
├── releases/<sha>.tgz   # paquetes subidos por GitHub Actions
├── src-<sha>/           # releases extraídas (se conservan 3)
├── current -> src-<sha> # la release en marcha
├── DEPLOYED             # sha y fecha del último despliegue sano
└── .deploy.lock         # candado de flock
```

## Puesta en marcha (una vez; la hace la coordinación)

> Nada de esto lo ejecuta la CI. Los secretos se generan en el propio servidor (`openssl rand -hex 32`) y no se imprimen ni se copian al chat.

1. **Docker**: Docker Engine con el plugin `compose` y el usuario de despliegue en el grupo `docker`. `flock` viene con `util-linux` en Ubuntu.
2. **Carpetas y script**:
   ```bash
   mkdir -p ~/doc-dev/bin ~/doc-dev/releases
   # deploy.sh desde una copia del repo (o del primer tarball)
   install -m 700 deploy/dev/deploy.sh ~/doc-dev/bin/deploy.sh
   ```
   Solo hace falta la primera vez: al terminar cada despliegue sano, si la release trae un `deploy/dev/deploy.sh` distinto, `deploy.sh` lo instala en `~/doc-dev/bin/deploy.sh` (`install -m 700`) para el siguiente despliegue.
3. **`.env`**: `cp deploy/dev/.env.example ~/doc-dev/.env && chmod 600 ~/doc-dev/.env` y rellenar cada `change-me`. Valores hexadecimales: van dentro de `DATABASE_URL` y `REDIS_URL`.
4. **Volúmenes existentes**: el servidor ya tiene `drinks-on-chain-back_postgres_data` y `drinks-on-chain-back_redis_data` (de la pila anterior). El `.env.example` ya los declara como `external`. Antes del primer despliegue:
   - para la pila anterior **sin borrar volúmenes** (`docker compose down`, nunca `down -v`) y el proceso `pm2` de la API (libera el puerto 3000). Dos Postgres no pueden usar el mismo volumen a la vez;
   - `POSTGRES_PASSWORD` debe ser la contraseña con la que se creó ese volumen, o cámbiala antes con `ALTER USER postgres PASSWORD '…'` desde `psql` dentro del contenedor antiguo;
   - haz una copia (`pg_dump`) antes de nada.
5. **Archivos subidos**: la API usa ahora el volumen `doc-dev_uploads` (montado en `/app/uploads`, usuario `node`, uid 1000). Para conservar los de la instalación anterior:
   ```bash
   docker volume create doc-dev_uploads
   docker run --rm -v doc-dev_uploads:/dst -v /ruta/anterior/uploads:/src:ro alpine \
     sh -c 'cp -a /src/. /dst/ && chown -R 1000:1000 /dst'
   ```
6. **nginx**: sin cambios si ya hace *proxy* a `127.0.0.1:3000`. La UI de Mailpit queda en `127.0.0.1:8025` (acceso con `ssh -L 8025:127.0.0.1:8025 …`). Postgres, Redis, SMTP y MinIO no se publican. Para que el navegador abra las URL firmadas de los archivos hace falta un `server` de nginx con *proxy* a `minio:9000` (p. ej. publicando MinIO en `127.0.0.1:9000`) y `S3_PUBLIC_ENDPOINT` con ese host en `~/doc-dev/.env`; mientras tanto, la API guarda y firma, pero las URL solo sirven dentro de la red interna.
7. **Llave de despliegue** (propia, solo para GitHub Actions):
   ```bash
   ssh-keygen -t ed25519 -N '' -C 'github-actions doc-dev' -f doc-dev-deploy
   # la pública, en ~/.ssh/authorized_keys del usuario de despliegue
   ssh-keyscan -t ed25519 <host>   # salida para DEV_SSH_KNOWN_HOSTS
   ```
8. **Secretos del repo en GitHub** (*Settings → Secrets and variables → Actions*):

   | Secreto | Valor |
   |---|---|
   | `DEV_SSH_HOST` | IP o nombre del servidor |
   | `DEV_SSH_USER` | usuario de despliegue |
   | `DEV_SSH_KEY` | llave privada `doc-dev-deploy` completa |
   | `DEV_SSH_KNOWN_HOSTS` | línea(s) de `ssh-keyscan` del servidor |

9. **Primer despliegue**: *Actions → Deploy dev → Run workflow* sobre `dev` (o un push a `dev`). Comprueba `cat ~/doc-dev/DEPLOYED` y `curl -s 127.0.0.1:3000/v1/health`.

## Operación

```bash
cat ~/doc-dev/DEPLOYED                                   # qué está desplegado
cd ~/doc-dev/current
docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env ps
docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env logs -f api
docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env logs -f worker   # JSON con correlationId
~/doc-dev/bin/deploy.sh <sha-anterior>                   # volver a una release conservada
```

- **Migraciones**: con `RUN_MIGRATIONS=true` la API aplica `prisma migrate deploy` al arrancar. Un rollback **no** revierte migraciones: escríbelas compatibles hacia atrás (añadir antes de quitar).
- **Semilla** (superusuario y datos de demostración, idempotente; detalle en el README, "Datos de demostración"): va compilada en la imagen. Con `SUPERADMIN_*`, `SEED_DEMO` y `SEED_DEMO_PASSWORD` definidos en `~/doc-dev/.env` (y el contenedor `api` recreado después de editarlos: `docker compose … up -d api` o el siguiente despliegue):
  ```bash
  cd ~/doc-dev/current
  docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env exec api node dist/seed.js
  ```
- **Copias**: pendientes (`pg_dump` diario fuera del servidor, O0-OPS-2); no forman parte de este script.

## Cierre H2 (`v0.2.0`): antes y después del despliegue

Detalle en [`docs/arquitectura/trazabilidad.md`](../docs/arquitectura/trazabilidad.md#cierre-h2-contracción-v020). Nada de esto lo ejecuta la CI ni la aplicación: lo decide y lo aplica la coordinación.

### 1. Antes de desplegar: comprobar la base (solo lectura)

La migración `20261002180000_o2_contraer_h2` falla con un mensaje claro, sin aplicar nada, si queda algún registro de la cadena sin lote o alguna serie de botella con dos códigos activos. Una migración fallida queda marcada en `_prisma_migrations` y **ninguna versión de la API arranca** (tampoco la anterior, en el rollback) hasta resolverla, así que compruébalo antes:

```sql
SELECT (SELECT count(*) FROM fermentation_tanks WHERE lot_id IS NULL) AS tanques,
       (SELECT count(*) FROM wine_aging_batches WHERE lot_id IS NULL) AS crianzas,
       (SELECT count(*) FROM production_batches WHERE lot_id IS NULL) AS destilaciones,
       (SELECT count(*) FROM bottling_batches WHERE lot_id IS NULL) AS embotellados,
       (SELECT count(*) FROM batch_lab_analyses WHERE lot_id IS NULL) AS analisis,
       (SELECT count(*) FROM (SELECT 1 FROM bottle_units WHERE status = 'ACTIVE'
          GROUP BY lot_id, serial HAVING count(*) > 1) d) AS series_duplicadas;
```

Todo en cero → se puede desplegar. Si no, no despliegues: hay que asignar un lote a esos registros (o anular los códigos duplicados) primero. Si aun así la migración falla en un despliegue: corrige los datos y, con la conexión del dueño,

```bash
docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env run --rm --no-deps \
  --entrypoint ./node_modules/.bin/prisma api migrate resolve --rolled-back 20261002180000_o2_contraer_h2
```

y vuelve a desplegar.

### 2. Usuario de base sin `DELETE` en la trazabilidad (opcional, preparado)

Hoy la API se conecta con el dueño de la base, al que no se le pueden quitar permisos. Para cumplir el contrato (§1) hace falta un rol aparte:

1. Copia de la base (`pg_dump`).
2. Una contraseña nueva para el rol en `~/doc-dev/.env` (`APP_DB_USER=doc_app`, `APP_DB_PASSWORD=…`, generada con `openssl rand -hex 32`), sin imprimirla.
3. [`dev/sql/rol-app-sin-delete.sql`](dev/sql/rol-app-sin-delete.sql) como el dueño, con la contraseña en el entorno (`DOC_APP_PASSWORD`), nunca como argumento. El script es idempotente y lleva el comando en su cabecera.
4. Un despliegue: la API y el worker se conectan con `APP_DB_USER`; las migraciones siguen yendo con el dueño (`MIGRATE_DATABASE_URL`, que el `compose.yml` ya define).

La semilla también funciona con ese rol (`exec api node dist/seed.js`). Para deshacerlo, quita las dos variables y despliega. Una tabla nueva de trazabilidad en una migración futura hay que añadirla a la lista del script y repetirlo.

### 3. Lotes de demostración ya sembrados (opcional)

La semilla es de solo inserción: los lotes de demostración que ya existen en el servidor **no se reescriben** (conservan los datos de los fixtures 0.3.x, con sus incidencias de migración) y solo se crean los que faltan. Para tener los 21 lotes coherentes hay que retirar antes la trazabilidad de las tres bodegas de demostración con [`dev/sql/reiniciar-trazabilidad-demo.sql`](dev/sql/reiniciar-trazabilidad-demo.sql) (borra datos: copia antes, `-v confirmar=si`) y volver a sembrar. Se pierde lo registrado a mano en esas bodegas.

## Apertura de la Ola 3 (`0.3.0-rc.0`): antes y después del despliegue

### 4. Migración de la apertura de la Ola 3

La migración `20261008120000_o3_cadena_expand` es aditiva (19 tablas y columnas nulas) y **no borra nada**, pero mueve datos (SE-02): copia los valores simulados de `wineries` (`stellar_public_key`, `dynamic_vault_id`, `onchain_producer_id`, `onchain_register_tx_hash`) a `legacy_simulated_address` y `legacy_simulated_data` y los pone a `NULL`, y marca `user_wallets` entera como `INVALID_SIMULATED`.

1. **Copia de la base** (`pg_dump`), como en cada migración con datos.
2. **Comprobación previa, solo lectura** (lo que la migración va a mover; anota el resultado):

   ```sql
   SELECT (SELECT count(*) FROM wineries) AS bodegas,
          (SELECT count(*) FROM wineries
            WHERE stellar_public_key IS NOT NULL OR dynamic_vault_id IS NOT NULL
               OR onchain_producer_id IS NOT NULL OR onchain_register_tx_hash IS NOT NULL) AS bodegas_con_valores_simulados,
          (SELECT count(*) FROM user_wallets) AS billeteras,
          (SELECT count(*) FROM users) AS personas,
          (SELECT count(*) FROM lots) AS lotes,
          (SELECT count(*) FROM audit_events) AS bitacora,
          (SELECT count(*) FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('chain_accounts', 'collections', 'tokens', 'tokenization_requests')) AS tablas_o3_ya_existentes,
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public'
              AND ((table_name = 'wineries' AND column_name IN ('chain_account_id', 'legacy_simulated_address', 'legacy_simulated_data'))
                OR (table_name = 'user_wallets' AND column_name = 'status'))) AS columnas_o3_ya_existentes;
   ```

   `tablas_o3_ya_existentes` y `columnas_o3_ya_existentes` deben ser **0** (si no, la migración ya se aplicó o hay restos: no despliegues y avisa).
3. **Después de desplegar** (solo lectura): `bodegas`, `billeteras`, `personas` y `lotes` no cambian; `bitacora` sube en 1 (la entrada `CHAIN_SIMULATED_WALLETS_INVALIDATED`, que la API escribe al arrancar, con el número de filas); y

   ```sql
   SELECT (SELECT count(*) FROM wineries WHERE legacy_simulated_data IS NOT NULL) AS bodegas_con_legado,
          (SELECT count(*) FROM wineries WHERE stellar_public_key IS NOT NULL OR dynamic_vault_id IS NOT NULL
               OR onchain_producer_id IS NOT NULL OR onchain_register_tx_hash IS NOT NULL) AS bodegas_con_valores_simulados,
          (SELECT count(*) FROM user_wallets WHERE status <> 'INVALID_SIMULATED') AS billeteras_sin_marcar,
          (SELECT after FROM audit_events WHERE action = 'CHAIN_SIMULATED_WALLETS_INVALIDATED') AS anotado;
   ```

   `bodegas_con_legado` = el `bodegas_con_valores_simulados` de antes; los otros dos, 0.

Para deshacerla sin restaurar la copia (los datos siguen en las columnas `legacy_*`): `UPDATE wineries SET stellar_public_key = legacy_simulated_data->>'stellarPublicKey', dynamic_vault_id = legacy_simulated_data->>'dynamicVaultId', onchain_producer_id = legacy_simulated_data->>'onchainProducerId', onchain_register_tx_hash = legacy_simulated_data->>'onchainRegisterTxHash' WHERE legacy_simulated_data IS NOT NULL;` y desplegar la versión anterior (que ignora las tablas y columnas nuevas).

### 5. Cuentas de la plataforma en testnet (cuando toque el paso 3.1)

La apertura no necesita ninguna variable de la cadena: sin ellas arranca con la cadena deshabilitada. Para habilitarla, en `~/doc-dev/.env` (permisos `600`), con las claves **generadas en el servidor** y sin imprimirlas: `STELLAR_RPC_URL`, `CHAIN_CUSTODY_DRIVER=ENV`, `CHAIN_SECRET_OPERATIONS`, `CHAIN_SECRET_ANCHOR`, `CHAIN_DEV_WINERY_SEED`, `STELLAR_HOME_DOMAIN`, `WINERY_NFT_WASM_HASH` y `API_PUBLIC_URL` (ver `dev/.env.example`). `CHAIN_MINT_ENABLED` se queda en `false` hasta que la coordinación lo active (ADR-011). Las tablas de la Ola 3 están en la lista de [`dev/sql/rol-app-sin-delete.sql`](dev/sql/rol-app-sin-delete.sql): si el rol de la aplicación ya se creó, repite el script.
