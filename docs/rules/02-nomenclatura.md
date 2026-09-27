# Nomenclatura — Drinks on Chain

> Reglas de naming para todo el proyecto NestJS. La consistencia en nombres elimina fricción cognitiva y hace el código predecible.

---

## 1. Idioma

| Qué | Idioma | Ejemplo |
|---|---|---|
| Código (variables, funciones, clases) | **Inglés** | `harvestBatch`, `findByTenant` |
| Comentarios de lógica de negocio compleja | **Español** | `// Singani requiere reposo mínimo...` |
| Strings de error en la API (mensajes al cliente) | **Inglés** (base) | `'Harvest batch not found'` |
| Documentación técnica | **Español** | Estos archivos |
| Nombres de tablas en Prisma schema | **Inglés** | `HarvestBatch`, `BottlingBatch` |

---

## 2. Variables y Constantes

### Variables locales — `camelCase`
```typescript
const harvestBatch = await this.findById(id);
const tenantId = request.user.wineryId;
const isDoEligible = terroir.altitudeMasl >= SINGANI_MIN_ALTITUDE_MASL;
let retryCount = 0;
```

### Constantes de módulo — `UPPER_SNAKE_CASE`
```typescript
// Valores que nunca cambian en runtime
export const SINGANI_MIN_ALTITUDE_MASL = 1600;
export const CLAIM_PASS_DEFAULT_EXPIRY_HOURS = 24;
export const MINT_JOB_MAX_ATTEMPTS = 3;
export const MINT_JOB_BACKOFF_DELAY_MS = 5_000;
export const REVIEW_MIN_STARS = 1;
export const REVIEW_MAX_STARS = 5;

// Tokens de inyección de dependencias — también UPPER_SNAKE_CASE
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
export const STELLAR_SERVICE = 'STELLAR_SERVICE';
```

### Archivos de constantes — `*.constants.ts`
```
src/shared/constants/
  business.constants.ts      ← SINGANI_MIN_ALTITUDE_MASL, etc.
  queue.constants.ts         ← Nombres de colas BullMQ
  stellar.constants.ts       ← Contract IDs, event names
  injection-tokens.constants.ts ← PAYMENT_PROVIDER, etc.
```

### Variables booleanas — prefijo `is`, `has`, `can`, `should`
```typescript
const isAnchored = batch.isAnchoredOnChain;
const hasLabAnalysis = !!batch.labAnalysis;
const canRelease = isAnchored && hasLabAnalysis;
const shouldRetry = attempt < MAX_ATTEMPTS;
```

### Arrays — nombre plural
```typescript
const harvestBatches = await this.findAll(tenantId);
const tokenIds = items.map(item => item.onchainTokenId);
const activeCollections = collections.filter(c => c.publicationStatus === 'PUBLISHED');
```

---

## 3. Funciones y Métodos

### Verbos que describen la acción — `camelCase`
```typescript
// CRUD básico
findById(id: string)
findAll(tenantId: string)
findByTenant(tenantId: string)
create(data: CreateDto)
update(id: string, data: UpdateDto)
delete(id: string)

// Acciones de dominio
releaseBottlingBatch(batchId: string)
anchorBatchOnChain(batchId: string)
generateClaimPass(tokenId: string, userId: string)
validateAndBurnClaimPass(passHash: string, posShiftId: string)
mintNft(to: string, tokenId: string, collectionId: string)

// Consultas con filtro
findPendingApproval(tenantId: string)
findActiveByCollection(collectionId: string)
findByStatus(status: TokenStatus, tenantId: string)

// Booleanos — prefijo `is`, `has`, `can`
isValidTenant(resourceTenantId: string, requestTenantId: string): boolean
hasConformingLabAnalysis(batchId: string): Promise<boolean>
canBeReleased(batch: BottlingBatch): boolean
```

### Handlers de eventos — prefijo `handle` o `on`
```typescript
handlePaymentCompleted(event: ParsedWebhookEvent): Promise<void>
handleProductMinted(data: MintedEventData): Promise<void>
onBatchAnchored(event: BatchAnchoredEvent): Promise<void>
```

### Factories — prefijo `create` o `build`
```typescript
createJwtPayload(user: User): JwtPayload
buildMintTransaction(params: MintParams): StellarTransaction
createNftMetadata(batch: BottlingBatch, serial: number): NftMetadata
```

---

## 4. Clases

### Clases — `PascalCase`
```typescript
class HarvestBatchService {}
class BottlingBatchRepository {}
class StellarIndexerService {}
class BankApiProvider implements IPaymentProvider {}
class CreateHarvestBatchDto {}
class HarvestBatchResponseDto {}
class TenantGuard implements CanActivate {}
class HttpExceptionFilter implements ExceptionFilter {}
```

### Sufijos por tipo de clase

| Sufijo | Uso | Ejemplo |
|---|---|---|
| `Service` | Lógica de negocio | `BottlingBatchService` |
| `Controller` | Endpoints HTTP | `HarvestBatchController` |
| `Repository` | Acceso a BD (Prisma) | `BottlingBatchRepository` |
| `Module` | Módulo NestJS | `BottlingModule` |
| `Dto` | Data Transfer Object | `CreateHarvestBatchDto`, `HarvestBatchResponseDto` |
| `Guard` | Guards de NestJS | `JwtGuard`, `TenantGuard`, `RolesGuard` |
| `Interceptor` | Interceptores | `ResponseTransformInterceptor` |
| `Filter` | Exception filters | `HttpExceptionFilter` |
| `Pipe` | Pipes de validación | `ParseUuidPipe` |
| `Decorator` | Custom decorators | `CurrentUser`, `TenantId` |
| `Provider` | Providers de interfaces | `BankApiProvider`, `StripeProvider` |
| `Validator` | Validadores de dominio | `BatchReleaseValidator` |
| `Util` | Utilidades puras | `HashUtil`, `QrUtil` |
| `Constants` | Archivos de constantes | `business.constants` |

---

## 5. Interfaces y Types

### Interfaces — `PascalCase` con prefijo `I` para abstracciones inyectables
```typescript
// Interfaces inyectables (DI) — con prefijo I
interface IPaymentProvider { ... }
interface IStellarService { ... }
interface IStorageService { ... }

// Interfaces de datos/DTOs — sin prefijo I
interface JwtPayload { ... }
interface NftMetadata { ... }
interface BatchAnchorData { ... }
interface TenantContext { ... }
```

### Types para uniones y aliases
```typescript
type BeverageType = 'WINE' | 'SINGANI' | 'BEER' | 'SPIRITS' | 'CIDER' | 'MEAD' | 'OTHER';
type TokenStatus = 'UNMINTED' | 'RESERVED' | 'MINTED' | 'BURNED';
type UserRole = 'PLATFORM_ADMIN' | 'WINERY_ADMIN' | 'ENOLOGIST' | 'AGRONOMIST' | 'CONSUMER' | 'POS_OPERATOR';
type WineryStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
```

### Enums — `PascalCase` para el enum, `UPPER_SNAKE_CASE` para valores
```typescript
// Los enums de Prisma se definen en schema.prisma como:
// enum BeverageType { WINE SINGANI BEER SPIRITS CIDER MEAD OTHER }
// Y se importan en el código como:
import { BeverageType, TokenStatus } from '@prisma/client';

// Enums propios de la app (no en Prisma)
enum QueueName {
  MINT_NFT = 'mint-nft',
  ANCHOR_BATCH = 'anchor-batch',
  REGISTER_PRODUCER = 'register-producer',
}

enum StellarContract {
  PRODUCER_REGISTRY = 'C01',
  BATCH_ANCHOR = 'C02',
  PRODUCT_NFT = 'C03',
  CLAIM_ESCROW = 'C05',
}
```

---

## 6. Estructura de Carpetas y Archivos

### Carpetas — `kebab-case`
```
src/
  modules/
    harvest-batches/        ← kebab-case
    fermentation-tanks/
    bottling-batches/
    batch-lab-analyses/
    claim-passes/
  shared/
    decorators/
    guards/
    interceptors/
    filters/
    pipes/
    helpers/
    constants/
    types/
```

### Archivos — `kebab-case` con sufijo que describe el tipo
```
harvest-batch.service.ts
harvest-batch.controller.ts
harvest-batch.repository.ts
harvest-batch.module.ts
harvest-batch.entity.ts          ← si se necesita (no Prisma)
create-harvest-batch.dto.ts
update-harvest-batch.dto.ts
harvest-batch-response.dto.ts
harvest-batch.service.spec.ts
harvest-batch.controller.spec.ts
```

### Barrel exports — `index.ts` en cada módulo
```typescript
// src/modules/harvest-batches/index.ts
export * from './harvest-batch.service';
export * from './harvest-batch.controller';
export * from './dto/create-harvest-batch.dto';
export * from './dto/harvest-batch-response.dto';
```

### Organización dentro de un módulo
```
src/modules/harvest-batches/
  ├── index.ts
  ├── harvest-batch.module.ts
  ├── harvest-batch.controller.ts
  ├── harvest-batch.service.ts
  ├── harvest-batch.repository.ts
  ├── harvest-batch.validator.ts      ← validaciones de dominio
  ├── dto/
  │   ├── create-harvest-batch.dto.ts
  │   ├── update-harvest-batch.dto.ts
  │   ├── harvest-batch-response.dto.ts
  │   └── harvest-batch-filters.dto.ts
  ├── __tests__/
  │   ├── harvest-batch.service.spec.ts
  │   └── harvest-batch.controller.spec.ts
  └── harvest-batch.constants.ts      ← constantes específicas del módulo
```

---

## 7. DTOs

### Nombres descriptivos por operación
```typescript
// Creación
CreateHarvestBatchDto
CreateFermentationTankDto
CreateEnologicalTreatmentDto

// Actualización
UpdateHarvestBatchDto          // parcial, todos campos opcionales
ApproveHarvestBatchDto         // acción específica con campos requeridos
ReleaseBottlingBatchDto

// Respuesta
HarvestBatchResponseDto        // respuesta de un solo recurso
HarvestBatchListResponseDto    // respuesta de lista
HarvestBatchSummaryDto         // versión reducida para listados
BottlingBatchPublicResponseDto // respuesta del endpoint público (sin datos sensibles)

// Filtros/Query params
HarvestBatchFiltersDto
CollectionFiltersDto
```

### DTOs siempre usan class-validator
```typescript
import { IsString, IsUUID, IsNumber, IsPositive, IsEnum, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateHarvestBatchDto {
  @ApiProperty({ description: 'ID del terroir de origen' })
  @IsUUID()
  terroirId: string;

  @ApiProperty({ description: 'Código único interno del lote de cosecha' })
  @IsString()
  @Transform(({ value }) => value.trim().toUpperCase())
  harvestBatchCode: string;

  @ApiProperty({ description: 'Grados Brix medidos', minimum: 10, maximum: 30 })
  @IsNumber()
  @Min(10)
  @Max(30)
  brixDegrees: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
```

---

## 8. Rutas de la API

### Formato: `kebab-case`, plural, versionado
```
/v1/harvest-batches
/v1/harvest-batches/:id
/v1/harvest-batches/:id/approve
/v1/fermentation-tanks
/v1/fermentation-tanks/:id/logs
/v1/bottling-batches/:id/release
/v1/collections/:id/publish
/v1/claims/passes
/v1/claims/validate
/v1/claims/burn
/v1/pos/shifts
/v1/pos/shifts/:id/close
/v1/public/batch/:lotCode
/v1/webhooks/payments
```

### Verbos HTTP correctos

| Acción | Método | Ruta |
|---|---|---|
| Listar todos | GET | `/v1/harvest-batches` |
| Obtener uno | GET | `/v1/harvest-batches/:id` |
| Crear | POST | `/v1/harvest-batches` |
| Actualizar parcial | PATCH | `/v1/harvest-batches/:id` |
| Reemplazar total | PUT | Evitar en este proyecto |
| Eliminar | DELETE | `/v1/harvest-batches/:id` |
| Acción de dominio | POST | `/v1/bottling-batches/:id/release` |
| Acción de dominio | POST | `/v1/wineries/:id/approve` |

### Parámetros de query — `camelCase`
```
GET /v1/tokenized-items?tokenStatus=MINTED&wineryId=xxx&limit=20&offset=0
GET /v1/collections?publicationStatus=PUBLISHED&beverageType=WINE
```

> Ajustado por A-33 (27-09-2026): las colecciones se paginan con `limit` (1–100, por defecto 20) y `offset`, no con `page`. Ver `03-formato-respuestas.md` § Paginación.

---

## 9. Variables de Entorno

### Prefijo por dominio, `UPPER_SNAKE_CASE`
```bash
# App
APP_PORT=3000
APP_ENV=development               # development | staging | production
APP_BASE_URL=https://api.drinks-on-chain.com

# Base de datos
DATABASE_URL=postgresql://...
DATABASE_POOL_MAX=10

# Auth
JWT_SECRET=...
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES_IN=30d

# Redis
REDIS_URL=redis://localhost:6379
REDIS_TLS=false

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=...
STELLAR_SOROBAN_RPC_URL=...
STELLAR_RELAYER_SECRET_KEY=...

# Contratos (prefijo CONTRACT_)
CONTRACT_PRODUCER_REGISTRY=C...
CONTRACT_BATCH_ANCHOR=C...
CONTRACT_PRODUCT_NFT=C...
CONTRACT_CLAIM_ESCROW=C...

# Supabase Storage
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...

# Dynamic
DYNAMIC_ENVIRONMENT_ID=...
DYNAMIC_API_KEY=...

# Pagos (prefijo PAYMENT_)
PAYMENT_BANK_API_KEY=...
PAYMENT_BANK_API_SECRET=...
PAYMENT_BANK_BASE_URL=...
PAYMENT_BANK_WEBHOOK_SECRET=...

# Indexer
STELLAR_INDEXER_POLL_INTERVAL_MS=5000
STELLAR_INDEXER_START_LEDGER=0
```

---

## 10. Nombres en Prisma Schema

### Modelos — `PascalCase` singular
```prisma
model HarvestBatch { ... }
model FermentationTank { ... }
model BottlingBatch { ... }
model TokenizedItem { ... }
model ClaimPass { ... }
```

### Campos — `camelCase` (Prisma mapea a `snake_case` en la DB)
```prisma
model HarvestBatch {
  id                    String    @id @default(uuid())
  wineryId              String    @map("winery_id")
  terroirId             String    @map("terroir_id")
  harvestBatchCode      String    @unique @map("harvest_batch_code")
  grossWeightKg         Decimal   @map("gross_weight_kg") @db.Decimal(12, 3)
  brixDegrees           Decimal   @map("brix_degrees") @db.Decimal(5, 2)
  phytosanitaryStatus   PhytoStatus @map("phytosanitary_status")
  createdAt             DateTime  @default(now()) @map("created_at")

  @@map("harvest_batches")
}
```

### Enums en Prisma — `PascalCase` nombre, `UPPER_SNAKE_CASE` valores
```prisma
enum BeverageType {
  WINE
  SINGANI
  BEER
  SPIRITS
  CIDER
  MEAD
  OTHER
}

enum TokenStatus {
  UNMINTED
  RESERVED
  MINTED
  BURNED
}
```
