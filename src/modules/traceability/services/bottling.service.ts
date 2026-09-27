import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@shared/prisma/prisma.service';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { CreateBottlingBatchDto } from '../dto/create-bottling-batch.dto';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import { Prisma, BottlingBatch } from '@prisma/client';

@Injectable()
export class BottlingService {
  private readonly logger = new Logger(BottlingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: TraceabilityStrategyFactory,
  ) {}

  async create(
    wineryId: string,
    userId: string,
    dto: CreateBottlingBatchDto,
  ): Promise<BottlingBatch> {
    if (!dto.wineAgingBatchId && !dto.productionBatchId) {
      throw new BadRequestException(
        'Debe especificar un lote de crianza (wineAgingBatchId) o un lote de producción/destilación (productionBatchId)',
      );
    }

    const winery = await this.prisma.winery.findUnique({
      where: { id: wineryId },
    });

    if (!winery) {
      throw new NotFoundException(`Bodega con ID ${wineryId} no encontrada`);
    }

    const strategy = this.strategyFactory.getStrategy(dto.productType);

    let sourceBatch: any;
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
    const validation = strategy.validateBottlingEligibility(sourceBatch);
    if (!validation.isValid) {
      throw new UnprocessableEntityException(
        validation.errors.join('; ') ||
          'El lote no cumple los requisitos para embotellado',
      );
    }

    // 2. Generación de Código Internacional de Lote
    const bottlingYear = new Date(dto.bottlingDate).getFullYear();
    const wineryCode = (
      winery.commercialName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3) || 'DOC'
    ).toUpperCase();

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

    return this.prisma.bottlingBatch.create({
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
    });
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryBottlingBatchesDto,
  ): Promise<{ items: BottlingBatch[]; total: number }> {
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
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
        orderBy: { bottlingDate: 'desc' },
        include: {
          labAnalysis: true,
        },
      }),
      this.prisma.bottlingBatch.count({ where }),
    ]);

    return { items, total };
  }

  async findById(
    wineryId: string | undefined,
    id: string,
  ): Promise<
    BottlingBatch & {
      labAnalysis?: any;
      wineAgingBatch?: any;
      productionBatch?: any;
    }
  > {
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
