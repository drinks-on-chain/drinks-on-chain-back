import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cuerpo de `refresh`, `switch-organization` y `logout`. El refresco viaja en
 * la cookie `doc_rt`; el cuerpo `{ refreshToken }` se acepta por
 * compatibilidad (*retirada* en H1).
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Compatibilidad hasta H1: el refresco, si el cliente no usa la cookie `doc_rt`',
    example:
      '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a.3.Q2hhbmdlLW1lLXJlZnJlc2gtc2VjcmV0LXZhbHVlLTQ',
    deprecated: true,
  })
  @IsOptional()
  @IsString({ message: 'El refreshToken debe ser una cadena de texto válida' })
  @MaxLength(200)
  refreshToken?: string;
}
