# Bitácora (auditoría)

> Ola 0 · paso 0.7 (AUD-01, AUD-02; docs-back/07 §4, docs-back/03 §10 y §13, contrato O1 §7). Base de la bitácora: modelo, escritura en la misma transacción, encadenamiento por hash e inmutabilidad. La consulta, la exportación CSV y la verificación por HTTP (`/v1/platform/audit*`, `/v1/organizations/current/audit`) llegan con el back office en la Ola 1 sobre este mismo modelo.

## Qué garantiza

| Garantía | Cómo |
|---|---|
| **Misma transacción** que la operación | `AuditService.record(tx, evento)` solo acepta el cliente de una transacción (rechaza el cliente raíz). Si la operación se revierte, la entrada no existe |
| **Solo inserción** | Trigger `audit_events_no_update_delete` (fila) y `audit_events_no_truncate` (sentencia) que rechazan `UPDATE`, `DELETE` y `TRUNCATE` con el error `42501`. Nadie edita ni borra desde la aplicación, tampoco el administrador |
| **Encadenada por hash** | Cada entrada guarda `seq` (1, 2, 3… sin huecos), `prevHash` (hash de la anterior) y `hash` = SHA-256 del JSON canónico de todos sus campos, `prevHash` incluido. Cambiar, borrar o intercalar una entrada rompe la cadena desde ese punto |
| **Sin carreras** | La cabeza de la cadena se lee bajo `pg_advisory_xact_lock` (se libera al confirmar o revertir): dos operaciones simultáneas nunca comparten `seq` ni `prevHash` |
| **Sin datos sensibles** | `before` y `after` pasan por `sanitizeAuditData`: contraseñas, tokens, secretos, claves, códigos TOTP y semillas de Stellar → `[REDACTED]`; fechas en ISO, decimales y enteros grandes como texto |

`verifyChain(from?, to?)` recorre el tramo y devuelve `{ valid, checked, firstBrokenSeq }` (la forma de `GET /v1/platform/audit/verify` del contrato): detecta contenido cambiado, huecos en `seq` y eslabones recalculados que ya no enlazan con el siguiente.

## Modelo (`audit_events`)

Forma pública (`AuditService.toView`) = `AuditEvent` del contrato O1 §7.

| Columna | Contrato | Notas |
|---|---|---|
| `id`, `seq`, `occurred_at` | `id`, `seq`, `occurredAt` | `occurred_at` con milisegundos (`timestamptz(3)`), tomado después del candado: el orden de `seq` y el de la fecha coinciden |
| `actor_user_id`, `actor_full_name`, `actor_role`, `actor_organization_id`, `actor_via_platform` | `actor` | `null` = el sistema. El nombre se guarda como estaba en ese momento (si el contexto no lo trae, se lee de la cuenta). `viaPlatform` = actuó desde la organización de plataforma |
| `source_app`, `source_ip`, `source_device_id` | `source` | App de la cabecera `X-Client-App` (`ERP`, `BACKOFFICE`, `MARKETPLACE`, `POS`, `PUBLIC`; sin cabecera o desconocida → `API`; el worker → `WORKER`) |
| `session_id` | — | `sid` de la sesión (adicional al contrato) |
| `action` | `action` | Código estable `UPPER_SNAKE_CASE` (`src/shared/audit/audit.actions.ts`) |
| `resource_type`, `resource_id` | `resource` | Tipo estable en `snake_case` (`winery`, `terroir`, `setting`, `file`…) |
| `organization_id` | `organizationId` | Organización **afectada** (la bodega del recurso); con ella el dueño verá la bitácora de su bodega (AUD-04) |
| `before`, `after` | `before`, `after` | `jsonb`, saneados |
| `reason` | `reason` | Obligatorio en acciones del back office sobre terceros (AUD-05, lo exige cada endpoint de la Ola 1) |
| `correlation_id` | `correlationId` | `X-Correlation-ID` de la petición (o del evento, en el worker) |
| `hash`, `prev_hash` | `hash`, `prevHash` | Hex de 64 caracteres; la primera entrada no tiene `prev_hash` (check en la base) |

Sin claves foráneas: la bitácora sobrevive a lo que registra. Índices por fecha, actor, organización, acción y recurso (con `seq` para ordenar), para los filtros del back office.

## Contexto de la petición

Actor, organización, app, IP, sesión y correlación salen de `src/shared/context/request-context.ts` (AsyncLocalStorage):

- `CorrelationIdMiddleware` lo abre con `correlationId`, `ip` y `clientApp`.
- El guardia de acceso (`AccessTokenGuard`, sesiones) lo completa con `userId`, `sessionId`, `audience`, `organizationId`, `organizationType` y `role`; `RequestContextInterceptor` rellena lo que siga vacío a partir de `request.user`.
- El worker lo abre por trabajo (`runWithCorrelationId`, app `WORKER`, sin persona).

Los logs JSON leen el mismo contexto (`correlationId`, `sid`, `org`, `userId`, `app`).

## Cómo registrar una acción

Dentro de la transacción de la operación, **como último paso** (desde el candado hasta la confirmación, las demás escrituras auditadas esperan):

```ts
await this.prisma.$transaction(async (tx) => {
  const winery = await this.wineryRepository.update(id, data, tx);
  await this.audit.record(tx, {
    action: AuditAction.WINERY_APPROVED,
    resource: { type: 'winery', id },
    organizationId: id,                      // organización afectada
    before: { certificationStatus: 'INVITED' },
    after: { certificationStatus: winery.certificationStatus },
    reason: dto.reason,                      // back office sobre terceros
  });
});
```

Atajos:

- `audit.transaction(work, describe)`: abre la transacción, ejecuta `work(tx)` y registra `describe(resultado)`. Para escrituras de un paso (las altas del ERP).
- `audit.recordStandalone(evento)`: entrada sin otra escritura que la acompañe (inicio de sesión fallido, subida de un archivo).
- `actor: null` fuerza "sistema"; `actor`/`source` parciales sustituyen lo que venga del contexto.

`AuditService` es global (`AuditModule`): no hace falta importar el módulo. En pruebas unitarias, `createAuditServiceMock(prismaMock)` (`src/shared/audit/__tests__/audit-service.mock.ts`) ejecuta `transaction` con el simulado de Prisma y guarda las entradas en `recorded`.

Desde el candado hasta la confirmación, las demás escrituras auditadas esperan: por eso `PrismaService` da a las transacciones más margen que el de Prisma por defecto (`maxWait` 10 s, `timeout` 15 s). La transacción debe ser `READ COMMITTED` (la de Prisma por defecto): con aislamiento mayor, la cabeza leída tras el candado podría ser vieja y la inserción fallaría por `seq` repetido (falla, no corrompe).

## Qué se registra hoy

| Acción | Dónde |
|---|---|
| `AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGIN_FAILED` (401/403; con el correo, nunca la contraseña) | `AuthAuditInterceptor` observa `POST /v1/auth/login` sin tocar el módulo de sesiones. Si ese módulo pasa a registrarlos él mismo, basta con quitar el interceptor de `AuditModule` |
| `WINERY_CREATED`, `WINERY_APPROVED`, `WINERY_REJECTED` (con el motivo) | `WineriesService`, en la transacción del alta y del cambio de estado |
| `TERROIR_CREATED`/`UPDATED`, `HARVEST_BATCH_CREATED`, `HARVEST_BATCH_PHYTO_STATUS_CHANGED`, `FERMENTATION_TANK_CREATED`, `FERMENTATION_LOG_ADDED`, `ENOLOGICAL_TREATMENT_ADDED`, `WINE_AGING_BATCH_CREATED`, `PRODUCTION_BATCH_CREATED`, `BOTTLING_BATCH_CREATED`, `LAB_ANALYSIS_CREATED` | Altas del ERP |
| `SETTING_CHANGED`, `SETTING_OVERRIDE_SET`, `SETTING_OVERRIDE_RESET` | `SettingsService` ([configuración](configuracion.md)) |
| `FILE_UPLOADED` | `UploadsService` ([correo y archivos](correo-y-archivos.md)) |

Pendiente (Ola 1 en adelante): membresías y equipo, invitaciones, solicitudes, cierre de sesión y recuperación de contraseña, cadena, canjes.

## Límites conocidos

- El trigger lo puede desactivar el dueño de la tabla (el usuario de la aplicación en desarrollo). La defensa completa (docs-back/03 §10) es que la aplicación use un usuario de base de datos sin `UPDATE`/`DELETE`/`ALTER` sobre `audit_events` y un proceso externo que verifique la cadena y guarde su cabeza fuera de la base; queda para la infraestructura de producción. Aun así, cualquier manipulación la detecta `verifyChain`.
- Retención indefinida en el MVP (docs-back/07 §4.3).
- Las pruebas e2e escriben entradas de prueba (`E2E_*`) que no se pueden borrar: úsese una base de pruebas.

## Pruebas

- Unitarias: `src/shared/audit/__tests__/` (saneado, hash y detección de eslabones rotos, servicio con contexto, interceptor de login).
- e2e con Postgres: `test/audit.e2e-spec.ts` — 12 escrituras simultáneas con `seq` consecutivos y cadena válida, rollback sin entrada, `UPDATE`/`DELETE`/`TRUNCATE` rechazados por la base, manipulación detectada por `verifyChain`, escritura por HTTP con `X-Client-App` y login correcto y fallido.
