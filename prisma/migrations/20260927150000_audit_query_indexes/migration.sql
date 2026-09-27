-- Bitácora: índices para la consulta del back office y la del dueño (AUD-03,
-- AUD-04). Todas las consultas ordenan por seq descendente.

-- Recurso (tipo, id) con seq para ordenar sin paso extra
DROP INDEX "audit_events_resource_type_resource_id_idx";
CREATE INDEX "audit_events_resource_type_resource_id_seq_idx" ON "audit_events"("resource_type", "resource_id", "seq");

-- Bitácora del dueño: lo que afecta a su bodega o lo que hicieron sus miembros desde ella
CREATE INDEX "audit_events_actor_organization_id_seq_idx" ON "audit_events"("actor_organization_id", "seq");
