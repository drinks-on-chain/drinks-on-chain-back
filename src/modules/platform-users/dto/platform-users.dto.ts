import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import {
  INTERNAL_ROLES,
  InternalRole,
} from '@modules/invitations/dto/invitation.dto';

const PLATFORM_ROLES = [
  'SUPERADMIN',
  'ADMIN',
  'OPERATIONS',
  'SUPPORT',
] as const;
const PLATFORM_USER_STATUSES = ['ACTIVE', 'BLOCKED', 'INVITED'] as const;
const PERMISSION_LEVELS = ['FULL', 'READ', 'OWN', 'NONE'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Usuario interno (contrato O1 §5): miembro de la organización de plataforma
 * o invitación pendiente (`status: 'INVITED'`, `membershipId: null`).
 */
export class PlatformUserDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null en una invitación pendiente',
  })
  membershipId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null si el correo invitado aún no tiene cuenta',
  })
  userId!: string | null;

  @ApiProperty({
    example: 'Valeria Méndez',
    description: 'En una invitación pendiente sin cuenta, el correo',
  })
  fullName!: string;

  @ApiProperty({ example: 'operaciones@drinksonchain.test' })
  email!: string;

  @ApiProperty({ enum: PLATFORM_ROLES, enumName: 'PlatformRole' })
  role!: (typeof PLATFORM_ROLES)[number];

  @ApiProperty({ enum: PLATFORM_USER_STATUSES })
  status!: (typeof PLATFORM_USER_STATUSES)[number];

  @ApiProperty({
    enum: ['OWNER', 'PLATFORM'],
    nullable: true,
    type: String,
  })
  blockedBy!: 'OWNER' | 'PLATFORM' | null;

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-04-04T09:15:00.000Z',
  })
  joinedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastLoginAt!: string | null;

  @ApiProperty({ example: true, description: '¿Tiene el TOTP inscrito?' })
  mfaEnabled!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Invitación pendiente (para reenviarla o anularla)',
  })
  invitationId!: string | null;

  @ApiProperty({
    enum: ['ACTIVE', 'BLOCKED'],
    type: String,
    nullable: true,
    description:
      'Estado de la cuenta completa (ampliación O1): BLOCKED si la plataforma la bloqueó; null en una invitación sin cuenta',
  })
  accountStatus!: 'ACTIVE' | 'BLOCKED' | null;

  @ApiProperty({ type: String, nullable: true })
  accountBlockedReason!: string | null;
}

/** `GET /v1/platform/users?status=&role=`. */
export class PlatformUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PLATFORM_USER_STATUSES })
  @IsOptional()
  @IsIn(PLATFORM_USER_STATUSES, { message: 'Estado no válido' })
  status?: (typeof PLATFORM_USER_STATUSES)[number];

  @ApiPropertyOptional({ enum: PLATFORM_ROLES, enumName: 'PlatformRole' })
  @IsOptional()
  @IsIn(PLATFORM_ROLES, { message: 'Rol no válido' })
  role?: (typeof PLATFORM_ROLES)[number];
}

/** `PATCH /v1/platform/users/{membershipId}`. */
export class UpdatePlatformUserDto {
  @ApiPropertyOptional({ enum: INTERNAL_ROLES })
  @IsOptional()
  @IsIn(INTERNAL_ROLES, {
    message: 'El rol debe ser ADMIN, OPERATIONS o SUPPORT',
  })
  role?: InternalRole;

  @ApiProperty({ description: 'Motivo (3–500 caracteres)' })
  @Transform(trim)
  @IsString({ message: 'El motivo es obligatorio' })
  @Length(3, 500, { message: 'El motivo debe tener entre 3 y 500 caracteres' })
  reason!: string;
}

/** Membresía en el detalle de una cuenta. */
export class AccountMembershipDto {
  @ApiProperty()
  membershipId!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty({ enum: ['PLATFORM', 'WINERY', 'PICKUP_POINT'] })
  organizationType!: string;

  @ApiProperty()
  organizationName!: string;

  @ApiProperty({ enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] })
  organizationStatus!: string;

  @ApiProperty({ example: 'OWNER' })
  role!: string;

  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED'] })
  status!: string;

  @ApiProperty({ enum: ['OWNER', 'PLATFORM'], type: String, nullable: true })
  blockedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;
}

/** GET /v1/platform/accounts/{userId} (ampliación O1): la cuenta completa. */
export class AccountDetailDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED'] })
  status!: 'ACTIVE' | 'BLOCKED';

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  blockedAt!: string | null;

  @ApiProperty({ type: [AccountMembershipDto] })
  memberships!: AccountMembershipDto[];
}

/** Bloqueo o desbloqueo de la cuenta completa. */
export class UserAccountStatusDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED'] })
  status!: 'ACTIVE' | 'BLOCKED';

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;
}

export class CapabilityDto {
  @ApiProperty({ example: 'platform.users' })
  key!: string;

  @ApiProperty({ example: 'Usuarios internos' })
  label!: string;

  @ApiProperty({
    description: 'Nivel de cada rol: FULL, READ, OWN (solo lo suyo) o NONE',
    type: 'object',
    additionalProperties: { type: 'string', enum: [...PERMISSION_LEVELS] },
    example: { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'NONE' },
  })
  roles!: Record<string, (typeof PERMISSION_LEVELS)[number]>;
}

/** `GET /v1/platform/permissions` (PLT-04). */
export class PermissionMatrixDto {
  @ApiProperty({ type: [CapabilityDto] })
  capabilities!: CapabilityDto[];
}
