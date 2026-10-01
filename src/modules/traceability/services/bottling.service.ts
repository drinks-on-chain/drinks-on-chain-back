import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { CreateBottlingBatchDto } from '../dto/create-bottling-batch.dto';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import {
  Prisma,
  BottlingBatch,
  WineAgingBatch,
  ProductionBatch,
} from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { ensureLotPrefix } from '@modules/wineries/winery-codes';

@Injectable()
export class BottlingService {
  private readonly logger = new Logger(BottlingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: TraceabilityStrategyFactory,
    private readonly audit: AuditService,
  ) {}

  async create(
    wineryId: string,
    userId: string,
    dto: CreateBottlingBatchDto,
  ): Promise<BottlingBatch> {
    if (!dto.wineAgingBatchId && !dto.productionBatchId) {
      const message =
        'Debe especificar un lote de crianza (wineAgingBatchId) o un lote de producción/destilación (productionBatchId)';
      throw new ValidationException([
        { field: 'wineAgingBatchId', message },
        { field: 'productionBatchId', message },
      ]);
    }

    const winery = await this.prisma.winery.findUnique({
      where: { id: wineryId },
    });

    if (!winery) {
      throw new NotFoundException(`Bodega con ID ${wineryId} no encontrada`);
    }

    const strategy = this.strategyFactory.getStrategy(dto.productType);

    let sourceBatch: WineAgingBatch | ProductionBatch | null = null;
    if (dto.wineAgingBatchId) {
      sourceBatch = await this.prisma.wineAgingBatch.findFirst({
        where: { id: dto.wineAgingBatchId, wineryId },
      });
      if (!sourceBatch) {
        throw new NotFoundException(
          `Lote de crianza con ID ${dto.wineAgingBatchId} no encontrado en esta bodega`,
        );
      }
    } else if (dto.productionBatchId) {
      sourceBatch = await this.prisma.productionBatch.findFirst({
        where: { id: dto.productionBatchId, wineryId },
      });
      if (!sourceBatch) {
        throw new NotFoundException(
          `Lote de destilación/producción con ID ${dto.productionBatchId} no encontrado en esta bodega`,
        );
      }
    }

    // 1. Validación de reglas enológicas D.O. (ej. 180 días de reposo inerte o bloqueo de barrica)
    // Sin lote de origen se delega igual en la estrategia (comportamiento
    // actual); la derivación del tipo desde el origen llega con EA-01/EA-02.
    const validation = strategy.validateBottlingEligibility(
      sourceBatch as WineAgingBatch | ProductionBatch,
    );
    if (!validation.isValid) {
      throw new UnprocessableEntityException(
        validation.errors.join('; ') ||
          'El lote no cumple los requisitos para embotellado',
      );
    }

    // 2. Generación de Código Internacional de Lote con el prefijo único de
    // la bodega (ORG-05; cierra la colisión de prefijos de EA-07). Una bodega
    // activa antes de la Ola 1 sin prefijo recibe el suyo aquí. La secuencia
    // sin carreras (contador por bodega y año) llega con la Etapa 2 (EA-07).
    const bottlingYear = new Date(dto.bottlingDate).getFullYear();
    const wineryCode =
      winery.lotPrefix ??
      (await this.prisma.$transaction((tx) => ensureLotPrefix(tx, winery)));

    const existingCount = await this.prisma.bottlingBatch.count({
      where: { wineryId },
    });
    const sequence = (existingCount + 1).toString().padStart(3, '0');
    const internationalLotCode = `${wineryCode}-${bottlingYear}-${dto.productType}-${sequence}`;

    const qrBatchUrl = `https://drinksonchain.com/trace/batch/${internationalLotCode}`;

    // 3. Generación de Hash Criptográfico canónico de los datos
    const canonicalPayload = {
      internationalLotCode,
      productType: dto.productType,
      finalAlcoholAbv: dto.finalAlcoholAbv,
      totalBottlesPackaged: dto.totalBottlesPackaged,
      packagingFormatCl: dto.packagingFormatCl,
      bottlingDate: dto.bottlingDate,
      wineryId,
    };
    const blockchainDataHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    // 4. Obtener miembro de bodega
    let releasedByMemberId: string | null = null;
    const member = await this.prisma.wineryMember.findFirst({
      where: { userId, wineryId, isActive: true },
    });
    if (member) {
      releasedByMemberId = member.id;
    }

    this.logger.log(
      `Registrando lote de embotellado "${internationalLotCode}" (${dto.totalBottlesPackaged} botellas de ${dto.packagingFormatCl} cL a ${dto.finalAlcoholAbv}% ABV)`,
    );

    return this.audit.transaction(
      (tx) =>
        tx.bottlingBatch.create({
          data: {
            wineryId,
            wineAgingBatchId: dto.wineAgingBatchId,
            productionBatchId: dto.productionBatchId,
            productType: dto.productType,
            internationalLotCode,
            finalAlcoholAbv: new Prisma.Decimal(dto.finalAlcoholAbv),
            waterDilutionLiters:
              dto.waterDilutionLiters !== undefined
                ? new Prisma.Decimal(dto.waterDilutionLiters)
                : null,
            totalBottlesPackaged: dto.totalBottlesPackaged,
            packagingFormatCl: dto.packagingFormatCl,
            bottleType: dto.bottleType,
            labelDesignUrl: dto.labelDesignUrl,
            bottlingDate: new Date(dto.bottlingDate),
            releasedByMemberId,
            blockchainDataHash,
            isAnchoredOnChain: false,
            qrBatchUrl,
          },
        }),
      (created) => ({
        action: AuditAction.BOTTLING_BATCH_CREATED,
        resource: { type: 'bottling_batch', id: created.id },
        organizationId: wineryId,
        after: created,
      }),
    );
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryBottlingBatchesDto,
  ): Promise<Paginated<BottlingBatch>> {
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
        orderBy: { bottlingDate: 'desc' },
        include: {
          labAnalysis: true,
        },
      }),
      this.prisma.bottlingBatch.count({ where }),
    ]);

    return toPage(items, total, query);
  }

  async findById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.bottlingBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        labAnalysis: true,
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

    return batch;
  }
}
