import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * `POST /v1/lots/{id}/lab-analyses` (contrato O2 §8.1): el embotellado lo da
 * el lote y la conformidad la calcula el servidor (§8.3), así que no son
 * campos de la entrada; el informe va por su `key` y el metanol, en mg/L de
 * producto o en mg/100 mL de alcohol anhidro. Unidades explícitas de §8.2.
 */
export class CreateLotLabAnalysisDto {
  @ApiProperty({
    example:
      'Laboratorio de Servicios Analíticos y Control de Calidad LAB-ISO 17025',
    description: 'Nombre del laboratorio acreditado',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  certifiedLaboratoryName!: string;

  @ApiProperty({
    example: 'LAB-SENASAG-ISO-2026-991',
    description: 'Código de acreditación o matrícula oficial del laboratorio',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
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
  testPerformedAt!: string;

  @ApiProperty({
    example: 40.05,
    description: 'Graduación alcohólica real (% v/v a 20 °C)',
  })
  @IsNumber()
  @IsPositive()
  actualAlcoholAbv!: number;

  @ApiPropertyOptional({
    example: 40.05,
    description: 'Grado alcohólico total (% v/v a 20 °C)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  totalAlcoholAbv?: number;

  @ApiProperty({
    example: 4.8,
    description: 'Acidez total (g/L como ácido tartárico)',
  })
  @IsNumber()
  @IsPositive()
  totalAcidityTartaricGl!: number;

  @ApiProperty({
    example: 0.22,
    description: 'Acidez volátil (g/L como ácido acético)',
  })
  @IsNumber()
  @IsPositive()
  volatileAcidityAceticGl!: number;

  @ApiPropertyOptional({ example: 22.0, description: 'SO₂ libre (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  freeSulfurDioxideMgL?: number;

  @ApiPropertyOptional({ example: 65.0, description: 'SO₂ total (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalSulfurDioxideMgL?: number;

  @ApiPropertyOptional({
    example: 1.2,
    description: 'Azúcares reductores (g/L)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reducingSugarsGl?: number;

  @ApiPropertyOptional({
    example: 18.5,
    description: 'Extracto seco total (g/L)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalDryExtractGl?: number;

  @ApiPropertyOptional({
    example: 17.3,
    description: 'Extracto seco libre de azúcar (g/L)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sugarFreeDryExtractGl?: number;

  @ApiPropertyOptional({
    example: 0.0,
    description: 'Sobrepresión de CO₂ a 20 °C (bar)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  overpressureBar?: number;

  @ApiPropertyOptional({
    example: 192,
    description:
      'Metanol en mg/L **de producto**; si no llega `methanolMg100mlAa`, el servidor lo convierte (`10 × mgL / grado`)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  methanolContentMgL?: number;

  @ApiPropertyOptional({
    example: 48.0,
    description:
      'Metanol en mg/100 mL de alcohol anhidro. Si llegan ambos y difieren más de 1 % → 422 `VALIDATION_ERROR`',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  methanolMg100mlAa?: number;

  @ApiPropertyOptional({ example: 0.02, description: 'Cobre (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  copperContentMgL?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { leadMgL: 0.0, aldehydesMgL: 12.5 },
    description: 'Ensayos adicionales',
  })
  @IsOptional()
  @IsObject()
  additionalParams?: Record<string, unknown>;

  @ApiProperty({
    example:
      'org/0b5c1f3e-8a2d-4c1e-9f7a-2d3e4f5a6b7c/lab-reports/2026/10/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d.pdf',
    description:
      '`key` del informe firmado (`POST /v1/uploads`), de esta bodega; se guarda con su huella SHA-256',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  laboratoryReportKey!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Declarado por el laboratorio (sin verificar; fuera del pasaporte)',
  })
  @IsOptional()
  @IsBoolean()
  conformsToEuStandards?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Declarado por el laboratorio (sin verificar; fuera del pasaporte)',
  })
  @IsOptional()
  @IsBoolean()
  conformsToUsaStandards?: boolean;
}
