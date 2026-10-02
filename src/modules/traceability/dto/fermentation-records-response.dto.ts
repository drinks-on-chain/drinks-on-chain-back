import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CorrectableResponseDto } from '@modules/lots/dto/correction-marks.dto';
import { TreatmentTypeEnum } from '@prisma/client';

/** Registro térmico y de densidad de una cuba (`POST …/logs`). */
export class FermentationLogResponseDto extends CorrectableResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  fermentationTankId!: string;

  @ApiProperty({ example: 18.5 })
  temperatureCelsius!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.045 })
  specificGravity?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 3.45 })
  phValue?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Desprendimiento moderado',
  })
  co2Observations?: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt!: Date;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  recordedByUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  notes?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Anulado por una corrección `VOID` (contrato O2 §9)',
  })
  voidedAt?: Date | null;
}

/** Tratamiento enológico aplicado a una cuba (`POST …/treatments`). */
export class EnologicalTreatmentResponseDto extends CorrectableResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  fermentationTankId!: string;

  @ApiProperty({ enum: TreatmentTypeEnum })
  treatmentType!: TreatmentTypeEnum;

  @ApiProperty({ example: 'Metabisulfito de potasio' })
  additiveName!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  additiveSupplier?: string | null;

  @ApiProperty({ example: 5 })
  dosageAppliedGPerHl!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 505 })
  totalAppliedG?: number | null;

  @ApiProperty({ example: 'SENASAG-ADT-2026-001' })
  regulatoryAuthCode!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  appliedAt!: Date;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  authorizedByMemberId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  notes?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Anulado por una corrección `VOID` (contrato O2 §9)',
  })
  voidedAt?: Date | null;
}
