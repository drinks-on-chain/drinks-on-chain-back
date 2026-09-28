import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhytoStatusEnum } from '@prisma/client';
import { TerroirResponseDto } from '@modules/terroirs/dto/terroir-response.dto';
import { FermentationTankResponseDto } from '@modules/traceability/dto/fermentation-tank-response.dto';
import { DoEvaluationDto } from '@modules/lots/dto/lot.dto';
import {
  MaturityAnalysisResponseDto,
  PhytoDecisionResponseDto,
} from './phyto-decision.dto';

/** La parcela tal como era al pesar (§3.2). */
export class TerroirSnapshotDto {
  @ApiProperty({ example: 'Parcela 1 · Los Parrales' })
  parcelName!: string;

  @ApiProperty({ example: 2350 })
  altitudeMasl!: number;

  @ApiProperty({ example: 'Moscatel de Alejandría' })
  varietyName!: string;

  @ApiProperty({ example: 'uva' })
  rawMaterialType!: string;

  @ApiProperty({ example: '2026-03-04T09:45:00.000Z' })
  takenAt!: string;
}

export class HarvestBatchResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  terroirId!: string;

  @ApiProperty({ example: 'HARV-2026-POTRERO-001' })
  harvestBatchCode!: string;

  @ApiProperty({ example: '2026-03-15' })
  intakeDate!: Date;

  @ApiProperty({ example: 2026 })
  harvestYear!: number;

  @ApiProperty({ example: 15000.0 })
  grossWeightKg!: number;

  @ApiProperty({ example: 150.0 })
  tareWeightKg!: number;

  @ApiProperty({ example: 14850.0 })
  netWeightKg!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 22.4,
    description:
      'Del último análisis de madurez; `null` sin análisis (cambio incompatible de la Ola 2)',
  })
  brixDegrees!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.45 })
  initialPh!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 6.8 })
  initialAcidityGl!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 16.5 })
  temperatureAtIntakeC?: number | null;

  @ApiProperty({ enum: PhytoStatusEnum, example: PhytoStatusEnum.APPROVED })
  phytosanitaryStatus!: PhytoStatusEnum;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://storage.drinksonchain.com/inspections/phyto-01.pdf',
  })
  phytoInspectionPdfUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  certifiedByMemberId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cosecha matutina manual',
  })
  notes?: string | null;

  @ApiProperty({ example: '2026-09-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Lote (Ola 2); `null` = uva recibida sin lote',
  })
  lotId!: string | null;

  @ApiProperty({ type: () => TerroirSnapshotDto, nullable: true })
  terroirSnapshot!: TerroirSnapshotDto | null;

  @ApiPropertyOptional({
    type: () => MaturityAnalysisResponseDto,
    isArray: true,
    description: 'En las rutas de vendimia (no en los pesajes anidados)',
  })
  maturityAnalyses?: MaturityAnalysisResponseDto[];

  @ApiPropertyOptional({
    type: () => PhytoDecisionResponseDto,
    isArray: true,
    description: 'En las rutas de vendimia (no en los pesajes anidados)',
  })
  phytoDecisions?: PhytoDecisionResponseDto[];

  @ApiPropertyOptional({
    example: 14850,
    description:
      'Kilos netos que aún no entraron a un tanque (en las rutas de vendimia)',
  })
  availableKg?: number;

  @ApiPropertyOptional({
    type: () => DoEvaluationDto,
    nullable: true,
    description:
      'D.O. con la instantánea del lote (solo lotes singani; en las rutas de vendimia)',
  })
  doEvaluation?: DoEvaluationDto | null;

  @ApiPropertyOptional({
    description:
      'Registrado más de 7 días después de `intakeDate` (S-9; en las rutas de vendimia)',
  })
  lateEntry?: boolean;

  @ApiPropertyOptional({
    type: () => TerroirResponseDto,
    description: 'En la lista y el detalle',
  })
  terroir?: TerroirResponseDto;

  @ApiPropertyOptional({
    type: () => FermentationTankResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  fermentationTanks?: FermentationTankResponseDto[];
}
