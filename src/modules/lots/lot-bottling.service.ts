import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { lockLot, LockedLot } from './lot-records';
import { actorMembership, dbClock } from './trace-db';
import { resolvePassportBaseUrl } from './bottle-units';
import {
  BottlingRequest,
  BottlingSourceRef,
  evaluateBottling,
  executeBottling,
} from './bottling-engine';
import type { BottlingBalance } from './domain/bottling-balance';
import { stateError, throwViolations, violation } from './domain/trace-errors';

/** Cuerpo de `POST /v1/lots/{id}/bottling[/preview]` (contrato O2 §6.1). */
export interface LotBottlingInput {
  sources?: {
    wineAgingBatchId?: string;
    productionBatchId?: string;
    liters: number;
  }[];
  bottlingDate: string;
  packagingFormatCl: number;
  totalBottlesPackaged: number;
  finalAlcoholAbv: number;
  waterDilutionLiters?: number;
  leftover?: {
    liters: number;
    disposition: 'RETAINED' | 'DISCARDED';
    notes?: string;
  };
  bottleType?: string;
  labelDesignKey?: string;
  labelDesignUrl?: string;
}

const BOTTLING_TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;

/**
 * Embotellado del lote (§6.1–§6.3) con el motor común del embotellado seguro
 * (`bottling-engine.ts`), el mismo que aplica la ruta legada `POST /v1/bottling`.
 */
@Injectable()
export class LotBottlingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** Vista previa: evalúa las reglas sin escribir nada. */
  async preview(
    wineryId: string,
    lotId: string,
    input: LotBottlingInput,
  ): Promise<{
    valid: boolean;
    balance: BottlingBalance;
    violations: ErrorDetail[];
  }> {
    return this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId, wineryId, { writable: true });
      await assertNotBottled(tx, lot);
      const clock = await dbClock(tx);
      const request = await toRequest(tx, lot, input);
      const evaluation = await evaluateBottling(tx, lot, request, clock);
      return {
        valid: evaluation.valid,
        balance: evaluation.balance,
        violations: evaluation.violations,
      };
    }, BOTTLING_TX_OPTIONS);
  }

  /** Embotellado: una sola vez por lote; devuelve el id del embotellado. */
  async create(
    wineryId: string,
    lotId: string,
    userId: string,
    input: LotBottlingInput,
  ): Promise<string> {
    const passportBaseUrl = resolvePassportBaseUrl({
      PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
      APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
    });
    return this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId, wineryId, { writable: true });
      await assertNotBottled(tx, lot);
      const clock = await dbClock(tx);
      const request = await toRequest(tx, lot, input);
      const evaluation = await evaluateBottling(tx, lot, request, clock);
      throwViolations(
        evaluation.violations,
        evaluation.violations.length > 1
          ? `${evaluation.violations[0].message} (y ${evaluation.violations.length - 1} regla(s) más)`
          : undefined,
      );
      const membership = await actorMembership(tx, userId, wineryId);
      const bottlingId = await executeBottling(tx, lot, request, evaluation, {
        clock,
        membershipId: membership?.id ?? null,
        passportBaseUrl,
        legacy: {
          wineAgingBatchId: request.sources.find((s) => s.kind === 'AGING')?.id,
          productionBatchId: request.sources.find((s) => s.kind === 'REST')?.id,
        },
      });
      const created = await tx.bottlingBatch.findUniqueOrThrow({
        where: { id: bottlingId },
      });
      await this.audit.record(tx, {
        action: AuditAction.BOTTLED,
        resource: { type: 'bottling_batch', id: bottlingId },
        organizationId: wineryId,
        after: { ...created, lotId, balance: evaluation.balance },
      });
      return bottlingId;
    }, BOTTLING_TX_OPTIONS);
  }
}

async function assertNotBottled(
  tx: Prisma.TransactionClient,
  lot: LockedLot,
): Promise<void> {
  const existing = await tx.bottlingBatch.findFirst({
    where: { lotId: lot.id },
    select: { id: true, internationalLotCode: true },
  });
  if (existing) {
    throw stateError(
      ErrorCode.TRC_LOT_ALREADY_BOTTLED,
      `El lote ya se embotelló (${existing.internationalLotCode}): un embotellado por lote`,
      [
        violation(
          ErrorCode.TRC_LOT_ALREADY_BOTTLED,
          'Segundo embotellado del lote',
          {
            meta: {
              bottlingBatchId: existing.id,
              lotCode: existing.internationalLotCode,
            },
          },
        ),
      ],
    );
  }
}

/**
 * Fuentes del embotellado: las indicadas, o por defecto todas las fuentes
 * abiertas del lote con todo su volumen disponible (§6.1).
 */
async function toRequest(
  tx: Prisma.TransactionClient,
  lot: LockedLot,
  input: LotBottlingInput,
): Promise<BottlingRequest> {
  let sources: BottlingSourceRef[];
  if (input.sources && input.sources.length > 0) {
    sources = input.sources.map((s, i) => {
      if (!!s.wineAgingBatchId === !!s.productionBatchId) {
        throw ValidationException.forField(
          `sources.${i}`,
          'Cada fuente es una crianza (wineAgingBatchId) o una destilación (productionBatchId)',
        );
      }
      return s.wineAgingBatchId
        ? { kind: 'AGING', id: s.wineAgingBatchId, liters: s.liters }
        : { kind: 'REST', id: s.productionBatchId as string, liters: s.liters };
    });
  } else {
    const [agings, productions] = await Promise.all([
      tx.wineAgingBatch.findMany({
        where: {
          lotId: lot.id,
          discardedAt: null,
          agingStatus: { in: ['AGING', 'READY'] },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
      tx.productionBatch.findMany({
        where: {
          lotId: lot.id,
          discardedAt: null,
          restStatus: { in: ['RESTING', 'READY', 'NOT_REQUIRED'] },
        },
        select: { id: true },
        orderBy: { processStartDate: 'asc' },
      }),
    ]);
    sources = [
      ...agings.map((a) => ({ kind: 'AGING' as const, id: a.id })),
      ...productions.map((p) => ({ kind: 'REST' as const, id: p.id })),
    ];
    if (sources.length === 0) {
      throw stateError(
        ErrorCode.TRC_INVALID_STAGE,
        'El lote no tiene crianzas ni destilaciones que embotellar',
        [
          violation(ErrorCode.TRC_INVALID_STAGE, 'Sin fuentes abiertas', {
            meta: { stage: lot.stage, allowed: ['AGING', 'RESTING'] },
          }),
        ],
      );
    }
  }
  return {
    sources,
    bottlingDate: input.bottlingDate,
    packagingFormatCl: input.packagingFormatCl,
    totalBottlesPackaged: input.totalBottlesPackaged,
    finalAlcoholAbv: input.finalAlcoholAbv,
    waterDilutionLiters: input.waterDilutionLiters,
    leftover: input.leftover,
    bottleType: input.bottleType,
    labelDesignKey: input.labelDesignKey,
    labelDesignUrl: input.labelDesignUrl,
  };
}
