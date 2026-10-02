-- Ola 2 · bloque A (O2-BE-1, pasos 2.3 y 2.7): transiciones del tanque y
-- anulaciones por corrección compensatoria (contrato O2 §4.2, §9). Aditiva:
-- columnas nulas o con valor por defecto.

-- AlterTable
ALTER TABLE "fermentation_tanks" ADD COLUMN     "transition_log" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "fermentation_logs" ADD COLUMN     "voided_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "enological_treatments" ADD COLUMN     "voided_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "batch_lab_analyses" ADD COLUMN     "voided_at" TIMESTAMPTZ(6);
