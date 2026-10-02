import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import { Prisma } from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import {
  BottlingBalance,
  computeBottlingBalance,
} from '@modules/lots/domain/bottling-balance';
import { parseLotRules } from '@modules/lots/domain/lot-rules';
import { distillationHeart, num } from '@modules/lots/domain/sources';
import { CorrectionMarks, markRows } from '@modules/lots/correction-marks';

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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  async findAll(
    wineryId: string | undefined,
    query: QueryBottlingBatchesDto,
  ): Promise<Paginated<BottlingView & CorrectionMarks>> {
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
      await markRows(
        this.prisma,
        'BOTTLING',
        items.map((i) => {
          const view: Partial<BottlingView> = toBottlingView(
            i,
            codes.get(i.id),
          );
          delete view.wineAgingBatch;
          delete view.productionBatch;
          return view as BottlingView;
        }),
      ),
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
    return (await markRows(this.prisma, 'BOTTLING', [view]))[0];
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
  // El vigente: ni sustituido por un reanálisis ni anulado por una corrección
  const valid = labAnalyses.filter((l) => l.voidedAt === null);
  const current =
    valid.find((l) => l.supersededAt === null) ?? valid[0] ?? null;
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
