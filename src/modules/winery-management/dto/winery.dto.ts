import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { WineryCategoryEnum, WineryStatusEnum } from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import {
  OptionalReasonProperty,
  ReasonProperty,
} from '@shared/audit/requires-reason';
import { InvitationDto } from '@modules/invitations/dto/invitation.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
/** `""` se trata como `null` (vaciar un campo opcional). */
const emptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
/** El campo puede faltar, pero si llega no puede ser `null` (columna obligatoria). */
const present = (field: string) =>
  ValidateIf((o: Record<string, unknown>) => o[field] !== undefined);

export const TAX_ID_PATTERN = /^\d{5,15}$/;
export const TAX_ID_MESSAGE = 'El NIT debe tener entre 5 y 15 dígitos';

export class WineryOwnerDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`null` si el dueño aún no aceptó su invitación',
  })
  userId!: string | null;

  @ApiProperty({ example: 'Rodrigo Aguilar' })
  fullName!: string;

  @ApiProperty({ example: 'rodrigo@altocamargo.test' })
  email!: string;
}

/** Elemento del directorio (contrato O1 §4). */
export class WinerySummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'altos-de-calamuchita' })
  slug!: string;

  @ApiProperty({ example: 'Bodega Altos de Calamuchita S.R.L.' })
  legalName!: string;

  @ApiProperty({ example: 'Bodega Altos de Calamuchita' })
  tradeName!: string;

  @ApiProperty({ example: '1023456019', description: 'NIT' })
  taxId!: string;

  @ApiProperty({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  category!: WineryCategoryEnum;

  @ApiProperty({ example: 'Valle Central de Tarija' })
  region!: string;

  @ApiProperty({ enum: WineryStatusEnum, enumName: 'WineryStatus' })
  status!: WineryStatusEnum;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ALT',
    description:
      'Prefijo del código de lote (3–5 letras, único y definitivo); se asigna al activarse',
  })
  lotPrefix!: string | null;

  @ApiProperty({ type: WineryOwnerDto, nullable: true })
  owner!: WineryOwnerDto | null;

  @ApiProperty({ example: 4, description: 'Membresías activas' })
  membersCount!: number;

  @ApiProperty({ example: '2026-03-01T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  activatedAt!: string | null;
}

export class WineryStatusChangeDto {
  @ApiProperty({ enum: WineryStatusEnum, enumName: 'WineryStatus' })
  status!: WineryStatusEnum;

  @ApiProperty({ example: '2026-03-02T10:00:00.000Z' })
  at!: string;

  @ApiProperty({
    example: 'Valeria Méndez',
    description: 'Nombre de quien hizo el cambio (el dueño al activarse)',
  })
  by!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;
}

/** Ficha de la bodega (contrato O1 §4). */
export class WineryDetailDto extends WinerySummaryDto {
  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  senasagRegistration!: string | null;

  @ApiProperty({ example: 'contacto@altos.test' })
  contactEmail!: string;

  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  publicStory!: string | null;

  @ApiProperty({ type: String, nullable: true })
  website!: string | null;

  @ApiProperty({ type: [WineryStatusChangeDto] })
  statusHistory!: WineryStatusChangeDto[];
}

/** Respuesta del alta directa y de la transferencia de titularidad. */
export class WineryWithInvitationDto {
  @ApiProperty({ type: WineryDetailDto })
  winery!: WineryDetailDto;

  @ApiProperty({ type: InvitationDto })
  invitation!: InvitationDto;
}

/** `GET /v1/public/wineries/{slug}` (solo bodegas `ACTIVE`). */
export class PublicWineryProfileDto {
  @ApiProperty({ example: 'altos-de-calamuchita' })
  slug!: string;

  @ApiProperty({ example: 'Bodega Altos de Calamuchita' })
  tradeName!: string;

  @ApiProperty({ example: 'Valle Central de Tarija' })
  region!: string;

  @ApiProperty({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  category!: WineryCategoryEnum;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  publicStory!: string | null;

  @ApiProperty({ type: String, nullable: true })
  website!: string | null;
}

/** `GET /v1/platform/wineries?status=&region=&category=&q=`. */
export class WineriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WineryStatusEnum, enumName: 'WineryStatus' })
  @IsOptional()
  @IsEnum(WineryStatusEnum, { message: 'Estado no válido' })
  status?: WineryStatusEnum;

  @ApiPropertyOptional({ description: 'Coincidencia parcial' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  region?: string;

  @ApiPropertyOptional({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  @IsOptional()
  @IsEnum(WineryCategoryEnum, { message: 'Categoría no válida' })
  category?: WineryCategoryEnum;

  @ApiPropertyOptional({
    description: 'Busca en razón social, nombre comercial, NIT y slug',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}

/**
 * Perfil que edita el dueño (`PATCH /v1/organizations/current`): sin NIT ni
 * razón social. `null` (o `""`) vacía un campo opcional.
 */
export class UpdateCurrentOrganizationDto {
  @ApiPropertyOptional({ example: 'Bodega Altos de Calamuchita' })
  @present('tradeName')
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  tradeName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(50)
  senasagRegistration?: string | null;

  @ApiPropertyOptional({ example: 'contacto@altos.test' })
  @present('contactEmail')
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  contactEmail?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  contactPhone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(4000)
  publicStory?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://altos.test',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'La web debe ser una URL http(s)' },
  )
  @MaxLength(500)
  website?: string | null;
}

/** `PATCH /v1/platform/wineries/{id}`: todo el perfil, datos legales incluidos. */
export class UpdatePlatformWineryDto extends UpdateCurrentOrganizationDto {
  @ApiPropertyOptional({ example: 'Bodega Altos de Calamuchita S.R.L.' })
  @present('legalName')
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  legalName?: string;

  @ApiPropertyOptional({ example: '1023456019' })
  @present('taxId')
  @Transform(trim)
  @IsString()
  @Matches(TAX_ID_PATTERN, { message: TAX_ID_MESSAGE })
  taxId?: string;

  @ApiPropertyOptional({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  @present('category')
  @IsEnum(WineryCategoryEnum, { message: 'Categoría no válida' })
  category?: WineryCategoryEnum;

  @ApiPropertyOptional({ example: 'Valle Central de Tarija' })
  @present('region')
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  region?: string;

  @ReasonProperty()
  reason!: string;
}

/** Datos de la bodega en el alta (directa o al aprobar una solicitud). */
export class CreatePlatformWineryDto {
  @ApiProperty({ example: 'Viñedos La Angostura S.R.L.' })
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  legalName!: string;

  @ApiProperty({ example: 'Viñedos La Angostura' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  tradeName!: string;

  @ApiProperty({ example: '7055446677' })
  @Transform(trim)
  @IsString()
  @Matches(TAX_ID_PATTERN, { message: TAX_ID_MESSAGE })
  taxId!: string;

  @ApiProperty({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  @IsEnum(WineryCategoryEnum, { message: 'Categoría no válida' })
  category!: WineryCategoryEnum;

  @ApiProperty({ example: 'Valle Central de Tarija · Uriondo' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  region!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(50)
  senasagRegistration?: string | null;

  @ApiProperty({ example: 'contacto@angostura.test' })
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  contactEmail!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  contactPhone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(4000)
  publicStory?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'La web debe ser una URL http(s)' },
  )
  @MaxLength(500)
  website?: string | null;

  @ApiProperty({ example: 'titular@angostura.test' })
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  ownerEmail!: string;

  @ApiProperty({ example: 'Lucía Vargas' })
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  ownerFullName!: string;

  @OptionalReasonProperty('Motivo (opcional; queda en la bitácora)')
  reason?: string | null;
}

/** `POST /v1/platform/wineries/{id}/suspend` · `/reactivate` · `/revoke`. */
export class WineryStatusActionDto {
  @ReasonProperty()
  reason!: string;
}

export const KEEP_PREVIOUS_OWNER_AS = ['ENOLOGIST', 'BLOCKED'] as const;
export type KeepPreviousOwnerAs = (typeof KEEP_PREVIOUS_OWNER_AS)[number];

/** `POST /v1/platform/wineries/{id}/transfer-ownership` (solo administración). */
export class TransferOwnershipDto {
  @ApiProperty({ example: 'nueva.titular@altos.test' })
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  newOwnerEmail!: string;

  @ReasonProperty()
  reason!: string;

  @ApiPropertyOptional({
    enum: KEEP_PREVIOUS_OWNER_AS,
    default: 'BLOCKED',
    description:
      'Qué pasa con el dueño anterior cuando el nuevo acepta: enólogo activo o enólogo bloqueado por la plataforma',
  })
  @IsOptional()
  @IsIn(KEEP_PREVIOUS_OWNER_AS, {
    message: 'keepPreviousOwnerAs debe ser ENOLOGIST o BLOCKED',
  })
  keepPreviousOwnerAs?: KeepPreviousOwnerAs;
}
