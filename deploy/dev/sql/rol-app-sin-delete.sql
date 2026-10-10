-- -----------------------------------------------------------------------------
-- Drinks on Chain · backend · usuario de base de la aplicación SIN `DELETE`
-- sobre la trazabilidad (contrato O2 §1; cierre H2) ni `UPDATE`/`DELETE` sobre
-- la bitácora (0.7, AUD-02).
--
-- PREPARADO, NO APLICADO: cambia roles del Postgres del servidor, así que lo
-- aplica la coordinación (plan/06). Ver deploy/README.md, «Usuario de base sin
-- DELETE en la trazabilidad».
--
-- Qué hace (idempotente; se puede repetir):
--   1. Crea (o actualiza) el rol de la aplicación, con el que se conectan la
--      API y el worker. El dueño de las tablas sigue siendo el rol actual
--      (`postgres`), que es quien aplica las migraciones.
--   2. Le da lectura y escritura sobre todo el esquema `public` (también sobre
--      las tablas que creen las migraciones futuras).
--   3. Le quita `DELETE` y `TRUNCATE` en las tablas de la trazabilidad (solo
--      inserción: los errores se corrigen con registros compensatorios, §9) y
--      `UPDATE`, `DELETE` y `TRUNCATE` en la bitácora.
--
-- Uso, como el dueño de la base y con la contraseña del rol en el entorno
-- (nunca como argumento):
--
--   export DOC_APP_PASSWORD   # ya definida en el entorno, p. ej. desde ~/doc-dev/.env
--   docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env \
--     exec -T -e DOC_APP_PASSWORD postgres \
--     psql -v ON_ERROR_STOP=1 -U postgres -d drinks_on_chain_db \
--     < deploy/dev/sql/rol-app-sin-delete.sql
--
-- Después: `APP_DB_USER=doc_app` y `APP_DB_PASSWORD=…` en ~/doc-dev/.env y un
-- despliegue (la API migra con `MIGRATE_DATABASE_URL`, que sigue siendo el
-- dueño). Para deshacerlo: quitar esas dos variables y volver a desplegar.
--
-- Una tabla nueva de trazabilidad en una migración futura hereda los permisos
-- por defecto (con `DELETE`): añádela a la lista de abajo y repite el script.
-- -----------------------------------------------------------------------------
\set ON_ERROR_STOP on
\if :{?app_role}
\else
  \set app_role doc_app
\endif
\getenv app_password DOC_APP_PASSWORD
\if :{?app_password}
\else
  \echo 'Falta DOC_APP_PASSWORD en el entorno: no se crea el rol.'
  \quit
\endif

BEGIN;

SELECT format('CREATE ROLE %I LOGIN', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_role', :'app_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec

GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
-- Lo que creen las migraciones futuras (las aplica el dueño)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";

-- Trazabilidad: solo inserción (y cambios de estado), nunca borrado
REVOKE DELETE, TRUNCATE ON
  "terroirs",
  "harvest_batches",
  "maturity_analyses",
  "phyto_decisions",
  "fermentation_tanks",
  "fermentation_tank_inputs",
  "fermentation_logs",
  "enological_treatments",
  "wine_aging_batches",
  "production_batches",
  "bottling_batches",
  "bottle_units",
  "bottle_code_exports",
  "batch_lab_analyses",
  "lots",
  "lot_events",
  "lot_sequences",
  "lot_compliance_issues",
  "lot_attachments",
  "lot_dossiers",
  "trace_corrections"
FROM :"app_role";

-- Cadena y tokenización (Ola 3, contrato O3 §1): lo que registra hechos es de
-- solo inserción y el estado vigente se actualiza con historial; nada se borra
REVOKE DELETE, TRUNCATE ON
  "chain_accounts",
  "nft_contracts",
  "chain_transactions",
  "chain_tx_attempts",
  "chain_events",
  "chain_cursors",
  "chain_alerts",
  "reconciliation_runs",
  "tokenization_requests",
  "tokenization_request_changes",
  "collections",
  "collection_images",
  "collection_status_history",
  "mints",
  "tokens",
  "lot_closures",
  "lot_closure_items",
  "dossier_anchors",
  "consumer_addresses"
FROM :"app_role";

-- Bitácora: inmutable también por permisos (además del trigger)
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM :"app_role";

-- El historial de migraciones solo lo escribe el dueño
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "_prisma_migrations" FROM :"app_role";

COMMIT;

\echo 'Rol de la aplicación listo:' :app_role
SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS permisos
FROM information_schema.role_table_grants
WHERE grantee = :'app_role' AND table_schema = 'public'
  AND table_name IN ('lots', 'lot_events', 'bottle_units', 'audit_events', 'users')
GROUP BY table_name
ORDER BY table_name;
