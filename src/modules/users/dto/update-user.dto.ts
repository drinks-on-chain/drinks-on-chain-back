import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'Juan Carlos Pérez',
    description: 'Nombre completo actualizado',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @ApiPropertyOptional({
    example: '+59170012345',
    description: 'Número de teléfono de contacto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'en',
    description: 'Preferencia de idioma (es / en)',
  })
  @IsOptional()
  @IsString()
  preferredLocale?: string;
}
