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
- **Pruebas Unitarias:** `93/93` tests pasando (23 suites).
- **Pruebas E2E:** `31/31` tests pasando (3 suites completas).
- **Compilación TypeScript:** `100%` en modo estricto (`strict: true`) con 0 errores de tipado o linting.
- **Base de Datos:** 14 modelos relacionales y 14 enums migrados y sincronizados en PostgreSQL.

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
│   │   ├── auth/                       # Autenticación JWT, RBAC y Guards
│   │   ├── harvest-batches/            # Lotes de vendimia, pesaje neto y fitosanitario
│   │   ├── health/                     # Healthcheck y diagnóstico de base de datos / Redis
│   │   ├── terroirs/                   # Parcelas agrícolas, GeoJSON y altitud msnm
│   │   ├── traceability/               # Núcleo ERP: Fermentación, Crianza, Destilación,
│   │   │   │                           # Embotellado, Laboratorio, DAG Builder & Strategies
│   │   │   ├── controllers/            # Controladores REST API
│   │   │   ├── dto/                    # DTOs tipados con class-validator y Swagger
│   │   │   ├── hooks/                  # Hooks desacoplados para simulación on-chain
│   │   │   ├── services/               # Lógica de negocio y persistencia Prisma
│   │   │   └── strategies/             # Strategy Pattern (Vino, Singani, Cerveza)
│   │   ├── users/                      # Perfiles de usuario y gestión de cuenta
│   │   ├── wallets/                    # Provisión de billeteras custodiales en Stellar
│   │   └── wineries/                   # Onboarding institucional y membresías
│   └── shared/                         # Utilidades transversales e interceptores
│       ├── decorators/                 # @CurrentUser(), @TenantId(), @Public()
│       ├── filters/                    # GlobalExceptionFilter (estándar de error API)
│       ├── interceptors/               # ResponseTransformInterceptor (envelope { success: true })
│       ├── prisma/                     # PrismaService singleton
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
4. **Control de Acceso Basado en Roles (RBAC):** `PLATFORM_ADMIN`, `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, `CONSUMER`, `POS_OPERATOR`.
5. **Grafo DAG de Trazabilidad:** Reconstrucción de linaje acíclico (`Stage::Plot` $\rightarrow$ `Stage::Harvest` $\rightarrow$ `Stage::Vinification` $\rightarrow$ `Stage::Distillation` / `Aging` $\rightarrow$ `Stage::Bottling`) con métricas escaladas ($\times 100$) y hashes `BytesN<32>` listos para el smart contract Soroban.
6. **Formato Estándar de Respuesta API:**
   ```json
   // Respuesta Exitosa
   {
     "success": true,
     "statusCode": 200,
     "timestamp": "2026-09-07T12:00:00.000Z",
     "path": "/v1/...",
     "data": { ... }
   }

   // Respuesta de Error
   {
     "success": false,
     "statusCode": 422,
     "timestamp": "2026-09-07T12:00:00.000Z",
     "path": "/v1/...",
     "error": {
       "code": "UNPROCESSABLE_ENTITY",
       "message": "Descripción amigable del error de negocio",
       "details": null
     }
   }
   ```

---

## ⚙️ 5. Pasos para Levantar el Proyecto

### 📋 Prerrequisitos
- **Node.js:** Versión 20.x o superior
- **Gestor de Paquetes:** `pnpm` (recomendado) o `npm`
- **Docker & Docker Compose:** Para PostgreSQL y Redis

---

### 🚀 Instalación y Puesta en Marcha

#### 1. Clonar el Repositorio e Instalar Dependencias
```bash
git clone https://github.com/tu-organizacion/drinks-on-chain.git
cd drinks-on-chain
pnpm install
```

#### 2. Configurar Variables de Entorno
Copia el archivo `.env.example` a `.env` y ajusta las credenciales locales:
```bash
cp .env.example .env
```
*Ejemplo de configuración local:*
```env
PORT=3000
NODE_ENV=development
API_PREFIX=v1

# PostgreSQL
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5435/drinks_on_chain_db?schema=public"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Autenticación JWT
JWT_SECRET="drinks_on_chain_ultra_secure_jwt_secret_key_2026"
JWT_EXPIRES_IN="7d"
JWT_REFRESH_SECRET="drinks_on_chain_ultra_secure_refresh_secret_2026"
JWT_REFRESH_EXPIRES_IN="30d"

# Stellar Soroban (Testnet)
STELLAR_NETWORK="TESTNET"
STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"
STELLAR_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
```

#### 3. Iniciar Servicios en Docker (PostgreSQL & Redis)
```bash
docker-compose up -d
```

#### 4. Ejecutar Migraciones de Base de Datos (Prisma)
```bash
pnpm prisma:migrate
# o con npx:
npx prisma migrate dev
```

#### 5. Iniciar la Aplicación en Modo Desarrollo
```bash
pnpm start:dev
```
La API estará disponible en: **`http://localhost:3000`**

---

### 📚 Documentación Interactiva de la API (Swagger OpenAPI)
Una vez levantado el servidor, accede a Swagger para explorar y probar todos los endpoints:
- **Swagger UI:** [`http://localhost:3000/docs`](http://localhost:3000/docs)
- **JSON OpenAPI Spec:** [`http://localhost:3000/docs-json`](http://localhost:3000/docs-json)

---

### 🧪 Ejecución de Pruebas Automatizadas

```bash
# 1. Pruebas Unitarias (93 tests)
pnpm test

# 2. Pruebas de Integración E2E (31 tests)
pnpm test:e2e

# 3. Cobertura de Código
pnpm test:cov

# 4. Compilación del Bundle de Producción
pnpm build
```

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
    Bodega->>API: POST /v1/auth/signup + POST /v1/wineries (PENDING)
    Admin->>API: POST /v1/wineries/:id/approve (Cambia a ACTIVE + Stellar Key)
    Bodega->>API: POST /v1/wineries/my/members (Incorpora Agrónomo y Enólogo)

    Note over Admin,Consumidor: 2. Trazabilidad de Campo y Vendimia
    Agro->>API: POST /v1/terroirs (Parcela a 1,850 msnm, Moscatel)
    Agro->>API: POST /v1/harvest-batches (15,000 kg brutos, 22.4 °Bx)
    Enol->>API: PATCH /v1/harvest-batches/:id/phyto-status (APPROVED)

    Note over Admin,Consumidor: 3. Vinificación y Transformación
    Enol->>API: POST /v1/fermentation-tanks (Cuba TK-03)
    Enol->>API: POST /v1/fermentation-tanks/:id/logs (Control térmico a 15.2°C)
    Enol->>API: POST /v1/production-batches/distillation (Alambique: 1,750 L corazón a 70.2% ABV)

    Note over Admin,Consumidor: 4. Embotellado y Certificación Analítica
    Enol->>API: POST /v1/bottling (Valida 180 días reposo -> 4,080 botellas + Genera QR)
    Enol->>API: POST /v1/lab-analyses (Certificado ISO 17025: Metanol < 200 mg/100ml)

    Note over Admin,Consumidor: 5. Pasaporte Digital Público (Consumidor)
    Consumidor->>API: GET /v1/traceability/public/:lotCode (Escaneo de QR físico)
    API-->>Consumidor: Árbol DAG completo con origen, altitud, análisis y hashes
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

- 📘 **[Guía de Pruebas Manuales Paso a Paso](docs/demo/guia_pruebas_manuales_trazabilidad.md):** Guía práctica con comandos `curl` y datos ficticios para probar el flujo completo.
- 📋 **[Catálogo de Endpoints de la API](docs/endpoints/endpoints.md):** Referencia detallada de todos los endpoints, DTOs y respuestas.
- 🗄️ **[Registro de Base de Datos](docs/bd/base_de_datos.md):** Estructura de tablas, atributos y relaciones Prisma.
- 📜 **[Contrato de Trazabilidad Soroban](docs/contratos/trazabillidad.rs):** Smart contract en Rust de referencia para el anclaje on-chain.

---

## 👥 Equipo y Licencia
Desarrollado para el ecosistema vitivinícola y agroindustrial de Bolivia sobre **Stellar Soroban**.  
Licencia: Propiedad privada — Drinks on Chain Team.
