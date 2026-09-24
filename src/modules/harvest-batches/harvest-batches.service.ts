import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { UpdatePhytoStatusDto } from './dto/update-phyto-status.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { Prisma, HarvestBatch, PhytoStatusEnum } from '@prisma/client';

@Injectable()
export class HarvestBatchesService {
  private readonly logger = new Logger(HarvestBatchesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(wineryId: string, dto: CreateHarvestBatchDto): Promise<HarvestBatch> {
    // 1. Validar que la parcela pertenezca a la bodega
    const terroir = await this.prisma.terroir.findFirst({
      where: { id: dto.terroirId, wineryId },
    });

    if (!terroir) {
      throw new NotFoundException(
        `Parcela con ID ${dto.terroirId} no encontrada en esta bodega`,
      );
    }

    // 2. Validar balance de pesaje
    if (dto.grossWeightKg <= dto.tareWeightKg) {
      throw new BadRequestException(
        'El peso bruto debe ser estrictamente mayor al peso tara',
      );
    }

    const netWeight = dto.grossWeightKg - dto.tareWeightKg;

    // 3. Generar código único de lote de vendimia
    const existingCount = await this.prisma.harvestBatch.count({
      where: {
        wineryId,
        harvestYear: dto.harvestYear,
      },
    });

    const terroirSlug = terroir.parcelName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    const sequence = (existingCount + 1).toString().padStart(3, '0');
    let harvestBatchCode = `HARV-${dto.harvestYear}-${terroirSlug}-${sequence}`;

    const duplicate = await this.prisma.harvestBatch.findUnique({
      where: { harvestBatchCode },
    });
    if (duplicate) {
      harvestBatchCode = `HARV-${dto.harvestYear}-${terroirSlug}-${sequence}-${Date.now().toString().slice(-4)}`;
    }

    this.logger.log(
      `Registrando lote de vendimia "${harvestBatchCode}" (${netWeight} kg netos)`,
    );

    return this.prisma.harvestBatch.create({
      data: {
        wineryId,
        terroirId: dto.terroirId,
        harvestBatchCode,
        intakeDate: new Date(dto.intakeDate),
        harvestYear: dto.harvestYear,
        grossWeightKg: new Prisma.Decimal(dto.grossWeightKg),
        tareWeightKg: new Prisma.Decimal(dto.tareWeightKg),
        netWeightKg: new Prisma.Decimal(netWeight),
        brixDegrees: new Prisma.Decimal(dto.brixDegrees),
        initialPh: new Prisma.Decimal(dto.initialPh),
        initialAcidityGl: new Prisma.Decimal(dto.initialAcidityGl),
        temperatureAtIntakeC:
          dto.temperatureAtIntakeC !== undefined
            ? new Prisma.Decimal(dto.temperatureAtIntakeC)
            : null,
        phytosanitaryStatus:
          dto.phytosanitaryStatus ?? PhytoStatusEnum.PENDING_INSPECTION,
        notes: dto.notes,
      },
    });
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryHarvestBatchesDto,
  ): Promise<{ items: HarvestBatch[]; total: number }> {
    const where: Prisma.HarvestBatchWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.harvestYear && { harvestYear: query.harvestYear }),
      ...(query.terroirId && { terroirId: query.terroirId }),
      ...(query.phytosanitaryStatus && {
        phytosanitaryStatus: query.phytosanitaryStatus,
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.harvestBatch.findMany({
        where,
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
        orderBy: { intakeDate: 'desc' },
        include: {
          terroir: true,
        },
      }),
      this.prisma.harvestBatch.count({ where }),
    ]);

    return { items, total };
  }

  async findById(
    wineryId: string | undefined,
    id: string,
  ): Promise<HarvestBatch & { terroir?: any; fermentationTanks?: any[] }> {
    const batch = await this.prisma.harvestBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        terroir: true,
        fermentationTanks: true,
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de vendimia con ID ${id} no encontrado en esta bodega`,
      );
    }

    return batch;
  }

  async updatePhytoStatus(
    wineryId: string,
    id: string,
    userId: string | null,
    dto: UpdatePhytoStatusDto,
  ): Promise<HarvestBatch> {
    await this.findById(wineryId, id);

    let memberId: string | null = null;
    if (userId) {
      const member = await this.prisma.wineryMember.findFirst({
        where: { userId, wineryId },
      });
      if (member) {
        memberId = member.id;
      }
    }

    this.logger.log(
      `Actualizando estado fitosanitario de lote ${id} a ${dto.phytosanitaryStatus}`,
    );

    return this.prisma.harvestBatch.update({
      where: { id },
      data: {
        phytosanitaryStatus: dto.phytosanitaryStatus,
        ...(dto.phytoInspectionPdfUrl && {
          phytoInspectionPdfUrl: dto.phytoInspectionPdfUrl,
        }),
        ...(dto.notes && { notes: dto.notes }),
        ...(memberId && { certifiedByMemberId: memberId }),
      },
    });
  }
}
