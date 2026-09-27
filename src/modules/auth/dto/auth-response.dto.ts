import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AudienceEnum, UserRoleEnum } from '@prisma/client';
import { MembershipDto } from '@modules/organizations/dto/membership.dto';

/**
 * Persona en la respuesta de sesión (contrato O0 §5). `userRole`, `wineryId`
 * y `memberRole` se mantienen por compatibilidad (*retirada* en H1):
 * `wineryId`/`memberRole` reflejan la organización activa si es una bodega.
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

  @ApiProperty({
    enum: UserRoleEnum,
    example: UserRoleEnum.WINERY_ADMIN,
    deprecated: true,
    description:
      'Compatibilidad hasta H1: rol de 0.1 equivalente a la organización activa',
  })
  userRole!: UserRoleEnum;

  @ApiPropertyOptional({
    type: String,
    example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f',
    nullable: true,
    deprecated: true,
    description: 'Compatibilidad hasta H1: la bodega activa',
  })
  wineryId?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'OWNER',
    nullable: true,
    deprecated: true,
    description: 'Compatibilidad hasta H1: rol en la bodega activa',
  })
  memberRole?: string | null;
}

export class AuthTokensDto {
  @ApiProperty({
    description:
      'Token de acceso JWT (15 min). Claims: sub, aud, org, orgType, role, sid, jti (+ email, userRole, wineryId, memberRole hasta H1)',
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

  @ApiProperty({
    description:
      'Token de renovación. Viaja también en la cookie HttpOnly `doc_rt`; en el cuerpo solo por compatibilidad (*retirada* en H1)',
    example:
      '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a.3.Q2hhbmdlLW1lLXJlZnJlc2gtc2VjcmV0LXZhbHVlLTQ',
    deprecated: true,
  })
  refreshToken!: string;
}

/**
 * Respuesta de `signup`, `login`, `refresh` y `switch-organization`
 * (contrato O0 §5). Además, `Set-Cookie: doc_rt=…`.
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
