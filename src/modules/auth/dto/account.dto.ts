import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MAX_CAPTCHA_TOKEN_LENGTH } from '@shared/captcha/captcha.service';

/** Captcha y campo trampa de los formularios públicos (contrato O1 §0). */
class PublicFormDto {
  @ApiProperty({
    description:
      'Token de Cloudflare Turnstile. En desarrollo, cualquier texto con la clave de prueba',
    example: 'XXXX.DUMMY.TOKEN.XXXX',
  })
  @IsString()
  @IsNotEmpty({ message: 'Falta el captcha' })
  @MaxLength(MAX_CAPTCHA_TOKEN_LENGTH)
  captchaToken!: string;

  @ApiPropertyOptional({
    description:
      'Campo trampa: debe llegar vacío (si no, 202 sin hacer nada). No se muestra al usuario',
    example: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}

/** `POST /v1/auth/forgot-password`. */
export class ForgotPasswordDto extends PublicFormDto {
  @ApiProperty({ example: 'ana@bodega.bo' })
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  email!: string;
}

/** `POST /v1/auth/resend-verification`. */
export class ResendVerificationDto extends ForgotPasswordDto {}

/** `POST /v1/auth/reset-password`. */
export class ResetPasswordDto {
  @ApiProperty({ description: 'Token del enlace del correo' })
  @IsString()
  @IsNotEmpty({ message: 'El token es obligatorio' })
  @MaxLength(512)
  token!: string;

  @ApiProperty({
    description:
      'Contraseña nueva: al menos 10 caracteres y que no sea común (422 `AUTH_WEAK_PASSWORD`)',
    example: 'vendimia-de-altura-2026',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña es obligatoria' })
  @MaxLength(1000)
  password!: string;
}

/** `POST /v1/auth/verify-email`. */
export class VerifyEmailDto {
  @ApiProperty({ description: 'Token del enlace del correo' })
  @IsString()
  @IsNotEmpty({ message: 'El token es obligatorio' })
  @MaxLength(512)
  token!: string;
}

/** `POST /v1/users/me/password`. */
export class ChangePasswordDto {
  @ApiProperty({ example: 'contraseña-actual' })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña actual es obligatoria' })
  @MaxLength(1000)
  currentPassword!: string;

  @ApiProperty({
    description:
      'Contraseña nueva: al menos 10 caracteres y que no sea común (422 `AUTH_WEAK_PASSWORD`)',
    example: 'vendimia-de-altura-2026',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña nueva es obligatoria' })
  @MaxLength(1000)
  newPassword!: string;
}
