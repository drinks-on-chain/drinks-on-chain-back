import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsPositive,
  IsBoolean,
  IsObject,
  IsUrl,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTerroirDto {
  @ApiProperty({
    example: 'Cuartel 4 - La Finca El Potrero',
    description: 'Nombre descriptivo de la parcela o cuartel',
  })
  @IsString()
  @IsNotEmpty()
  parcelName!: string;

  @ApiPropertyOptional({
    example: 'CAT-TL-4022',
    description: 'Código catastral del predio rural',
  })
  @IsOptional()
  @IsString()
  cadastreCode?: string;

  @ApiProperty({
    example: 4.5,
    description: 'Superficie cultivada en hectáreas',
  })
  @IsNumber()
  @IsPositive()
  surfaceHectares!: number;

  @ApiProperty({
    example: 1850.0,
    description: 'Altitud de la parcela en metros sobre el nivel del mar (m.s.n.m.)',
  })
  @IsNumber()
  @IsPositive()
  altitudeMasl!: number;

  @ApiPropertyOptional({
    example: -21.48512,
    description: 'Latitud geográfica decimal (WGS84)',
  })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({
    example: -64.78921,
    description: 'Longitud geográfica decimal (WGS84)',
  })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({
    example: {
      type: 'Polygon',
      coordinates: [
        [
          [-64.789, -21.485],
          [-64.788, -21.485],
          [-64.788, -21.486],
          [-64.789, -21.486],
          [-64.789, -21.485],
        ],
      ],
    },
    description: 'Polígono perimetral en formato estándar GeoJSON RFC 7946',
  })
  @IsOptional()
  @IsObject()
  geographicPolygonGeojson?: Record<string, any>;

  @ApiProperty({
    example: 'uva',
    description: 'Tipo de materia prima vegetal (uva, cebada, agave, etc.)',
  })
  @IsString()
  @IsNotEmpty()
  rawMaterialType!: string;

  @ApiProperty({
    example: 'Moscatel de Alejandría',
    description: 'Variedad o clon específico cultivado',
  })
  @IsString()
  @IsNotEmpty()
  varietyName!: string;

  @ApiPropertyOptional({
    example: 'Franco-arcilloso con cantos rodados',
    description: 'Descripción pedológica del suelo',
  })
  @IsOptional()
  @IsString()
  soilType?: string;

  @ApiPropertyOptional({
    example: 'Riego por goteo computarizado',
    description: 'Sistema de irrigación instalado',
  })
  @IsOptional()
  @IsString()
  irrigationSystem?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Indica si cumple criterios para Denominación de Origen',
  })
  @IsOptional()
  @IsBoolean()
  isDoEligible?: boolean;

  @ApiPropertyOptional({
    example: 'D.O. Singani',
    description: 'Denominación de Origen a la que postula (ej. D.O. Singani, D.O. Tarija)',
  })
  @IsOptional()
  @IsString()
  doType?: string;

  @ApiPropertyOptional({
    example: 'https://storage.drinksonchain.com/cert/do-potrero.pdf',
    description: 'URL del certificado oficial de Denominación de Origen',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  doCertificateUrl?: string;
}
