import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRoleEnum } from '@prisma/client';

export class SignupDto {
  @ApiProperty({
    example: 'juan.perez@bodega.bo',
    description: 'Correo electrónico único para inicio de sesión',
  })
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description:
      'Contraseña segura de mínimo 8 caracteres con al menos una letra y un número',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'La contraseña debe contener al menos una letra y un número',
  })
  password!: string;

  @ApiProperty({
    example: 'Juan Pérez',
    description: 'Nombre completo o razón del usuario',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre completo es obligatorio' })
  fullName!: string;

  @ApiPropertyOptional({
    enum: [UserRoleEnum.CONSUMER, UserRoleEnum.WINERY_ADMIN],
    default: UserRoleEnum.CONSUMER,
    deprecated: true,
    description:
      'Obsoleto (H1): el registro de personal (`WINERY_ADMIN`) se retira al cerrar la Ola 1; las bodegas entran por solicitud de alta o alta directa y su equipo por invitación. Tras H1 la ruta queda solo para consumidores (`CONSUMER`, Ola 4). Roles administrativos y operativos no están permitidos en registro público.',
  })
  @IsOptional()
  @IsEnum(UserRoleEnum, { message: 'Rol de usuario no válido' })
  userRole?: UserRoleEnum = UserRoleEnum.CONSUMER;

  @ApiPropertyOptional({
    example: '+59170012345',
    description: 'Número de teléfono para contacto o verificación MFA',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'es',
    default: 'es',
    description: 'Idioma preferido para el perfil (es o en)',
  })
  @IsOptional()
  @IsString()
  preferredLocale?: string = 'es';
}
