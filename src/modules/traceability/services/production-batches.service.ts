import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { CreateDistillationBatchDto } from '../dto/create-distillation-batch.dto';
import { QueryProductionBatchesDto } from '../dto/query-production-batches.dto';
import {
  Prisma,
  ProductionBatch,
  ProductionProcessEnum,
  RestStatusEnum,
  BeverageTypeEnum,
} from '@prisma/client';

@Injectable()
export class ProductionBatchesService {
  private readonly logger = new Logger(ProductionBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: TraceabilityStrategyFactory,
  ) {}

  async createDistillationBatch(
    wineryId: string,
    dto: CreateDistillationBatchDto,
  ): Promise<ProductionBatch> {
    const tank = await this.prisma.fermentationTank.findFirst({
      where: { id: dto.fermentationTankId, wineryId },
      include: { harvestBatch: { include: { terroir: true } } },
    });

    if (!tank) {
      throw new NotFoundException(
        `Cuba de fermentación con ID ${dto.fermentationTankId} no encontrada en esta bodega`,
      );
    }

    // Validación D.O. si corresponde
    if (dto.isDoEligible && tank.harvestBatch?.terroir) {
      const strategy = this.strategyFactory.getStrategy(BeverageTypeEnum.SINGANI);
      const validation = strategy.validatePlotAndHarvest(
        tank.harvestBatch.terroir,
        tank.harvestBatch,
      );
      if (!validation.isValid) {
        throw new UnprocessableEntityException(
          validation.errors.join('; ') || 'El lote no cumple con los requisitos D.O. para destilación',
        );
      }
    }

    // Validación de balance de masa si se proveen datos
    if (
      dto.inputVolumeLiters &&
      dto.outputVolumeLiters &&
      dto.wasteVolumeLiters
    ) {
      const sum = dto.outputVolumeLiters + dto.wasteVolumeLiters;
      if (sum > dto.inputVolumeLiters * 1.05) {
        throw new BadRequestException(
          `Balance de masa inconsistente: La suma de corazón (${dto.outputVolumeLiters} L) y descarte (${dto.wasteVolumeLiters} L) excede el volumen de entrada (${dto.inputVolumeLiters} L)`,
        );
      }
    }

    const startDate = new Date(dto.processStartDate);
    const endDate = dto.processEndDate ? new Date(dto.processEndDate) : null;

    let mandatoryRestUntil: Date | null = null;
    let restStatus: RestStatusEnum = RestStatusEnum.NOT_REQUIRED;

    if (endDate) {
      mandatoryRestUntil = new Date(endDate);
      mandatoryRestUntil.setDate(mandatoryRestUntil.getDate() + 180); // 180 días obligatorios
      restStatus = RestStatusEnum.RESTING;
    }

    this.logger.log(
      `Registrando lote de destilación en ${dto.equipmentIdentifier} para bodega ${wineryId}`,
    );

    return this.prisma.productionBatch.create({
      data: {
        wineryId,
        fermentationTankId: dto.fermentationTankId,
        processType: ProductionProcessEnum.SINGANI_DISTILLATION,
        equipmentIdentifier: dto.equipmentIdentifier,
        processStartDate: startDate,
        processEndDate: endDate,
        inputVolumeLiters:
          dto.inputVolumeLiters !== undefined
            ? new Prisma.Decimal(dto.inputVolumeLiters)
            : null,
        outputVolumeLiters:
          dto.outputVolumeLiters !== undefined
            ? new Prisma.Decimal(dto.outputVolumeLiters)
            : null,
        wasteVolumeLiters:
          dto.wasteVolumeLiters !== undefined
            ? new Prisma.Decimal(dto.wasteVolumeLiters)
            : null,
        initialAlcoholPercentage:
          dto.initialAlcoholPercentage !== undefined
            ? new Prisma.Decimal(dto.initialAlcoholPercentage)
            : null,
        isDoEligible: dto.isDoEligible ?? true,
        mandatoryRestUntil,
        restStatus,
        additionalParams: dto.additionalParams ?? Prisma.DbNull,
        notes: dto.notes,
      },
    });
  }

  async getRestStatus(
    wineryId: string | undefined,
    id: string,
  ): Promise<{
    id: string;
    restStatus: RestStatusEnum;
    processEndDate: Date | null;
    mandatoryRestUntil: Date | null;
    daysElapsed: number;
    daysRemaining: number;
    isRestCompleted: boolean;
  }> {
    const batch = await this.findProductionBatchById(wineryId, id);

    if (!batch.processEndDate || !batch.mandatoryRestUntil) {
      return {
        id: batch.id,
        restStatus: batch.restStatus,
        processEndDate: batch.processEndDate,
        mandatoryRestUntil: null,
        daysElapsed: 0,
        daysRemaining: 0,
        isRestCompleted: false,
      };
    }

    const now = new Date();
    const end = new Date(batch.processEndDate);
    const restTarget = new Date(batch.mandatoryRestUntil);

    const elapsedMs = now.getTime() - end.getTime();
    const daysElapsed = Math.max(0, Math.floor(elapsedMs / (1000 * 60 * 60 * 24)));

    const remainingMs = restTarget.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

    const isRestCompleted = daysRemaining === 0;

    return {
      id: batch.id,
      restStatus: isRestCompleted ? RestStatusEnum.READY : batch.restStatus,
      processEndDate: batch.processEndDate,
      mandatoryRestUntil: batch.mandatoryRestUntil,
      daysElapsed,
      daysRemaining,
      isRestCompleted,
    };
  }

  async findProductionBatchById(
    wineryId: string | undefined,
    id: string,
  ): Promise<
    ProductionBatch & { fermentationTank?: any; bottlingBatches?: any[] }
  > {
    const batch = await this.prisma.productionBatch.findFirst({
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
        `Lote de producción con ID ${id} no encontrado en esta bodega`,
      );
    }

    return batch;
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryProductionBatchesDto,
  ): Promise<{ items: ProductionBatch[]; total: number }> {
    const where: Prisma.ProductionBatchWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.processType && { processType: query.processType }),
      ...(query.restStatus && { restStatus: query.restStatus }),
      ...(query.fermentationTankId && {
        fermentationTankId: query.fermentationTankId,
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.productionBatch.findMany({
        where,
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
        orderBy: { processStartDate: 'desc' },
        include: {
          fermentationTank: true,
        },
      }),
      this.prisma.productionBatch.count({ where }),
    ]);

    return { items, total };
  }
}
