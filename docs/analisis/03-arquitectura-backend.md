# Arquitectura Backend — Drinks on Chain

> **Stack:** NestJS (TypeScript) + Prisma + PostgreSQL (Supabase) + Redis (BullMQ) + Stellar Soroban + Dynamic  
> **Decisión:** Ver [`05-decision-backend.md`](./05-decision-backend.md) para el análisis completo NestJS vs Supabase.  
> **Principio:** Un solo servicio NestJS contiene toda la lógica, incluyendo el Stellar Indexer como background worker.

---

## Vista General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLIENTES EXTERNOS                               │
│       App Bodega · App Consumidor · App POS · Herramienta Backoffice    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS (REST + Server-Sent Events)
┌──────────────────────────────▼──────────────────────────────────────────┐
│                    SERVICIO: drinks-on-chain-api                         │
│                         (NestJS en Docker)                               │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      API REST (Controllers)                      │    │
│  │  /auth · /wineries · /terroirs · /harvest · /fermentation       │    │
│  │  /bottling · /collections · /orders · /claims · /pos · /public  │    │
│  │  /webhooks/payments (público, firmado)                           │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Capa de Servicios                              │    │
│  │  AuthService · WineryService · BatchService · TokenService       │    │
│  │  PaymentsService (IPaymentProvider) · StellarService             │    │
│  │  StorageService · WalletService · ClaimService                   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌────────────────────┐  ┌─────────────────────┐  ┌────────────────┐   │
│  │  BullMQ Workers    │  │  Stellar Indexer     │  │  CRON Jobs     │   │
│  │                    │  │                      │  │                │   │
│  │  - mint-nft        │  │  Escucha eventos     │  │  - Desbloquear │   │
│  │  - mint-retry      │  │  on-chain en loop    │  │    lotes       │   │
│  │  - anchor-batch    │  │  Soroban RPC/Horizon │  │  - Expirar     │   │
│  │  - register-pos    │  │  → Procesa → Prisma  │  │    passes      │   │
│  └────────────────────┘  └─────────────────────┘  └────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                   Prisma ORM + Guards + Interceptors             │    │
│  │  TenantGuard (winery_id) · RolesGuard · JwtGuard                │    │
│  └──────────────────────────────┬──────────────────────────────────┘    │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │
          ┌───────────────────────┼──────────────────────┐
          │                       │                       │
┌─────────▼──────┐     ┌──────────▼───────┐    ┌────────▼────────┐
│  PostgreSQL    │     │  Supabase Storage │    │  Redis          │
│  (Supabase     │     │  - lab-reports/  │    │  BullMQ queues  │
│  o cualquier   │     │  - nft-metadata/ │    │  + caché        │
│  Postgres)     │     │  - winery-docs/  │    │                 │
└────────────────┘     │  - product-imgs/ │    └─────────────────┘
                       └───────────────────┘
                               
          ┌────────────────────────────────────────┐
          │                                        │
┌─────────▼──────┐                    ┌────────────▼───────────┐
│  Stellar       │                    │  Dynamic SDK           │
│  Soroban RPC   │                    │  Wallets custodiales   │
│  Horizon API   │                    │  para usuarios/bodegas │
└────────────────┘                    └────────────────────────┘
```

---

## Multi-Tenancy en NestJS

Sin RLS de Supabase, la seguridad multi-tenant se implementa en la capa de aplicación:

### 1. JWT contiene el tenant identifier

```typescript
// Al hacer login, el JWT payload incluye:
interface JwtPayload {
  sub: string;          // user_id
  email: string;
  role: UserRole;
  winery_id: string | null;  // null para CONSUMER y PLATFORM_ADMIN
  member_role: WineryMemberRole | null;
}
```

### 2. TenantGuard extrae y valida el tenant

```typescript
// src/modules/auth/guards/tenant.guard.ts
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // inyectado por JwtGuard
    
    // Para rutas B2B (bodega): el winery_id del JWT es el tenant
    request.tenantId = user.winery_id;
    return true;
  }
}
```

### 3. Todos los Services filtran por tenantId

```typescript
// src/modules/harvest/harvest.service.ts
async findAll(tenantId: string) {
  return this.prisma.harvestBatch.findMany({
    where: { winery_id: tenantId }, // ← SIEMPRE filtrado por tenant
    include: { terroir: true },
    orderBy: { intake_date: 'desc' },
  });
}

async findOne(id: string, tenantId: string) {
  const batch = await this.prisma.harvestBatch.findFirst({
    where: { 
      id,
      winery_id: tenantId, // ← Previene acceso cross-tenant
    },
  });
  if (!batch) throw new NotFoundException('Harvest batch not found');
  return batch;
}
```

### 4. PLATFORM_ADMIN omite el filtro de tenant

```typescript
// src/shared/decorators/skip-tenant.decorator.ts
export const SKIP_TENANT_KEY = 'skipTenant';
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true);

// En AdminController:
@Get('all-batches')
@SkipTenant() // Admin ve todos los lotes de todas las bodegas
async getAllBatches(@CurrentUser() user: JwtPayload) {
  return this.harvestService.findAll(null); // null = sin filtro
}
```

---

## Stellar Indexer como BullMQ Worker

El indexer corre **dentro del mismo proceso NestJS** como un BullMQ worker de larga duración.

### Estrategia

```typescript
// src/modules/stellar/indexer/stellar-indexer.service.ts

@Injectable()
export class StellarIndexerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StellarIndexerService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventProcessor: EventProcessorService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    // Inicia el indexer cuando la app arranca
    this.startIndexing();
  }

  private async startIndexing() {
    this.isRunning = true;
    this.logger.log('Stellar Indexer started');
    
    while (this.isRunning) {
      try {
        await this.pollNewEvents();
        await this.sleep(5000); // Poll cada 5 segundos
      } catch (error) {
        this.logger.error('Indexer error', error);
        await this.sleep(15000); // Backoff en error
      }
    }
  }

  private async pollNewEvents() {
    // Obtener el último ledger procesado por contrato
    const states = await this.prisma.indexerState.findMany();
    
    for (const state of states) {
      const newEvents = await this.fetchContractEvents(
        state.contract_address,
        state.last_ledger_processed,
      );
      
      for (const event of newEvents) {
        await this.eventProcessor.process(event);
        await this.prisma.indexerState.update({
          where: { contract_id: state.contract_id },
          data: { 
            last_ledger_processed: event.ledger,
            events_processed: { increment: 1 },
          },
        });
      }
    }
  }

  private async fetchContractEvents(contractAddress: string, fromLedger: bigint) {
    // Llama a Soroban RPC o Horizon API para obtener eventos
    const rpcUrl = this.config.get('STELLAR_SOROBAN_RPC_URL');
    const response = await fetch(`${rpcUrl}`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: {
          startLedger: fromLedger.toString(),
          filters: [{ type: 'contract', contractIds: [contractAddress] }],
        },
      }),
    });
    return (await response.json()).result?.events ?? [];
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Event Processor

```typescript
// src/modules/stellar/indexer/event-processor.service.ts

@Injectable()
export class EventProcessorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mintQueue: Queue, // BullMQ queue para jobs async
  ) {}

  async process(event: StellarEvent) {
    // Idempotencia: ignorar eventos ya procesados
    const existing = await this.prisma.blockchainEvent.findUnique({
      where: { tx_hash: event.txHash },
    });
    if (existing?.processed) return;

    // Guardar el evento crudo
    const saved = await this.prisma.blockchainEvent.upsert({
      where: { tx_hash: event.txHash },
      update: {},
      create: {
        event_type: event.type,
        contract_id: event.contractId,
        contract_address: event.contractAddress,
        tx_hash: event.txHash,
        ledger_sequence: event.ledger,
        ledger_timestamp: new Date(event.timestamp),
        payload: event.data,
      },
    });

    // Procesar según tipo de evento
    switch (event.type) {
      case 'ProductMinted':
        await this.handleProductMinted(event.data);
        break;
      case 'ProductBurned':
        await this.handleProductBurned(event.data);
        break;
      case 'BatchAnchored':
        await this.handleBatchAnchored(event.data);
        break;
      case 'PassRedeemed':
        await this.handlePassRedeemed(event.data);
        break;
      case 'ProducerRegistered':
        await this.handleProducerRegistered(event.data);
        break;
    }

    // Marcar como procesado
    await this.prisma.blockchainEvent.update({
      where: { id: saved.id },
      data: { processed: true, processed_at: new Date() },
    });
  }

  private async handleProductMinted(data: MintedEventData) {
    await this.prisma.tokenizedItem.update({
      where: { onchain_token_id: data.token_id },
      data: {
        token_status: 'MINTED',
        mint_tx_hash: data.tx_hash,
        minted_at: new Date(),
      },
    });
  }

  private async handleProductBurned(data: BurnedEventData) {
    await this.prisma.$transaction([
      this.prisma.tokenizedItem.update({
        where: { onchain_token_id: data.token_id },
        data: {
          token_status: 'BURNED',
          burn_tx_hash: data.tx_hash,
          burned_at: new Date(),
        },
      }),
    ]);
  }

  private async handleBatchAnchored(data: BatchAnchoredEventData) {
    await this.prisma.bottlingBatch.update({
      where: { id: data.batch_id },
      data: {
        is_anchored_on_chain: true,
        anchored_at: new Date(),
      },
    });
  }
}
```

---

## CRON Jobs con @nestjs/schedule

```typescript
// src/modules/bottling/batch-scheduler.service.ts

@Injectable()
export class BatchSchedulerService {
  constructor(private readonly prisma: PrismaService) {}

  // Cada hora: desbloquear lotes de crianza listos para embotellar
  @Cron('0 * * * *')
  async unlockReadyAgingBatches() {
    await this.prisma.wineAgingBatch.updateMany({
      where: {
        aging_status: 'AGING',
        lock_until_date: { lte: new Date() },
      },
      data: { aging_status: 'READY' },
    });
  }

  // Cada hora: desbloquear lotes de destilados con reposo cumplido
  @Cron('30 * * * *')
  async unlockReadyProductionBatches() {
    await this.prisma.productionBatch.updateMany({
      where: {
        rest_status: 'RESTING',
        mandatory_rest_until: { lte: new Date() },
      },
      data: { rest_status: 'READY' },
    });
  }

  // Cada 15 minutos: marcar claim passes expirados
  @Cron('*/15 * * * *')
  async expireClaimPasses() {
    await this.prisma.claimPass.updateMany({
      where: {
        pass_status: 'ACTIVE',
        expires_at: { lte: new Date() },
      },
      data: { pass_status: 'EXPIRED' },
    });
  }
}
```

---

## BullMQ: Cola de Jobs Asíncronos

```typescript
// Colas definidas en el sistema:

// QUEUE: mint-nft
// Procesada cuando el payment-callback confirma un pago
// Permite retry con backoff si el mint en Stellar falla
{
  name: 'mint-nft',
  data: { order_id, tokenized_item_ids, buyer_wallet_address },
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  }
}

// QUEUE: anchor-batch
// Disparada cuando un enólogo libera un lote de embotellado
{
  name: 'anchor-batch',
  data: { bottling_batch_id },
  options: { attempts: 3, backoff: { type: 'exponential', delay: 10000 } }
}

// QUEUE: register-producer
// Cuando Debro aprueba una bodega
{
  name: 'register-producer',
  data: { winery_id },
  options: { attempts: 3 }
}
```

---

## Autenticación y Autorización

### JWT propio (sin Supabase Auth)

```typescript
// Login endpoint devuelve:
{
  access_token: "eyJ...",  // JWT firmado por NestJS
  refresh_token: "...",
  user: {
    id, email, role, winery_id, member_role
  }
}

// JWT Payload:
{
  sub: "user_uuid",
  email: "user@email.com",
  role: "ENOLOGIST",
  winery_id: "winery_uuid",  // null para CONSUMER/PLATFORM_ADMIN
  member_role: "ENOLOGIST",
  iat: 1234567890,
  exp: 1234654290
}
```

### Guards aplicados por ruta

```typescript
// Aplicación de guards:
@UseGuards(JwtGuard, RolesGuard, TenantGuard)
@Roles(UserRole.ENOLOGIST, UserRole.WINERY_ADMIN)
@Post('harvest-batches')
async createHarvest(@Body() dto: CreateHarvestDto, @TenantId() tenantId: string) {
  return this.harvestService.create(dto, tenantId);
}
```

---

## Supabase Storage (vía SDK en NestJS)

```typescript
// src/modules/storage/storage.service.ts
@Injectable()
export class StorageService {
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.getOrThrow('SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'), // Service role para Storage
    );
  }

  async uploadLabReport(wineryId: string, batchId: string, file: Buffer, filename: string) {
    const path = `${wineryId}/${batchId}/${filename}`;
    const { data, error } = await this.supabase.storage
      .from('lab-reports')
      .upload(path, file, { contentType: 'application/pdf' });
    
    if (error) throw new InternalServerErrorException('Storage upload failed');
    return this.supabase.storage.from('lab-reports').getPublicUrl(path).data.publicUrl;
  }

  async uploadNftMetadata(tokenId: string, metadata: object) {
    const path = `${tokenId}.json`;
    const { error } = await this.supabase.storage
      .from('nft-metadata')
      .upload(path, JSON.stringify(metadata), { contentType: 'application/json', upsert: true });
    
    if (error) throw new InternalServerErrorException('NFT metadata upload failed');
    return this.supabase.storage.from('nft-metadata').getPublicUrl(path).data.publicUrl;
  }
}
```

---

## Internacionalización (i18n) en NestJS

```typescript
// Usando nestjs-i18n

// Cabecera: Accept-Language: es | en

// src/i18n/
//   es/
//     common.json
//     errors.json
//     beverage-types.json
//   en/
//     common.json
//     errors.json
//     beverage-types.json

// En los services:
const name = i18n.t(`beverage-types.${beverageType}`, { lang: acceptLanguage });
```

---

## Variables de Entorno

```bash
# App
NODE_ENV=development
PORT=3000
API_BASE_URL=https://api.drinks-on-chain.com

# Base de datos (Supabase PostgreSQL)
DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=...                        # Secret para firmar tokens
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES_IN=30d

# Supabase Storage
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...      # Service role (solo para Storage)

# Stellar
STELLAR_NETWORK=testnet               # testnet | mainnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_RELAYER_SECRET_KEY=S...       # Clave privada del relayer (NUNCA exponer)

# Contratos Soroban (se actualizan al deployar)
CONTRACT_PRODUCER_REGISTRY=C...
CONTRACT_BATCH_ANCHOR=C...
CONTRACT_PRODUCT_NFT=C...
CONTRACT_CLAIM_ESCROW=C...

# Dynamic
DYNAMIC_ENVIRONMENT_ID=...
DYNAMIC_API_KEY=...

# Pagos
PAYMENT_BANK_API_KEY=...
PAYMENT_BANK_API_SECRET=...
PAYMENT_BANK_BASE_URL=https://api.banco.bo/v1
PAYMENT_BANK_WEBHOOK_SECRET=...

# Indexer
STELLAR_INDEXER_START_LEDGER=0        # Ledger desde donde iniciar
STELLAR_INDEXER_POLL_INTERVAL_MS=5000 # Poll cada 5 segundos
```

---

## Docker Compose (Desarrollo Local)

```yaml
# docker-compose.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: development
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
    env_file: .env
    volumes:
      - ./src:/app/src
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
```

---

## Infraestructura de Producción

```
Railway.app (recomendado para iniciar):
  Service 1: drinks-on-chain-api    ← Contenedor Docker NestJS
  Service 2: Redis                  ← Plugin nativo de Railway
  DB externa: Supabase PostgreSQL   ← Solo como host de Postgres
  Storage: Supabase Storage         ← Via SDK desde el servicio 1

Costo estimado MVP:
  Railway Starter plan: ~$5-10/mes
  Redis: ~$0 (Railway hobby) o $5/mes
  Supabase Free tier: $0 (500MB storage, 1GB DB)
  Total: ~$5-15/mes para arrancar

Escalabilidad:
  - Aumentar replicas de la API (Railway lo maneja)
  - Redis Cluster si la carga lo requiere
  - Mover DB a un Postgres dedicado (Neon.tech, RDS) sin cambiar código (solo DATABASE_URL)
```
