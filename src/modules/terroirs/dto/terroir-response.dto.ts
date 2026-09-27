import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HarvestBatchResponseDto } from '@modules/harvest-batches/dto/harvest-batch-response.dto';

export class TerroirResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'Cuartel 4 - La Finca El Potrero' })
  parcelName!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'CAT-TL-4022' })
  cadastreCode?: string | null;

  @ApiProperty({ example: 4.5 })
  surfaceHectares!: number;

  @ApiProperty({ example: 1850.0 })
  altitudeMasl!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: -21.48512 })
  latitude?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: -64.78921 })
  longitude?: number | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  geographicPolygonGeojson?: Record<string, unknown> | null;

  @ApiProperty({ example: 'uva' })
  rawMaterialType!: string;

  @ApiProperty({ example: 'Moscatel de Alejandría' })
  varietyName!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Franco-arcilloso',
  })
  soilType?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Riego por goteo',
  })
  irrigationSystem?: string | null;

  @ApiProperty({ example: true })
  isDoEligible!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'D.O. Singani',
  })
  doType?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://storage.drinksonchain.com/cert/do-potrero.pdf',
  })
  doCertificateUrl?: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '2026-09-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({
    type: () => HarvestBatchResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  harvestBatches?: HarvestBatchResponseDto[];
}
