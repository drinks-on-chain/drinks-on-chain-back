# Principios Generales de Desarrollo — Drinks on Chain

> Estas reglas aplican a **todo el código** del proyecto. Son la base sobre la que se construyen las reglas específicas de NestJS, BD y API.

---

## 1. Clean Code

### Nombres que explican intención
```typescript
// ❌ MAL
const d = new Date();
const u = await this.repo.find(id);
const x = u.winery_id === tid;

// ✅ BIEN
const today = new Date();
const harvestBatch = await this.harvestBatchRepository.findById(id);
const belongsToCurrentTenant = harvestBatch.wineryId === tenantId;
```

### Funciones pequeñas y con un solo propósito
```typescript
// ❌ MAL — hace demasiado
async processOrder(orderId: string, userId: string) {
  const order = await this.prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundException();
  if (order.userId !== userId) throw new ForbiddenException();
  if (order.paymentStatus !== 'PENDING') throw new BadRequestException();
  const tokens = await this.prisma.tokenizedItem.findMany({ where: { ... } });
  // ... 40 líneas más
}

// ✅ BIEN — cada función hace una cosa
async processOrder(orderId: string, userId: string) {
  const order = await this.findAndValidateOrder(orderId, userId);
  const tokens = await this.reserveTokensForOrder(order);
  return this.initiatePayment(order, tokens);
}
```

### Sin comentarios obvios — el código se documenta solo
```typescript
// ❌ MAL
// Verificar si el usuario existe
const user = await this.usersService.findById(userId);

// ✅ BIEN — el nombre ya lo dice
const user = await this.usersService.findById(userId);

// ✅ CUÁNDO SÍ comentar: decisiones no obvias, lógica de negocio compleja
// Singani requiere mínimo 6 meses de reposo por ley boliviana (DS 26017)
const MIN_REST_MONTHS_SINGANI = 6;
```

### Sin números mágicos
```typescript
// ❌ MAL
if (altitude < 1600) throw new BadRequestException();
if (stars < 1 || stars > 5) throw new BadRequestException();

// ✅ BIEN
const SINGANI_MIN_ALTITUDE_MASL = 1600;
const REVIEW_MIN_STARS = 1;
const REVIEW_MAX_STARS = 5;

if (altitude < SINGANI_MIN_ALTITUDE_MASL) throw new BadRequestException('...');
if (stars < REVIEW_MIN_STARS || stars > REVIEW_MAX_STARS) throw new BadRequestException('...');
```

---

## 2. Principios SOLID

### S — Single Responsibility Principle
> Cada clase/módulo tiene **una sola razón para cambiar**.

```typescript
// ❌ MAL — el Service hace demasiado
class BottlingService {
  async releaseBottlingBatch(batchId: string) {
    // Validación de negocio
    // Cálculo del hash SHA-256
    // Llamada a Stellar blockchain
    // Envío de email de notificación
    // Generación del QR URL
    // Actualización en BD
  }
}

// ✅ BIEN — responsabilidades separadas
class BottlingService {
  constructor(
    private readonly batchValidator: BatchReleaseValidator,
    private readonly stellarService: StellarService,
    private readonly hashUtil: HashUtil,
    private readonly notificationService: NotificationService,
  ) {}

  async releaseBottlingBatch(batchId: string, tenantId: string) {
    const batch = await this.batchValidator.validateForRelease(batchId, tenantId);
    await this.stellarService.anchorBatch(batch);
    await this.notificationService.notifyBatchReleased(batch);
    return batch;
  }
}
```

### O — Open/Closed Principle
> Abierto para extensión, cerrado para modificación.

```typescript
// ❌ MAL — agregar una bebida nueva requiere modificar esta función
function calculateRestPeriod(beverageType: string): number {
  if (beverageType === 'SINGANI') return 6;
  if (beverageType === 'WHISKY') return 36;
  // Para agregar cerveza hay que modificar aquí
}

// ✅ BIEN — extender sin modificar
interface IBeverageProductionRules {
  getMinRestMonths(): number;
  getMinAlcoholPercentage(): number;
  isDOEligible(terroir: Terroir): boolean;
}

class SinganiProductionRules implements IBeverageProductionRules {
  getMinRestMonths() { return 6; }
  getMinAlcoholPercentage() { return 40; }
  isDOEligible(terroir: Terroir) { return terroir.altitudeMasl >= 1600; }
}

// Para nueva bebida: crear nueva clase, sin tocar las existentes
class BeerProductionRules implements IBeverageProductionRules {
  getMinRestMonths() { return 1; }
  getMinAlcoholPercentage() { return 3; }
  isDOEligible() { return false; }
}
```

### L — Liskov Substitution Principle
> Las clases derivadas deben poder sustituir a sus base sin romper el sistema.

```typescript
// Cualquier IPaymentProvider debe poder usarse donde se espera IPaymentProvider
// sin que el código que llama sepa cuál es la implementación concreta.
// Ver docs/analisis/06-interfaz-pagos-y-qr.md
```

### I — Interface Segregation Principle
> Interfaces pequeñas y específicas, no una interfaz gorda que nadie usa completa.

```typescript
// ❌ MAL — una interfaz con todo
interface IProductionRepository {
  findBatch(id: string): Promise<BottlingBatch>;
  findAllBatches(tenantId: string): Promise<BottlingBatch[]>;
  createFermentationLog(log: CreateLogDto): Promise<FermentationLog>;
  findTerroir(id: string): Promise<Terroir>;
  // ... 30 métodos más
}

// ✅ BIEN — interfaces separadas por dominio
interface IBottlingBatchRepository {
  findById(id: string): Promise<BottlingBatch | null>;
  findByTenant(tenantId: string): Promise<BottlingBatch[]>;
  create(data: CreateBottlingBatchData): Promise<BottlingBatch>;
  update(id: string, data: UpdateBottlingBatchData): Promise<BottlingBatch>;
}

interface IFermentationLogRepository {
  findByTank(tankId: string): Promise<FermentationLog[]>;
  create(data: CreateFermentationLogData): Promise<FermentationLog>;
}
```

### D — Dependency Inversion Principle
> Depender de abstracciones, no de implementaciones concretas.

```typescript
// ❌ MAL — acoplado a la implementación concreta
class OrdersService {
  private readonly bankProvider = new BankApiProvider(); // acoplado
}

// ✅ BIEN — depende de la interfaz, NestJS inyecta la implementación
class OrdersService {
  constructor(
    @Inject(PAYMENT_PROVIDER)
    private readonly paymentProvider: IPaymentProvider, // abstracción
  ) {}
}
```

---

## 3. DRY — Don't Repeat Yourself

```typescript
// ❌ MAL — lógica de validación de tenant duplicada en 10 servicios
class HarvestService {
  async findBatch(id: string, tenantId: string) {
    const batch = await this.prisma.harvestBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException(`Harvest batch ${id} not found`);
    if (batch.wineryId !== tenantId) throw new ForbiddenException();
    return batch;
  }
}
class BottlingService {
  async findBatch(id: string, tenantId: string) {
    const batch = await this.prisma.bottlingBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException(`Bottling batch ${id} not found`);
    if (batch.wineryId !== tenantId) throw new ForbiddenException();
    return batch;
  }
}

// ✅ BIEN — helper genérico reutilizable
// src/shared/helpers/tenant-resource.helper.ts
export function assertBelongsToTenant<T extends { wineryId: string }>(
  resource: T | null,
  resourceName: string,
  id: string,
  tenantId: string,
): asserts resource is T {
  if (!resource) throw new NotFoundException(`${resourceName} ${id} not found`);
  if (resource.wineryId !== tenantId) throw new ForbiddenException();
}
```

---

## 4. KISS — Keep It Simple, Stupid

> Siempre elige la solución más simple que funcione. No sobre-ingenierices.

```typescript
// ❌ MAL — innecesariamente complejo para lo que hace
const isActive = wineries.reduce((acc, w) => {
  return acc || w.certificationStatus === WineryStatus.ACTIVE;
}, false);

// ✅ BIEN
const isActive = wineries.some(w => w.certificationStatus === WineryStatus.ACTIVE);
```

---

## 5. YAGNI — You Aren't Gonna Need It

> No implementes funcionalidad que "quizás se necesite en el futuro". Impleméntala cuando se necesite.

```typescript
// ❌ MAL — implementar mercado secundario en el MVP porque "quizás se necesite"
// (El mercado secundario es Fase 3. No lo toques en el MVP.)

// ✅ BIEN — documentar la extensión futura sin implementarla
// TODO(Fase 3): Implementar mercado secundario
// El contrato C-03.transfer() ya está preparado para ello.
// Ver docs/analisis/01-alcance-mvp.md
```

---

## 6. Reglas de Inmutabilidad y Seguridad

### Preferir `const` sobre `let`
```typescript
// ❌ MAL
let batch = await this.findBatch(id);
let hasLab = batch.labAnalysis !== null;

// ✅ BIEN
const batch = await this.findBatch(id);
const hasLab = batch.labAnalysis !== null;
```

### Nunca mutar argumentos de función
```typescript
// ❌ MAL
function enrichBatch(batch: BottlingBatch) {
  batch.qrUrl = generateQrUrl(batch.lotCode); // mutación
  return batch;
}

// ✅ BIEN
function enrichBatch(batch: BottlingBatch): EnrichedBottlingBatch {
  return { ...batch, qrUrl: generateQrUrl(batch.lotCode) };
}
```

### Tipado estricto — sin `any`
```typescript
// ❌ MAL
async handleWebhook(payload: any) { ... }

// ✅ BIEN
async handleWebhook(payload: unknown) {
  const event = this.paymentsService.parseWebhookEvent(payload); // tipado al parsear
}
```
