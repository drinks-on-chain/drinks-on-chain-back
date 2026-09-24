import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateFermentationTankDto } from '../dto/create-fermentation-tank.dto';
import { CreateFermentationLogDto } from '../dto/create-fermentation-log.dto';
import { CreateEnologicalTreatmentDto } from '../dto/create-enological-treatment.dto';
import { QueryTanksDto } from '../dto/query-tanks.dto';
import {
  Prisma,
  FermentationTank,
  FermentationLog,
  EnologicalTreatment,
  TankStatusEnum,
} from '@prisma/client';

@Injectable()
export class FermentationService {
  private readonly logger = new Logger(FermentationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTank(
    wineryId: string,
    dto: CreateFermentationTankDto,
  ): Promise<FermentationTank> {
    const harvestBatch = await this.prisma.harvestBatch.findFirst({
      where: { id: dto.harvestBatchId, wineryId },
    });

    if (!harvestBatch) {
      throw new NotFoundException(
        `Lote de vendimia con ID ${dto.harvestBatchId} no encontrado en esta bodega`,
      );
    }

    this.logger.log(
      `Registrando cuba de fermentación ${dto.tankCode} vinculada al lote ${harvestBatch.harvestBatchCode}`,
    );

    return this.prisma.fermentationTank.create({
      data: {
        wineryId,
        harvestBatchId: dto.harvestBatchId,
        tankCode: dto.tankCode,
        capacityLiters:
          dto.capacityLiters !== undefined
            ? new Prisma.Decimal(dto.capacityLiters)
            : null,
        material: dto.material,
        volumeFilledLiters:
          dto.volumeFilledLiters !== undefined
            ? new Prisma.Decimal(dto.volumeFilledLiters)
            : null,
        destinationType: dto.destinationType,
        status: dto.status ?? TankStatusEnum.FILLING,
        startDate: new Date(dto.startDate),
      },
    });
  }

  async findTanks(
    wineryId: string | undefined,
    query: QueryTanksDto,
  ): Promise<{ items: FermentationTank[]; total: number }> {
    const where: Prisma.FermentationTankWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.status && { status: query.status }),
      ...(query.destinationType && { destinationType: query.destinationType }),
      ...(query.harvestBatchId && { harvestBatchId: query.harvestBatchId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.fermentationTank.findMany({
        where,
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
        orderBy: { startDate: 'desc' },
        include: {
          harvestBatch: true,
        },
      }),
      this.prisma.fermentationTank.count({ where }),
    ]);

    return { items, total };
  }

  async findTankById(
    wineryId: string | undefined,
    id: string,
  ): Promise<
    FermentationTank & {
      harvestBatch?: any;
      logs?: FermentationLog[];
      treatments?: EnologicalTreatment[];
    }
  > {
    const tank = await this.prisma.fermentationTank.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        harvestBatch: true,
        logs: {
          orderBy: { recordedAt: 'asc' },
        },
        treatments: {
          orderBy: { appliedAt: 'asc' },
        },
      },
    });

    if (!tank) {
      throw new NotFoundException(
        `Cuba de fermentación con ID ${id} no encontrada en esta bodega`,
      );
    }

    return tank;
  }

  async addLog(
    wineryId: string,
    tankId: string,
    userId: string,
    dto: CreateFermentationLogDto,
  ): Promise<FermentationLog> {
    await this.findTankById(wineryId, tankId);

    this.logger.log(
      `Registrando log térmico (${dto.temperatureCelsius}°C) en cuba ${tankId}`,
    );

    return this.prisma.fermentationLog.create({
      data: {
        fermentationTankId: tankId,
        temperatureCelsius: new Prisma.Decimal(dto.temperatureCelsius),
        specificGravity:
          dto.specificGravity !== undefined
            ? new Prisma.Decimal(dto.specificGravity)
            : null,
        phValue:
          dto.phValue !== undefined ? new Prisma.Decimal(dto.phValue) : null,
        co2Observations: dto.co2Observations,
        recordedAt: new Date(dto.recordedAt),
        recordedByUserId: userId,
        notes: dto.notes,
      },
    });
  }

  async addTreatment(
    wineryId: string,
    tankId: string,
    userId: string,
    dto: CreateEnologicalTreatmentDto,
  ): Promise<EnologicalTreatment> {
    await this.findTankById(wineryId, tankId);

    const member = await this.prisma.wineryMember.findFirst({
      where: { userId, wineryId, isActive: true },
    });

    if (!member) {
      throw new ForbiddenException(
        'El usuario no es miembro activo acreditado de esta bodega',
      );
    }

    this.logger.log(
      `Registrando tratamiento enológico "${dto.additiveName}" (${dto.dosageAppliedGPerHl} g/hL) en cuba ${tankId}`,
    );

    return this.prisma.enologicalTreatment.create({
      data: {
        fermentationTankId: tankId,
        treatmentType: dto.treatmentType,
        additiveName: dto.additiveName,
        additiveSupplier: dto.additiveSupplier,
        dosageAppliedGPerHl: new Prisma.Decimal(dto.dosageAppliedGPerHl),
        totalAppliedG:
          dto.totalAppliedG !== undefined
            ? new Prisma.Decimal(dto.totalAppliedG)
            : null,
        regulatoryAuthCode: dto.regulatoryAuthCode,
        appliedAt: new Date(dto.appliedAt),
        authorizedByMemberId: member.id,
        notes: dto.notes,
      },
    });
  }
}
