import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WineryMemberRoleEnum } from '@prisma/client';

export class AddMemberDto {
  @ApiProperty({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'UUID del usuario a incorporar como miembro operativo',
  })
  @IsUUID('4', { message: 'El ID de usuario debe ser un UUID v4 válido' })
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    enum: WineryMemberRoleEnum,
    example: WineryMemberRoleEnum.ENOLOGIST,
    description: 'Rol operativo dentro de la bodega',
  })
  @IsEnum(WineryMemberRoleEnum, { message: 'Rol de miembro no válido' })
  memberRole!: WineryMemberRoleEnum;

  @ApiPropertyOptional({
    example: 'MP-BOL-2024-9981',
    description: 'Número de matrícula profesional (obligatorio para enólogos/agrónomos)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  professionalLicenseNumber?: string;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/licenses/license-9981.pdf',
    description: 'URL del PDF de la matrícula profesional',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  professionalLicensePdfUrl?: string;
}
