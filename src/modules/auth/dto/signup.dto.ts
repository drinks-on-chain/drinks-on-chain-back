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
    description: 'Contraseña segura de mínimo 8 caracteres con al menos una letra y un número',
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
    enum: UserRoleEnum,
    default: UserRoleEnum.CONSUMER,
    description: 'Rol del usuario en la plataforma',
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
