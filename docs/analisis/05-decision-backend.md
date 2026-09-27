# Decisión Arquitectónica: NestJS vs Supabase como Backend

> **Fecha:** 2026-08-28  
> **Estado:** DECIDIDO — Ver sección "Decisión Final"

---

## El Problema Central

El proyecto necesita:
1. API REST multi-tenant con lógica de negocio compleja (ERP, trazabilidad, blockchain)
2. Integración con Stellar (contratos Soroban) como **relayer** firmante
3. Un **Stellar Event Indexer** que escuche eventos on-chain continuamente
4. Integración con plataforma de pagos (webhook receiver)
5. Integración con Dynamic SDK (wallets)
6. **Sin servicios separados** — todo en un solo lugar

---

## Análisis Comparativo

### Opción A — Supabase como backend completo

**Cómo funciona:**
- PostgREST para CRUD automático
- Edge Functions (Deno/TypeScript) para lógica custom
- pg_cron para tareas programadas
- DB Triggers para reactividad

| Criterio | Evaluación | Detalle |
|---|---|---|
| Stellar Indexer | 🔴 **IMPOSIBLE** | Las Edge Functions tienen timeout máximo de 2 min. Un indexer necesita ser un proceso long-running. No hay Workers en Supabase. |
| Webhook de Pagos | 🟡 Funciona con limitaciones | Edge Function puede recibir el webhook, pero si el mint falla, el retry es difícil |
| Lógica de negocio compleja | 🟡 Funciona pero es incómodo | Lógica distribuida entre Triggers, Edge Functions y pg_cron. Difícil de testear. |
| Multi-tenancy (RLS) | ✅ Nativo | RLS de PostgreSQL es excelente |
| Retries y colas | 🔴 No nativo | No hay sistema de colas. Hay que implementar con pg_cron + tablas (frágil) |
| Testing | 🔴 Muy difícil | Edge Functions en Deno son difíciles de testear unitariamente |
| Servicios separados | 🔴 **Forzado** | El indexer OBLIGA a tener un servicio separado. No hay manera de evitarlo. |
| Despliegue único | 🔴 No posible | Mínimo: Supabase + un servicio externo para el indexer |
| Costo operacional | 🟡 Bajo en inicio | Supabase Free tier limitado para Edge Functions |
| Developer Experience | 🟡 Medio | PostgREST es mágico pero pierde control. Edge Functions son limitadas. |

**Veredicto:** Supabase solo NO es viable para este proyecto porque el Stellar Indexer es incompatible con el modelo de Edge Functions. Te forzaría a tener un servicio separado de todas formas.

---

### Opción B — NestJS como backend completo

**Cómo funciona:**
- NestJS maneja todo: API REST, autenticación, lógica de negocio
- Prisma como ORM (TypeScript first, migrations, type-safe)
- BullMQ para colas de trabajo (mint retries, indexer jobs)
- NestJS Scheduler para tareas CRON (desbloquear lotes, expirar passes)
- Supabase se usa únicamente como: **PostgreSQL hosted** + **Storage**

| Criterio | Evaluación | Detalle |
|---|---|---|
| Stellar Indexer | ✅ **Nativo** | BullMQ Worker o NestJS Scheduler. Corre dentro del mismo proceso. |
| Webhook de Pagos | ✅ Excelente | Controller dedicado con HMAC validation. Retry con BullMQ. |
| Lógica de negocio compleja | ✅ Excelente | Services, Guards, Interceptors. Arquitectura limpia y testeable. |
| Multi-tenancy | ✅ Via middleware | TenantGuard extrae winery_id del JWT y lo inyecta en cada query. |
| Retries y colas | ✅ BullMQ | Cola de jobs robusta con Redis. Backoff exponencial nativo. |
| Testing | ✅ Excelente | Jest + NestJS Testing Module. Unit + Integration + E2E. |
| Servicios separados | ✅ **Cero** | Todo dentro del mismo proceso NestJS. Un solo servicio deployado. |
| Despliegue único | ✅ Un contenedor Docker | NestJS + Redis en docker-compose o Railway |
| Costo operacional | ✅ Predecible | Un servicio en Railway/Render ~$7-15/mes |
| Developer Experience | ✅ Excelente | TypeScript end-to-end, decoradores, inyección de dependencias |
| Payment Interface | ✅ Excelente | Interface TypeScript + `@Injectable()` = swap de proveedor sin tocar nada |

**Veredicto:** NestJS cubre todos los requisitos en un único servicio.

---

### Opción C — Híbrida (NestJS + Supabase completo)

**Descripción:** Usar Supabase para Auth, RLS y Realtime, pero NestJS para la lógica.

**Problema:** Introduces complejidad sin beneficio real. Tienes dos fuentes de verdad para auth (Supabase JWT + NestJS Guards). RLS en Supabase te da seguridad a nivel DB pero duplica la lógica que ya tienes en NestJS Guards. El Realtime de Supabase es un plus, pero no es crítico para el MVP.

**Veredicto:** Innecesariamente complejo. No recomendado.

---

## ✅ Decisión Final: NestJS

```
┌────────────────────────────────────────────────────────────────────────┐
│                    SERVICIO: drinks-on-chain-api                        │
│                         (NestJS en Docker)                              │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  API REST    │  │  BullMQ      │  │  Stellar     │  │  CRON     │  │
│  │  (Controllers│  │  Workers     │  │  Indexer     │  │  Jobs     │  │
│  │  + Swagger)  │  │  (mint retry │  │  (background │  │  (unlock  │  │
│  │              │  │  etc.)       │  │  worker)     │  │  batches) │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └───────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Capa de Servicios NestJS                       │  │
│  │  AuthService · WineryService · BatchService · TokenService       │  │
│  │  PaymentService (interface) · StellarService · StorageService    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Prisma ORM                                   │  │
│  └─────────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │
          ┌───────────────────────┼──────────────────────┐
          │                       │                       │
┌─────────▼──────┐     ┌──────────▼───────┐    ┌────────▼────────┐
│  PostgreSQL    │     │  Supabase Storage │    │  Redis          │
│  (Supabase DB  │     │  (PDFs, imágenes, │    │  (BullMQ queues │
│  o cualquier   │     │  NFT metadata)    │    │  + caché)       │
│  Postgres)     │     └───────────────────┘    └─────────────────┘
└────────────────┘
```

### ¿Qué sigue usando Supabase?
- **PostgreSQL:** Supabase sigue siendo el host de la DB. Prisma se conecta via `DATABASE_URL` directo al Postgres. Puedes migrar a Neon, RDS o cualquier Postgres sin cambiar nada.
- **Storage:** Supabase Storage para archivos (PDFs, imágenes, metadata NFT). Se usa via SDK en el `StorageService` de NestJS.
- **Auth:** Se elimina. NestJS maneja auth con JWT propio. Más control, menos dependencias.
- **Realtime:** Se elimina del MVP. Si se necesita en el futuro, se puede usar Server-Sent Events (SSE) desde NestJS o agregar Supabase Realtime después.
- **Edge Functions:** Se eliminan. Todo está en NestJS.
- **RLS:** Se elimina a nivel DB. La seguridad multi-tenant se aplica en la capa de servicio NestJS (TenantGuard + Prisma queries filtradas por winery_id).

### Por qué eliminar RLS de Supabase
```
Supabase RLS REQUIERE que las queries pasen por PostgREST o el cliente de Supabase
con el JWT del usuario. Si usas Prisma directamente (NestJS → Postgres), 
las queries no pasan por PostgREST → RLS no se aplica.

La seguridad multi-tenant en NestJS se implementa así:
  1. JWT contiene { user_id, winery_id, role }
  2. TenantGuard en cada Controller extrae el winery_id del JWT
  3. Cada método de Service recibe el winery_id y lo aplica en el WHERE de Prisma
  4. Prisma nunca ejecuta una query sin winery_id en datos multi-tenant
  
Esto es igualmente seguro si está bien implementado, y mucho más testeable.
```

---

## Stack Tecnológico Definitivo

| Componente | Tecnología | Propósito |
|---|---|---|
| **Framework** | NestJS (TypeScript) | API REST + módulos + DI |
| **ORM** | Prisma | Type-safe DB queries + migrations |
| **Base de datos** | PostgreSQL (vía Supabase) | Datos operacionales |
| **Colas** | BullMQ + Redis | Jobs async (mint, indexer, retry) |
| **Scheduler** | @nestjs/schedule | CRON jobs (unlock lotes, expirar passes) |
| **Blockchain** | stellar-sdk (JS) | Soroban contract calls |
| **Wallets** | Dynamic SDK | Wallets invisibles |
| **Storage** | Supabase Storage SDK | PDFs, imágenes, NFT metadata |
| **Docs API** | Swagger (@nestjs/swagger) | Documentación automática de endpoints |
| **Testing** | Jest + Supertest | Unit + E2E |
| **Auth** | Passport.js + JWT | Autenticación propia |
| **Validación** | class-validator + class-transformer | DTOs tipados |
| **Contenedor** | Docker + docker-compose | Despliegue local y producción |

---

## Estructura de Módulos NestJS

```
src/
├── main.ts
├── app.module.ts
│
├── modules/
│   ├── auth/                    # JWT auth, estrategias Passport
│   │   ├── guards/
│   │   │   ├── jwt.guard.ts
│   │   │   ├── tenant.guard.ts  # Multi-tenant: inyecta winery_id
│   │   │   └── roles.guard.ts   # RBAC por user_role
│   │   ├── decorators/
│   │   │   ├── tenant.decorator.ts
│   │   │   └── current-user.decorator.ts
│   │   └── strategies/
│   │       └── jwt.strategy.ts
│   │
│   ├── users/                   # CRUD usuarios + wallets
│   ├── wineries/                # Onboarding bodegas, miembros
│   ├── terroirs/                # Gestión de terroirs
│   ├── harvest/                 # Cosechas + fitosanitario
│   ├── fermentation/            # Tanques + logs + tratamientos
│   ├── production/              # Crianza vino + destilación
│   ├── bottling/                # Embotellado + análisis de lab
│   ├── collections/             # Colecciones NFT
│   ├── tokenization/            # tokenized_items
│   ├── orders/                  # Órdenes de compra
│   ├── claims/                  # Claim passes + POS + redemptions
│   ├── pos/                     # Terminal POS endpoints
│   │
│   ├── stellar/                 # Integración Stellar/Soroban
│   │   ├── stellar.service.ts   # Relayer: construye y firma txs
│   │   ├── contracts/
│   │   │   ├── producer-registry.contract.ts
│   │   │   ├── batch-anchor.contract.ts
│   │   │   ├── product-nft.contract.ts
│   │   │   └── claim-escrow.contract.ts
│   │   └── indexer/
│   │       ├── stellar-indexer.service.ts  # BullMQ Worker
│   │       └── event-processor.service.ts
│   │
│   ├── wallets/                 # Dynamic SDK integration
│   │   └── wallets.service.ts
│   │
│   ├── payments/                # Sistema de pagos (INTERFACE)
│   │   ├── interfaces/
│   │   │   └── payment-provider.interface.ts  ← INTERFAZ ABSTRACTA
│   │   ├── providers/
│   │   │   └── bank-api.provider.ts  ← Implementación del banco
│   │   └── payments.service.ts  # Usa la interfaz, no la impl
│   │
│   └── storage/                 # Supabase Storage wrapper
│       └── storage.service.ts
│
├── shared/
│   ├── prisma/
│   │   └── prisma.service.ts
│   ├── filters/
│   │   └── global-exception.filter.ts
│   ├── interceptors/
│   │   └── tenant.interceptor.ts
│   └── utils/
│       ├── hash.util.ts         # SHA-256 helper
│       └── qr.util.ts           # Generación de QR payloads
│
└── prisma/
    ├── schema.prisma
    └── migrations/
```

---

## Interfaz de Proveedor de Pagos

Este es el corazón del sistema de pagos desacoplado. Ver detalle en `06-interfaz-pagos.md`.

```typescript
// payments/interfaces/payment-provider.interface.ts
export interface IPaymentProvider {
  createCharge(params: CreateChargeParams): Promise<ChargeResult>;
  getCharge(chargeId: string): Promise<ChargeStatus>;
  validateWebhook(payload: unknown, signature: string): boolean;
  parseWebhookEvent(payload: unknown): ParsedWebhookEvent;
  refund?(chargeId: string, amount?: number): Promise<RefundResult>;
}
```

---

## Redis en docker-compose

```yaml
# docker-compose.yml
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://redis:6379
    depends_on: [redis]
  
  redis:
    image: redis:7-alpine
    volumes: [redis_data:/data]

volumes:
  redis_data:
```

Redis es el único servicio adicional que NestJS necesita (para BullMQ). No es un "microservicio de negocio" — es infraestructura, como lo es PostgreSQL.

---

## Despliegue

**Desarrollo local:**
```bash
docker-compose up     # Levanta API + Redis
npx prisma migrate dev
npm run start:dev
```

**Producción (opción recomendada Railway.app):**
```
Service 1: drinks-on-chain-api (Docker)
Service 2: Redis (Railway plugin — 1 click)
Service 3: PostgreSQL (Supabase — ya existe)
```

Un solo repositorio, dos servicios de infraestructura (Redis + Postgres). Todo el código en un lugar.
