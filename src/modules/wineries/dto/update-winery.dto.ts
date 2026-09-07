import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWineryDto {
  @ApiPropertyOptional({ example: 'Bodega Kohlberg Tarija' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  commercialName?: string;

  @ApiPropertyOptional({ example: 'Km 15 Carretera a Bermejo' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'gerencia@kohlberg.bo' })
  @IsOptional()
  @IsEmail({}, { message: 'El correo de contacto debe ser válido' })
  contactEmail?: string;

  @ApiPropertyOptional({ example: '+59170098765' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'https://storage.supabase.co/logos/new-logo.png' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;
}
