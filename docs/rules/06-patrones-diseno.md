# Patrones de Diseño — Drinks on Chain

> Guía de patrones de diseño aplicados en la arquitectura NestJS del backend.
> Cada patrón resuelve un problema arquitectónico específico y promueve el desacoplamiento, la testabilidad y la escalabilidad del sistema.

---

## 1. Strategy & Adapter Pattern (Proveedores Intercambiables)

### Problema
El sistema debe soportar plataformas de pago externas (bancos bolivianos, pasarelas fiat como Stripe, o exchanges cripto) y servicios de almacenamiento (Supabase Storage, AWS S3, Cloudflare R2) sin que la lógica central de negocio quede acoplada a una SDK o API específica.

### Implementación

```
┌────────────────────────┐
│     OrdersService      │
└───────────┬────────────┘
            │ depende de
┌───────────▼────────────┐
│   <<IPaymentProvider>> │  (Strategy Interface)
└───────────▲────────────┘
            │
    ┌───────┴─────────────────┐
┌───┴───────────────┐ ┌───────┴──────────────┐
│  BankApiProvider  │ │    StripeProvider    │  (Concrete Adapters)
└───────────────────┘ └──────────────────────┘
```

#### Código
```typescript
// src/modules/payments/interfaces/payment-provider.interface.ts
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface IPaymentProvider {
  createCharge(params: CreateChargeParams): Promise<ChargeResult>;
  getCharge(chargeId: string): Promise<ChargeStatus>;
  validateWebhook(payload: unknown, headers: Record<string, string>): boolean;
  parseWebhookEvent(payload: unknown): ParsedWebhookEvent;
}
```

```typescript
// Inyección en el módulo NestJS
@Module({
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      useClass: process.env.PAYMENT_GATEWAY === 'STRIPE' ? StripeProvider : BankApiProvider,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
```

---

## 2. Repository Pattern (Abstracción de Acceso a Datos con Prisma)

### Problema
Acoplar los `Services` de NestJS directamente al cliente de Prisma dificulta los unit tests con mocks, duplica queries complejas (filtros multi-tenant, includes) y mezcla reglas de persistencia con reglas de negocio.

### Implementación
Creamos repositorios dedicados por dominio que encapsulan las llamadas a Prisma.

```typescript
// src/modules/harvest/repositories/harvest-batch.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { HarvestBatch, Prisma } from '@prisma/client';

@Injectable()
export class HarvestBatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdAndTenant(id: string, wineryId: string): Promise<HarvestBatch | null> {
    return this.prisma.harvestBatch.findFirst({
      where: { id, wineryId },
      include: { terroir: true, winery: true },
    });
  }

  async findByCode(code: string): Promise<HarvestBatch | null> {
    return this.prisma.harvestBatch.findUnique({
      where: { harvestBatchCode: code },
    });
  }

  async create(data: Prisma.HarvestBatchCreateInput): Promise<HarvestBatch> {
    return this.prisma.harvestBatch.create({ data });
  }

  async updateStatus(
    id: string,
    status: Prisma.EnumPhytoStatusFieldUpdateOperationsInput,
    certifiedByMemberId: string,
  ): Promise<HarvestBatch> {
    return this.prisma.harvestBatch.update({
      where: { id },
      data: {
        phytosanitaryStatus: status,
        certifiedByMemberId,
      },
    });
  }
}
```

---

## 3. Factory & Builder Pattern (Construcción de Transacciones y Metadatos)

### Problema
Construir transacciones de Soroban (Stellar), generar payloads de códigos QR y crear metadatos de tokens NFT requiere formatear estructuras complejas con múltiples validaciones y hashes criptográficos.

### Implementación

```typescript
// src/modules/tokenization/factories/nft-metadata.factory.ts
import { Injectable } from '@nestjs/common';
import { BottlingBatch, Collection, LabAnalysis, Terroir } from '@prisma/client';
import { HashUtil } from '../../../shared/utils/hash.util';

export interface StandardNftMetadata {
  name: string;
  description: string;
  image: string;
  external_url: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
  properties: {
    lot_code: string;
    serial_number: number;
    blockchain_data_hash: string;
    winery: string;
    lab_analysis: Record<string, unknown>;
  };
}

@Injectable()
export class NftMetadataFactory {
  createMetadata(
    collection: Collection,
    batch: BottlingBatch & { terroir?: Terroir; labAnalysis?: LabAnalysis | null },
    serialNumber: number,
  ): { metadata: StandardNftMetadata; metadataHash: string } {
    const metadata: StandardNftMetadata = {
      name: `${collection.nameEs} #${serialNumber}`,
      description: collection.descriptionEs || '',
      image: collection.coverImageUrl || '',
      external_url: `https://drinks-on-chain.com/tokens/${collection.id}/${serialNumber}`,
      attributes: [
        { trait_type: 'Beverage Type', value: batch.productType },
        { trait_type: 'Alcohol ABV (%)', value: Number(batch.finalAlcoholAbv) },
        { trait_type: 'Packaging Format (cl)', value: batch.packagingFormatCl },
        { trait_type: 'Serial Number', value: serialNumber },
      ],
      properties: {
        lot_code: batch.internationalLotCode,
        serial_number: serialNumber,
        blockchain_data_hash: batch.blockchainDataHash || '',
        winery: collection.wineryId,
        lab_analysis: batch.labAnalysis ? {
          actual_alcohol_abv: batch.labAnalysis.actualAlcoholAbv,
          total_acidity_gl: batch.labAnalysis.totalAcidityTartaricGl,
          laboratory_name: batch.labAnalysis.certifiedLaboratoryName,
        } : {},
      },
    };

    const metadataHash = HashUtil.sha256(JSON.stringify(metadata));
    return { metadata, metadataHash };
  }
}
```

---

## 4. Chain of Responsibility (Pipeline de Seguridad & Guardias NestJS)

### Problema
Cada petición HTTP entrante debe pasar por múltiples verificaciones secuenciales:
1. ¿El token JWT es válido? (`JwtAuthGuard`)
2. ¿El usuario tiene el rol necesario? (`RolesGuard`)
3. ¿El usuario pertenece a la bodega solicitada y se aísla su tenant? (`TenantGuard`)

### Implementación
NestJS implementa de forma nativa la Cadena de Responsabilidad mediante `CanActivate` Guards.

```
Request ──▶ [ JwtAuthGuard ] ──▶ [ RolesGuard ] ──▶ [ TenantGuard ] ──▶ Controller
                 │                    │                   │
                 ▼ (401)              ▼ (403)             ▼ (403)
             Unauthorized         Forbidden           TenantMismatch
```

```typescript
// Aplicación en Controller:
@Controller('harvest-batches')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
export class HarvestBatchController {
  @Post()
  @Roles(UserRole.ENOLOGIST, UserRole.AGRONOMIST, UserRole.WINERY_ADMIN)
  async create(
    @Body() dto: CreateHarvestBatchDto,
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.harvestService.create(dto, tenantId, user.id);
  }
}
```

---

## 5. Unit of Work & Transacciones Atómicas (Prisma `$transaction`)

### Problema
Operaciones críticas como la confirmación de pago + reserva de tokens + creación de ítems de orden, o la redención física en POS + actualización de estado a BURNED + registro del log de canje, deben ejecutarse en un bloque **todo o nada** (ACID).

### Implementación

```typescript
// src/modules/claims/claims.service.ts
async executePhysicalRedemption(params: BurnClaimParams) {
  // Transacción interactiva de Prisma (Unit of Work)
  return this.prisma.$transaction(async (tx) => {
    // 1. Marcar el pase de claim como USADO
    const pass = await tx.claimPass.update({
      where: { id: params.claimPassId },
      data: { passStatus: 'USED' },
    });

    // 2. Actualizar el token como BURNED
    const item = await tx.tokenizedItem.update({
      where: { id: pass.tokenizedItemId },
      data: {
        tokenStatus: 'BURNED',
        burnedAt: new Date(),
        burnTxHash: params.stellarTxHash,
      },
    });

    // 3. Registrar la redención física
    const redemption = await tx.claimRedemption.create({
      data: {
        claimPassId: pass.id,
        tokenizedItemId: item.id,
        posShiftId: params.posShiftId,
        posOperatorUserId: params.operatorUserId,
        burnTxHash: params.stellarTxHash,
      },
    });

    // 4. Incrementar contador en el turno POS
    await tx.posShift.update({
      where: { id: params.posShiftId },
      data: { totalClaimsProcessed: { increment: 1 } },
    });

    return redemption;
  });
}
```

---

## 6. Outbox + Worker (Procesamiento Asíncrono con BullMQ)

> **Ajustado por A-33 (27-09-2026)**: la "doble escritura" (guardar en la base y después encolar desde la API) queda sustituida por el **outbox transaccional** (ADR-005). La API nunca encola directamente. Implementación real y garantías: `docs/arquitectura/outbox.md`.

### Problema
Las transacciones en la red Stellar (minteo, anclaje de lotes, quema), el correo y el banco pueden tardar o fallar. Un endpoint HTTP no debe esperarlos, y escribir en la base y encolar por separado deja estados a medias: la base se confirma y el encolado falla (o al revés).

### Implementación
El servicio escribe sus datos **y** un evento en `outbox_events` en la misma transacción. El proceso `worker` publica los eventos en BullMQ (`FOR UPDATE SKIP LOCKED`, `jobId` = id del evento, reintentos exponenciales) y un procesador hace el efecto externo.

```
HTTP ──▶ [ $transaction: datos + outbox_events ] ──▶ Response 200/201
                          │
                          ▼ (worker, asíncrono)
               [ Relay del outbox ] ──▶ [ Cola BullMQ: chain · email · scheduled · default ]
                                                    │
                                                    ▼
                                     [ Procesador @HandlesJob(cola, tipo) ]
                                                    │
                                                    ▼
                                     [ StellarService.mint() · reintentos ]
```

```typescript
// src/modules/commerce/orders.service.ts (api)
await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.update({ where: { id }, data: { status: 'PAID' } });
  await this.outbox.add(tx, {
    type: 'order.paid',
    aggregateType: 'order',
    aggregateId: order.id,
    queue: QUEUE_CHAIN,
    payload: { orderId: order.id },
  });
});
```

```typescript
// src/modules/commerce/jobs/order-paid.handler.ts (worker)
@Injectable()
@HandlesJob(QUEUE_CHAIN, 'order.paid')
export class OrderPaidHandler implements JobHandler<OutboxJobData<OrderPaidPayload>> {
  private readonly logger = new Logger(OrderPaidHandler.name);

  constructor(private readonly stellarService: StellarService) {}

  async handle(data: OutboxJobData<OrderPaidPayload>): Promise<void> {
    // Idempotente: la entrega es "al menos una vez" (comprobar tx_hash antes de enviar)
    await this.stellarService.transferOrderNfts(data.payload.orderId);
  }
}
```

- Los procesadores se registran en un `<modulo>-jobs.module.ts` añadido a `JOB_MODULES` (`src/worker/worker.module.ts`); la API no los carga.
- Tareas programadas: `@ScheduledTask({ name, pattern })` en lugar de `@HandlesJob`.
- El `correlationId` de la petición viaja en el evento y aparece en los logs JSON del worker.

---

## 7. Custom Decorators Pattern (Metadatos e Inyección Limpia)

### Problema
Evitar extraer manualmente datos del request (`req.user.wineryId`, `req.user.id`) en cada controller.

### Implementación

```typescript
// src/shared/decorators/tenant-id.decorator.ts
import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';

export const TenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const tenantId = request.tenantId || request.user?.wineryId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant context (wineryId) is required for this operation');
    }
    return tenantId;
  },
);
```

```typescript
// src/shared/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
```
