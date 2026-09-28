import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorDetailDto } from '@shared/dto/api-error-response.dto';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';
import { LabConformityCheckDto } from '@modules/lots/contract/dto/public-passports.dto';

/** Conformidad calculada contra la instantánea del lote (§8.3, EA-08). */
export class LabConformityDto {
  @ApiProperty({
    enum: ['CONFORMING', 'NON_CONFORMING', 'INCOMPLETE'],
    description:
      'Falta un parámetro exigido → INCOMPLETE (nunca conforme por omisión)',
  })
  status!: string;

  @ApiProperty({ type: () => LabConformityCheckDto, isArray: true })
  checks!: LabConformityCheckDto[];

  @ApiProperty({
    type: () => ErrorDetailDto,
    isArray: true,
    description:
      'Avisos (p. ej. grado medido ≠ etiquetado en más de 0,5 % vol, S-15)',
  })
  warnings!: ErrorDetailDto[];

  @ApiProperty({ example: '2026-03-04T09:45:00.000Z' })
  rulesTakenAt!: string;
}

/** Unidades de cada campo (§8.2). */
export class LabUnitsDto {
  @ApiProperty({ example: '% v/v a 20 °C' }) actualAlcoholAbv!: string;
  @ApiProperty({ example: '% v/v a 20 °C' }) totalAlcoholAbv!: string;
  @ApiProperty({ example: 'g/L como ácido tartárico' })
  totalAcidityTartaricGl!: string;
  @ApiProperty({ example: 'g/L como ácido acético' })
  volatileAcidityAceticGl!: string;
  @ApiProperty({ example: 'mg/L' }) freeSulfurDioxideMgL!: string;
  @ApiProperty({ example: 'mg/L' }) totalSulfurDioxideMgL!: string;
  @ApiProperty({ example: 'g/L' }) reducingSugarsGl!: string;
  @ApiProperty({ example: 'g/L' }) totalDryExtractGl!: string;
  @ApiProperty({ example: 'g/L' }) sugarFreeDryExtractGl!: string;
  @ApiProperty({ example: 'bar' }) overpressureBar!: string;
  @ApiProperty({ example: 'mg/L de producto' }) methanolContentMgL!: string;
  @ApiProperty({ example: 'mg/100 mL de alcohol anhidro' })
  methanolMg100mlAa!: string;
  @ApiProperty({ example: 'mg/L' }) copperContentMgL!: string;
}

export class LabReportDto {
  @ApiProperty({ description: '`key` del archivo, o la URL legada' })
  key!: string;

  @ApiProperty({ type: String, nullable: true })
  sha256!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'URL firmada (pendiente: la legada o `null`)',
  })
  url!: string | null;
}

export class BatchLabAnalysisResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  bottlingBatchId!: string;

  @ApiProperty({ example: 'Laboratorio LAB-ISO 17025' })
  certifiedLaboratoryName!: string;

  @ApiProperty({ example: 'LAB-SENASAG-ISO-2026-991' })
  accreditedLabCertificationCode!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-02',
  })
  analysisRequestDate?: Date | null;

  @ApiProperty({ example: '2026-10-04' })
  testPerformedAt!: Date;

  @ApiProperty({ example: 40.05 })
  actualAlcoholAbv!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 40.05 })
  totalAlcoholAbv?: number | null;

  @ApiProperty({ example: 4.8 })
  totalAcidityTartaricGl!: number;

  @ApiProperty({ example: 0.22 })
  volatileAcidityAceticGl!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 22.0 })
  freeSulfurDioxideMgL?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 65.0 })
  totalSulfurDioxideMgL?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.2 })
  reducingSugarsGl?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 18.5 })
  totalDryExtractGl?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 17.3 })
  sugarFreeDryExtractGl?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 0.0 })
  overpressureBar?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 48.0 })
  methanolContentMgL?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 0.02 })
  copperContentMgL?: number | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  additionalParams?: Record<string, unknown> | null;

  @ApiProperty({ example: 'https://storage.drinksonchain.com/certs/lab.pdf' })
  laboratoryReportPdfUrl!: string;

  @ApiProperty({ example: true })
  conformsToSenasagStandards!: boolean;

  @ApiProperty({ example: true })
  conformsToEuStandards!: boolean;

  @ApiProperty({ example: true })
  conformsToUsaStandards!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  reviewedByMemberId?: string | null;

  @ApiProperty({ example: '2026-10-04T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Lote (Ola 2)',
  })
  lotId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description:
      'Metanol en mg/100 mL de alcohol anhidro (si solo llega mg/L: 10 × mgL / grado)',
  })
  methanolMg100mlAa!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['CONFORMING', 'NON_CONFORMING', 'INCOMPLETE'],
  })
  conformityStatus!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sustituido por un reanálisis',
  })
  supersededAt!: Date | null;

  @ApiPropertyOptional({
    type: () => LabConformityDto,
    nullable: true,
    description: 'Rutas de laboratorio',
  })
  conformity?: LabConformityDto | null;

  @ApiPropertyOptional({
    type: () => LabUnitsDto,
    description: 'Rutas de laboratorio',
  })
  units?: LabUnitsDto;

  @ApiPropertyOptional({
    description:
      'Es el análisis vigente del embotellado (rutas de laboratorio)',
  })
  current?: boolean;

  @ApiPropertyOptional({
    type: () => TraceActorDto,
    nullable: true,
    description: 'Rutas de laboratorio',
  })
  recordedBy?: TraceActorDto | null;

  @ApiPropertyOptional({
    type: () => LabReportDto,
    nullable: true,
    description: 'Rutas de laboratorio',
  })
  report?: LabReportDto | null;
}
