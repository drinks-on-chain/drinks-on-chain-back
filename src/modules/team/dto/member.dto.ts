import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import {
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
} from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import {
  OptionalReasonProperty,
  ReasonProperty,
} from '@shared/audit/requires-reason';
import {
  ROLES_BY_ORGANIZATION_TYPE,
  WineryRole,
} from '@modules/organizations/organization.constants';

const WINERY_ROLES = ROLES_BY_ORGANIZATION_TYPE.WINERY as readonly WineryRole[];

/** Miembro de una organización (contrato O1 §5). */
export class MemberDto {
  @ApiProperty({ format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'Ana Gutiérrez' })
  fullName!: string;

  @ApiProperty({ example: 'enologa@altos.test' })
  email!: string;

  @ApiProperty({ enum: MembershipRoleEnum, enumName: 'MembershipRole' })
  role!: MembershipRoleEnum;

  @ApiProperty({ enum: MembershipStatusEnum, enumName: 'MemberStatus' })
  status!: MembershipStatusEnum;

  @ApiProperty({
    enum: MembershipBlockedByEnum,
    enumName: 'BlockedBy',
    nullable: true,
    type: String,
    description:
      'Quién bloqueó: el dueño no puede desbloquear lo que bloqueó la plataforma',
  })
  blockedBy!: MembershipBlockedByEnum | null;

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;

  @ApiProperty({ example: '2026-03-02T10:00:00.000Z' })
  joinedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null para los roles que solo ven nombres y roles',
  })
  lastLoginAt!: string | null;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'BLOCKED'],
    description:
      'Solo en las rutas del back office (ampliación O1 §11 bis): estado de la cuenta completa',
  })
  accountStatus?: 'ACTIVE' | 'BLOCKED';

  @ApiPropertyOptional({ type: String, nullable: true })
  accountBlockedReason?: string | null;
}

/** `GET …/members?status=&role=`. */
export class MembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MembershipStatusEnum, enumName: 'MemberStatus' })
  @IsOptional()
  @IsEnum(MembershipStatusEnum, { message: 'Estado no válido' })
  status?: MembershipStatusEnum;

  @ApiPropertyOptional({ enum: MembershipRoleEnum, enumName: 'MembershipRole' })
  @IsOptional()
  @IsEnum(MembershipRoleEnum, { message: 'Rol no válido' })
  role?: MembershipRoleEnum;
}

/** `PATCH /v1/organizations/current/members/{membershipId}` (dueño). */
export class UpdateMemberRoleDto {
  @ApiProperty({
    enum: WINERY_ROLES,
    description:
      '`OWNER` → 403 `ORG_OWNER_ROLE_RESERVED` (solo por transferencia)',
    example: 'ENOLOGIST',
  })
  @IsIn(WINERY_ROLES, { message: 'Rol de bodega no válido' })
  role!: WineryRole;
}

/** Igual, desde el back office (motivo obligatorio). */
export class PlatformUpdateMemberRoleDto extends UpdateMemberRoleDto {
  @ReasonProperty()
  reason!: string;
}

/** `POST …/block` · `/unblock` del dueño (motivo opcional). */
export class MemberBlockDto {
  @OptionalReasonProperty('Motivo (opcional)')
  reason?: string | null;
}

/** `POST …/block` · `/unblock` del back office (motivo obligatorio). */
export class PlatformMemberActionDto {
  @ReasonProperty()
  reason!: string;
}
