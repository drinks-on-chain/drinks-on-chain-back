# Roadmap del backend

Seguimiento en el repo de la planificación de `docs-back/08-roadmap.md` (repo `drinks-on-chain-docsback`) y del plan maestro (`PLAN-MAESTRO.md`, olas). Se marca cada paso al terminarlo: `- [x] … · fecha`.

## Etapa 0 · Cimientos (Ola 0)

**Objetivo**: la base sobre la que se construye todo lo demás, sin romper el ERP que ya consume el frontend.
**Terminado cuando**: cada PR pasa CI; `dev` se despliega solo al entorno de desarrollo; el inicio de sesión usa tokens cortos y organización activa; una acción de prueba deja su entrada en la bitácora y un correo sale por la cola; el ERP del frontend sigue funcionando.

- [ ] **0.1 Acceso y servidor** (D7, OP-02) — contraseñas del servidor y del superadministrador cambiadas, acceso por llave SSH con usuario revocable, inventario del despliegue actual, copia de la base. *Coordinación / OPS.*
- [ ] **0.2 Flujo de trabajo y entrega** (OPS-07, OPS-08, OPS-11) — parcial:
  - [x] Rama `dev` creada desde `main` · 2026-09-27
  - [x] Node 22 (`.nvmrc`), pnpm 10.28 (`packageManager`), ESLint 9 *flat config* + Prettier, errores de lint corregidos · 2026-09-27
  - [x] CI: lint, tipos, unitarias, e2e con Postgres y Redis reales, migraciones desde cero y `migrate diff`, `docker build`, auditoría de dependencias · 2026-09-27
  - [x] `Dockerfile` multi-etapa y `docker/entrypoint.sh` (migraciones opcionales al arrancar) · 2026-09-27
  - [x] `docker-compose.yml` local (Postgres, Redis, Mailpit, MinIO en `127.0.0.1`) y `deploy/dev/compose.yml` del servidor · 2026-09-27
  - [x] CORS por lista de orígenes (`CORS_ALLOWED_ORIGINS`, sin reflejo) y `.env.example` limpio (OP-03) · 2026-09-27
  - [x] Despliegue reproducible a desarrollo desde `dev` (`deploy-dev.yml` + `deploy/dev/deploy.sh` con rollback) · 2026-09-27
  - [ ] Puesta en marcha en el servidor y secretos `DEV_SSH_*` en GitHub (coordinación, ver `deploy/README.md`)
  - [x] Proceso `worker` en compose (local, perfil `app`, y `deploy/dev/compose.yml`) con healthcheck; `deploy.sh` espera también al worker · 2026-09-27
  - [ ] Copias diarias de la base fuera del servidor
- [x] **0.3 Estándares de API** (OPS-02, OPS-12, A-33) · 2026-09-27
  - [x] Errores: validación → 422 `VALIDATION_ERROR` con `details: [{ field, message }]` (puntos en anidados, `null` si no es de un campo), catálogo de códigos (`src/shared/exceptions/error-codes.ts`), 409 en conflictos de estado, 429 con `Retry-After` · 2026-09-27
  - [x] Listas `{ items, total, limit, offset }` en las 9 colecciones (también `wineries/pending` y `wineries/my/members`), `limit` 20 por defecto y 100 máximo (más → 422), `@ApiPaginatedResponse` en OpenAPI · 2026-09-27
  - [x] `Idempotency-Key` con `@Idempotent()` y Redis (24 h, 409 `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS`) en las altas del ERP · 2026-09-27
  - [x] OpenAPI como contrato: `pnpm openapi:generate` → `openapi.json` versionado, esquema `bearer` (SE-08) y rutas `@Public` sin candado, CI que falla si difiere y `oasdiff` (aviso en `dev`, bloqueo en PR a `main`), `SWAGGER_ENABLED` · 2026-09-27
  - [x] `docs/rules/` ajustadas por A-33 en paginación, errores e `Idempotency-Key` (02, 03, 04, 07, 08); los ajustes de sesión, membresías y outbox van con 0.4–0.6 · 2026-09-27
- [x] **0.4 Outbox, worker y colas** (OPS-04, OPS-05, OP-01) — outbox en la misma transacción, proceso `worker`, BullMQ, tareas programadas, transacciones en operaciones de varios pasos. · 2026-09-27 ([`docs/arquitectura/outbox.md`](arquitectura/outbox.md))
  - [x] Tabla `outbox_events` y `OutboxService.add(tx, evento)` (solo dentro de una transacción) · 2026-09-27
  - [x] Relay con `FOR UPDATE SKIP LOCKED`, `jobId` = id del evento, reintentos exponenciales y `FAILED` tras `OUTBOX_MAX_ATTEMPTS` · 2026-09-27
  - [x] Proceso `worker` (`src/worker.ts`, sin HTTP): colas `chain`, `email`, `scheduled`, `default`, procesadores por módulo (`@HandlesJob`), apagado ordenado, logs JSON con `correlationId`, latido para el healthcheck · 2026-09-27
  - [x] Tareas programadas (`@ScheduledTask`, job schedulers de BullMQ); primera: `outbox.cleanup` · 2026-09-27
  - [x] OP-01: `createWinery` y `createAndAddMember` en `prisma.$transaction` con los eventos `winery.created` y `member.added` (activación simulada de la bóveda en el worker), respuestas sin cambios · 2026-09-27
  - [x] Pruebas: unitarias del relay, despachador, programador y latido; e2e con Postgres y Redis reales (sin huérfanos, rollback sin evento, una sola vez con dos relays) · 2026-09-27
  - [x] `docs/rules/06` §6 ajustada por A-33: outbox en lugar de doble escritura · 2026-09-27
- [x] **0.5 Sesiones seguras** (IAM-02/03/04/07/13, SE-03, SE-06) · 2026-09-27 ([`docs/arquitectura/identidad.md`](arquitectura/identidad.md))
  - [x] Tabla `sessions` (`sid`, organización activa, hash del refresco, generación, caducidad deslizante, revocación, IP y agente) · 2026-09-27
  - [x] Acceso de 15 min con `sub, aud, org, orgType, role, sid, jti` (+ compatibilidad hasta H1); `JWT_EXPIRES_IN` recortado a 900 s · 2026-09-27
  - [x] Renovación rotativa en la cookie `doc_rt` (7 días personal / 30 consumidor), reutilización → 401 `AUTH_REFRESH_REUSED` y sesión revocada, periodo de gracia de 20 s para pestañas concurrentes, `refreshToken` en el cuerpo hasta H1 · 2026-09-27
  - [x] `POST /auth/logout` y `/auth/logout-all` (204, borran la cookie) · 2026-09-27
  - [x] Revocación inmediata (IAM-13): lista de `sid` en Redis + comprobación de sesión, persona y membresía en cada petición; bloquear membresía o cuenta revoca sus sesiones · 2026-09-27
  - [x] Límite global por IP real (`TRUST_PROXY=1`) y por ruta en `/auth/*`; bloqueo progresivo del login por correo e IP en Redis (429 con `Retry-After`) · 2026-09-27
  - [x] IP real del cliente detrás del proxy de las apps (O1-OPS-1): cabeceras `X-DOC-Client-IP` firmadas con HMAC y `PROXY_SHARED_SECRET` (varios secretos para rotar), ±60 s · 2026-09-27
- [x] **0.6 Organizaciones y membresías** (EQP-01, EQP-09, IAM-08, SE-01, OP-05, OP-07) · 2026-09-27
  - [x] Tablas `organizations` (bodega = mismo id) y `memberships`; estado de bodega `INVITED` (antes `PENDING`, contrato O1 §0) · 2026-09-27
  - [x] Migración de datos probada sobre una copia con datos: `PLATFORM_ADMIN` → `SUPERADMIN`, `winery_members` → membresías `WINERY` (mismo id); seeder idempotente · 2026-09-27
  - [x] Organización activa por defecto (última usada; si no, la primera activa, plataforma antes que bodega), `POST /auth/switch-organization`, `GET /users/me` con `{ user, memberships, activeOrganizationId }` · 2026-09-27
  - [x] Guards globales y `@Audience`/`@OrgType`/`@Roles`/`@RequireActiveOrg` por membresía; matriz de roles del ERP de docs-back/05 §3; plataforma con `?wineryId=` obligatorio en escrituras (OP-07); SE-05 como aviso (`FEATURE_ENFORCE_ACTIVE_ORG`) · 2026-09-27
  - [x] SE-01: las rutas de una bodega solo crean o reactivan su propia membresía; nada escribe ya `users.user_role` · 2026-09-27
  - [x] Retirada en H1: `users.user_role` borrado (migración *contract* `20260927190000_o1_retirada_h1`) y fuera los campos y claims de compatibilidad (`userRole`, `wineryId`, `memberRole`, `email`) y `tokens.refreshToken`; `winery_members` se conserva como autoría de la trazabilidad hasta que la Ola 2 la mueva a las membresías · 2026-09-27
- [x] **0.7 Bitácora base** (AUD-01, AUD-02) — registro en la misma transacción, solo inserción, encadenada por hash. · 2026-09-27 ([`docs/arquitectura/bitacora.md`](arquitectura/bitacora.md))
  - [x] Tabla `audit_events` con la forma del contrato O1 §7, `seq` monotónico, `hash` SHA-256 del evento canónico y `prevHash` · 2026-09-27
  - [x] Inmutabilidad en la base: trigger que rechaza `UPDATE`, `DELETE` y `TRUNCATE` · 2026-09-27
  - [x] `AuditService.record(tx, …)` en la misma transacción con `pg_advisory_xact_lock`, saneado de `before`/`after`, `transaction()` y `recordStandalone()`; `verifyChain(from, to)` · 2026-09-27
  - [x] Contexto de la petición (`src/shared/context/request-context.ts`) con persona, organización, rol, sesión, audiencia, IP, correlación y app (`X-Client-App`) · 2026-09-27
  - [x] Instrumentado: inicio de sesión correcto y fallido, alta/aprobación/rechazo de bodega y altas del ERP · 2026-09-27
  - [x] Pruebas: escrituras simultáneas, rollback sin entrada, `UPDATE`/`DELETE`/`TRUNCATE` rechazados, manipulación detectada · 2026-09-27
  - [ ] Usuario de base de datos de la aplicación sin permisos de `UPDATE`/`DELETE` sobre la bitácora (infraestructura de producción)
- [x] **0.8 Configuración base** (CFG-01, CFG-05) — definiciones de parámetros y valor efectivo con caché. · 2026-09-27 ([`docs/arquitectura/configuracion.md`](arquitectura/configuracion.md))
  - [x] Tablas de definiciones, estándar general, ajustes por bodega e historial · 2026-09-27
  - [x] Catálogo completo de docs-back/05 §4 (27 claves, mínimos legales de A-31) copiado a la base al arrancar · 2026-09-27
  - [x] `SettingsService`: valor efectivo con caché en Redis e invalidación al confirmar y por `setting.changed`; `snapshot(wineryId)` para el lote (CFG-06); validación de tipo, límites, nivel y mínimo legal con excepción · 2026-09-27
  - [x] Escrituras con historial y bitácora (`setGlobal`, `setOverrides`, `resetOverrides`) listas para los endpoints de la Ola 1 · 2026-09-27
  - [x] `GET /v1/organizations/current/settings` (solo lectura) · 2026-09-27
- [x] **0.9 Servicios comunes** (CMP-01, OPS-06, OPS-12, OPS-01, OPS-03, SE-04, SE-08) — correo con plantillas y cola (Mailpit en desarrollo), almacenamiento privado con URL firmadas (MinIO), OpenAPI publicado (hecho en 0.3), healthcheck y logs JSON. · 2026-09-27 ([`docs/arquitectura/correo-y-archivos.md`](arquitectura/correo-y-archivos.md))
  - [x] Correo: plantillas Handlebars (texto + HTML, marca, español), cola `email`, SMTP con `nodemailer`, `email_messages` con estado e idempotencia; Mailpit en desarrollo y en la CI · 2026-09-27
  - [x] Almacenamiento privado: driver S3 (MinIO) con URL firmadas de corta vida y bucket creado al arrancar, driver local con URL firmadas por HMAC; sin carpeta pública (`useStaticAssets` retirado) · 2026-09-27
  - [x] Subidas solo para personal, tipo real por firma de bytes, sin SVG, límite por tipo, prefijo por organización (SE-04) · 2026-09-27
  - [x] `GET /v1/health/live` y `/v1/health/ready`; logs JSON en la API con `correlationId`, `sid` y `org`; Swagger apagado en producción salvo `SWAGGER_ENABLED=true` (SE-08) · 2026-09-27
  - [x] `deploy.sh` se instala solo en `~/doc-dev/bin` al terminar un despliegue sano · 2026-09-27
  - [ ] Publicar MinIO para el navegador en el servidor de desarrollo (nginx → `minio:9000` y `S3_PUBLIC_ENDPOINT`) (coordinación)
  - [ ] Antivirus y cuotas por rol de las subidas (SE-04, resto)
- [x] **0.10 Datos de demostración** (OPS-09) — semilla determinista alineada con los mocks del frontend. · 2026-09-27 (README, "Datos de demostración")
  - [x] Semilla idempotente en TypeScript compilada en la imagen (`node dist/seed.js`, `pnpm seed`), `prisma/seed.ts` retirado · 2026-09-27
  - [x] Superusuario solo desde `SUPERADMIN_*` (sin contraseña por defecto); datos de demostración con `SEED_DEMO=true` y `SEED_DEMO_PASSWORD` · 2026-09-27
  - [x] Fixtures de `@drinks-on-chain/mocks` 0.3.0-rc.2 copiados (`pnpm seed:sync`): personal interno, 6 bodegas en todos los estados con sus membresías y bloqueos, trazabilidad completa del ERP con los mismos ids, códigos y fechas · 2026-09-27
  - [x] e2e: dos ejecuciones sobre un esquema vacío sin duplicados y una dueña de demo que inicia sesión y ve sus parcelas · 2026-09-27
  - [ ] Ejecutarla en el servidor de desarrollo con contraseñas generadas allí (coordinación)
  - [x] `lotPrefix`, `slug`, perfiles públicos, historial de estados y solicitudes de alta de los mocks (Ola 1 · 1.3–1.5) · 2026-09-27
  - [ ] Ajustes por bodega de los mocks (se crean con el uso; sin sembrar)

## Etapa 1 · Back office y bodegas (Ola 1)

- [x] **1.1 Usuarios internos** (PLT-01, PLT-02, PLT-03, PLT-04, PLT-05) — superusuario por semilla, usuarios internos por invitación con rol, permisos por rol, 2FA TOTP. · 2026-09-27 ([`docs/arquitectura/identidad.md`](arquitectura/identidad.md#cuenta-segundo-factor-e-invitaciones-ola-1--11-y-12))
  - [x] TOTP obligatorio para el personal de plataforma: login con reto (`mfaToken` 5 min, un solo uso), `mfa/enroll`, `mfa/enroll/confirm` (10 códigos de recuperación con HMAC), `mfa/verify`; secretos cifrados (AES-256-GCM, `MFA_ENCRYPTION_KEY`); 5 fallos → 429 y correo; sin repetir códigos · 2026-09-27
  - [x] La plataforma solo queda activa en sesiones con segundo factor: `switch-organization` → 403 `AUTH_MFA_REQUIRED`; las sesiones de plataforma anteriores se revocan · 2026-09-27
  - [x] `GET/POST /v1/platform/users`, `PATCH /v1/platform/users/{membershipId}`, `/block`, `/unblock`, `/reset-mfa`; `POST /v1/platform/accounts/{userId}/block|unblock` y `GET /v1/platform/accounts/{userId}` (ampliación); `send-password-reset`; superusuario protegido · 2026-09-27
  - [x] `GET /v1/platform/permissions`: matriz única en código que también dan los `@Roles` del back office · 2026-09-27
  - [x] Semilla: TOTP del personal interno de demo con `SEED_DEMO_TOTP_SECRET` · 2026-09-27
- [x] **1.2 Cuentas** (IAM-05, IAM-06, IAM-09, IAM-10; EQP-03 en invitaciones) — aceptar invitación (cuenta nueva o membresía añadida), recuperación de contraseña, verificación de correo, perfil. · 2026-09-27
  - [x] `forgot-password` (202 siempre, captcha Turnstile y campo trampa), `reset-password` (revoca todas las sesiones), `verify-email`, `resend-verification`, `POST /users/me/password` (revoca las demás), `PATCH /users/me` con preferencias y consentimiento con fecha; política de contraseñas → 422 `AUTH_WEAK_PASSWORD` · 2026-09-27
  - [x] Invitaciones: token de un solo uso (hash), caducidad `invitacion.caducidadHoras`, `GET /invitations/{token}`, `accept` (cuenta nueva o existente con el mismo correo; plataforma → TOTP), `resend`, `revoke`, `GET/POST /organizations/current/invitations`, `GET/POST /platform/organizations/{id}/invitations` (el `GET`, ampliación); límite de colaboradores; `InvitationsService.create` y `onAccepted` para la parte B · 2026-09-27
  - [x] Correos: invitación, recuperación, contraseña cambiada, verificación, 2FA restablecido, intentos fallidos y aviso al dueño; enlaces con `APP_URL_*` · 2026-09-27
  - [x] Bitácora de cada acción con motivo donde el contrato lo exige · 2026-09-27
  - [x] Semilla: invitaciones de demostración con token secreto (HMAC con `SEED_DEMO_PASSWORD`) · 2026-09-27
  - [x] Pruebas: unitarias y e2e (recuperación hasta Mailpit, TOTP, invitaciones, límites, permisos por rol y entre organizaciones) · 2026-09-27
  - [ ] Definir `MFA_ENCRYPTION_KEY` y la clave real de Turnstile en el servidor (coordinación)
- [x] **1.3 Solicitudes de alta** (ORG-01, ORG-02) — formulario público con captcha, bandeja con estados, reunión agendada, aprobar o rechazar con motivo. · 2026-09-27 ([`docs/arquitectura/organizaciones.md`](arquitectura/organizaciones.md#solicitudes-de-alta-3))
  - [x] Modelo `winery_applications` (+ notas, reunión, decisión) con las transiciones del contrato (409 `APPLICATION_INVALID_TRANSITION`) sin carreras · 2026-09-27
  - [x] `POST /v1/public/winery-applications`: captcha, campo trampa, límite por IP (minuto y hora) y por correo, NIT repetido → 202 silencioso con aviso a operaciones; `POST …/verify` con el enlace del correo (`APP_URL_BODEGAS/unirse/verificar`) · 2026-09-27
  - [x] Bandeja y detalle; tomar, notas, reunión, reunión hecha, aprobar (bodega `INVITED` + invitación al dueño en la misma transacción) y rechazar con motivo y correo · 2026-09-27
- [x] **1.4 Alta directa y activación** (ORG-03, ORG-04, ORG-05) — alta desde el back office, invitación automática al dueño, activación al aceptar, prefijo de lote único. · 2026-09-27
  - [x] `POST /v1/platform/wineries` (201 `{ winery, invitation }`) · 2026-09-27
  - [x] Activación con `InvitationsService.onAccepted`: `ACTIVE`, `lotPrefix` único (3–5 letras con desambiguación, columna única), `activatedAt`, `winery.activated` por el outbox · 2026-09-27
  - [x] Migración: `slug` y `lotPrefix` de las bodegas existentes respetando los prefijos de sus códigos de lote (`ALT`, `CVJ`…), historial inicial · 2026-09-27
  - [x] El embotellado usa `lotPrefix` (EA-07: colisión de prefijos) · 2026-09-27
  - [ ] Secuencia del código de lote sin carreras (EA-07, resto): Etapa 2
- [x] **1.5 Gestión de bodegas** (ORG-07, ORG-08, ORG-09, ORG-10, ORG-11, SE-05) — perfil editable, suspender, reactivar y revocar (el ERP bloquea bodegas no activas), directorio, transferir titularidad, perfil público. · 2026-09-27
  - [x] Directorio, ficha con historial, `PATCH` con motivo; suspender/reactivar/revocar (revocar solo administración) con aviso al dueño y sesiones revocadas; revocar anula las invitaciones · 2026-09-27
  - [x] Transferir la titularidad (`keepPreviousOwnerAs`: `ENOLOGIST` o `BLOCKED`), sesiones del dueño anterior cerradas al aceptar · 2026-09-27
  - [x] `GET/PATCH /v1/organizations/current`, `GET /v1/public/wineries/{slug}` · 2026-09-27
  - [x] SE-05 activo por defecto (`FEATURE_ENFORCE_ACTIVE_ORG`): 403 `ORG_NOT_ACTIVE` con el estado; perfil y bitácora propia en `SUSPENDED` · 2026-09-27
- [x] **1.6 Equipo de la bodega** (EQP-02, EQP-03, EQP-04, EQP-05, EQP-06, EQP-07, EQP-08, EQP-10) — el dueño invita; reenviar y anular; listado con estado; cambiar rol; bloquear y desbloquear (dueño y back office); límite de colaboradores; aviso al dueño. · 2026-09-27
  - [x] `GET/PATCH /v1/organizations/current/members…`, `block`/`unblock` con las reglas de `blockedBy`; versión del back office con motivo y aviso al dueño (EQP-10) y `accountStatus` (§11 bis) · 2026-09-27
  - [x] Bloquear y cambiar el rol revocan las sesiones afectadas; desbloquear respeta el límite de colaboradores · 2026-09-27
  - [x] `OPERATOR` lee `GET /v1/terroirs` (lista y detalle) sin editarlas (§11 bis) · 2026-09-27
  - [x] Rutas que se retiran en H1 marcadas `deprecated` con aviso en los logs (`signup` de personal, `POST /wineries`, `wineries/pending|approve|reject`, `wineries/my/members*`) · 2026-09-27
  - [x] Retiradas al cerrar la ola (H1), comprobado que ERP y Backoffice en `dev` no las usan: `POST /wineries`, `wineries/pending|approve|reject`, `wineries/my/members*`; `signup` solo de consumidores (`userRole` → 422); refresco solo en la cookie · 2026-09-27
  - [x] Pruebas unitarias y e2e (Postgres, Redis, Mailpit) del recorrido completo, alta directa, SE-05, transferencia, equipo, permisos por rol y entre organizaciones · 2026-09-27
- [x] **1.7 Configuración en el back office** (CFG-02, CFG-03, CFG-04, CFG-07) — estándar general, ajustes por bodega (selección o todas), volver al estándar, historial y mínimo legal como piso con excepción de administración. · 2026-09-27 ([`docs/arquitectura/configuracion.md`](arquitectura/configuracion.md#back-office-ola-1))
  - [x] `GET/PUT /v1/platform/settings[/{key}]`, `GET/PUT …/{key}/overrides`, `POST …/overrides/reset`, `GET …/{key}/history` con permisos por rol (§9) · 2026-09-27
  - [x] `GET /v1/organizations/current/settings` con `@OrgType('WINERY')`, `?wineryId=` para la plataforma y `@RequireActiveOrg()` · 2026-09-27
  - [x] e2e: 403 por rol, motivo obligatorio, niveles, mínimo legal rechazado y aceptado con excepción, 404 entre bodegas, volver al estándar e historial · 2026-09-27
- [x] **1.8 Bitácora y tablero** (AUD-03, AUD-04, AUD-05, CMP-02, PLT-06) · 2026-09-27 ([`docs/arquitectura/bitacora.md`](arquitectura/bitacora.md#consulta-ola-1))
  - [x] `GET /v1/platform/audit` con filtros y `seq` descendente; índices para los filtros · 2026-09-27
  - [x] `GET /v1/platform/audit/export`: CSV por streaming, límite de 50 000 filas (`AUDIT_EXPORT_TOO_LARGE`), cabeceras de descarga, celdas seguras contra fórmulas · 2026-09-27
  - [x] `GET /v1/platform/audit/verify` (ADMIN) por fechas · 2026-09-27
  - [x] `GET /v1/organizations/current/audit` para el dueño (también lo hecho por la plataforma), legible con la bodega suspendida · 2026-09-27
  - [x] `@RequiresReason()` común para las rutas del back office sobre terceros (AUD-05) · 2026-09-27
  - [x] `GET /v1/platform/dashboard` con bodegas, miembros bloqueados, alertas y últimos eventos · 2026-09-27
  - [x] Contadores de solicitudes e invitaciones con consultas tipadas de Prisma · 2026-09-27
  - [x] Correos de la etapa (CMP-02: solicitudes, estado de la bodega, avisos a operaciones y al dueño) y bitácora de las acciones de las partes A y B con acción estable y motivo · 2026-09-27
- [x] **Corrección H0 · decimales y contrato** (error real detectado por el e2e `h0` del ERP) · 2026-09-27
  - [x] Los `Decimal` de Prisma (y de decimal.js) salen como **número JSON** en todas las respuestas (`ResponseTransformInterceptor`) y en las repeticiones idempotentes; la bitácora (`before/after`) y el CSV no cambian (decimales como texto exacto) · 2026-09-27
  - [x] `openapi.json` con tipos reales: anulables (`nullable`) con su tipo en lugar de `object`, relaciones anidadas de los detalles, esquemas del DAG, del pasaporte público, del reposo inerte y de lecturas y tratamientos de cuba · 2026-09-27
  - [x] Validador genérico de respuestas contra `openapi.json` (`test/helpers/openapi-validator.ts`, Ajv) y e2e de contrato con un recurso de cada módulo del ERP sobre la semilla de demo · 2026-09-27
  - [x] `/v1/health/ready` con `worker: up | down` (latido del worker en Redis con caducidad); sin worker, 200 y `degraded` · 2026-09-27
  - [x] `null` en campos opcionales del cuerpo = omitido (antes 500 en altas y ediciones del ERP y en `PATCH /users/me`); `@NullableFields` para borrar en PATCH; 422 en obligatorios; 422 declarado en toda operación con cuerpo · 2026-09-27
  - [x] Esquema de respuesta declarado en toda respuesta 2xx en JSON (DAG, pasaporte, reposo, 202 con `data: null`), comprobado en la prueba del contrato · 2026-09-27

## Lista de espera (añadido a la Ola 1 · v0.1.1)

Contrato: `plan/contratos/o1b-lista-de-espera.md` (carpeta del ecosistema). Sale desde `main` (sin lo de la Ola 2). Detalle en el [README](../README.md#-lista-de-espera-v011).

- [x] **Modelo y migración aditiva** — `waitlist_entries` (única por tipo y correo normalizado) y `waitlist_counters` (posición por tipo con la fila bloqueada: consecutiva y sin carreras); migración `20260927200000_o1_lista_de_espera`, anterior a la primera de la Ola 2 · 2026-10-01
- [x] **Inscripción pública** — `POST /v1/public/waitlist` (201 `{ type, position }`; duplicado → misma respuesta; campo trampa → 201 sin guardar; 422 por campo en español) y `GET /v1/public/waitlist/stats` (caché de 60 s) · 2026-10-01
  - [x] Límites: 20 por minuto y 300 por hora por IP real, 3 por hora por correo → 429 con `Retry-After` (`WAITLIST_LIMIT_IP_MINUTE`, `WAITLIST_LIMIT_IP_HOUR`, `WAITLIST_LIMIT_EMAIL_HOUR`) · 2026-10-01
  - [x] Captcha de Turnstile solo con `WAITLIST_CAPTCHA_REQUIRED=true` · 2026-10-01
- [x] **Back office** — `GET /v1/platform/waitlist` (filtros, búsqueda, página), `GET …/sources`, `PATCH …/{id}` (estado y notas), `GET …/export` (CSV por streaming, BOM, celdas seguras, sin IP ni agente de usuario, máximo 50 000 filas → `WAITLIST_EXPORT_TOO_LARGE`); capacidad `waitlist` en la matriz de permisos (soporte lee; no edita ni exporta) · 2026-10-01
- [x] **Tablero** — `waitlist: { consumers, wineries, last24h }` en `GET /v1/platform/dashboard` (aditivo) · 2026-10-01
- [x] **Bitácora** — `WAITLIST_JOINED`, `WAITLIST_STATUS_CHANGED`, `WAITLIST_EXPORTED`; recurso `waitlist_entry`; sin datos personales · 2026-10-01
- [x] **Pruebas y contrato** — unitarias y e2e (Postgres y Redis reales) con las respuestas validadas contra `openapi.json`, regenerado · 2026-10-01
- [ ] Correo de confirmación a cada inscrito: cuando haya proveedor de correo y dominio propio
- [ ] Claves reales de Turnstile y `WAITLIST_CAPTCHA_REQUIRED=true` en el servidor
