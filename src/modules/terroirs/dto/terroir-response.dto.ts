import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TerroirResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'Cuartel 4 - La Finca El Potrero' })
  parcelName!: string;

  @ApiPropertyOptional({ example: 'CAT-TL-4022' })
  cadastreCode?: string | null;

  @ApiProperty({ example: 4.5 })
  surfaceHectares!: number;

  @ApiProperty({ example: 1850.0 })
  altitudeMasl!: number;

  @ApiPropertyOptional({ example: -21.48512 })
  latitude?: number | null;

  @ApiPropertyOptional({ example: -64.78921 })
  longitude?: number | null;

  @ApiPropertyOptional()
  geographicPolygonGeojson?: Record<string, any> | null;

  @ApiProperty({ example: 'uva' })
  rawMaterialType!: string;

  @ApiProperty({ example: 'Moscatel de Alejandría' })
  varietyName!: string;

  @ApiPropertyOptional({ example: 'Franco-arcilloso' })
  soilType?: string | null;

  @ApiPropertyOptional({ example: 'Riego por goteo' })
  irrigationSystem?: string | null;

  @ApiProperty({ example: true })
  isDoEligible!: boolean;

  @ApiPropertyOptional({ example: 'D.O. Singani' })
  doType?: string | null;

  @ApiPropertyOptional({
    example: 'https://storage.drinksonchain.com/cert/do-potrero.pdf',
  })
  doCertificateUrl?: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '2026-09-06T12:00:00.000Z' })
  createdAt!: Date;
}
