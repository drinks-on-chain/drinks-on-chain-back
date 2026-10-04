-- -----------------------------------------------------------------------------
-- Drinks on Chain · backend · SOLO DESARROLLO · reinicio de la trazabilidad de
-- las bodegas de demostración.
--
-- PREPARADO, NO APLICADO: borra datos, así que lo decide y lo ejecuta la
-- coordinación (plan/06), nunca la aplicación ni la semilla.
--
-- Para qué: la semilla es de solo inserción (un lote de demostración que ya
-- existe no se reescribe). Una base sembrada antes del cierre H2 conserva los
-- lotes antiguos con los datos incoherentes de los fixtures 0.3.x (p. ej.
-- CVJ-2026-SINGANI-002 con una segunda destilación posterior a su
-- embotellado), visibles como incidencias de migración. Este script retira
-- TODA la trazabilidad de las tres bodegas de demostración con datos
-- (Altos de Calamuchita, Cinti Viejo y Casa Uriondo) para que la semilla la
-- vuelva a crear entera y coherente:
--
--   1. copia de la base (pg_dump);
--   2. este script, como el dueño de la base y con `-v confirmar=si`;
--   3. la semilla: `docker compose … exec api node dist/seed.js`.
--
-- Se pierde lo que alguien haya registrado a mano en esas tres bodegas (lotes,
-- pesajes, tanques…). No toca: personas, bodegas, membresías, parcelas,
-- configuración, bitácora (inmutable: conserva la historia de lo borrado) ni
-- ninguna otra bodega.
--
--   docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env \
--     exec -T postgres psql -v ON_ERROR_STOP=1 -v confirmar=si \
--     -U postgres -d drinks_on_chain_db < deploy/dev/sql/reiniciar-trazabilidad-demo.sql
-- -----------------------------------------------------------------------------
\set ON_ERROR_STOP on
\if :{?confirmar}
\else
  \set confirmar no
\endif
SELECT :'confirmar' = 'si' AS confirmado \gset
\if :confirmado
\else
  \echo 'No se borra nada: repite con -v confirmar=si (y con una copia de la base hecha).'
  \quit
\endif

BEGIN;

-- UUID v5 de los mocks: winery:altos, winery:cintiviejo, winery:uriondo
CREATE TEMP TABLE demo_wineries (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO demo_wineries VALUES
  ('bd7bf10b-1768-51fa-aa4e-6299f374a153'),
  ('04de1441-989d-5c3e-b06f-033f3961d19d'),
  ('eac1f883-31c7-5032-8628-cac993ca5e48');

CREATE TEMP TABLE demo_lots ON COMMIT DROP AS
  SELECT id FROM lots WHERE winery_id IN (SELECT id FROM demo_wineries);
CREATE TEMP TABLE demo_harvests ON COMMIT DROP AS
  SELECT id FROM harvest_batches WHERE winery_id IN (SELECT id FROM demo_wineries);
CREATE TEMP TABLE demo_tanks ON COMMIT DROP AS
  SELECT id FROM fermentation_tanks WHERE winery_id IN (SELECT id FROM demo_wineries);
CREATE TEMP TABLE demo_bottlings ON COMMIT DROP AS
  SELECT id FROM bottling_batches WHERE winery_id IN (SELECT id FROM demo_wineries);

\echo 'Trazabilidad de demostración que se retira:'
SELECT (SELECT count(*) FROM demo_lots) AS lotes,
       (SELECT count(*) FROM demo_harvests) AS pesajes,
       (SELECT count(*) FROM demo_tanks) AS tanques,
       (SELECT count(*) FROM demo_bottlings) AS embotellados,
       (SELECT count(*) FROM bottle_units WHERE lot_id IN (SELECT id FROM demo_lots)) AS codigos_de_botella;

-- En el orden que exigen las claves foráneas (`RESTRICT`, sin cascadas)
DELETE FROM bottle_code_exports WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM bottle_units WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM lot_events WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM lot_compliance_issues WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM lot_attachments WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM lot_dossiers WHERE lot_id IN (SELECT id FROM demo_lots);
DELETE FROM trace_corrections WHERE winery_id IN (SELECT id FROM demo_wineries);
DELETE FROM batch_lab_analyses WHERE bottling_batch_id IN (SELECT id FROM demo_bottlings);
DELETE FROM bottling_batches WHERE id IN (SELECT id FROM demo_bottlings);
DELETE FROM phyto_decisions WHERE harvest_batch_id IN (SELECT id FROM demo_harvests);
DELETE FROM maturity_analyses WHERE harvest_batch_id IN (SELECT id FROM demo_harvests);
DELETE FROM fermentation_tank_inputs WHERE fermentation_tank_id IN (SELECT id FROM demo_tanks);
DELETE FROM fermentation_logs WHERE fermentation_tank_id IN (SELECT id FROM demo_tanks);
DELETE FROM enological_treatments WHERE fermentation_tank_id IN (SELECT id FROM demo_tanks);
DELETE FROM wine_aging_batches WHERE winery_id IN (SELECT id FROM demo_wineries);
DELETE FROM production_batches WHERE winery_id IN (SELECT id FROM demo_wineries);
DELETE FROM fermentation_tanks WHERE id IN (SELECT id FROM demo_tanks);
DELETE FROM lot_backfill_pending WHERE harvest_batch_id IN (SELECT id FROM demo_harvests);
DELETE FROM harvest_batches WHERE id IN (SELECT id FROM demo_harvests);
DELETE FROM lots WHERE id IN (SELECT id FROM demo_lots);
-- Las secuencias vuelven a empezar con los códigos de la semilla
DELETE FROM lot_sequences WHERE winery_id IN (SELECT id FROM demo_wineries);

COMMIT;

\echo 'Hecho. Ahora, la semilla: docker compose … exec api node dist/seed.js'
