-- Ola 1 · retirada en H1 (contrato O1 §11, O0 §5): fase *contract* de la
-- migración 20260927120000_organizations_memberships_sessions.
--
-- `users.user_role` (rol global de 0.1) dejó de autorizar en la Ola 0: los
-- permisos van por `memberships`, que esa migración rellenó a partir de él
-- (PLATFORM_ADMIN → SUPERADMIN de la plataforma; `winery_members` → membresías
-- de bodega). Desde H1 ningún código lo lee ni lo escribe (ni `user.userRole`
-- en las respuestas ni el claim del acceso), así que se borra con su tipo.
--
-- `winery_members` NO se borra: sigue siendo la autoría de la trazabilidad
-- (claves foráneas desde `harvest_batches.certified_by_member_id`,
-- `enological_treatments.authorized_by_member_id`,
-- `bottling_batches.released_by_member_id` y
-- `batch_lab_analyses.reviewed_by_member_id`) y guarda la matrícula
-- profesional. Comparte el id con la membresía de la bodega.

-- AlterTable
ALTER TABLE "users" DROP COLUMN "user_role";

-- DropEnum
DROP TYPE "user_role_enum";
