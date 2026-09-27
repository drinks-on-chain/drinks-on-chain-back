import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { Prisma, WineAgingBatch, AgingStatusEnum } from '@prisma/client';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { ConflictException as AppConflictException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';

@Injectable()
export class WineAgingService {
  private readonly logger = new Logger(WineAgingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createAgingBatch(
    wineryId: string,
    dto: CreateWineAgingBatchDto,
  ): Promise<WineAgingBatch> {
    const tank = await this.prisma.fermentationTank.findFirst({
      where: { id: dto.fermentationTankId, wineryId },
      include: { wineAgingBatch: true },
    });

    if (!tank) {
      throw new NotFoundException(
        `Cuba de fermentación con ID ${dto.fermentationTankId} no encontrada en esta bodega`,
      );
    }

    if (tank.wineAgingBatch) {
      throw new AppConflictException(
        ErrorCode.FERMENTATION_TANK_ALREADY_TRANSFERRED,
        `La cuba ${tank.tankCode} ya ha sido transferida a un lote de crianza previo`,
      );
    }

    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();
    const lockUntilDate = new Date(startDate);
    lockUntilDate.setMonth(lockUntilDate.getMonth() + dto.plannedMonths);

    this.logger.log(
      `Iniciando crianza de vino en ${dto.containerType} por ${dto.plannedMonths} meses (bloqueado hasta ${lockUntilDate.toISOString().split('T')[0]})`,
    );

    return this.prisma.wineAgingBatch.create({
      data: {
        wineryId,
        fermentationTankId: dto.fermentationTankId,
        containerType: dto.containerType,
        containerMaterial: dto.containerMaterial,
        containerCode: dto.containerCode,
        barrelUseCycle: dto.barrelUseCycle,
        volumeLiters:
          dto.volumeLiters !== undefined
            ? new Prisma.Decimal(dto.volumeLiters)
            : null,
        plannedMonths: dto.plannedMonths,
        lockUntilDate,
        agingStatus: AgingStatusEnum.AGING,
        notes: dto.notes,
      },
    });
  }

  async findAgingBatchById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.wineAgingBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        fermentationTank: {
          include: {
            harvestBatch: {
              include: { terroir: true },
            },
          },
        },
        bottlingBatches: true,
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de crianza con ID ${id} no encontrado en esta bodega`,
      );
    }

    return batch;
  }

  async findAll(
    wineryId: string | undefined,
    query: PaginationQueryDto,
  ): Promise<Paginated<WineAgingBatch>> {
    const where: Prisma.WineAgingBatchWhereInput = {
      ...(wineryId && { wineryId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.wineAgingBatch.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: { createdAt: 'desc' },
        include: {
          fermentationTank: true,
        },
      }),
      this.prisma.wineAgingBatch.count({ where }),
    ]);

    return toPage(items, total, query);
  }
}
