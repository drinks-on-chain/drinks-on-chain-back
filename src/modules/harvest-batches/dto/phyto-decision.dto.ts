import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';

export const PHYTO_DECISIONS = ['APPROVED', 'REJECTED', 'QUARANTINE'] as const;
export type PhytoDecisionValue = (typeof PHYTO_DECISIONS)[number];

/** Dictamen fitosanitario (§3.4, EA-04). */
export class CreatePhytoDecisionDto {
  @ApiProperty({ enum: PHYTO_DECISIONS })
  @IsIn(PHYTO_DECISIONS as unknown as string[])
  decision!: PhytoDecisionValue;

  @ApiPropertyOptional({
    description:
      '`key` del informe de inspección subido con `POST /v1/uploads` (de la bodega)',
    example: 'org/5f1c0000-0000-4000-8000-000000000000/inspeccion.pdf',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  inspectionReportKey?: string;

  @ApiPropertyOptional({
    description: 'Motivo: obligatorio en `REJECTED` y `QUARANTINE`',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    example: '2026-03-16T10:00:00Z',
    description: 'Momento del dictamen (por defecto, ahora); no futuro',
  })
  @IsOptional()
  @IsDateString()
  decidedAt?: string;
}

export class InspectionReportDto {
  @ApiProperty()
  key!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'SHA-256 del archivo (si se conoce)',
  })
  sha256!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'URL firmada de corta vida (`GET /v1/uploads/signed-url`)',
  })
  url!: string | null;
}

export class PhytoDecisionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  harvestBatchId!: string;

  @ApiProperty({ enum: PHYTO_DECISIONS })
  decision!: string;

  @ApiProperty({ example: '2026-03-16T10:00:00.000Z' })
  decidedAt!: string;

  @ApiProperty({ example: '2026-03-16T10:00:00.000Z' })
  recordedAt!: string;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: '`null` = no registrado (datos migrados sin autor)',
  })
  decidedBy!: TraceActorDto | null;

  @ApiProperty({ type: () => InspectionReportDto, nullable: true })
  inspectionReport!: InspectionReportDto | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: ['ERP', 'MIGRATION'] })
  source!: string;
}

/** Análisis de madurez (§3.3). */
export class CreateMaturityAnalysisDto {
  @ApiProperty({ example: 22.4, minimum: 0, maximum: 40 })
  @IsNumber()
  @Min(0)
  @Max(40)
  brixDegrees!: number;

  @ApiProperty({ example: 3.45, minimum: 2, maximum: 5 })
  @IsNumber()
  @Min(2)
  @Max(5)
  ph!: number;

  @ApiProperty({ example: 6.8, minimum: 0, maximum: 30 })
  @IsNumber()
  @Min(0)
  @Max(30)
  acidityGl!: number;

  @ApiProperty({ example: '2026-03-15T09:00:00Z', description: 'No futuro' })
  @IsDateString()
  measuredAt!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class MaturityAnalysisResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  harvestBatchId!: string;

  @ApiProperty({ example: 22.4 })
  brixDegrees!: number;

  @ApiProperty({ example: 3.45 })
  ph!: number;

  @ApiProperty({ example: 6.8 })
  acidityGl!: number;

  @ApiProperty({ example: '2026-03-15T09:00:00.000Z' })
  measuredAt!: string;

  @ApiProperty({ example: '2026-03-15T09:05:00.000Z' })
  recordedAt!: string;

  @ApiProperty({ type: () => TraceActorDto, nullable: true })
  recordedBy!: TraceActorDto | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: ['ERP', 'MIGRATION'] })
  source!: string;
}
