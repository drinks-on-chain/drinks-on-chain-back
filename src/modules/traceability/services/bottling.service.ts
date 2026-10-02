import { Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { CreateBottlingBatchDto } from '../dto/create-bottling-batch.dto';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import { Prisma } from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { lockLot, LockedLot } from '@modules/lots/lot-records';
import { actorMembership, dbClock } from '@modules/lots/trace-db';
import { ensureHarvestLot } from '@modules/lots/chain';
import {
  BottlingRequest,
  evaluateBottling,
  executeBottling,
} from '@modules/lots/bottling-engine';
import { resolvePassportBaseUrl } from '@modules/lots/bottle-units';
import {
  BottlingBalance,
  computeBottlingBalance,
} from '@modules/lots/domain/bottling-balance';
import { parseLotRules } from '@modules/lots/domain/lot-rules';
import { distillationHeart, num } from '@modules/lots/domain/sources';
import {
  stateError,
  throwViolations,
  violation,
} from '@modules/lots/domain/trace-errors';

/** Transacción del embotellado: genera hasta 100 000 códigos de botella. */
const BOTTLING_TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;

const HEART_SELECT = {
  heartLiters: true,
  outputVolumeLiters: true,
  heartAbvPercent: true,
  initialAlcoholPercentage: true,
} as const;

const BOTTLING_VIEW_INCLUDE = {
  lot: {
    select: {
      rules: true,
      productType: true,
      // Todas las fuentes que entraron al embotellado del lote (§6.1)
      wineAgingBatches: {
        where: { agingStatus: 'BOTTLED' },
        select: { volumeLiters: true },
      },
      productionBatches: {
        where: { restStatus: 'BOTTLED' },
        select: HEART_SELECT,
      },
    },
  },
  labAnalyses: { orderBy: { createdAt: 'desc' } },
  wineAgingBatch: { select: { volumeLiters: true } },
  productionBatch: { select: HEART_SELECT },
} satisfies Prisma.BottlingBatchInclude;

@Injectable()
export class BottlingService {
  private readonly logger = new Logger(BottlingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Ruta legada `POST /v1/bottling` (contrato O2 §6.1): el lote se deduce del
   * origen y aplica desde la apertura las mismas reglas que
   * `POST /v1/lots/{id}/bottling` (EA-01, EA-02, EA-07): tipo derivado,
   * candados con el reloj de la base y la instantánea, un embotellado por
   * lote, balance de volumen y alcohol, fuentes a `BOTTLED`.
   */
  async create(wineryId: string, userId: string, dto: CreateBottlingBatchDto) {
    if (!dto.wineAgingBatchId && !dto.productionBatchId) {
      const message =
        'Debe especificar un lote de crianza (wineAgingBatchId) o un lote de producción/destilación (productionBatchId)';
      throw new ValidationException([
        { field: 'wineAgingBatchId', message },
        { field: 'productionBatchId', message },
      ]);
    }
    if (dto.wineAgingBatchId && dto.productionBatchId) {
      throwViolations([
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'Un embotellado sale de una crianza (vino) o de una destilación (singani), no de ambas',
          { field: 'productionBatchId' },
        ),
      ]);
    }
    const passportBaseUrl = this.passportBaseUrl();
    const id = await this.prisma.$transaction(async (tx) => {
      const lot = await this.lotOfSource(tx, wineryId, dto);
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
      const clock = await dbClock(tx);
      const request: BottlingRequest = {
        sources: [
          dto.wineAgingBatchId
            ? { kind: 'AGING', id: dto.wineAgingBatchId }
            : { kind: 'REST', id: dto.productionBatchId as string },
        ],
        declaredProductType: dto.productType,
        bottlingDate: dto.bottlingDate,
        packagingFormatCl: dto.packagingFormatCl,
        totalBottlesPackaged: dto.totalBottlesPackaged,
        finalAlcoholAbv: dto.finalAlcoholAbv,
        waterDilutionLiters: dto.waterDilutionLiters,
        bottleType: dto.bottleType,
        labelDesignUrl: dto.labelDesignUrl,
      };
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
          wineAgingBatchId: dto.wineAgingBatchId,
          productionBatchId: dto.productionBatchId,
        },
      });
      const created = await tx.bottlingBatch.findUniqueOrThrow({
        where: { id: bottlingId },
      });
      this.logger.log(
        `Embotellado "${created.internationalLotCode}" (${dto.totalBottlesPackaged} botellas de ${dto.packagingFormatCl} cL a ${dto.finalAlcoholAbv}% ABV)`,
      );
      await this.audit.record(tx, {
        action: AuditAction.BOTTLING_BATCH_CREATED,
        resource: { type: 'bottling_batch', id: created.id },
        organizationId: wineryId,
        after: { ...created, balance: evaluation.balance },
      });
      return created.id;
    }, BOTTLING_TX_OPTIONS);
    return this.findById(wineryId, id);
  }

  /** Lote del origen (lo rellena al vuelo si es anterior a la Ola 2), bloqueado. */
  private async lotOfSource(
    tx: Prisma.TransactionClient,
    wineryId: string,
    dto: CreateBottlingBatchDto,
  ): Promise<LockedLot> {
    const source = dto.wineAgingBatchId
      ? await tx.wineAgingBatch.findFirst({
          where: { id: dto.wineAgingBatchId, wineryId },
          select: {
            lotId: true,
            fermentationTank: { select: { harvestBatchId: true } },
          },
        })
      : await tx.productionBatch.findFirst({
          where: { id: dto.productionBatchId, wineryId },
          select: {
            lotId: true,
            fermentationTank: { select: { harvestBatchId: true } },
          },
        });
    if (!source) {
      throw new NotFoundException(
        dto.wineAgingBatchId
          ? `Lote de crianza con ID ${dto.wineAgingBatchId} no encontrado en esta bodega`
          : `Lote de destilación/producción con ID ${dto.productionBatchId} no encontrado en esta bodega`,
      );
    }
    const lotId =
      source.lotId ??
      (await ensureHarvestLot(tx, source.fermentationTank.harvestBatchId));
    if (!lotId) {
      throw new NotFoundException('La fuente no pertenece a ningún lote');
    }
    return lockLot(tx, lotId, wineryId, { writable: true });
  }

  private passportBaseUrl(): string {
    return resolvePassportBaseUrl({
      PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
      APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
    });
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryBottlingBatchesDto,
  ): Promise<Paginated<BottlingView>> {
    const where: Prisma.BottlingBatchWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.productType && { productType: query.productType }),
      ...(query.isAnchoredOnChain !== undefined && {
        isAnchoredOnChain: query.isAnchoredOnChain,
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.bottlingBatch.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ bottlingDate: 'desc' }, { id: 'asc' }],
        include: BOTTLING_VIEW_INCLUDE,
      }),
      this.prisma.bottlingBatch.count({ where }),
    ]);
    const codes = await this.codeCounts(items.map((i) => i.id));
    // En la lista no van la crianza ni la destilación (solo en el detalle)
    return toPage(
      items.map((i) => {
        const view: Partial<BottlingView> = toBottlingView(i, codes.get(i.id));
        delete view.wineAgingBatch;
        delete view.productionBatch;
        return view as BottlingView;
      }),
      total,
      query,
    );
  }

  async findById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.bottlingBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        ...BOTTLING_VIEW_INCLUDE,
        wineAgingBatch: {
          include: {
            fermentationTank: {
              include: {
                harvestBatch: {
                  include: { terroir: true },
                },
              },
            },
          },
        },
        productionBatch: {
          include: {
            fermentationTank: {
              include: {
                harvestBatch: {
                  include: { terroir: true },
                },
              },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de embotellado con ID ${id} no encontrado en esta bodega`,
      );
    }
    const codes = await this.codeCounts([batch.id]);
    const view = toBottlingView(batch, codes.get(batch.id));
    if (view.labelDesign) {
      // URL firmada de corta vida de la etiqueta (§6.3); la lista solo trae la `key`
      try {
        view.labelDesign.url = (
          await this.storage.getSignedUrl(view.labelDesign.key)
        ).url;
      } catch {
        view.labelDesign.url = null;
      }
    }
    return view;
  }

  private async codeCounts(
    ids: string[],
  ): Promise<Map<string, BottleCodesSummary>> {
    const map = new Map<string, BottleCodesSummary>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.bottleUnit.groupBy({
      by: ['bottlingBatchId', 'status'],
      where: { bottlingBatchId: { in: ids } },
      _count: { _all: true },
      _min: { serial: true },
      _max: { serial: true },
    });
    for (const row of rows) {
      const current = map.get(row.bottlingBatchId) ?? {
        total: 0,
        active: 0,
        voided: 0,
        firstSerial: null,
        lastSerial: null,
      };
      current.total += row._count._all;
      if (row.status === 'ACTIVE') current.active += row._count._all;
      else current.voided += row._count._all;
      const min = row._min.serial;
      const max = row._max.serial;
      if (
        min !== null &&
        (current.firstSerial === null || min < current.firstSerial)
      )
        current.firstSerial = min;
      if (
        max !== null &&
        (current.lastSerial === null || max > current.lastSerial)
      )
        current.lastSerial = max;
      map.set(row.bottlingBatchId, current);
    }
    return map;
  }
}

export interface BottleCodesSummary {
  total: number;
  active: number;
  voided: number;
  firstSerial: number | null;
  lastSerial: number | null;
}

type BottlingRow = Prisma.BottlingBatchGetPayload<{
  include: typeof BOTTLING_VIEW_INCLUDE;
}>;

export type BottlingView = Omit<BottlingRow, 'lot' | 'labAnalyses'> & {
  lotCode: string;
  labAnalysis: BottlingRow['labAnalyses'][number] | null;
  balance: BottlingBalance | null;
  leftover: {
    liters: number;
    disposition: string;
    notes: string | null;
  } | null;
  bottleCodes: BottleCodesSummary;
  labelDesign: { key: string; url: string | null } | null;
};

/** Embotellado con los campos de la Ola 2 (§6.3). */
function toBottlingView(
  row: BottlingRow,
  codes: BottleCodesSummary | undefined,
): BottlingView {
  const { lot, labAnalyses, ...rest } = row;
  const current =
    labAnalyses.find((l) => l.supersededAt === null) ?? labAnalyses[0] ?? null;
  let available = num(row.availableLiters);
  let heartPure: number | null = null;
  // Fuentes del embotellado: las del lote que quedaron `BOTTLED`; en los
  // registros sin ellas, la crianza o la destilación enlazada
  const distillations =
    lot && lot.productionBatches.length > 0
      ? lot.productionBatches
      : row.productionBatch
        ? [row.productionBatch]
        : [];
  const agings =
    lot && lot.wineAgingBatches.length > 0
      ? lot.wineAgingBatches
      : row.wineAgingBatch
        ? [row.wineAgingBatch]
        : [];
  if (distillations.length > 0) {
    const hearts = distillations.map((p) => distillationHeart(p));
    if (hearts.every((h) => h.liters !== null)) {
      available ??= hearts.reduce((sum, h) => sum + (h.liters as number), 0);
    }
    heartPure = hearts.every((h) => h.liters !== null && h.abv !== null)
      ? hearts.reduce(
          (sum, h) => sum + ((h.liters as number) * (h.abv as number)) / 100,
          0,
        )
      : null;
  } else if (agings.length > 0) {
    const liters = agings.map((a) => num(a.volumeLiters));
    if (liters.every((l) => l !== null)) {
      available ??= (liters as number[]).reduce((sum, l) => sum + l, 0);
    }
  }
  const productType =
    (lot?.productType as 'WINE' | 'SINGANI' | null) ??
    (row.productType === 'SINGANI' ? 'SINGANI' : 'WINE');
  const balance =
    lot && available !== null
      ? computeBottlingBalance({
          productType,
          availableLiters: available,
          waterDilutionLiters: num(row.waterDilutionLiters) ?? 0,
          bottles: row.totalBottlesPackaged,
          formatCl: row.packagingFormatCl,
          leftoverLiters: num(row.leftoverLiters) ?? 0,
          maxLossPercent: parseLotRules(lot.rules).bottling.maxLossPercent,
          finalAbv: row.finalAlcoholAbv.toNumber(),
          pureAlcoholAvailableLiters: heartPure,
        })
      : null;
  return {
    ...rest,
    lotCode: row.internationalLotCode,
    labAnalysis: current,
    balance,
    leftover:
      row.leftoverLiters !== null
        ? {
            liters: row.leftoverLiters.toNumber(),
            disposition: row.leftoverDisposition ?? 'RETAINED',
            notes: row.leftoverNotes,
          }
        : null,
    bottleCodes: codes ?? {
      total: 0,
      active: 0,
      voided: 0,
      firstSerial: null,
      lastSerial: null,
    },
    labelDesign: row.labelDesignKey
      ? { key: row.labelDesignKey, url: null }
      : null,
  };
}
