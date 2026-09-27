import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import {
  InvitationStatusEnum,
  MembershipRoleEnum,
  OrganizationTypeEnum,
} from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Motivo opcional de una acción del back office (3–500 si llega; AUD-05). */
export class OptionalReasonDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Motivo (3–500 caracteres); queda en la bitácora',
    example: 'La bodega lo pidió por soporte',
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500, { message: 'El motivo debe tener entre 3 y 500 caracteres' })
  reason?: string | null;
}

/** Motivo obligatorio de una acción del back office sobre terceros (AUD-05). */
export class RequiredReasonDto {
  @ApiProperty({
    description: 'Motivo (3–500 caracteres); queda en la bitácora',
    example: 'Dejó la empresa',
  })
  @Transform(trim)
  @IsString({ message: 'El motivo es obligatorio' })
  @Length(3, 500, { message: 'El motivo debe tener entre 3 y 500 caracteres' })
  reason!: string;
}

export class InvitedByDto {
  @ApiProperty({ example: '4e89872f-1de3-5f01-968b-2203e12dbfd0' })
  userId!: string;

  @ApiProperty({ example: 'Jorge Salinas' })
  fullName!: string;

  @ApiProperty({
    example: false,
    description: '`true` si invitó el back office en nombre de la organización',
  })
  viaPlatform!: boolean;
}

/** Invitación (contrato O1 §2). */
export class InvitationDto {
  @ApiProperty({ example: '45a3d555-de55-5dcf-af73-d97324c07209' })
  id!: string;

  @ApiProperty({ example: 'enologa@altos.test' })
  email!: string;

  @ApiProperty({ example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f' })
  organizationId!: string;

  @ApiProperty({
    enum: OrganizationTypeEnum,
    enumName: 'OrganizationType',
    example: OrganizationTypeEnum.WINERY,
  })
  organizationType!: OrganizationTypeEnum;

  @ApiProperty({ example: 'Altos de Calamuchita' })
  organizationName!: string;

  @ApiProperty({
    enum: MembershipRoleEnum,
    enumName: 'MembershipRole',
    example: MembershipRoleEnum.ENOLOGIST,
  })
  role!: MembershipRoleEnum;

  @ApiProperty({
    enum: InvitationStatusEnum,
    enumName: 'InvitationStatus',
    example: InvitationStatusEnum.PENDING,
    description: 'Una pendiente con la caducidad vencida se presenta `EXPIRED`',
  })
  status!: InvitationStatusEnum;

  @ApiProperty({ example: '2026-09-30T14:00:00.000Z' })
  expiresAt!: string;

  @ApiProperty({ example: '2026-09-27T14:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: InvitedByDto })
  invitedBy!: InvitedByDto;
}

/** `GET /v1/invitations/{token}` (público). */
export class InvitationPreviewDto {
  @ApiProperty({ example: 'enologa@altos.test' })
  email!: string;

  @ApiProperty({ example: 'Altos de Calamuchita' })
  organizationName!: string;

  @ApiProperty({
    enum: OrganizationTypeEnum,
    enumName: 'OrganizationType',
    example: OrganizationTypeEnum.WINERY,
  })
  organizationType!: OrganizationTypeEnum;

  @ApiProperty({
    enum: MembershipRoleEnum,
    enumName: 'MembershipRole',
    example: MembershipRoleEnum.ENOLOGIST,
  })
  role!: MembershipRoleEnum;

  @ApiProperty({ example: 'Jorge Salinas' })
  invitedByName!: string;

  @ApiProperty({ example: '2026-09-30T14:00:00.000Z' })
  expiresAt!: string;

  @ApiProperty({
    enum: InvitationStatusEnum,
    enumName: 'InvitationStatus',
    example: InvitationStatusEnum.PENDING,
  })
  status!: InvitationStatusEnum;

  @ApiProperty({
    example: false,
    description:
      '`true`: iniciar sesión con ese correo y aceptar con `{}`; `false`: crear la cuenta con `{ fullName, password }`',
  })
  accountExists!: boolean;
}

/**
 * `POST /v1/invitations/{token}/accept`. Cuenta nueva: `{ fullName, password }`
 * sin sesión. Cuenta existente: `{}` con la sesión de la persona invitada.
 */
export class AcceptInvitationDto {
  @ApiPropertyOptional({ example: 'Ana Gutiérrez' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  fullName?: string;

  @ApiPropertyOptional({
    description:
      'Contraseña de la cuenta nueva: al menos 10 caracteres y que no sea común',
    example: 'vendimia-de-altura-2026',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  password?: string;
}

/** `POST /v1/organizations/current/invitations`. */
export class CreateInvitationDto {
  @ApiProperty({ example: 'enologa@altos.test' })
  @Transform(trim)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    enum: MembershipRoleEnum,
    enumName: 'MembershipRole',
    example: MembershipRoleEnum.ENOLOGIST,
    description:
      'Rol de la organización (bodega: ENOLOGIST, AGRONOMIST, OPERATOR, ACCOUNTANT). `OWNER` → 403 `ORG_OWNER_ROLE_RESERVED`',
  })
  @IsEnum(MembershipRoleEnum, { message: 'El rol no es válido' })
  role!: MembershipRoleEnum;
}

/** `POST /v1/platform/organizations/{organizationId}/invitations`. */
export class PlatformCreateInvitationDto extends CreateInvitationDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Motivo (3–500 caracteres); queda en la bitácora',
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500, { message: 'El motivo debe tener entre 3 y 500 caracteres' })
  reason?: string | null;
}

/** Roles que se asignan al personal interno (`SUPERADMIN` no se asigna). */
export const INTERNAL_ROLES = ['ADMIN', 'OPERATIONS', 'SUPPORT'] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];

/** `POST /v1/platform/users`: invita a un usuario interno. */
export class CreatePlatformUserDto {
  @ApiProperty({ example: 'soporte2@drinksonchain.test' })
  @Transform(trim)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ enum: INTERNAL_ROLES, example: 'SUPPORT' })
  @IsIn(INTERNAL_ROLES, {
    message: 'El rol debe ser ADMIN, OPERATIONS o SUPPORT',
  })
  role!: InternalRole;

  @ApiPropertyOptional({
    type: String,
    description: 'Motivo (3–500 caracteres); queda en la bitácora',
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500, { message: 'El motivo debe tener entre 3 y 500 caracteres' })
  reason?: string | null;
}

/** `GET /v1/organizations/current/invitations?status=`. */
export class InvitationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: InvitationStatusEnum,
    enumName: 'InvitationStatus',
  })
  @IsOptional()
  @IsEnum(InvitationStatusEnum, { message: 'Estado de invitación no válido' })
  status?: InvitationStatusEnum;
}
