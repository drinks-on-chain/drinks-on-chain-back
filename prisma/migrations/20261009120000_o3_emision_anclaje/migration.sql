-- Ola 3 · pasos 3.4 y 3.5 (plan/contratos/o3-tokenizacion.md §5.5, §7.2 y §12.2)
-- Migración aditiva: no borra ninguna fila ni ningún dato.
--
-- 1. Anclajes simulados del embotellado. Antes del paso 3.5 ningún lote se
--    ancló de verdad: los `blockchain_anchor_tx_hash` que existan son valores
--    de relleno (semilla de demostración o el gancho simulado). Se copian a
--    `legacy_simulated_anchor_tx_hash` y los campos legados quedan como "sin
--    anclar"; a partir de ahora solo los escribe el anclaje confirmado y
--    verificado en la red (`dossier_anchors` en `ANCHORED`).
-- 2. El `slug` de una colección pasa a ser único por bodega, no global.

ALTER TABLE "bottling_batches"
ADD COLUMN "legacy_simulated_anchor_tx_hash" VARCHAR(100);

UPDATE "bottling_batches" AS b
SET "legacy_simulated_anchor_tx_hash" = b."blockchain_anchor_tx_hash",
    "blockchain_anchor_tx_hash" = NULL,
    "is_anchored_on_chain" = false,
    "anchored_at" = NULL
WHERE (b."is_anchored_on_chain" = true
       OR b."blockchain_anchor_tx_hash" IS NOT NULL
       OR b."anchored_at" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "dossier_anchors" a
    WHERE a."lot_id" = b."lot_id" AND a."status" = 'ANCHORED'
  );

DROP INDEX "collections_slug_key";

CREATE UNIQUE INDEX "collections_winery_id_slug_key" ON "collections"("winery_id", "slug");
