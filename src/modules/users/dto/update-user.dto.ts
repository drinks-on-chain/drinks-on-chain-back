import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Preferencias de comunicación (IAM-09); se admiten cambios parciales. */
export class NotificationPrefsPatchDto {
  @ApiPropertyOptional({
    example: true,
    description: 'Avisos de avance de etapa de los lotes comprados',
  })
  @IsOptional()
  @IsBoolean()
  lotProgress?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Recordatorios de canje (ventana a punto de vencer)',
  })
  @IsOptional()
  @IsBoolean()
  redemptionReminders?: boolean;
}

/** `PATCH /v1/users/me` (contrato O1 §1). */
export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'Juan Carlos Pérez',
    description: 'Nombre completo actualizado',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede quedar vacío' })
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
    enum: ['es', 'en'],
    description: 'Preferencia de idioma',
  })
  @IsOptional()
  @IsIn(['es', 'en'], { message: 'El idioma debe ser es o en' })
  preferredLocale?: string;

  @ApiPropertyOptional({ type: NotificationPrefsPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPrefsPatchDto)
  notificationPrefs?: NotificationPrefsPatchDto;

  @ApiPropertyOptional({
    example: false,
    description:
      'Consentimiento de promociones; se guarda con la fecha en que se dio',
  })
  @IsOptional()
  @IsBoolean()
  promotionsConsent?: boolean;
}
