import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchLabAnalysisResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  bottlingBatchId!: string;

  @ApiProperty({ example: 'Laboratorio LAB-ISO 17025' })
  certifiedLaboratoryName!: string;

  @ApiProperty({ example: 'LAB-SENASAG-ISO-2026-991' })
  accreditedLabCertificationCode!: string;

  @ApiPropertyOptional({ example: '2026-10-02' })
  analysisRequestDate?: Date | null;

  @ApiProperty({ example: '2026-10-04' })
  testPerformedAt!: Date;

  @ApiProperty({ example: 40.05 })
  actualAlcoholAbv!: number;

  @ApiPropertyOptional({ example: 40.05 })
  totalAlcoholAbv?: number | null;

  @ApiProperty({ example: 4.8 })
  totalAcidityTartaricGl!: number;

  @ApiProperty({ example: 0.22 })
  volatileAcidityAceticGl!: number;

  @ApiPropertyOptional({ example: 22.0 })
  freeSulfurDioxideMgL?: number | null;

  @ApiPropertyOptional({ example: 65.0 })
  totalSulfurDioxideMgL?: number | null;

  @ApiPropertyOptional({ example: 1.2 })
  reducingSugarsGl?: number | null;

  @ApiPropertyOptional({ example: 18.5 })
  totalDryExtractGl?: number | null;

  @ApiPropertyOptional({ example: 17.3 })
  sugarFreeDryExtractGl?: number | null;

  @ApiPropertyOptional({ example: 0.0 })
  overpressureBar?: number | null;

  @ApiPropertyOptional({ example: 48.0 })
  methanolContentMgL?: number | null;

  @ApiPropertyOptional({ example: 0.02 })
  copperContentMgL?: number | null;

  @ApiPropertyOptional()
  additionalParams?: Record<string, unknown> | null;

  @ApiProperty({ example: 'https://storage.drinksonchain.com/certs/lab.pdf' })
  laboratoryReportPdfUrl!: string;

  @ApiProperty({ example: true })
  conformsToSenasagStandards!: boolean;

  @ApiProperty({ example: true })
  conformsToEuStandards!: boolean;

  @ApiProperty({ example: true })
  conformsToUsaStandards!: boolean;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  reviewedByMemberId?: string | null;

  @ApiProperty({ example: '2026-10-04T12:00:00.000Z' })
  createdAt!: Date;
}
