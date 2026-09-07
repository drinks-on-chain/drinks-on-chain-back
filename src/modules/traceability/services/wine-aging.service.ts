import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { Prisma, WineAgingBatch, AgingStatusEnum } from '@prisma/client';

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
      throw new BadRequestException(
        `La cuba ${tank.tankCode} ya ha sido transferida a un lote de crianza previo`,
      );
    }

    const startDate = new Date();
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

  async findAgingBatchById(
    wineryId: string,
    id: string,
  ): Promise<WineAgingBatch & { fermentationTank?: any; bottlingBatches?: any[] }> {
    const batch = await this.prisma.wineAgingBatch.findFirst({
      where: { id, wineryId },
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
    wineryId: string,
  ): Promise<{ items: WineAgingBatch[]; total: number }> {
    const [items, total] = await Promise.all([
      this.prisma.wineAgingBatch.findMany({
        where: { wineryId },
        orderBy: { createdAt: 'desc' },
        include: {
          fermentationTank: true,
        },
      }),
      this.prisma.wineAgingBatch.count({ where: { wineryId } }),
    ]);

    return { items, total };
  }
}
