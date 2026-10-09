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
  - [x] Secuencia del código de lote sin carreras (EA-07, resto): `lot_sequences` con la fila bloqueada desde la apertura de la Ola 2; probado con embotellados simultáneos · 2026-10-01
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

## Etapa 2 · ERP completo y trazabilidad confiable (Ola 2)

**Objetivo**: un ERP cuyas reglas no se pueden eludir, con el lote como entidad, códigos por botella, expediente con hash y pasaporte público real (docs-back/08 §5; contrato `plan/contratos/o2-erp-confiable.md`).
**Terminado cuando**: el caso "Singani Gran Reserva 2026" se recorre de la parcela a los códigos de botella; las pruebas de elusión fallan con 422/409; el pasaporte público muestra solo datos registrados; el ERP funciona contra el backend real.

- [x] **Apertura (O2-BE-1)** — modelo del lote, migración *expand* con relleno, OpenAPI con todas las rutas del contrato (501 donde falta lógica) y cierres de seguridad en las rutas actuales. · 2026-09-28 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md))
  - [x] Tablas `lots`, `lot_events`, `lot_sequences`, `phyto_decisions`, `maturity_analyses`, `fermentation_tank_inputs`, `bottle_units`, `bottle_code_exports`, `trace_corrections`, `lot_compliance_issues`, `lot_attachments`, `lot_dossiers` y `lot_id` (y autoría por membresía) en la cadena actual; migración aditiva · 2026-09-28
  - [x] Relleno §2.6 (un lote por pesaje con UUID v5, instantánea `MIGRATION`, dictámenes, análisis, entradas, conformidad, códigos de botella, línea de tiempo e incidencias) al arrancar la API; probado sobre una copia con la semilla anterior · 2026-09-28
  - [x] Semilla con lotes y correcciones de realismo documentadas (sin incidencias) · 2026-09-28
  - [x] `details` ampliado (`code`, `rule`, `expected`, `actual`, `meta`) y códigos `TRC_…`/`PUB_…`/`NOT_IMPLEMENTED` · 2026-09-28
  - [x] OpenAPI con las 140 rutas: implementadas `GET/POST /v1/lots`, `GET/PATCH /v1/lots/{id}`, `POST …/discard`, `POST /v1/lots/{id}/bottling[/preview]`, dictámenes y análisis de madurez, `GET /v1/public/wineries`; el resto de rutas del contrato con 501 y su esquema · 2026-09-28
  - [x] Cierres de seguridad en las rutas actuales: EA-04, EA-01, EA-02, EA-03, EA-07, EA-08, SE-07, EA-05 en el grafo legado y plataforma de solo lectura (S-25) · 2026-09-28
  - [x] e2e `traceability-o2` (migración, elusión, secuencias, SE-07, plataforma, 501) validadas contra `openapi.json`; unitarias del dominio · 2026-09-28
  - [x] Contraer en H2: `lot_id NOT NULL`, `Restrict` en las claves antiguas y retirada de las rutas y los campos legados (§16.2) · 2026-10-02 (ver «Cierre H2», abajo; el usuario de base sin `DELETE` queda preparado, sin aplicar)
- [x] **2.1 Lote** (ERP-01, CFG-06) — entidad, instantánea de reglas, estimación con historial, descarte y migración (apertura); línea de tiempo, balance y grafo (2.9); recorrido completo por la API en `test/h2-recorrido.e2e-spec.ts`. · 2026-10-02
- [x] **2.2 Origen y vendimia** (ERP-02…05, EA-03, EA-04) — D.O. calculada, análisis separable, dictamen que bloquea la fermentación y sin autoaprobación (apertura); corrección de los campos normativos de una parcela usada con reevaluación de la D.O. de sus lotes, anulación de un dictamen erróneo e informe del dictamen por su `key` con URL firmada · 2026-10-01
- [x] **2.3 Vinificación** (ERP-06…09) — entradas, capacidad y código físico (apertura); transiciones `start`/`complete`/`clean` con bifurcación coherente con el destino y D.O. comprobada, `TRANSFERRED` automático, `availableLiters`, `transferLossLiters` y `transitions` · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#vinificación-crianza-y-destilación-laboratorio-y-correcciones-pasos-2224-y-27))
- [x] **2.4 Crianza, destilación y reposo** (ERP-10…12) — candados con la instantánea (apertura); cierre de la destilación con cortes tipados y balance de masa, descartes con motivo y tarea diaria `trace.locks.release` en el worker (idempotente, `LOCK_RELEASED`) · 2026-10-01
- [x] **2.5 Embotellado seguro** (ERP-13, 14, 16; EA-01, EA-02, EA-07, OP-06) — reglas en `POST /v1/lots/{id}/bottling[/preview]` (la ruta `POST /v1/bottling` se retiró en H2), `PASSPORT_BASE_URL`. · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#embotellado-seguro-precisiones-del-paso-25)). El recorrido H2 por la API está en `test/h2-recorrido.e2e-spec.ts`; el de las aplicaciones, en O2-E2E-1
  - [x] Huecos cerrados: fuente repetida en `sources` (`TRC_BOTTLING_SOURCE_INVALID`), `liters` parcial que escondía merma (el disponible es la fuente entera; el alcohol, el de los litros tomados), etiqueta ajena o inexistente (`TRC_FILE_NOT_FOUND`), balance de la respuesta con varias fuentes, URL firmada de la etiqueta · 2026-10-01
  - [x] e2e: `TRC_BOTTLING_EXCEEDS_VOLUME`, `TRC_ALCOHOL_BALANCE_EXCEEDED` (tolerancia del 0,5 %, S-11), sin agua en vino (S-12), `TRC_LOT_ALREADY_BOTTLED`, embotellados simultáneos de dos bodegas, de tres lotes de una bodega y del mismo lote · 2026-10-01
- [x] **2.6 Códigos de botella** (ERP-15) — listado y búsqueda, CSV por *streaming*, ZIP para la imprenta en el worker (`trace.bottle-codes.export`), anular y sustituir. · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#códigos-de-botella-paso-26))
  - [x] `GET /v1/lots/{id}/bottle-codes` (rango, estado, `q`); `GET …/export` (CSV); `POST …/exports` y `GET …/exports/{exportId}` (ZIP con `codigos.csv` y `qr/{serial}-{code}.svg|png`, URL firmada de 15 min, caducidad de 7 días); `POST /v1/bottle-codes/{code}/void` (S-14) · 2026-10-01
  - [x] Cada exportación en `bottle_code_exports` y en la bitácora con su rango; anulación en la línea de tiempo y en la bitácora · 2026-10-01
  - [x] Unitarias (dígito de control, CSV, ZIP, PNG del QR, rangos) y e2e con 2.950 y 5.000 botellas · 2026-10-01
- [x] **2.7 Laboratorio y correcciones** (ERP-17, 18; EA-06, EA-08) — conformidad calculada con unidades y reanálisis (apertura); laboratorio del lote con el informe por su `key`; correcciones compensatorias (lista cerrada de campos, `VOID`, rol que crea el registro, revalidación con la instantánea, incidencias `CORRECTION` y `RULES_REEVALUATION` y su resolución) · 2026-10-01
- [x] **2.8 Expediente** (ERP-19) — requisitos, cierre con hash canónico (JCS + SHA-256) y raíz Merkle con sal por botella, descarga del JSON canónico. · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#expediente-del-lote-y-hash-canónico-paso-28))
  - [x] `GET /v1/lots/{id}/dossier/preview`, `POST …/dossier/close` (lote `CERTIFIED`, evento `DOSSIER_CLOSED`, bitácora y `lot.certified` en el outbox), `GET …/dossier`, `GET …/dossier/canonical` · 2026-10-01
  - [x] `TRC_DOSSIER_NOT_READY` (un detalle por requisito) y `TRC_DOSSIER_CLOSED` (segundo cierre, sustituir un código, laboratorio, correcciones y archivos, todos con `assertDossierOpen`); el resto de escrituras de un lote certificado, `TRC_LOT_TERMINAL` · 2026-10-02
  - [x] `bottleMerkleProof` para el pasaporte de la botella (2.10) · 2026-10-01
  - [x] Unitarias (JCS con los ejemplos de la RFC 8785, Merkle, contenido canónico) y e2e (huella recalculada desde los bytes descargados, raíz recalculada desde los códigos) · 2026-10-01
  - [ ] Anclaje del hash en la red: Ola 3 (`lot.certified`)
- [x] **2.9 Vistas del lote** (ERP-20…24, EA-05, SE-07) — línea de tiempo, balance, grafo, panel, reporte y archivos del lote. · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#vistas-del-lote-y-pasaporte-público-pasos-29-y-210))
  - [x] `GET /v1/lots/{id}/timeline` (eventos con actor, registro tardío, candados y fecha estimada) y `GET /v1/lots/{id}/balance` (kilos → litros → botellas con mermas por etapa y proyección S-19; sin volumen registrado la merma es `null`) · 2026-10-01
  - [x] `GET /v1/lots/{id}/graph` con datos reales (`null` = no registrado) y SE-07: bodega dueña y plataforma; cualquier otra sesión → 404 · 2026-10-01
  - [x] `GET /v1/traceability/dashboard` (lotes por etapa, candados en ≤ 14 días, alertas de fermentación S-18, dictámenes pendientes, embotellados sin laboratorio, listos para cerrar, incidencias, uva sin lote) · 2026-10-01
  - [x] `GET /v1/traceability/reports/production` en JSON y CSV (fila por lote, totales por tipo, 422 `TRC_REPORT_TOO_LARGE` sobre 10 000 filas) · 2026-10-01
  - [x] Archivos del lote: `POST/GET /v1/lots/{id}/attachments` y `POST …/{attachmentId}/visibility` sobre `uploads` (privados salvo la etiqueta, S-20; tipo, tamaño y SHA-256; el cambio de visibilidad se registra sin editar el adjunto) · 2026-10-01
  - [x] `corrected` de los nodos del grafo y `corrections` del pasaporte leen `trace_corrections` (la corrección de un análisis, un dictamen, una lectura o un tratamiento marca su pesaje o su tanque); los registros anulados no cuentan en las vistas, el panel, el reporte ni el pasaporte · 2026-10-02
- [x] **2.10 Pasaporte público** (PUB-01, 02, 05; EA-05) — lote y botella con solo datos registrados, límites y caché. · 2026-10-01 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#vistas-del-lote-y-pasaporte-público-pasos-29-y-210))
  - [x] `GET /v1/public/passports/{code}`, `/public/lots/{lotCode}`, `/public/bottles/{code}`: "no registrado" como `NOT_RECORDED`/`null`, roles y no nombres (S-21), sin pesos ni volúmenes (S-22), visible con la bodega suspendida, el lote descartado y el código anulado (S-23) · 2026-10-01
  - [x] `GET /v1/public/lots/{lotCode}/dossier` (bytes canónicos del expediente cerrado) y `…/attachments/{attachmentId}` (302 a una URL firmada, solo adjuntos públicos) · 2026-10-01
  - [x] 404 uniforme, 422 por código mal formado, 60 peticiones/min por IP real (120 en `/public/wineries`) y 429 `PUB_TOO_MANY_LOOKUPS` tras 20 códigos inexistentes en 10 min (S-24); `Cache-Control`, `ETag` y caché en Redis de 60 s que cambia con cada evento del lote (§12.4) · 2026-10-01
  - [x] Prueba Merkle de la botella con la construcción única de `domain/merkle.ts`: reproduce `lot_dossiers.bottle_merkle_root` de un expediente cerrado de verdad; un código anulado antes del cierre no tiene prueba y uno anulado después la conserva (S-14) · 2026-10-02
  - [ ] Eventos `lot.*` del outbox (§15) distintos de `lot.certified`: no se emiten en la Ola 2 (la caché del pasaporte se invalida con la marca de estado del lote en cada lectura); cada uno llega con su consumidor en las Olas 3 y 4 ([`docs/arquitectura/outbox.md`](arquitectura/outbox.md#eventos-y-tareas-de-los-lotes-ola-2))
- [x] **Integración de los tres bloques (O2-BE-1)** — una sola construcción del árbol Merkle, cabos entre bloques y recorrido H2 por la API. · 2026-10-02
  - [x] `domain/merkle.ts` único (hoja `SHA-256("{serie}:{código}:{sal}")`, por serie, el nodo sin pareja sube); el pasaporte usa `closedDossierLeaves` · 2026-10-02
  - [x] Expediente cerrado: laboratorio (también la ruta legada), correcciones y archivos → 409 `TRC_DOSSIER_CLOSED` con `meta.closedAt` y `meta.hash` · 2026-10-02
  - [x] Registros anulados (`voided_at`): fuera de las métricas del grafo, del panel, del reporte y del pasaporte; marcados con `voidedAt` en el expediente canónico · 2026-10-02
  - [x] e2e `h2-recorrido`: lote singani → pesaje → análisis → dictamen → tanque → destilación cerrada con el reposo cumplido → vista previa y 2.950 botellas → CSV y ZIP → laboratorio conforme → cierre → pasaporte de lote y de botella con su prueba Merkle; pruebas de elusión de §18 por el camino · 2026-10-02
  - [x] Worker: un procesador por evento emitido (`lot.certified`, `trace.bottle-codes.export`) y tareas `trace.locks.release` y `trace.bottle-codes.exports-cleanup`, comprobado en `worker.e2e` · 2026-10-02
  - [x] e2e estable: la semilla escribe la bitácora de sus lotes al final de la transacción (ya no retiene el candado de la cadena mientras genera los códigos) y `pnpm test:e2e` corre en serie (`test:e2e:parallel` para la versión rápida) · 2026-10-02
- [x] **Cierre H2 · contraer (O2-BE-1, `v0.2.0`)** — legado retirado y esquema endurecido. · 2026-10-02 ([`docs/arquitectura/trazabilidad.md`](arquitectura/trazabilidad.md#cierre-h2-contracción-v020), [`CHANGELOG.md`](../CHANGELOG.md))
  - [x] Rutas retiradas: `PATCH /v1/harvest-batches/{id}/phyto-status`, `POST /v1/bottling`, `POST /v1/lab-analyses`, `GET /v1/traceability/dag/{bottlingBatchId}`, `GET /v1/traceability/public/{lotCode}` (158 operaciones en el OpenAPI) · 2026-10-02
  - [x] Campos de entrada retirados: dictamen y análisis planos en el pesaje, `isDoEligible` en parcelas y destilación, `harvestBatchId` único en el tanque, cierre de la destilación en su alta, `labelDesignUrl` y `laboratoryReportPdfUrl`; `inputs`, `volumeFilledLiters`, `inputVolumeLiters` y `laboratoryReportKey` pasan a obligatorios · 2026-10-02
  - [x] `TRC_TANK_NOT_COMPLETED` completo: crianza y destilación solo desde un tanque `COMPLETED`; un tanque `COMPLETED` con remanente se cierra con `clean` cuando ya salió una destilación · 2026-10-02
  - [x] Migración *contract* `20261002180000_o2_contraer_h2`: `lot_id NOT NULL` en la cadena, 18 claves a `RESTRICT`, índice único parcial de un código activo por serie, índices de las claves consultadas; falla con un mensaje claro y sin aplicar nada si queda un registro sin lote (`test/migration-contract.e2e-spec.ts`; probada sobre una base con la semilla anterior y sobre otra con datos de la suite) · 2026-10-02
  - [x] Relleno de la apertura retirado (`LOT_BACKFILL_ON_BOOT` ya no existe); la tabla `lot_backfill_pending` se conserva vacía una versión más · 2026-10-02
  - [x] Semilla con los 21 lotes de los mocks 0.5.0 (uno o más por etapa, el Gran Reserva con el expediente cerrado), de solo inserción, sin incidencias · 2026-10-02
  - [x] `sha256` de los archivos subidos y del informe de laboratorio; el contador diario de lecturas se recalcula al anular una lectura · 2026-10-02
  - [ ] Usuario de base sin `DELETE` en la trazabilidad: `deploy/dev/sql/rol-app-sin-delete.sql` preparado y probado en local; lo aplica la coordinación en el servidor ([`deploy/README.md`](../deploy/README.md#2-usuario-de-base-sin-delete-en-la-trazabilidad-opcional-preparado))
  - [ ] Lotes de demostración ya sembrados en el servidor: la semilla no los reescribe; recrearlos es una decisión de la coordinación (`deploy/dev/sql/reiniciar-trazabilidad-demo.sql`)

**Etapa 2 completa en el backend** (versión `0.2.0`; la etiqueta `v0.2.0` la crea la coordinación al fusionar `dev → main`). Quedan fuera, con su ola: el anclaje del hash en la red y el resto de eventos `lot.*` (Olas 3 y 4).

## Etapa 3 · Tokenización y cadena (Ola 3)

**Objetivo**: cada bodega activa con su cuenta y su contrato NFT en Stellar; la bodega autoriza la tokenización de un lote y el back office la aprueba; emisión en lote, preventa, anclaje del expediente y conciliación (docs-back/08 §7; contrato `plan/contratos/o3-tokenizacion.md`).
**Terminado cuando**: el recorrido H3 se completa en testnet (identidad de la bodega, 100 NFT emitidos y publicados, ampliación a 150, anclaje verificado en el visor, conciliación `OK`) y las pruebas negativas del contrato §14 responden su código.

- [x] **Apertura (O3-BE-1)** — OpenAPI con las rutas de la ola (501 donde falta lógica), migración *expand*, SE-02 y custodia de claves. · 2026-10-08 ([README](../README.md#-cadena-y-tokenización-ola-3--apertura))
  - [x] Módulos `chain` y `tokenization` (etiquetas `Chain`, `Tokenization`, `Public`): **54 rutas nuevas, todas con `501 NOT_IMPLEMENTED`** y su forma definitiva (212 operaciones en el OpenAPI): transacciones, cuentas de la plataforma, identidad y pausa de la bodega, eventos, conciliación y alertas; solicitudes del ERP y bandeja del back office; colecciones, NFT, cierre con faltante y métricas; `stellar.toml`, registro, metadatos del NFT, verificación del anclaje e imágenes públicas de las colecciones · 2026-10-08
  - [x] Sesión, organización, rol, `Idempotency-Key` obligatoria (10 rutas, §0), `reason` (10 rutas) y cuerpo se validan ya: un 501 significa "llegaste a la lógica, que aún no existe" · 2026-10-08
  - [x] Ampliaciones aditivas de las Olas 1 y 2, con datos reales: `LotSummary.tokenization` (`NONE`), 6 tipos nuevos en la línea de tiempo, `LotDossier.anchor` y `PublicLotPassport.dossier.anchor` con forma (siguen `null`), bloques `tokenization` y `chain` del tablero y `tokenization` del panel del ERP (cuentan las tablas nuevas: cero) · 2026-10-08
  - [x] Migración *expand* `20261008120000_o3_cadena_expand`: 19 tablas (`chain_accounts`, `nft_contracts`, `chain_transactions`, `chain_tx_attempts`, `chain_events`, `chain_cursors`, `chain_alerts`, `reconciliation_runs`, `tokenization_requests`, `tokenization_request_changes`, `collections`, `collection_images`, `collection_status_history`, `mints`, `tokens`, `lot_closures`, `lot_closure_items`, `dossier_anchors`, `consumer_addresses`) con sus invariantes (`CHECK minted ≤ quota`, una colección por lote, una solicitud abierta por lote, un anclaje por expediente, `intent_key` y `rpc_event_id` únicos) · 2026-10-08
  - [x] SE-02 en los datos: los valores simulados de `wineries` pasan a `legacy_simulated_address` / `legacy_simulated_data` y quedan a `NULL`; `user_wallets` entera `INVALID_SIMULATED`; nada se borra; la API anota `CHAIN_SIMULATED_WALLETS_INVALIDATED` una sola vez al arrancar. Probada sobre una base con la semilla de `v0.2.0` (6 bodegas, 18 personas, 21 lotes) y en `test/tokenization-o3.e2e-spec.ts` · 2026-10-08
  - [x] SE-02 en el código: fuera `MockDynamicWalletProvider`, la creación de billeteras al registrarse o aceptar una invitación y los procesadores `winery.created` / `member.added`; `GET /v1/users/me/wallet` → 404 `CHN_WALLET_NOT_AVAILABLE` al personal; `WineryResponseDto` con los campos legados en `null`; la semilla ya no escribe direcciones de relleno · 2026-10-08
  - [x] Custodia de claves (`KeyCustody`, §2.1): drivers `LOCAL` (memoria, pruebas) y `ENV` (solo testnet y red local; bodegas derivadas con SEP-0005 de `CHAIN_DEV_WINERY_SEED` por `derivationIndex`), solo en el worker; variables de §2.1 validadas y **todas opcionales** (sin ellas, cadena deshabilitada); `CHAIN_MINT_ENABLED=false` por defecto (ADR-011) · 2026-10-08
  - [x] Pruebas: unitarias (vectores de SEP-0005, custodios, configuración sin fugas de secretos, enlaces del explorador, memo hex ↔ base64, tablero, permisos) y e2e (migración sobre datos, invariantes, SE-02, las 54 rutas con 501/401/403/422 validadas contra `openapi.json`) · 2026-10-08
  - [ ] Copia de la base y despliegue de la apertura en el servidor de desarrollo (coordinación)
  - [ ] Cuentas de operaciones y de anclaje generadas en el servidor y fondeadas con Friendbot (coordinación; `deploy/dev/.env.example`)
- [x] **3.1 Firmante y transacciones** (CHN-04, CHN-05, CHN-06) — firmante que solo acepta intenciones, cola `chain`, estados y reintentos, idempotencia en la red, `GET/POST /v1/platform/chain/transactions…`, `GET /v1/platform/chain/accounts`. · 2026-10-09 ([README](../README.md#firmante-transacciones-e-identidad-de-la-bodega-pasos-31-y-32))
  - [x] `@stellar/stellar-sdk` 17.2.1 fijada (protocolo 29) · 2026-10-09
  - [x] Registro de intenciones por el outbox (`chain.tx.requested`, `intentKey` única) y firmante aislado en el worker: validación de §2.2 con la fila bloqueada (`CHN_INTENT_REJECTED`, nunca se firma), firma separada de la autorización (bodega) y del sobre (operaciones), sin fee-bump · 2026-10-09
  - [x] Ciclo de estados con historial (`chain_tx_attempts`), reintentos de S-4, `-32603` → reenvío de la misma transacción, idempotencia en la red (hash antes de enviar; reconstruir solo con `NOT_FOUND` y `maxTime` vencido) y una transacción en vuelo por cuenta de origen · 2026-10-09
  - [x] Colas `chain` y `chain-poll`; tareas `chain.tx.poll`, `chain.balance.check` y `chain.testnet.fund`; `FUND_ACCOUNT` por Friendbot (solo `TESTNET`/`LOCAL`) · 2026-10-09
  - [x] Rutas reales: lista y detalle de transacciones, `retry`, `abandon` y `accounts`; `explorerUrl` construido en el backend; bitácora (`CHAIN_TX_RETRIED`, `CHAIN_TX_ABANDONED`) y eventos `chain.tx.confirmed`, `chain.tx.failed` y `chain.alert.raised` · 2026-10-09
  - [x] Driver `ENV` completo (`ensureKey` asigna el índice de derivación de la bodega; comprobación de la semilla de consumidores al arrancar) y `deploy/dev/generar-claves-cadena.sh` · 2026-10-09
  - [ ] Pendiente de su paso: `CHN_ARCHIVED_ENTRY` → `RESTORE_ENTRIES` encadenado y `codeTtlDays` (3.6); `CHN_MINT_DISABLED` y la comparación de `total_minted()` (3.4); correo a operaciones de las alertas `CRITICAL` (3.6)
- [x] **3.2 Identidad de la bodega** (CHN-01, CHN-02, ORG-06, SE-02) — cuenta y contrato al activarse, `chain/provision`, pausa en la red, `stellar.toml`, registro público, relleno de las bodegas activas. · 2026-10-09
  - [x] `winery.activated` → `CREATE_WINERY_ACCOUNT` + `DEPLOY_WINERY_CONTRACT` (sal y constructor de §3.1) con lectura de vuelta antes de `ACTIVE`; `WINERY_CHAIN_IDENTITY_CREATED` y `winery.chain_identity_ready` · 2026-10-09
  - [x] `POST …/chain/provision`, `…/chain/pause` y `…/chain/unpause`; `winery.status_changed` (nuevo, aditivo en O1): revocar una bodega pausa su contrato en la red · 2026-10-09
  - [x] `GET /.well-known/stellar.toml`, `GET /v1/public/chain/registry` y `chain-account` del ERP y de la plataforma (colecciones en cero hasta 3.4) · 2026-10-09
  - [x] `chain.identity.backfill`: de una en una y solo bodegas `ACTIVE`; compatibilidad de §3.3.5 (`stellarPublicKey` real y `onchainRegisterTxHash`) · 2026-10-09
  - [x] Pruebas: unitarias (estados, validación de intenciones, reintentos, clasificación de errores, parámetros del contrato, `stellar.toml`, generación de claves) y e2e contra la red local en la CI (`test/chain-o3.e2e-spec.ts`: Friendbot, identidad completa, idempotencia, relleno, pausa y reanudación, revocación, RPC detenido, respuesta perdida, secuencia en conflicto, autorización inválida, intención rechazada, permisos) · 2026-10-09
  - [ ] Habilitar la cadena en el servidor de desarrollo (coordinación; `deploy/README.md` §5)
- [x] **3.3 Solicitud de tokenización** (TOK-01…05) — reglas de la cuota, solicitudes del ERP, bandeja, datos comerciales y precio, aprobar, pedir cambios y rechazar; `TOK_ESTIMATE_BELOW_MINTED` en `PATCH /v1/lots/{id}`. · 2026-10-09
  - Sin red: aprobar crea en una transacción la colección `MINTING` (o amplía la cuota), el `Mint` `PENDING` con sus trozos de hasta 32 000 y el evento `tokenization.request_approved` (cola `chain`). La tokenización habla con la cadena por el puerto `TOKENIZATION_CHAIN_PORT` (`src/modules/tokenization/ports/`), hoy con un adaptador que solo lee `chain_accounts` y `nft_contracts`; los pasos 3.2 y 3.4 enlazan el suyo.
  - `tokenizacion.requiereAprobacion = false` (S-11): la solicitud se aprueba sola al enviarse si cumple todo lo que exige aprobar; si no, queda para operaciones.
  - Bodega suspendida o revocada (§3.5, parte de base de datos): colecciones publicadas a `PAUSED` por el sistema; al revocar, solicitudes abiertas rechazadas.
  - Adelantado del paso 3.4 (lo que no necesita la red): lecturas de colecciones del ERP y del back office, editar datos comerciales y precio con historial, `publish`, `pause`, `resume`, `close`, NFT y transacciones paginados, métricas (TOK-11), metadatos públicos del NFT e imágenes públicas de las colecciones. Quedan con 501 el cierre con faltante (3.6) y las rutas de `chain`.
- [ ] **3.4 Emisión y preventa** (CHN-07, TOK-06…08) — `MINT_BATCH` por trozos, colecciones, NFT, publicar, pausar, reanudar, ampliar la cuota, metadatos públicos e imágenes. Falta lo que necesita la red: registrar y enviar las intenciones `MINT_BATCH` (consumiendo `tokenization.request_approved` o por el puerto), confirmar la emisión (`Token`, `READY`, `publishOnMint`), `NFT_MINTED` y su correo.
- [ ] **3.5 Anclaje** (CHN-10, TOK-09, PUB-03) — `ANCHOR_DOSSIER` al certificar, lote `ANCHORED`, NFT canjeables, verificación pública.
- [ ] **3.6 Conciliación y cierre** (CHN-11…13, TOK-10, TOK-11, ORG-12) — indexador, conciliación y alertas, TTL, cierre con faltante, métricas y cuenta de la bodega.
- [ ] **Cierre H3 · contraer** — se borran `user_wallets` y las columnas simuladas de `wineries`; se retira `GET /v1/users/me/wallet` del personal y los campos legados de `WineryResponseDto`; OpenAPI borrador de la Etapa 4; `v0.3.0`.
