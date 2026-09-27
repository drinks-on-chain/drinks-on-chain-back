import { Prisma } from '@prisma/client';
import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsDateString,
  IsBoolean,
  IsUrl,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBatchLabAnalysisDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID del lote de embotellado certificado',
  })
  @IsUUID()
  @IsNotEmpty()
  bottlingBatchId!: string;

  @ApiProperty({
    example:
      'Laboratorio de Servicios Analíticos y Control de Calidad LAB-ISO 17025',
    description: 'Nombre del laboratorio acreditado',
  })
  @IsString()
  @IsNotEmpty()
  certifiedLaboratoryName!: string;

  @ApiProperty({
    example: 'LAB-SENASAG-ISO-2026-991',
    description: 'Código de acreditación o matrícula oficial del laboratorio',
  })
  @IsString()
  @IsNotEmpty()
  accreditedLabCertificationCode!: string;

  @ApiPropertyOptional({
    example: '2026-10-02',
    description: 'Fecha de solicitud de ensayo (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  analysisRequestDate?: string;

  @ApiProperty({
    example: '2026-10-04',
    description: 'Fecha de emisión del informe analítico (YYYY-MM-DD)',
  })
  @IsDateString()
  @IsNotEmpty()
  testPerformedAt!: string;

  @ApiProperty({
    example: 40.05,
    description: 'Graduación alcohólica real cuantificada (% ABV)',
  })
  @IsNumber()
  @IsPositive()
  actualAlcoholAbv!: number;

  @ApiPropertyOptional({
    example: 40.05,
    description: 'Grado alcohólico total potencial (% ABV)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  totalAlcoholAbv?: number;

  @ApiProperty({
    example: 4.8,
    description: 'Acidez total expresada en g/L de ácido tartárico',
  })
  @IsNumber()
  @IsPositive()
  totalAcidityTartaricGl!: number;

  @ApiProperty({
    example: 0.22,
    description: 'Acidez volátil expresada en g/L de ácido acético',
  })
  @IsNumber()
  @IsPositive()
  volatileAcidityAceticGl!: number;

  @ApiPropertyOptional({
    example: 22.0,
    description: 'Dióxido de azufre libre (SO2 libre) en mg/L',
  })
  @IsOptional()
  @IsNumber()
  freeSulfurDioxideMgL?: number;

  @ApiPropertyOptional({
    example: 65.0,
    description: 'Dióxido de azufre total (SO2 total) en mg/L',
  })
  @IsOptional()
  @IsNumber()
  totalSulfurDioxideMgL?: number;

  @ApiPropertyOptional({
    example: 1.2,
    description: 'Azúcares reductores en g/L',
  })
  @IsOptional()
  @IsNumber()
  reducingSugarsGl?: number;

  @ApiPropertyOptional({
    example: 18.5,
    description: 'Extracto seco total en g/L',
  })
  @IsOptional()
  @IsNumber()
  totalDryExtractGl?: number;

  @ApiPropertyOptional({
    example: 17.3,
    description: 'Extracto seco libre de azúcar en g/L',
  })
  @IsOptional()
  @IsNumber()
  sugarFreeDryExtractGl?: number;

  @ApiPropertyOptional({
    example: 0.0,
    description: 'Sobrepresión de CO2 a 20°C en bar (para espumosos)',
  })
  @IsOptional()
  @IsNumber()
  overpressureBar?: number;

  @ApiPropertyOptional({
    example: 48.0,
    description:
      'Contenido de metanol en mg/100 ml de alcohol anhidro (límite legal < 200)',
  })
  @IsOptional()
  @IsNumber()
  methanolContentMgL?: number;

  @ApiPropertyOptional({
    example: 0.02,
    description: 'Contenido de cobre en mg/L (límite legal < 0.05)',
  })
  @IsOptional()
  @IsNumber()
  copperContentMgL?: number;

  @ApiPropertyOptional({
    example: { leadMgL: 0.0, aldehydesMgL: 12.5 },
    description: 'Ensayos cromatográficos adicionales',
  })
  @IsOptional()
  @IsObject()
  additionalParams?: Prisma.InputJsonObject;

  @ApiProperty({
    example: 'https://storage.drinksonchain.com/certs/lab-report-2026-991.pdf',
    description: 'URL del PDF del Certificado Analítico oficial firmado',
  })
  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  laboratoryReportPdfUrl!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Dictamen de conformidad con normas SENASAG / Norma Boliviana NB 324001',
  })
  @IsOptional()
  @IsBoolean()
  conformsToSenasagStandards?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Dictamen de conformidad con regulaciones de la Unión Europea',
  })
  @IsOptional()
  @IsBoolean()
  conformsToEuStandards?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Dictamen de conformidad con regulaciones TTB (Estados Unidos)',
  })
  @IsOptional()
  @IsBoolean()
  conformsToUsaStandards?: boolean;
}
