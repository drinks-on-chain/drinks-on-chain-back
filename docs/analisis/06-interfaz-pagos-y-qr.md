# Interfaz del Proveedor de Pagos — Drinks on Chain

> **Principio:** El sistema de pagos está completamente desacoplado del resto del backend.  
> Cambiar de proveedor (banco boliviano → Stripe → exchange cripto) requiere únicamente crear una nueva clase que implemente `IPaymentProvider`.  
> **Ningún otro módulo del sistema conoce el proveedor concreto.**

---

## El Problema que Resuelve

```
SIN interface (acoplado):
  OrderService → BancoBolivianoAPI directamente
  → Si cambias el banco, tienes que modificar OrderService, WebhookController, etc.

CON interface (desacoplado):
  OrderService → IPaymentProvider (interface)
  → PaymentsModule provee la implementación concreta (BankApiProvider)
  → Para cambiar: creates StripeProvider, cambias el binding en PaymentsModule
  → OrderService NO se toca
```

---

## Interfaz Principal

```typescript
// src/modules/payments/interfaces/payment-provider.interface.ts

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER'; // Token de inyección DI

/**
 * Parámetros para crear un cobro.
 * Agnóstico al proveedor.
 */
export interface CreateChargeParams {
  /** Monto en USD (o la moneda base del sistema) */
  amountUsd: number;
  /** Código único que identifica el flujo de compra en nuestro sistema */
  orderCode: string;
  /** ID del usuario comprador */
  userId: string;
  /** ID de la colección comprada */
  collectionId: string;
  /** Cantidad de botellas */
  quantity: number;
  /** Descripción visible al pagador */
  description: string;
  /** URL a la que redirigir después de pago exitoso (si el proveedor lo soporta) */
  successRedirectUrl?: string;
  /** URL a la que redirigir en caso de pago cancelado */
  cancelRedirectUrl?: string;
  /** Metadatos adicionales (se retornan en el webhook) */
  metadata?: Record<string, string>;
}

/**
 * Resultado de crear un cobro.
 */
export interface ChargeResult {
  /** ID del cobro en el sistema del proveedor */
  chargeId: string;
  /** URL de pago a la que debe redirigirse al usuario (si aplica) */
  checkoutUrl?: string;
  /** Estado inicial del cobro */
  status: ChargeStatus;
  /** Fecha de expiración del cobro (si aplica) */
  expiresAt?: Date;
  /** Datos adicionales del proveedor */
  providerData?: Record<string, unknown>;
}

/**
 * Estado de un cobro al consultarlo.
 */
export interface ChargeStatus {
  chargeId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
  amountPaid?: number;
  currency?: string;
  paidAt?: Date;
  failureReason?: string;
}

/**
 * Evento parseado del webhook del proveedor.
 * Normalizado para que el sistema no conozca el formato del proveedor.
 */
export interface ParsedWebhookEvent {
  /** Tipo de evento normalizado */
  eventType: 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'PAYMENT_REFUNDED' | 'OTHER';
  /** ID del cobro en el proveedor */
  chargeId: string;
  /** Nuestro código de orden extraído del metadata */
  orderCode: string;
  /** Monto confirmado (si disponible) */
  amountConfirmed?: number;
  /** Fecha del evento */
  occurredAt: Date;
  /** Payload original sin parsear (para logging) */
  rawPayload: unknown;
}

/**
 * Resultado de un reembolso.
 */
export interface RefundResult {
  refundId: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  amountRefunded: number;
}

/**
 * INTERFAZ PRINCIPAL DEL PROVEEDOR DE PAGOS
 * 
 * Todo proveedor de pagos debe implementar esta interfaz.
 * Proveedores posibles: Banco boliviano, Stripe, PayPal, Kushki, exchange cripto, etc.
 */
export interface IPaymentProvider {
  /**
   * Crear un cobro / orden de pago.
   * Retorna el ID del cobro y (si aplica) una URL de checkout.
   */
  createCharge(params: CreateChargeParams): Promise<ChargeResult>;

  /**
   * Consultar el estado actual de un cobro.
   * Útil para polling o verificación manual.
   */
  getCharge(chargeId: string): Promise<ChargeStatus>;

  /**
   * Validar que un webhook entrante viene realmente del proveedor.
   * Cada proveedor usa su propio mecanismo (HMAC, firma RSA, IP whitelist, etc.).
   * 
   * @returns true si la firma es válida, false si el webhook debe rechazarse
   */
  validateWebhook(payload: unknown, headers: Record<string, string>): boolean;

  /**
   * Parsear el payload del webhook a un formato normalizado.
   * Solo llamar después de validateWebhook() == true.
   */
  parseWebhookEvent(payload: unknown): ParsedWebhookEvent;

  /**
   * Emitir un reembolso (opcional — no todos los proveedores lo requieren en MVP).
   * El reembolso en este sistema es manual: Debro devuelve el dinero externamente.
   * Este método es para automatizarlo en el futuro si el proveedor lo soporta.
   */
  refund?(chargeId: string, amountUsd?: number): Promise<RefundResult>;
}
```

---

## Implementación del Banco Boliviano (Placeholder)

```typescript
// src/modules/payments/providers/bank-api.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IPaymentProvider,
  CreateChargeParams,
  ChargeResult,
  ChargeStatus,
  ParsedWebhookEvent,
} from '../interfaces/payment-provider.interface';

/**
 * Implementación para la API del banco boliviano.
 * 
 * TODO: Completar con la documentación real de la API del banco.
 * Esta implementación usa un cliente HTTP genérico y debe adaptarse
 * a los endpoints, autenticación y formatos específicos del banco.
 */
@Injectable()
export class BankApiProvider implements IPaymentProvider {
  private readonly logger = new Logger(BankApiProvider.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly webhookSecret: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.getOrThrow('PAYMENT_BANK_API_KEY');
    this.apiSecret = this.config.getOrThrow('PAYMENT_BANK_API_SECRET');
    this.baseUrl = this.config.getOrThrow('PAYMENT_BANK_BASE_URL');
    this.webhookSecret = this.config.getOrThrow('PAYMENT_BANK_WEBHOOK_SECRET');
  }

  async createCharge(params: CreateChargeParams): Promise<ChargeResult> {
    this.logger.log(`Creating charge for order ${params.orderCode}`);

    // TODO: Adaptar a la estructura real de la API del banco
    // Ejemplo genérico de cómo podría ser:
    const response = await fetch(`${this.baseUrl}/charges`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: params.amountUsd,
        currency: 'USD', // o 'BOB' si el banco trabaja en bolivianos
        reference: params.orderCode, // Nuestro código de orden → retornado en webhook
        description: params.description,
        // callback_url: ...,
        metadata: {
          order_code: params.orderCode,
          user_id: params.userId,
          collection_id: params.collectionId,
          quantity: params.quantity.toString(),
          ...params.metadata,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Bank API error: ${data.message || response.statusText}`);
    }

    // TODO: Mapear la respuesta del banco a ChargeResult
    return {
      chargeId: data.id,              // adaptar al campo real
      checkoutUrl: data.payment_url,  // adaptar al campo real
      status: { chargeId: data.id, status: 'PENDING' },
      expiresAt: data.expires_at ? new Date(data.expires_at) : undefined,
      providerData: data,
    };
  }

  async getCharge(chargeId: string): Promise<ChargeStatus> {
    const response = await fetch(`${this.baseUrl}/charges/${chargeId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });

    const data = await response.json();

    // TODO: Mapear el estado del banco a nuestro enum normalizado
    return {
      chargeId,
      status: this.mapBankStatus(data.status),
      amountPaid: data.amount_paid,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
    };
  }

  validateWebhook(payload: unknown, headers: Record<string, string>): boolean {
    // TODO: Implementar con el mecanismo real del banco
    // Ejemplo con HMAC-SHA256 (común en muchas APIs bancarias):
    const signature = headers['x-bank-signature']; // adaptar al header real
    if (!signature) return false;

    const crypto = require('crypto');
    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSig),
    );
  }

  parseWebhookEvent(payload: unknown): ParsedWebhookEvent {
    const data = payload as Record<string, unknown>;

    // TODO: Adaptar a la estructura real del webhook del banco
    return {
      eventType: this.mapBankEventType(data.event_type as string),
      chargeId: data.charge_id as string,
      orderCode: (data.metadata as Record<string, string>)?.order_code,
      amountConfirmed: data.amount as number,
      occurredAt: new Date(data.timestamp as string),
      rawPayload: payload,
    };
  }

  // Helpers privados de mapeo
  private mapBankStatus(bankStatus: string): ChargeStatus['status'] {
    // TODO: Adaptar a los estados reales del banco
    const map: Record<string, ChargeStatus['status']> = {
      'pending': 'PENDING',
      'processing': 'PROCESSING',
      'approved': 'COMPLETED',
      'completed': 'COMPLETED',
      'rejected': 'FAILED',
      'expired': 'EXPIRED',
      'refunded': 'REFUNDED',
    };
    return map[bankStatus?.toLowerCase()] ?? 'PENDING';
  }

  private mapBankEventType(eventType: string): ParsedWebhookEvent['eventType'] {
    // TODO: Adaptar a los eventos reales del banco
    const map: Record<string, ParsedWebhookEvent['eventType']> = {
      'payment.completed': 'PAYMENT_COMPLETED',
      'payment.failed': 'PAYMENT_FAILED',
      'payment.refunded': 'PAYMENT_REFUNDED',
    };
    return map[eventType] ?? 'OTHER';
  }
}
```

---

## Registro en el Módulo de Pagos

```typescript
// src/modules/payments/payments.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PAYMENT_PROVIDER } from './interfaces/payment-provider.interface';
import { BankApiProvider } from './providers/bank-api.provider';
import { PaymentsService } from './payments.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [ConfigModule],
  controllers: [WebhookController],
  providers: [
    PaymentsService,
    {
      // Para cambiar de proveedor: solo cambia BankApiProvider por StripeProvider
      // sin tocar nada más en el sistema.
      provide: PAYMENT_PROVIDER,
      useClass: BankApiProvider,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
```

---

## Servicio de Pagos (usa la interfaz, nunca la implementación)

```typescript
// src/modules/payments/payments.service.ts

import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  IPaymentProvider,
  CreateChargeParams,
} from './interfaces/payment-provider.interface';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) 
    private readonly paymentProvider: IPaymentProvider, // ← Solo conoce la INTERFAZ
  ) {}

  async createOrderCharge(params: CreateChargeParams) {
    return this.paymentProvider.createCharge(params);
  }

  async verifyWebhook(payload: unknown, headers: Record<string, string>) {
    const isValid = this.paymentProvider.validateWebhook(payload, headers);
    if (!isValid) {
      this.logger.warn('Invalid webhook signature received');
      throw new BadRequestException('Invalid webhook signature');
    }
    return this.paymentProvider.parseWebhookEvent(payload);
  }
}
```

---

## Controller del Webhook

```typescript
// src/modules/payments/webhook.controller.ts

import {
  Controller, Post, Body, Headers, HttpCode, HttpStatus,
  Logger, UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { OrdersService } from '../orders/orders.service';
import { Public } from '../auth/decorators/public.decorator'; // excluye JWT guard

@Controller('webhooks/payments')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @Public() // No requiere JWT — viene del banco
  @HttpCode(HttpStatus.OK)
  async handlePaymentWebhook(
    @Body() payload: unknown,
    @Headers() headers: Record<string, string>,
  ) {
    // 1. Validar firma del webhook
    const event = await this.paymentsService.verifyWebhook(payload, headers);

    // 2. Idempotencia: ignorar eventos ya procesados
    const alreadyProcessed = await this.ordersService.isChargeProcessed(event.chargeId);
    if (alreadyProcessed) {
      this.logger.log(`Webhook ${event.chargeId} already processed, skipping`);
      return { received: true };
    }

    // 3. Procesar según tipo de evento
    switch (event.eventType) {
      case 'PAYMENT_COMPLETED':
        await this.ordersService.confirmPaymentAndQueueMint(event);
        break;
      case 'PAYMENT_FAILED':
        await this.ordersService.handlePaymentFailed(event);
        break;
      default:
        this.logger.log(`Unhandled event type: ${event.eventType}`);
    }

    return { received: true };
  }
}
```

---

## Cómo Cambiar de Proveedor

### Ejemplo: migrar a Stripe en el futuro

```typescript
// 1. Crear nuevo provider:
// src/modules/payments/providers/stripe.provider.ts
@Injectable()
export class StripeProvider implements IPaymentProvider {
  async createCharge(params: CreateChargeParams): Promise<ChargeResult> {
    // Implementación con Stripe SDK
    const session = await stripe.checkout.sessions.create({...});
    return { chargeId: session.id, checkoutUrl: session.url, ... };
  }
  // ... resto de métodos
}

// 2. Cambiar el binding en payments.module.ts:
{ provide: PAYMENT_PROVIDER, useClass: StripeProvider }  // ← Solo esta línea

// 3. Nada más cambia en el sistema.
```

---

## Variables de Entorno del Módulo de Pagos

```bash
# .env
PAYMENT_BANK_API_KEY=...
PAYMENT_BANK_API_SECRET=...
PAYMENT_BANK_BASE_URL=https://api.banco.bo/v1
PAYMENT_BANK_WEBHOOK_SECRET=...       # Para validar la firma del webhook
```

---

## Los dos QR del sistema

Este módulo clarifica cómo interactúan los dos tipos de QR:

### QR 1 — QR de Trazabilidad de Lote (estático, impreso en etiqueta)

```
Generado al crear/liberar el bottling_batch.
Impreso permanentemente en la etiqueta de la botella.
NUNCA cambia.

Contenido del QR:
  URL: https://api.drinks-on-chain.com/public/batch/{international_lot_code}
  
Qué muestra (sin login):
  - Bodega, enólogo, terroir, año de cosecha
  - Parámetros del análisis de laboratorio
  - Hash de anclaje en Stellar (verificable públicamente)
  - Estado del lote: disponible / tokenizado / agotado
  
Qué NO hace: No sirve para reclamar/quemar ningún NFT.
```

### QR 2 — QR de Claim (dinámico, generado por el usuario para retiro)

```
Generado por el USUARIO cuando quiere retirar físicamente su botella.
Es efímero (expira en X horas, configurable).
Pertenece al usuario propietario del NFT.

Contenido del QR:
  Payload JSON: {
    token_id: "uuid del tokenized_item",
    user_id: "uuid del usuario",
    pickup_location_id: "uuid del punto de retiro",
    nonce: "bytes aleatorios",
    expires_at: "ISO timestamp"
  }
  pass_hash = SHA-256(payload)  ← Este hash está anclado on-chain en C-05

Flujo en el POS:
  1. Operador POS escanea el QR del usuario
  2. POS envía el payload al backend
  3. Backend recalcula SHA-256 del payload
  4. Verifica en C-05 que el hash existe y está ACTIVE
  5. Verifica que no expiró y que el pickup_location_id coincide con el POS actual
  6. Si todo válido: ejecuta C-03.burn() + C-05.redeem()
  7. Entrega física de la botella al usuario
  
Qué NO hace: No muestra trazabilidad al público. Es solo para el operador POS.
```

### Separación de responsabilidades

| Aspecto | QR de Lote (botella) | QR de Claim (usuario) |
|---|---|---|
| ¿Quién lo genera? | Sistema al crear el lote | El usuario desde la app |
| ¿Cuándo se genera? | Al embotellado | Al solicitar retiro |
| ¿Es estático? | ✅ Sí — nunca cambia | ❌ No — expira y se regenera |
| ¿Quién lo escanea? | Cualquier persona | Solo operadores POS |
| ¿Requiere auth? | No | Sí (POS autenticado) |
| ¿Ejecuta algo on-chain? | No | Sí — burn + redeem |
| Tabla relacionada | `bottling_batches` | `claim_passes` |
