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
- [x] **0.6 Organizaciones y membresías** (EQP-01, EQP-09, IAM-08, SE-01, OP-05, OP-07) · 2026-09-27
  - [x] Tablas `organizations` (bodega = mismo id) y `memberships`; estado de bodega `INVITED` (antes `PENDING`, contrato O1 §0) · 2026-09-27
  - [x] Migración de datos probada sobre una copia con datos: `PLATFORM_ADMIN` → `SUPERADMIN`, `winery_members` → membresías `WINERY` (mismo id); seeder idempotente · 2026-09-27
  - [x] Organización activa por defecto (última usada; si no, la primera activa, plataforma antes que bodega), `POST /auth/switch-organization`, `GET /users/me` con `{ user, memberships, activeOrganizationId }` · 2026-09-27
  - [x] Guards globales y `@Audience`/`@OrgType`/`@Roles`/`@RequireActiveOrg` por membresía; matriz de roles del ERP de docs-back/05 §3; plataforma con `?wineryId=` obligatorio en escrituras (OP-07); SE-05 como aviso (`FEATURE_ENFORCE_ACTIVE_ORG`) · 2026-09-27
  - [x] SE-01: las rutas de una bodega solo crean o reactivan su propia membresía; nada escribe ya `users.user_role` · 2026-09-27
  - [ ] Retirar `users.user_role`, `winery_members` y los campos de compatibilidad (cierre de la Ola 1, H1)
- [ ] **0.7 Bitácora base** (AUD-01, AUD-02) — registro en la misma transacción, solo inserción, encadenada por hash.
- [ ] **0.8 Configuración base** (CFG-01, CFG-05) — definiciones de parámetros y valor efectivo con caché.
- [ ] **0.9 Servicios comunes** (CMP-01, OPS-06, OPS-12, OPS-01, OPS-03, SE-04, SE-08) — correo con plantillas y cola (Mailpit en desarrollo), almacenamiento privado con URL firmadas (MinIO), OpenAPI publicado (hecho en 0.3), healthcheck y logs JSON.
- [ ] **0.10 Datos de demostración** (OPS-09) — semilla determinista alineada con los mocks del frontend.
