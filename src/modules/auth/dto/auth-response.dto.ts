import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AudienceEnum } from '@prisma/client';
import { MembershipDto } from '@modules/organizations/dto/membership.dto';

/**
 * Persona en la respuesta de sesión (contrato O0 §5). El rol y la bodega van
 * en `memberships` y `activeOrganizationId` (`userRole`, `wineryId` y
 * `memberRole` se retiraron al cerrar la Ola 1, H1).
 */
export class AuthUserDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'juan.perez@bodega.bo' })
  email!: string;

  @ApiProperty({ example: 'Juan Pérez' })
  fullName!: string;

  @ApiPropertyOptional({
    type: String,
    example: '+59170012345',
    nullable: true,
  })
  phoneNumber?: string | null;

  @ApiProperty({ example: 'es' })
  preferredLocale!: string;

  @ApiProperty({
    enum: AudienceEnum,
    enumName: 'Audience',
    example: AudienceEnum.STAFF,
    description:
      '`STAFF` si tiene al menos una membresía; `CONSUMER` si no tiene ninguna',
  })
  audience!: AudienceEnum;
}

export class AuthTokensDto {
  @ApiProperty({
    description:
      'Token de acceso JWT (15 min). Claims: sub, aud, org, orgType, role, sid, jti',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({
    example: 900,
    description: 'Vida del token de acceso en segundos',
  })
  expiresIn!: number;
}

/**
 * Respuesta de `signup`, `login`, `refresh` y `switch-organization`
 * (contrato O0 §5). El refresco viaja solo en `Set-Cookie: doc_rt=…`
 * (`tokens.refreshToken` se retiró en H1).
 */
export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ type: [MembershipDto] })
  memberships!: MembershipDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f',
    description:
      'Organización activa: la última usada o la primera membresía activa (plataforma antes que bodega); null si no tiene',
  })
  activeOrganizationId!: string | null;

  @ApiProperty({ type: AuthTokensDto })
  tokens!: AuthTokensDto;
}
