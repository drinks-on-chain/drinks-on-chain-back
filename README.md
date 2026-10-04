# 🍷 Drinks on Chain — Backend API

> **Plataforma Integral de Trazabilidad Agroalimentaria B2B, Tokenización RWA (Real World Assets) y Comercio Electrónico Web3 sobre la Blockchain Stellar.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11.0-ea2849.svg?logo=nestjs)](https://nestjs.com/)
[![Prisma ORM](https://img.shields.io/badge/Prisma-6.4-2D3748.svg?logo=prisma)](https://www.prisma.io/)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-08B5E5.svg?logo=stellar)](https://stellar.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg?logo=postgresql)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-100%25%20Passing-brightgreen.svg)]()

---

## 📖 1. Idea General del Proyecto

**Drinks on Chain** es un ecosistema tecnológico diseñado para digitalizar, certificar y tokenizar la cadena de valor de la industria vitivinícola, destilerías de altura (**Singani Boliviano con Denominación de Origen**) y cervecerías artesanales.

### 🌟 Pilares Fundamentales

1. **ERP de Trazabilidad Agroalimentaria B2B:** Registro granular y encadenado de la custodia desde la parcela agrícola, recepción en báscula con pesaje neto, fermentación con control térmico, destilación en alambique o crianza en barrica, hasta el fraccionamiento y embotellado final.
2. **Cumplimiento Normativo y Enológico Automatizado:** Reglas de validación estrictas basadas en normativas bolivianas e internacionales (SENASAG, ISO 17025, Denominación de Origen Singani con altitud $\ge 1,600$ msnm, 100% uva Moscatel de Alejandría y reposo inerte obligatorio de 180 días).
3. **Pasaporte Digital de Producto (Acceso QR):** Generación automática de códigos QR físicos vinculados a un árbol genealógico DAG (*Directed Acyclic Graph*) que permite a consumidores, inspectores y distribuidores auditar el origen exacto del producto.
4. **Anclaje Criptográfico y Tokenización RWA (Fases 5+):** Estructuración de datos y hashes SHA-256 compatibles con los contratos inteligentes Soroban ([`docs/contratos/trazabillidad.rs`](docs/contratos/trazabillidad.rs)) para emisión de NFTs de custodia, compras anticipadas (*en primeur*), redención física y liquidación en Stellar USDC.

---

## 📊 2. Estado Actual del Proyecto

El desarrollo del backend se estructura en **9 fases progresivas**. Actualmente se han completado al 100% las **Fases 1 a 4**:

```mermaid
flowchart LR
    F1["✅ Fase 1<br/>Scaffolding & Infra"] --> F2["✅ Fase 2<br/>Smart Contracts Base"]
    F2 --> F3["✅ Fase 3<br/>Identidad, Auth & Multi-Tenancy"]
    F3 --> F4["✅ Fase 4<br/>ERP de Trazabilidad & Strategy Pattern"]
    F4 -.-> F5["⏳ Fase 5<br/>Tokenización & Vaults"]
    F5 -.-> F6["⏳ Fase 6<br/>Pagos & Órdenes"]
    F6 -.-> F7["⏳ Fase 7<br/>Claims & POS"]
    F7 -.-> F8["⏳ Fase 8<br/>Indexer Stellar"]
    F8 -.-> F9["⏳ Fase 9<br/>Visor Público & Reviews"]
```

### 📈 Métricas de Calidad Actuales
- **Pruebas Unitarias:** `686/686` tests pasando (73 suites).
- **Pruebas E2E:** `326/326` tests pasando (24 suites, contra Postgres, Redis y Mailpit reales).
- **Compilación TypeScript:** modo estricto (`strict: true`) sin errores; ESLint 9 sin errores (CI en cada push y PR).
- **Base de Datos:** 47 modelos relacionales y 36 enums migrados y sincronizados en PostgreSQL (incluidos el outbox, las organizaciones, las membresías, las sesiones y el lote con su cadena).

---

## 🏗️ 3. Estructura del Repositorio

```
drinks-on-chain-backend/
├── docs/                               # Documentación de arquitectura y especificaciones
│   ├── architecture/                   # Diagramas y flujos de trazabilidad / Stellar
│   ├── bd/                             # Diccionario de datos y catálogo de tablas
│   ├── contratos/                      # Contratos inteligentes Soroban (Rust)
│   ├── demo/                           # Guías de pruebas manuales y payloads de ejemplo
│   ├── endpoints/                      # Catálogo exhaustivo de endpoints de la API
│   └── implementation/                 # Planes y UTs ejecutadas por fase
├── prisma/                             # Esquema y migraciones de base de datos
│   ├── migrations/                     # Historial de migraciones PostgreSQL
│   └── schema.prisma                   # Definición de modelos, enums y relaciones
├── src/                                # Código fuente de la aplicación NestJS
│   ├── config/                         # Validación de variables de entorno (Joi)
│   ├── modules/                        # Módulos de dominio de la aplicación
│   │   ├── auth/                       # Sesiones (acceso + doc_rt), guards globales, límites
│   │   ├── organizations/              # Organizaciones y membresías (roles por organización)
│   │   ├── harvest-batches/            # Pesaje, análisis de madurez y dictámenes
│   │   ├── lots/                       # Lote del servidor (Ola 2): reglas, relleno, embotellado seguro
│   │   ├── health/                     # Healthcheck y diagnóstico de base de datos / Redis
│   │   ├── terroirs/                   # Parcelas agrícolas, GeoJSON y altitud msnm
│   │   ├── traceability/               # Núcleo ERP: Fermentación, Crianza, Destilación,
│   │   │   │                           # Embotellado, Laboratorio, DAG Builder & Strategies
│   │   │   ├── controllers/            # Controladores REST API
│   │   │   ├── dto/                    # DTOs tipados con class-validator y Swagger
│   │   │   ├── hooks/                  # Hooks desacoplados para simulación on-chain
│   │   │   ├── services/               # Lógica de negocio y persistencia Prisma
│   │   │   └── strategies/             # Strategy Pattern (Vino, Singani, Cerveza)
│   │   ├── uploads/                    # Subida multiparte de imágenes y PDFs con validación MIME
│   │   ├── users/                      # Perfiles de usuario y gestión de cuenta
│   │   ├── wallets/                    # Provisión de billeteras custodiales en Stellar
│   │   └── wineries/                   # Onboarding institucional y membresías
│   │       └── jobs/                   # Procesadores del worker (winery.created, member.added)
│   ├── worker/                         # Proceso worker: relay del outbox, colas BullMQ,
│   │                                   # tareas programadas, latido (healthcheck)
│   ├── main.ts                         # Proceso api (HTTP)
│   ├── worker.ts                       # Proceso worker (sin HTTP)
│   └── shared/                         # Utilidades transversales e interceptores
│       ├── decorators/                 # @CurrentUser(), @TenantId(), @Public()
│       ├── filters/                    # GlobalExceptionFilter (estándar de error API)
│       ├── interceptors/               # ResponseTransformInterceptor (envelope { success: true })
│       ├── logging/                    # Logger JSON con correlationId
│       ├── outbox/                     # OutboxService.add(tx, evento): outbox transaccional
│       ├── prisma/                     # PrismaService singleton
│       ├── queue/                      # Colas nombradas, @HandlesJob, @ScheduledTask
│       ├── storage/                    # IStorageService agnóstico (Local, S3, Supabase)
│       └── utils/                      # Criptografía SHA-256, utilitarios de QR y sanitización
└── test/                               # Suite de pruebas de integración End-to-End (E2E)
    ├── app.e2e-spec.ts
    ├── auth-multi-tenancy.e2e-spec.ts
    └── traceability.e2e-spec.ts
```

---

## 📐 4. Estándares y Patrones de Arquitectura

1. **Clean Architecture & Modular Monolith:** Cada módulo es autónomo, delimitado por dominios y expone interfaces claras.
2. **Strategy Pattern para Bebidas (`ITraceabilityStrategy`):** Motor de validación polimórfico que desacopla las reglas agronómicas y de madurez según la categoría:
   - `WineTraceabilityStrategy`: Control de °Bx, crianza en barrica con bloqueo de fecha `lockUntilDate`.
   - `SinganiTraceabilityStrategy`: Restricción estricta de altitud $\ge 1,600$ msnm, 100% Moscatel de Alejandría, balance de masa en alambiques y **180 días obligatorios de reposo inerte**.
   - `BeerTraceabilityStrategy`: Control de densidades y atenuación de levaduras cerveceras.
3. **Multi-Tenancy Estricto (`TenantGuard` & `@TenantId()`):** Aislamiento de datos a nivel de base de datos (`wineryId`) garantizando que ningún usuario acceda o vincule recursos de otra bodega (seguridad por oscuridad con respuesta `404 Not Found`).
4. **Sesiones seguras y roles por membresía** (Ola 0 · 0.5–0.6, detalle en [`docs/arquitectura/identidad.md`](docs/arquitectura/identidad.md)):
   - **Sesión**: acceso JWT de 15 min con `sid` y organización activa (`org`, `orgType`, `role`); renovación **rotativa** en la cookie `HttpOnly` `doc_rt` (7 días el personal, 30 los consumidores, deslizante), con **detección de reutilización** (revoca la sesión) y un periodo de gracia de 20 s para pestañas concurrentes; `logout` y `logout-all`; revocación inmediata al bloquear una persona o una membresía (lista de `sid` en Redis + sesión en la base).
   - **Organizaciones y membresías**: una persona puede estar en varias organizaciones (`PLATFORM`, `WINERY`, `PICKUP_POINT`) con un rol en cada una: plataforma `SUPERADMIN`/`ADMIN`/`OPERATIONS`/`SUPPORT`; bodega `OWNER`/`ENOLOGIST`/`AGRONOMIST`/`OPERATOR`/`ACCOUNTANT`. La organización activa se elige con `POST /v1/auth/switch-organization`; `GET /v1/users/me` devuelve `{ user, memberships, activeOrganizationId }`.
   - **Autorización**: guards globales (límite por IP real → acceso y sesión viva → `@Audience`/`@OrgType`/`@Roles` contra la organización activa → bodega de la petición). El personal de plataforma opera sobre una bodega con `?wineryId=` (obligatorio en escrituras). Una bodega solo puede añadir o reactivar membresías **de sí misma** (SE-01).
   - Sin rol global desde H1: `users.user_role` y los campos de compatibilidad (`user.userRole`, `wineryId`, `memberRole`, `tokens.refreshToken`) se retiraron al cerrar la Ola 1. `winery_members` sigue como autoría de la trazabilidad y matrícula (mismo id que la membresía).
   > 🔒 El endpoint público `POST /v1/auth/signup` solo crea **consumidores**; el superadministrador sale de la semilla (`SUPERADMIN_*`, membresía `SUPERADMIN` de la organización de plataforma) y el personal de bodega entra por invitación. Login con bloqueo progresivo por correo e IP (429 `AUTH_TOO_MANY_ATTEMPTS`).
   - **Alta de bodegas y equipo** (Ola 1 · 1.3–1.6, detalle en [`docs/arquitectura/organizaciones.md`](docs/arquitectura/organizaciones.md)): solicitud pública con captcha y verificación del correo (`/v1/public/winery-applications`) o alta directa (`/v1/platform/wineries`); la bodega nace `INVITED` con la invitación del dueño y pasa a `ACTIVE` —con su **prefijo de lote único**— cuando él acepta. Suspender, reactivar, revocar y transferir la titularidad desde el back office. **SE-05 activo**: el ERP responde 403 `ORG_NOT_ACTIVE` a una bodega no `ACTIVE` (el perfil y la bitácora propia se leen suspendida). Equipo del dueño y del back office con bloqueos que cierran las sesiones al instante.
5. **Trazabilidad confiable con el lote del servidor** (Ola 2, `v0.2.0`; detalle en [`docs/arquitectura/trazabilidad.md`](docs/arquitectura/trazabilidad.md) y cambios incompatibles en [`CHANGELOG.md`](CHANGELOG.md)): el **lote** (`/v1/lots`) agrupa la cadena y guarda la **instantánea de reglas** con la que se valida siempre; los datos anteriores se migran con un lote por pesaje (UUID v5) y lo que no cumple queda como incidencia. Reglas en el servidor con el reloj de la base, sin elusión posible: dictamen fuera del alta y exigido para fermentar (EA-04), tipo del embotellado derivado del origen y candados de la instantánea (EA-01), un embotellado por lote con balance de volumen y alcohol y un código por botella (EA-02), D.O. calculada (EA-03), secuencias sin carreras (EA-07), conformidad de laboratorio con unidades (EA-08), grafo solo para la bodega dueña y la plataforma (SE-07) y **plataforma de solo lectura** (403 `TRC_PLATFORM_READ_ONLY`). Errores `TRC_…` con `details` ampliado (`code`, `rule`, `expected`, `actual`, `meta`); ya no queda ninguna ruta del contrato con 501 `NOT_IMPLEMENTED`. Las transiciones del tanque, el cierre de la destilación, los descartes, el laboratorio por lote y las **correcciones compensatorias** (pasos 2.3, 2.4 y 2.7), los **códigos de botella** (listado, CSV, ZIP para la imprenta, anular y sustituir; paso 2.6) y el **expediente** con hash canónico (JCS + SHA-256) y raíz Merkle de los códigos (paso 2.8) tienen su lógica. Las **vistas del lote** (línea de tiempo, balance, grafo, panel, reporte de producción y archivos) y el **pasaporte público** de lotes y botellas (`/v1/public/passports/{code}`: solo datos registrados, roles y no nombres, 404 uniforme, freno a la enumeración y caché; la botella trae la prueba Merkle que reproduce la raíz del expediente cerrado) también (pasos 2.9 y 2.10). **Cierre H2**: las rutas y los campos legados se retiraron, toda la cadena lleva su lote (`lot_id NOT NULL`), las claves foráneas son `RESTRICT` (nada se borra por arrastre) y hay un solo código activo por serie de botella, también en la base.
6. **Grafo del lote** (`GET /v1/lots/{id}/graph`): linaje acíclico parcela → vendimia → vinificación → destilación o crianza → embotellado, con los datos registrados (`null` = no registrado), solo para la bodega dueña y la plataforma (SE-07). El grafo DAG anterior (`/v1/traceability/dag/…` y `/v1/traceability/public/…`) se retiró en H2; el público es el pasaporte (`/v1/public/passports/{code}`).
7. **Formato Estándar de Respuesta API:**
   ```json
   // Respuesta Exitosa
   {
     "success": true,
     "statusCode": 200,
     "timestamp": "2026-09-07T12:00:00.000Z",
     "path": "/v1/...",
     "data": { ... }
   }

   // Colección (toda lista, con ?limit=1..100 (20) y ?offset>=0)
   { "success": true, "...": "...", "data": { "items": [ ... ], "total": 47, "limit": 20, "offset": 0 } }

   // Respuesta de Error (validación → 422 con un detalle por campo)
   {
     "success": false,
     "statusCode": 422,
     "timestamp": "2026-09-07T12:00:00.000Z",
     "path": "/v1/...",
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "Validation failed",
       "details": [{ "field": "grossWeightKg", "message": "..." }]
     }
   }
   ```
   Estándares completos (A-33: listas, errores, `Idempotency-Key`, 429 con `Retry-After`) en [`docs/rules/03-formato-respuestas.md`](docs/rules/03-formato-respuestas.md).

   Los `Decimal` de Prisma salen como **números JSON** (`"surfaceHectares": 5`, no `"5"`), como declara `openapi.json`: los convierte `ResponseTransformInterceptor` (`src/shared/utils/decimal-json.util.ts`). La bitácora (`before`/`after`) guarda los decimales como texto exacto, igual que antes. Para comprobar una respuesta contra el contrato en un e2e: `loadOpenApiValidator().expectResponse('get', path, res)` (`test/helpers/openapi-validator.ts`).

---

## ⚙️ 5. Pasos para Levantar el Proyecto

### 📋 Prerrequisitos
- **Node.js 22** (`.nvmrc`; `nvm use`) y **pnpm 10.28** (`corepack enable`: toma la versión de `package.json#packageManager`).
- **Docker** con el plugin `compose`.

### 🚀 Desarrollo local

```bash
pnpm install
cp .env.example .env              # cambia cada change-me (openssl rand -hex 32)
docker compose up -d              # Postgres 5435, Redis 6379, Mailpit 1025/8025, MinIO 9000/9001
pnpm prisma:deploy                # aplica las migraciones (o pnpm prisma:migrate al crear una nueva)
pnpm seed                         # superusuario y datos de demostración (idempotente; ver "Datos de demostración")
pnpm start:dev                    # API en http://localhost:4000/v1 · Swagger en /docs
pnpm start:worker:dev             # worker (otra terminal): outbox, colas y tareas programadas
```

- Todos los puertos de `docker-compose.yml` se publican solo en `127.0.0.1`; las contraseñas salen del `.env` (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD`) y deben coincidir con `DATABASE_URL` y `REDIS_URL`.
- La API usa el puerto **4000** en local (el 3000 es del sitio de bodegas y el 3002 del ERP).
- La API y el worker también pueden correr en contenedor: `docker compose --profile app up -d --build` (la API migra al arrancar; el worker arranca cuando la API está sana).
- Mailpit: <http://localhost:8025> (ahí llegan los correos del worker). MinIO: consola en <http://localhost:9001>; la API guarda los archivos en el bucket `S3_BUCKET` (lo crea al arrancar).

#### Variables de entorno

`.env.example` documenta cada variable; la validación está en `src/config/env.validation.ts`. Solo son obligatorias `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` y `JWT_REFRESH_SECRET` (y `CORS_ALLOWED_ORIGINS` en producción). Detrás de un proxy, `TRUST_PROXY=1` (el servidor de desarrollo ya lo fija en `deploy/dev/compose.yml`); `JWT_REFRESH_EXPIRES_IN` ya no se usa. Stellar y el indexador son opcionales hasta la Ola 3; las variables de Dynamic, Supabase, pasarela bancaria y los contratos `CONTRACT_*` antiguos ya no se leen.

Variables nuevas de la Ola 0 · 0.7–0.9 (todas con valores por defecto de desarrollo, ver [`docs/arquitectura/correo-y-archivos.md`](docs/arquitectura/correo-y-archivos.md)):

| Variable | Proceso | Uso |
|---|---|---|
| `STORAGE_DRIVER` | api | `s3` (MinIO) o `local` (pruebas); por defecto `local` |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` | api | Almacenamiento S3 compatible; obligatorias `S3_BUCKET`, `S3_ACCESS_KEY` y `S3_SECRET_KEY` con `STORAGE_DRIVER=s3` |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | api | Vida de las URL firmadas (900 s) |
| `STORAGE_LOCAL_PATH`, `STORAGE_BASE_URL`, `STORAGE_SIGNING_SECRET` | api | Driver local: carpeta, origen público de la API y secreto de las URL firmadas |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`, `MAIL_REPLY_TO` | worker | Correo; por defecto Mailpit en `localhost:1025` |
| `LOG_FORMAT` | api, worker | `json` (por defecto) o `text` |
| `SWAGGER_ENABLED` | api | Sin definir: activo fuera de producción, apagado en producción |

Variables nuevas de la Ola 1 · 1.1–1.2 (cuenta, segundo factor e invitaciones; ver [`docs/arquitectura/identidad.md`](docs/arquitectura/identidad.md)):

| Variable | Proceso | Uso |
|---|---|---|
| `MFA_ENCRYPTION_KEY` | api | Clave (≥ 32 caracteres, `openssl rand -base64 32`) con la que se cifran los secretos TOTP en la base (AES-256-GCM). Sin ella la API arranca con una clave derivada de `JWT_SECRET` y lo avisa en el log; lo cifrado así se sigue leyendo cuando se define |
| `TURNSTILE_SECRET_KEY` | api | Captcha de los formularios públicos (Cloudflare Turnstile). Obligatoria en producción; fuera de ella, y por defecto en `deploy/dev/compose.yml`, la clave de prueba que siempre valida (`1x0000000000000000000000000000000AA`, sin llamar a Cloudflare) |
| `APP_URL_ERP`, `APP_URL_BACKOFFICE`, `APP_URL_POS`, `APP_URL_MARKETPLACE` | api | URL base de cada app en los enlaces de los correos. Por defecto `http://localhost:3002`, `3003`, `3004`, `3005`; en el servidor de desarrollo, las de Vercel del ERP y el Backoffice |
| `APP_URL_BODEGAS` | api | Sitio de bodegas: enlace de verificación de las solicitudes de alta (`/unirse/verificar?token=`). Por defecto `http://localhost:3000`; en el servidor de desarrollo, `https://drinks-on-chain-bodegas.vercel.app` (1.3) |
| `RATE_LIMIT_APPLICATION_PER_MINUTE` | api | Envíos del formulario público de solicitud por IP y minuto (5); además, como mucho 3 por correo y 10 por IP en una hora (el resto, 202 sin crear nada) |
| `FEATURE_ENFORCE_ACTIVE_ORG` | api | SE-05. **Activo por defecto** desde la Ola 1 (403 `ORG_NOT_ACTIVE`); `false` lo deja solo en aviso en los logs |
| `SEED_DEMO_TOTP_SECRET` | semilla | Secreto TOTP (base32) del personal interno de demostración (`DRINKSONCHAINDEMOTOTPKEY` = el de los mocks). Sin él, lo inscriben al entrar |

Variables nuevas de la lista de espera (v0.1.1; ver [Lista de espera](#-lista-de-espera-v011)):

| Variable | Proceso | Uso |
|---|---|---|
| `WAITLIST_LIMIT_IP_MINUTE` | api | Inscripciones por IP real y minuto (20) |
| `WAITLIST_LIMIT_IP_HOUR` | api | Inscripciones por IP real y hora (300) |
| `WAITLIST_LIMIT_EMAIL_HOUR` | api | Inscripciones por correo y hora (3) |
| `WAITLIST_CAPTCHA_REQUIRED` | api | `true` exige `captchaToken` válido de Turnstile; por defecto `false` (campo trampa y límites) |

Variables nuevas de la Ola 2 (trazabilidad confiable; ver [`docs/arquitectura/trazabilidad.md`](docs/arquitectura/trazabilidad.md)):

| Variable | Proceso | Uso |
|---|---|---|
| `PASSPORT_BASE_URL` | api, semilla | Base del QR del lote y de cada botella: `{PASSPORT_BASE_URL}/b/{código}` (OP-06). Por defecto `APP_URL_MARKETPLACE`; si tampoco, `http://localhost:3005`. En desarrollo, la URL del Marketplace de desarrollo |
| `MIGRATE_DATABASE_URL` | imagen (`docker/entrypoint.sh`) | Opcional. Conexión del dueño de la base para `prisma migrate deploy` cuando la API se conecta con un rol sin `DELETE` sobre la trazabilidad ([`deploy/README.md`](deploy/README.md#cierre-h2-v020-antes-y-después-del-despliegue)). Sin definir: se migra con `DATABASE_URL` |
| `API_PUBLIC_URL` | api | Origen público de la API para los enlaces del pasaporte (expediente canónico y adjuntos públicos). Vacío: rutas relativas (`/v1/public/lots/…`) que la app resuelve contra su proxy |
| `RATE_LIMIT_PASSPORT_PER_MINUTE`, `RATE_LIMIT_PUBLIC_WINERIES_PER_MINUTE` | api | Peticiones por minuto e IP real en el pasaporte público (60) y en `/v1/public/wineries` (120) |
| `PASSPORT_MISS_LIMIT`, `PASSPORT_MISS_WINDOW_SECONDS` | api | Freno a la enumeración de códigos: códigos inexistentes por IP (20) en la ventana (600 s) antes del 429 `PUB_TOO_MANY_LOOKUPS` |

**CORS**: `CORS_ALLOWED_ORIGINS` es una lista de orígenes exactos separada por comas (`https://erp.ejemplo.com,http://localhost:3002`). No se admiten comodines ni se refleja el origen de la petición; vacía fuera de producción equivale a `http://localhost:3002,http://localhost:3009`. Cabeceras permitidas: `Authorization`, `Content-Type`, `X-Correlation-ID`, `Idempotency-Key`, `Accept-Language`, `X-Client-App`; expuestas: `X-Correlation-ID`, `Retry-After`.

### ✅ Puertas de calidad

Se ejecutan en la CI (`.github/workflows/ci.yml`) en cada push y PR a `dev` y `main`, y en local antes de integrar:

```bash
pnpm lint            # ESLint 9 (flat config) + Prettier, sin --fix (pnpm lint:fix para corregir)
pnpm typecheck       # tsc --noEmit en modo estricto
pnpm test            # unitarias (incluye la prueba del contrato OpenAPI)
pnpm test:e2e        # e2e contra Postgres, Redis y Mailpit reales (docker compose up -d y el .env; S3_E2E=true añade MinIO); en serie
pnpm test:e2e:parallel  # lo mismo con varias suites a la vez: más rápido, pide una máquina holgada
                     # incluye el contrato: las respuestas del ERP validan contra openapi.json (tipos incluidos)
pnpm build
pnpm openapi:generate   # si cambió la API: regenera openapi.json y se versiona en el mismo commit
docker build .       # imagen de producción
pnpm audit --prod --audit-level high
```

La CI además aplica las migraciones sobre una base vacía (`prisma migrate deploy`) y falla si `schema.prisma` tiene cambios sin migración (`prisma migrate diff --exit-code`), y regenera el OpenAPI y falla si `openapi.json` no coincide con el código (ver más abajo).

**Auditoría de dependencias**: bloquea avisos altos o críticos de producción. Excepciones sin arreglo dentro de la versión mayor actual, en `package.json#pnpm.auditConfig.ignoreGhsas`:

| Aviso | Paquete (ruta) | Motivo |
|---|---|---|
| GHSA-ggr8-5vv4-36mx | `deepmerge-ts` (`prisma` → `@prisma/config`) | Solo lo usa la CLI de Prisma al leer su configuración; se va con Prisma 7 |
| GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j | `toml` (`@stellar/stellar-sdk` 13) | Solo para resolver `stellar.toml`, que el backend no usa; el SDK se actualiza en la Ola 3 (SE-02) |

### 🧵 Procesos: `api` y `worker`

Una sola imagen, dos procesos (docs-back/03 §2 y §4):

| Proceso | Comando | Qué hace |
|---|---|---|
| `api` | `node dist/main.js` (`pnpm start:prod`) | HTTP `/v1`: valida, autoriza, escribe en PostgreSQL y en el **outbox** en la misma transacción y responde. Nunca espera a la red ni al correo |
| `worker` | `node dist/worker.js` (`pnpm start:worker`) | Sin HTTP. Publica el outbox en BullMQ, procesa las colas `chain`, `email`, `scheduled` y `default`, ejecuta las tareas programadas y escribe un latido para su healthcheck (`node dist/worker-healthcheck.js`) y en Redis (`<QUEUE_PREFIX>:worker:heartbeat`, lo lee `/v1/health/ready` → `worker: up \| down`) |

```mermaid
flowchart LR
  API["api"] -->|"transacción: datos + outbox_events"| PG[("PostgreSQL")]
  PG -->|"relay · FOR UPDATE SKIP LOCKED"| W["worker"]
  W -->|"jobId = id del evento"| R[("Redis · BullMQ")]
  R -->|"@HandlesJob(cola, tipo)"| W
  W --> EXT["red · correo · banco<br/>(hoy simulados)"]
```

**Añadir un procesador** (detalle y garantías en [`docs/arquitectura/outbox.md`](docs/arquitectura/outbox.md)):

1. En el servicio, dentro de `prisma.$transaction(async (tx) => …)`: `await this.outbox.add(tx, { type: 'order.paid', aggregateType: 'order', aggregateId, queue: QUEUE_CHAIN, payload })` (importa `OutboxModule`).
2. En `src/modules/<modulo>/jobs/`: una clase `@Injectable()` + `@HandlesJob(QUEUE_CHAIN, 'order.paid')` que implemente `JobHandler<OutboxJobData<Payload>>`. **Idempotente**: la entrega es "al menos una vez".
3. Regístrala en un `<modulo>-jobs.module.ts` y añade ese módulo a `JOB_MODULES` en `src/worker/worker.module.ts`.
4. Tareas programadas: igual, con `@ScheduledTask({ name, pattern: '0 3 * * *' })` (cron UTC) o `{ name, every: ms }`.

Variables del worker (todas opcionales salvo `DATABASE_URL` y `REDIS_URL`) en `.env.example`, bloque "Worker".

### 🐳 Imagen y despliegue

- `Dockerfile` multi-etapa (`node:22-alpine`, pnpm por corepack, solo dependencias de producción, usuario `node`, `HEALTHCHECK` a `/v1/health`; también `/v1/health/live` y `/v1/health/ready`). Con `RUN_MIGRATIONS=true`, `docker/entrypoint.sh` ejecuta `prisma migrate deploy` antes de arrancar.
- **Desarrollo**: cada push a `dev` con la CI en verde se despliega solo en el servidor de desarrollo (`deploy-dev.yml` → `git archive` → `scp` → `deploy.sh`), con rollback automático si la API o el worker no quedan sanos. Detalles, puesta en marcha y secretos en [`deploy/README.md`](deploy/README.md).
- Ramas: trabajo en `dev` (o ramas `feat/…` integradas en `dev`); `main` solo por PR `dev → main`.

### 📚 OpenAPI como contrato (OPS-12)

`openapi.json` (raíz del repo, versionado) es el contrato con el frontend: `@drinks-on-chain/mocks` lo importa con `pnpm openapi:pull` y valida sus datos de prueba contra él (plan/03 §2).

1. Cambias controladores o DTO (colecciones con `@ApiPaginatedResponse(Dto)`, altas con `@Idempotent()`, rutas sin sesión con `@Public()`).
2. `pnpm openapi:generate` compila y genera el documento **sin base de datos ni Redis** (Nest en modo `preview`, `src/openapi/generate.ts`), con rutas y componentes ordenados para que el diff sea estable. `pnpm openapi:check` solo comprueba.
3. Versionas `openapi.json` en el mismo commit. `pnpm test` también falla si no está al día (`src/openapi/__tests__/openapi.spec.ts`, que además comprueba que toda colección declara `{ items, total, limit, offset }`, que las rutas `@Public` van sin candado y el resto con `bearer`).
4. CI (`ci.yml`, job *check*): regenera y falla si `git diff --exit-code openapi.json` no está limpio.
5. CI (`openapi.yml`): [`oasdiff`](https://github.com/oasdiff/oasdiff) en Docker compara con la versión anterior y publica en el resumen de la ejecución los cambios incompatibles y el changelog. En `dev` (push o PR) **solo avisa**; en un **PR a `main` falla** salvo que el PR tenga la etiqueta `breaking-change` o una línea `BREAKING CHANGE:` en la descripción (cambio coordinado con el frontend y anotado en `drinks-on-chain-mocks`).

Con la API levantada:
- **Swagger UI:** <http://localhost:4000/docs>
- **JSON OpenAPI Spec:** <http://localhost:4000/docs-json> (mismo documento que `openapi.json`)
- Sin `SWAGGER_ENABLED`, ambos quedan apagados en producción (SE-08); `SWAGGER_ENABLED=true` los activa. En desarrollo quedan activos: <https://136.243.223.39.sslip.io/docs>.

### 📝 Lista de espera (v0.1.1)

Captación de interesados desde la landing (consumidores) y el sitio de bodegas (bodegas); contrato en `plan/contratos/o1b-lista-de-espera.md` de la carpeta del ecosistema. Módulo `src/modules/waitlist`, tablas `waitlist_entries` y `waitlist_counters` (migración aditiva `20260927200000_o1_lista_de_espera`). No envía correos.

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /v1/public/waitlist` | Público | Inscribe (`type`: `CONSUMER` con `isAdult: true`, o `WINERY` con `wineryName`; `consent: true` siempre). 201 `{ type, position }` |
| `GET /v1/public/waitlist/stats` | Público | `{ consumers, wineries }`, con caché de 60 s |
| `GET /v1/platform/waitlist` | ADMIN, OPERATIONS, SUPPORT | Lista paginada (más reciente primero) con `type`, `status`, `source`, `q`, `from`, `to` |
| `GET /v1/platform/waitlist/sources` | ADMIN, OPERATIONS, SUPPORT | Orígenes (`source`) con su número de inscritos (`?type=` opcional) |
| `PATCH /v1/platform/waitlist/{id}` | ADMIN, OPERATIONS | `{ status?, notes? }`; `CONTACTED` guarda cuándo y quién |
| `GET /v1/platform/waitlist/export` | ADMIN, OPERATIONS | CSV (UTF-8 con BOM, celdas protegidas contra fórmulas), sin IP ni agente de usuario |
| `GET /v1/platform/dashboard` | Personal de plataforma | Añade `waitlist: { consumers, wineries, last24h }` |

- **Posición**: número de orden por tipo, desde 1 y sin huecos. Sale de `waitlist_counters`, cuya fila se bloquea dentro de la transacción de la inscripción (sin carreras). Único por tipo y correo normalizado (minúsculas, sin espacios).
- **Correo ya inscrito en ese tipo**: mismo 201 con la posición que ya tenía; no se duplica ni se revela nada. Solo se completan `phone`, `city` y `region` si estaban vacíos.
- **Campo trampa** (`website`): relleno → 201 con una posición verosímil, sin guardar nada.
- **Límites** (429 `TOO_MANY_REQUESTS` con `Retry-After`): 20 por minuto y 300 por hora por IP real, 3 por hora por correo. El de minuto es el del `ThrottlerGuard`; los de hora viven en Redis (el correo, como hash) y, si Redis no responde, no bloquean. La IP real la resuelve el proxy firmado de las apps (`PROXY_SHARED_SECRET`): sin él, todas las inscripciones llegan con la IP de Vercel y el límite por IP corta a la gente.
- **Captcha**: solo con `WAITLIST_CAPTCHA_REQUIRED=true` (422 `CAPTCHA_INVALID` en `captchaToken`); actívalo cuando `TURNSTILE_SECRET_KEY` sea la clave real.
- **Permisos**: capacidad `waitlist` de la matriz (`GET /v1/platform/permissions`): administración y operaciones `FULL`, soporte `READ`.
- **Bitácora** (recurso `waitlist_entry`): `WAITLIST_JOINED` (origen `PUBLIC`, solo el tipo y el origen de la inscripción), `WAITLIST_STATUS_CHANGED` (estado anterior y nuevo, sin el texto de las notas) y `WAITLIST_EXPORTED` (número de filas y filtros).
- **Datos personales**: se guardan además la IP real y el agente de usuario (para abuso; no se exportan ni salen por la API) y la fecha del consentimiento.

### 🌱 Datos de demostración (0.10, OPS-09)

La semilla (`src/seed.ts` y `src/seed/`) es **determinista e idempotente**: se puede ejecutar las veces que haga falta sin duplicar nada. Los datos maestros (personas, bodegas, membresías, parcelas) se escriben con `upsert` por su id fijo (o por su clave natural: correo, persona + organización): volver a ejecutarla los devuelve a su estado inicial. La **trazabilidad es de solo inserción**: cada lote de demostración se crea entero la primera vez y, si ya existe, no se toca (ni él ni sus registros). Nunca toca lo creado aparte. Va compilada en la imagen (`dist/seed.js` y los fixtures en `dist/seed/fixtures/`), así que no necesita `ts-node`.

| Dónde | Comando |
|---|---|
| Local (lee `.env`) | `pnpm seed` (también `pnpm prisma:seed`) |
| Imagen | `node dist/seed.js` |
| Servidor de desarrollo | `cd ~/doc-dev/current && docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env exec api node dist/seed.js` |

| Variable | Uso |
|---|---|
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `SUPERADMIN_NAME` | Superusuario (membresía `SUPERADMIN` de la plataforma). Si falta el correo o la contraseña, **no se crea** y se avisa: no hay contraseña por defecto. Si ya existe, se actualizan su nombre y su contraseña (la del entorno manda) |
| `SEED_DEMO` | `true`: personal interno, bodegas y trazabilidad de los mocks. Por defecto `false` (solo plataforma y superusuario). Nunca en producción |
| `SEED_DEMO_PASSWORD` | Contraseña de **todas** las personas de demostración; obligatoria con `SEED_DEMO=true` |
| `SEED_DEMO_TOTP_SECRET` | Secreto TOTP (base32) del personal interno inscrito en los mocks (administración, operaciones, soporte); se cifra como en la API (necesita `JWT_SECRET` y, si la API la usa, `MFA_ENCRYPTION_KEY`). Sin él quedan sin inscribir y lo inscriben en su primer inicio de sesión |

Desde el cierre H2 (`v0.2.0`) la semilla siembra los **21 lotes de demostración de `@drinks-on-chain/mocks` 0.5.0** (`src/seed/lots.seed.ts`), con sus registros, autores, fechas, línea de tiempo e instantánea de reglas, coherentes de principio a fin (pesaje → dictamen → fermentación → destilación o crianza → reposo ≥ 180 días → embotellado → laboratorio) y **sin incidencias de cumplimiento**. Las tres diferencias con los fixtures están documentadas en `src/seed/corrections.ts`. Una base sembrada con una versión anterior conserva sus lotes antiguos tal cual y solo recibe los que le faltan; para recrearlos todos, [`deploy/README.md`](deploy/README.md#3-lotes-de-demostración-ya-sembrados-opcional).

Las contraseñas deben tener al menos 10 caracteres y la semilla rechaza los `change-me` de los `.env.example`. En el servidor, las variables pasan al contenedor `api` desde `~/doc-dev/.env` (`deploy/dev/compose.yml`; la API no las lee): tras editarlas, `docker compose … up -d api` (o el siguiente despliegue) antes del `exec`.

**Contenido** (con `SEED_DEMO=true`): los fixtures de `@drinks-on-chain/mocks` copiados en `src/seed/fixtures/` (versión en `source.json`; se actualizan con `pnpm seed:sync [-- ruta/a/drinks-on-chain-mocks]`), con los **mismos ids (UUID v5 con el espacio de nombres de los mocks), nombres, códigos y fechas**, para que una pantalla muestre lo mismo con los mocks y con el backend:

- Personal interno: `administracion@drinksonchain.test` (`ADMIN`), `operaciones@drinksonchain.test` y `analista@drinksonchain.test` (`OPERATIONS`), `soporte@drinksonchain.test` (`SUPPORT`).
- Seis bodegas en todos los estados: Altos de Calamuchita y Cinti Viejo `ACTIVE`, Viñedos del Guadalquivir y Sol de Padcaya `INVITED`, Casa Uriondo `SUSPENDED`, Valle Escondido `REVOKED`, cada una con su organización (mismo id).
- Personas de bodega con sus membresías: dueños, enólogas, agrónomos, operarios y una contadora bloqueada por la plataforma; Sofía Aramayo (`sofia@aramayo.test`) es enóloga en Altos y dueña de Casa Uriondo; Inés Salazar, agrónoma en Cinti Viejo y operaria bloqueada por el dueño en Altos.
- Trazabilidad: 12 parcelas y **21 lotes, al menos uno en cada etapa** (`ORIGIN` 1, `HARVEST` 3, `FERMENTING` 2, `AGING` 2, `DISTILLING` 1, `RESTING` 1, `BOTTLED` 7, `CERTIFIED` 1, `REJECTED` 1, `DISCARDED` 2) más un pesaje sin lote: 21 vendimias → 18 tanques con 238 lecturas y 17 tratamientos → 6 crianzas y 9 destilaciones → 9 embotellados con 25.791 códigos de botella (24.670 activos) → 7 análisis de laboratorio.
- **Singani Gran Reserva 2026** (`CVJ-2026-SINGANI-004`), el caso de la Ola 2, con el **expediente cerrado** (`CERTIFIED`): 18.400 kg → tanque de 12.100 L → corazón de 1.500 L al 60 % → 180 días de reposo → 2.950 botellas → laboratorio conforme → cierre, con la huella y la raíz Merkle calculadas al sembrar.
- Fechas fijas de los mocks (día de referencia 2026-09-25): no se desplazan al día en que se ejecuta.

**Diferencias con los mocks** (lo que el modelo actual aún no tiene o resuelve de otra forma):

| Mocks | Semilla |
|---|---|
| `gestor@drinksonchain.test` (`SUPERADMIN`) | No se crea: el superusuario es el de `SUPERADMIN_*` |
| Consumidores (`maria@`, `carlos@tribu.test`) y cajero del POS | No se crean hasta el Marketplace y el POS |
| Contraseña `demo1234` | La de `SEED_DEMO_PASSWORD` |
| Organización de plataforma `uid('organization:platform')` | `00000000-0000-4000-8000-000000000001` (la de la migración) |
| `lotPrefix`, `slug`, historia pública, sitio web e historial de estados de las bodegas | Los de `winery-profiles.json` (`ALT`, `CVJ`, `CUR`, `VES`); un embotellado nuevo usa el prefijo de la bodega. Si otra bodega que no es de demostración ya tiene ese `slug` o prefijo, se conserva el suyo y se avisa |
| Solicitudes de alta (`applications.json`, una por estado) | Mismos ids, estados, notas, reunión y decisión, con las fechas desplazadas a hoy. La sin verificar lleva un token HMAC con `SEED_DEMO_PASSWORD` (no `demo-verificacion-…`); la semilla escribe en su log `<APP_URL_BODEGAS>/unirse/verificar?token=…` |
| Invitaciones (`demo-invitacion-…`) | Mismos ids, correos, roles y estados, con las fechas desplazadas del día de referencia a hoy (las pendientes siguen vigentes). El token no es el legible de los mocks (público): es un HMAC con `SEED_DEMO_PASSWORD`; la semilla escribe en su log la ruta `/invitacion/<token>` de cada pendiente o caducada |
| TOTP del personal interno | Con `SEED_DEMO_TOTP_SECRET`, sin códigos de recuperación |
| Ajustes por bodega, bitácora y buzón de la Ola 1 | Se crean con el uso (no se siembran) |
| Tratamientos sin autor | `authorizedByMemberId` obligatorio: la enóloga activa de la bodega (si no, el dueño) |
| Lecturas con `recordedByMemberId` | `recordedByUserId`: la persona de ese miembro |
| Billeteras sin bóveda | `dynamicVaultId` simulado `demo-vault-<id>` (billeteras y bodegas con cuenta Stellar) |
| Archivos `/mocks/uploads/…` | Las mismas rutas, sin archivo en el almacenamiento: los informes y las etiquetas de los lotes sembrados no se abren, ni hay adjuntos sembrados (los eventos `FILE_ATTACHED` de los mocks no se siembran) |
| Expediente cerrado con huella fija | La huella y la raíz Merkle se calculan al sembrar (dependen de las sales de los códigos de botella, que son aleatorias) |

---

## 🔄 6. Flujos de Negocio (Actuales y Futuros)

### 🍇 A. Flujos Actuales (Fases 1 a 4)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Platform Admin
    actor Bodega as Winery Admin
    actor Agro as Agrónomo
    actor Enol as Enólogo
    actor Consumidor as Consumidor / Inspector

    Note over Admin,Consumidor: 1. Identidad y Onboarding Institucional
    Bodega->>API: POST /v1/public/winery-applications (solicitud)
    Admin->>API: POST /v1/platform/winery-applications/:id/approve (bodega INVITED + invitación)
    Bodega->>API: POST /v1/invitations/:token/accept (ACTIVE + prefijo de lote)
    Bodega->>API: POST /v1/organizations/current/invitations (Agrónomo y Enólogo)

    Note over Admin,Consumidor: 2. Trazabilidad de Campo y Vendimia
    Agro->>API: POST /v1/terroirs (Parcela a 1,850 msnm, Moscatel)
    Enol->>API: POST /v1/lots (Singani 2026: instantánea de reglas)
    Agro->>API: POST /v1/harvest-batches (lotId, 15,000 kg brutos, maturity 22.4 °Bx)
    Enol->>API: POST /v1/harvest-batches/:id/phyto-decisions (APPROVED, otra persona que quien pesó)

    Note over Admin,Consumidor: 3. Vinificación y Transformación
    Enol->>API: POST /v1/fermentation-tanks (Cuba TK-03, inputs)
    Enol->>API: POST /v1/fermentation-tanks/:id/logs (Control térmico a 15.2°C)
    Enol->>API: POST /v1/fermentation-tanks/:id/complete (destino: destilación)
    Enol->>API: POST /v1/production-batches/distillation (Alambique, litros de entrada)
    Enol->>API: POST /v1/production-batches/:id/close (cortes: 1,750 L de corazón a 70.2% ABV)

    Note over Admin,Consumidor: 4. Embotellado y Certificación Analítica
    Enol->>API: POST /v1/lots/:id/bottling (Valida 180 días de reposo -> 4,080 botellas, un código por botella)
    Enol->>API: POST /v1/lots/:id/lab-analyses (Informe subido: Metanol < 200 mg/100 ml a.a.)
    Enol->>API: POST /v1/lots/:id/dossier/close (Expediente con hash y raíz Merkle)

    Note over Admin,Consumidor: 5. Pasaporte Digital Público (Consumidor)
    Consumidor->>API: GET /v1/public/passports/:code (Escaneo del QR del lote o de la botella)
    API-->>Consumidor: Solo datos registrados: origen, etapas, conformidad, expediente y prueba Merkle
```

1. **Gestión de Identidad & Multi-Tenancy:** Registro de usuarios, asignación de billeteras custodiales en Stellar y aislamiento de bodegas.
2. **Registro de Terroirs & Lotes de Cosecha:** Alta de viñedos con coordenadas GPS, altitud msnm y recepción en báscula con cálculo de peso neto.
3. **Control Fitosanitario & Vinificación:** Aprobación enológica con informe PDF, cubas de acero inoxidable y bitácoras térmicas *append-only*.
4. **Transformación Especializada:** Destilación de Singani con balance de masa y regla de 180 días de reposo inerte, o crianza de vinos en barricas de roble francés con bloqueo de fecha `lockUntilDate`.
5. **Fraccionamiento & Embotellado:** Validación D.O., código internacional `{WINERY}-{YEAR}-{TYPE}-{SEQ}`, URL QR y hash canónico SHA-256.
6. **Certificación de Laboratorio Acreditado:** Validación bromatológica oficial (ISO 17025 / SENASAG) verificando límites toxicológicos de metanol y metales pesados.
7. **Pasaporte Digital Público:** Consulta sin autenticación del linaje agroalimentario y verificación de autenticidad.
8. **Exportación Opcional:** Marcado de acreditación para bodegas y lotes con destino a mercados internacionales (la trazabilidad se preserva para el 100% de la producción sin importar si se exporta o no).

---

### 🚀 B. Flujos Futuros (Fases 5 a 9)

1. **Fase 5 — Tokenización RWA & Colecciones:**
   - Emisión de NFTs de botellas y barricas sobre Stellar Soroban vinculadas al `blockchainDataHash` de trazabilidad.
   - Bóvedas de custodia digital (*Smart Vaults*) para preventas *en primeur*.
2. **Fase 6 — Pasarela de Pagos & Órdenes:**
   - Procesamiento de pagos mixtos (Stellar USDC, XLM, pasarelas fiat locales con QR Simple boliviano).
   - Carrito de compras y liquidación directa a las billeteras de las bodegas.
3. **Fase 7 — Sistema POS & Redención Física (Claims):**
   - Retiro físico de botellas en bodegas, cavas turísticas y puntos autorizados mediante códigos QR de un solo uso (*Claim Passes*).
   - Quema (*burn*) o actualización de estado del NFT al momento de la entrega física.
4. **Fase 8 — Indexador de Eventos Stellar:**
   - Indexación en tiempo real de transacciones y eventos emitidos por los contratos Soroban mediante colas BullMQ.
5. **Fase 9 — Visor Público, Reseñas & Auditoría:**
   - Sistema de valoraciones y reseñas verificadas para consumidores con comprobante de compra.
   - Auditoría legal de trazabilidad para entidades reguladoras y certificadoras internacionales.

---

## 📄 7. Documentación Complementaria

- 📦 **[Registro de cambios](CHANGELOG.md):** versiones y cambios incompatibles de la API (`v0.2.0`: cierre H2).
- 🍸 **[Guía de Pruebas Manuales — Flujo Singani D.O.](docs/demo/guia_pruebas_manuales_trazabilidad.md):** Flujo completo con comandos `curl`, altitud $\ge 1,600$ msnm, destilación y 180 días de reposo inerte.
- 🍷 **[Guía de Pruebas Manuales — Flujo Vino de Altura](docs/demo/guia_pruebas_manuales_vino.md):** Flujo vitivinícola con maceración, crianza en barricas de roble (190 días) y embotellado.
- 🧾 **[Bitácora](docs/arquitectura/bitacora.md):** entradas en la misma transacción, solo inserción, cadena de hashes y cómo registrar una acción; consulta, exportación CSV y verificación del back office, bitácora del dueño, motivo obligatorio (`@RequiresReason()`) y tablero (`/v1/platform/dashboard`).
- ⚙️ **[Configuración en dos niveles](docs/arquitectura/configuracion.md):** catálogo de parámetros, valor efectivo con caché, mínimos legales e instantánea del lote; edición desde el back office (`/v1/platform/settings/*`).
- ✉️ **[Correo, archivos y operación](docs/arquitectura/correo-y-archivos.md):** correo por la cola, almacenamiento privado con URL firmadas, salud, logs y Swagger.
- 🔐 **[Identidad, sesiones y membresías](docs/arquitectura/identidad.md):** modelo, cookie `doc_rt`, rotación y reutilización, organización activa, revocación, matriz de roles y límites.
- 🍇 **[Trazabilidad confiable](docs/arquitectura/trazabilidad.md):** lote del servidor, instantánea de reglas, migración de los datos anteriores, reglas que ya no se pueden eludir (EA-01…EA-08, SE-07, plataforma de solo lectura), códigos `TRC_…`, códigos de botella, expediente con hash canónico, vistas del lote y pasaporte público.
- 🏷️ **[Solicitudes, bodegas y equipo](docs/arquitectura/organizaciones.md):** formulario público y bandeja de solicitudes, alta directa, activación con prefijo de lote, suspender/reactivar/revocar/transferir, SE-05, equipo del dueño y del back office, correos y rutas que se retiran en H1.
- 📋 **[Catálogo de Endpoints de la API](docs/endpoints/endpoints.md):** Referencia detallada de todos los endpoints, DTOs y respuestas.
- 🗄️ **[Registro de Base de Datos](docs/bd/base_de_datos.md):** Estructura de tablas, atributos y relaciones Prisma.
- 📜 **[Contrato de Trazabilidad Soroban](docs/contratos/trazabillidad.rs):** Smart contract en Rust de referencia para el anclaje on-chain.

---

## 👥 Equipo y Licencia
Desarrollado para el ecosistema vitivinícola y agroindustrial de Bolivia sobre **Stellar Soroban**.  
Licencia: Propiedad privada — Drinks on Chain Team.
