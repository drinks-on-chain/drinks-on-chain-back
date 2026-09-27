import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthResponseDto } from './auth-response.dto';

/** `POST /v1/auth/mfa/enroll`. */
export class MfaTokenDto {
  @ApiProperty({
    description: 'Reto del login (`mfa.mfaToken`): 5 min, un solo uso',
    example: 'Q2hhbGxlbmdlLXRva2VuLWV4YW1wbGUtMzItYnl0ZXM',
  })
  @IsString()
  @IsNotEmpty({ message: 'El reto de segundo factor es obligatorio' })
  @MaxLength(512)
  mfaToken!: string;
}

/** `POST /v1/auth/mfa/verify` y `/mfa/enroll/confirm`. */
export class MfaCodeDto extends MfaTokenDto {
  @ApiProperty({
    description:
      'Código TOTP de 6 dígitos o, en `verify`, un código de recuperación (`XXXXX-XXXXX`)',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty({ message: 'El código es obligatorio' })
  @MaxLength(20)
  code!: string;
}

export class MfaChallengeDto {
  @ApiProperty({ example: true, enum: [true] })
  required!: true;

  @ApiProperty({
    example: true,
    description:
      '`false`: aún no inscribió su app de autenticación (`/v1/auth/mfa/enroll`)',
  })
  enrolled!: boolean;

  @ApiProperty({
    description: 'Reto de un solo uso válido 5 minutos',
    example: 'Q2hhbGxlbmdlLXRva2VuLWV4YW1wbGUtMzItYnl0ZXM',
  })
  mfaToken!: string;
}

/**
 * Respuesta de `POST /v1/auth/login` (y de aceptar una invitación de
 * plataforma) para el personal de plataforma: sin tokens ni cookie.
 */
export class MfaChallengeResponseDto {
  @ApiProperty({ type: MfaChallengeDto })
  mfa!: MfaChallengeDto;
}

/** `POST /v1/auth/mfa/enroll`. */
export class MfaEnrollResponseDto {
  @ApiProperty({
    description: 'URI `otpauth://totp/…` para el código QR',
    example:
      'otpauth://totp/Drinks%20on%20Chain:ana%40drinksonchain.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Drinks%20on%20Chain',
  })
  otpauthUrl!: string;

  @ApiProperty({
    description: 'Secreto en base32, para escribirlo a mano si no se lee el QR',
    example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  })
  secret!: string;
}

/** `POST /v1/auth/mfa/enroll/confirm`: la sesión + 10 códigos de recuperación. */
export class MfaEnrollConfirmResponseDto extends AuthResponseDto {
  @ApiProperty({
    type: [String],
    minItems: 10,
    maxItems: 10,
    description:
      'Códigos de recuperación de un solo uso. Se muestran solo esta vez',
    example: ['7K2QD-M4XPA', '0B9ZR-TT3HC'],
  })
  recoveryCodes!: string[];
}
