import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WineryCategoryEnum } from '@prisma/client';

export class CreateWineryDto {
  @ApiProperty({
    example: 'Sociedad Agroindustrial Kohlberg S.A.',
    description: 'Razón social legal de la empresa',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  legalName!: string;

  @ApiProperty({
    example: 'Bodega Kohlberg',
    description: 'Nombre o marca comercial de la bodega',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  commercialName!: string;

  @ApiProperty({
    enum: WineryCategoryEnum,
    example: WineryCategoryEnum.WINERY,
    description: 'Categoría principal de producción de bebida',
  })
  @IsEnum(WineryCategoryEnum, { message: 'Categoría de bebida no válida' })
  beverageCategory!: WineryCategoryEnum;

  @ApiProperty({
    example: '1028374029',
    description: 'Número de Identificación Tributaria (NIT)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  taxIdNit!: string;

  @ApiPropertyOptional({
    example: '08-01-03-01-0001',
    description: 'Registro Sanitario SENASAG',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  senasagSanitaryReg?: string;

  @ApiProperty({
    example: 'Valle Central de Tarija',
    description: 'Región geográfica o departamento de producción',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  geographicRegion!: string;

  @ApiPropertyOptional({
    example: 'BO',
    default: 'BO',
    description: 'Código de país ISO 3166-1 alfa-2',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string = 'BO';

  @ApiPropertyOptional({
    example: 'Km 15 Carretera a Bermejo, Santa Ana la Nueva',
    description: 'Dirección física de la bodega o destilería',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({
    example: 'contacto@kohlberg.bo',
    description: 'Correo electrónico institucional',
  })
  @IsEmail({}, { message: 'El correo de contacto debe ser válido' })
  @IsNotEmpty()
  contactEmail!: string;

  @ApiPropertyOptional({
    example: '+59146642345',
    description: 'Teléfono de contacto institucional',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/drinks-on-chain/logos/kohlberg.png',
    description: 'URL del logo institucional',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;
}
