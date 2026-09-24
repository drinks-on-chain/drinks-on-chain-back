import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WineryMemberRoleEnum } from '@prisma/client';

export class CreateMemberDto {
  @ApiProperty({
    example: 'enologo@bodega.bo',
    description: 'Correo electrónico institucional para el nuevo miembro',
  })
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Contraseña temporal o definitiva (mínimo 8 caracteres, al menos una letra y un número)',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'La contraseña debe contener al menos una letra y un número',
  })
  password!: string;

  @ApiProperty({
    example: 'Lic. Marcela Zenteno',
    description: 'Nombre completo del miembro operativo',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre completo es obligatorio' })
  fullName!: string;

  @ApiProperty({
    enum: WineryMemberRoleEnum,
    example: WineryMemberRoleEnum.ENOLOGIST,
    description: 'Rol operativo dentro de la bodega (ENOLOGIST, AGRONOMIST, OPERATOR, ACCOUNTANT, WINERY_ADMIN)',
  })
  @IsEnum(WineryMemberRoleEnum, { message: 'Rol de miembro no válido' })
  memberRole!: WineryMemberRoleEnum;

  @ApiPropertyOptional({
    example: '+59171234567',
    description: 'Número de teléfono de contacto',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'COL-ENOL-TAR-402',
    description: 'Número de matrícula profesional (obligatorio para enólogos/agrónomos)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  professionalLicenseNumber?: string;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/licenses/license-402.pdf',
    description: 'URL del PDF de la matrícula profesional',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  professionalLicensePdfUrl?: string;
}
