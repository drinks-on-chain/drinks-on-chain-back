# Guía de Implementación y Estándares NestJS — Drinks on Chain

> Reglas técnicas de arquitectura, estructura modular, configuración, validación, seguridad y pruebas unitarias/e2e para el backend en NestJS.

---

## 1. Arquitectura Modular

1. **Módulos Atómicos por Dominio:** Cada módulo agrupa su Controller, Service, Repository, DTOs, interfaces y eventos.
2. **Encapsulamiento:** Todo Provider que no se exporte explícitamente en `exports: [...]` es privado del módulo.
3. **Módulos Compartidos (`SharedModule` / `CoreModule`):** PrismaService, Utilidades criptográficas, Interceptores y Filtros globales residen en `src/shared/`.
4. **Cero Dependencias Circulares:** Queda prohibido el acoplamiento circular. Si dos módulos se necesitan mutuamente, extraer la lógica común a un tercer módulo o usar eventos/colas.

---

## 2. Configuración y Validación de Variables de Entorno

Toda variable de entorno debe ser validada al arrancar la aplicación mediante un schema (Joi o class-validator). Si falta una variable crítica (ej. `STELLAR_RELAYER_SECRET_KEY` o `DATABASE_URL`), el servidor **debe fallar inmediatamente al iniciar** (*fail fast*).

```typescript
// src/config/env.validation.ts
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('900s'), // 15 min (A-33)
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet', 'futurenet').default('testnet'),
  STELLAR_HORIZON_URL: Joi.string().uri().required(),
  STELLAR_SOROBAN_RPC_URL: Joi.string().uri().required(),
  STELLAR_RELAYER_SECRET_KEY: Joi.string().length(56).required(),
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
  PAYMENT_BANK_API_KEY: Joi.string().required(),
  PAYMENT_BANK_WEBHOOK_SECRET: Joi.string().required(),
});
```

---

## 3. Documentación Swagger / OpenAPI Obligatoria

Todo endpoint expuesto debe contar con decoradores de `@nestjs/swagger` indicando:
- `@ApiTags()` del módulo correspondiente.
- `@ApiOperation({ summary, description })`.
- `@ApiResponse()` para 200/201, 401/403 (Auth/Tenant), 404 (NotFound), 409 (conflicto) y 422 (validación y DomainException).
- `@ApiBearerAuth()` para endpoints protegidos (esquema `bearer`); las rutas `@Public()` salen sin candado en el documento.
- Colecciones: `@ApiPaginatedResponse(Dto)` (declara `{ items, total, limit, offset }` y el 422 de `limit`/`offset`).
- Altas que no deben repetirse: `@Idempotent()` (declara la cabecera `Idempotency-Key`).

> Ajustado por A-33 (27-09-2026): la validación es 422, no 400, y el OpenAPI es el contrato con el frontend: `pnpm openapi:generate` escribe `openapi.json` (versionado; la CI falla si no coincide con el código y avisa de los cambios incompatibles). Ver README · "OpenAPI como contrato".

```typescript
// Ejemplo de documentación en Controller
@ApiTags('Harvest Batches')
@ApiBearerAuth()
@OrgType('WINERY')
@Controller('harvest-batches') // guards globales: acceso, autorización y bodega (A-33)
export class HarvestBatchController {
  @Post()
  @ApiOperation({ summary: 'Registrar un nuevo lote de cosecha/vendimia' })
  @ApiResponse({ status: 201, description: 'Lote creado exitosamente', type: HarvestBatchResponseDto })
  @ApiResponse({ status: 422, description: 'VALIDATION_ERROR en el DTO', type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, description: 'No autorizado o no pertenece a la bodega' })
  @ApiResponse({ status: 409, description: 'Código de lote ya existe' })
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

## 4. Seguridad en NestJS

### A. Helmet y CORS en `main.ts`
```typescript
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Headers de seguridad HTTP
  app.use(helmet());

  // CORS restringido por entorno
  app.enableCors({
    origin: process.env.CORS_ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'Accept-Language'],
  });

  // Versionado global de la API (/v1/...)
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  await app.listen(process.env.PORT || 3000);
}
```

### B. Rate Limiting con `@nestjs/throttler`
Para proteger endpoints críticos (auth, checkout de órdenes, validación POS):
- Endpoints de autenticación: máximo 5 intentos por minuto por IP.
- Endpoints de claim/validate: máximo 60 peticiones por minuto por terminal POS.
- Endpoints generales de consulta: máximo 120 peticiones por minuto.

---

## 5. Estándares de Pruebas (Testing Guidelines)

### A. Pruebas Unitarias (Unit Tests con Jest)
- Se prueban los **Services**, **Validators**, **Factories** y **Utilities** de forma aislada.
- Se mockean los Repositorios y llamadas externas (Stellar SDK, Dynamic, Payment Gateway).

```typescript
// src/modules/harvest/__tests__/harvest.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { HarvestBatchService } from '../harvest-batch.service';
import { HarvestBatchRepository } from '../repositories/harvest-batch.repository';
import { TerroirRepository } from '../../terroirs/repositories/terroir.repository';

describe('HarvestBatchService', () => {
  let service: HarvestBatchService;
  let harvestRepo: jest.Mocked<HarvestBatchRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HarvestBatchService,
        {
          provide: HarvestBatchRepository,
          useValue: {
            findByIdAndTenant: jest.fn(),
            findByCode: jest.fn(),
            create: jest.fn(),
          },
        },
        {
          provide: TerroirRepository,
          useValue: {
            findByIdAndTenant: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HarvestBatchService>(HarvestBatchService);
    harvestRepo = module.get(HarvestBatchRepository);
  });

  it('should throw ConflictException if batch code already exists', async () => {
    harvestRepo.findByCode.mockResolvedValue({ id: 'existing-id' } as any);

    await expect(
      service.create({ harvestBatchCode: 'DUPLICATE' } as any, 'tenant-123', 'user-456'),
    ).rejects.toThrow();
  });
});
```

### B. Pruebas de Integración y End-to-End (E2E con Supertest)
- Se ejecuta contra una base de datos PostgreSQL de test en Docker.
- Se verifican los flujos completos: `POST /v1/auth/signup` ➔ `POST /v1/orders` ➔ `POST /v1/webhooks/payments`.

---

## 6. Resumen del Checklist de Calidad por Pull Request

Antes de dar por completado un módulo o funcionalidad:
- [ ] ¿Cumple con Clean Code y los principios SOLID?
- [ ] ¿Respeta la nomenclatura en inglés para código y camelCase para variables/métodos?
- [ ] ¿Todas las consultas a la base de datos están aisladas por `wineryId` (multi-tenant)?
- [ ] ¿El endpoint retorna el formato estándar JSON (`ApiSuccessResponse`)?
- [ ] ¿Las excepciones lanzadas son de dominio (`DomainException`, `HarvestErrors.*`) con código semántico?
- [ ] ¿El DTO tiene validaciones estrictas con `class-validator`?
- [ ] ¿Los logs no contienen llaves privadas, contraseñas ni datos sensibles?
- [ ] ¿Los endpoints están documentados con `@nestjs/swagger`?
- [ ] ¿Tiene pruebas unitarias con cobertura sobre los casos de éxito y de error de negocio?
