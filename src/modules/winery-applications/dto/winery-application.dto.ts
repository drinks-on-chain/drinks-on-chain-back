import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  MeetingChannelEnum,
  WineryApplicationStatusEnum,
  WineryCategoryEnum,
} from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { MAX_CAPTCHA_TOKEN_LENGTH } from '@shared/captcha/captcha.service';
import {
  OptionalReasonProperty,
  ReasonProperty,
} from '@shared/audit/requires-reason';
import { InvitationDto } from '@modules/invitations/dto/invitation.dto';
import {
  TAX_ID_MESSAGE,
  TAX_ID_PATTERN,
  WineryDetailDto,
} from '@modules/winery-management/dto/winery.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const emptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** `POST /v1/public/winery-applications` (sitio de bodegas `/unirse`). */
export class CreateWineryApplicationDto {
  @ApiProperty({ example: 'Viñas del Alto Camargo S.R.L.' })
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  legalName!: string;

  @ApiProperty({ example: 'Viñas del Alto Camargo' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  tradeName!: string;

  @ApiProperty({ example: '7011002233', description: 'NIT (5–15 dígitos)' })
  @Transform(trim)
  @IsString()
  @Matches(TAX_ID_PATTERN, { message: TAX_ID_MESSAGE })
  taxId!: string;

  @ApiProperty({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  @IsEnum(WineryCategoryEnum, { message: 'Categoría no válida' })
  category!: WineryCategoryEnum;

  @ApiProperty({ example: 'Valle de Cinti · Camargo' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  region!: string;

  @ApiProperty({ example: 'Rodrigo Aguilar' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  contactName!: string;

  @ApiProperty({ example: 'rodrigo@altocamargo.test' })
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  contactEmail!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 20,
    example: '+59172110022',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  contactPhone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  message?: string | null;

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
    type: String,
    nullable: true,
    description:
      'Campo trampa: debe llegar vacío (si no, 202 sin crear nada). No se muestra al usuario',
    example: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string | null;
}

export class CreateWineryApplicationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['UNVERIFIED'], example: 'UNVERIFIED' })
  status!: 'UNVERIFIED';
}

/** `POST /v1/public/winery-applications/verify`. */
export class VerifyWineryApplicationDto {
  @ApiProperty({ description: 'Token del enlace del correo' })
  @IsString()
  @IsNotEmpty({ message: 'El token es obligatorio' })
  @MaxLength(512)
  token!: string;
}

export class PersonRefDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'Valeria Méndez' })
  fullName!: string;
}

export class ApplicationMeetingDto {
  @ApiProperty({ example: '2026-09-30T15:00:00.000Z' })
  scheduledAt!: string;

  @ApiProperty({ enum: MeetingChannelEnum, enumName: 'MeetingChannel' })
  channel!: MeetingChannelEnum;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;
}

export class ApplicationDecisionDto {
  @ApiProperty({
    example: 'Valeria Méndez',
    description: 'Nombre de quien aprobó o rechazó',
  })
  by!: string;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  at!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;
}

export class ApplicationNoteDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({
    example: 'Valeria Méndez',
    description: 'Nombre de quien la escribió',
  })
  by!: string;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  at!: string;
}

/** Elemento de la bandeja (sin `notes`; contrato O1 §3). */
export class WineryApplicationSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: WineryApplicationStatusEnum,
    enumName: 'ApplicationStatus',
  })
  status!: WineryApplicationStatusEnum;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty()
  legalName!: string;

  @ApiProperty()
  tradeName!: string;

  @ApiProperty({ description: 'NIT' })
  taxId!: string;

  @ApiProperty({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  category!: WineryCategoryEnum;

  @ApiProperty()
  region!: string;

  @ApiProperty()
  contactName!: string;

  @ApiProperty()
  contactEmail!: string;

  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ type: PersonRefDto, nullable: true })
  assignee!: PersonRefDto | null;

  @ApiProperty({ type: ApplicationMeetingDto, nullable: true })
  meeting!: ApplicationMeetingDto | null;

  @ApiProperty({ type: ApplicationDecisionDto, nullable: true })
  decision!: ApplicationDecisionDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Bodega creada al aprobarla',
  })
  wineryId!: string | null;
}

/** Detalle (`GET /v1/platform/winery-applications/{id}`): con `notes`. */
export class WineryApplicationDto extends WineryApplicationSummaryDto {
  @ApiProperty({ type: [ApplicationNoteDto] })
  notes!: ApplicationNoteDto[];
}

/** `GET /v1/platform/winery-applications?status=&q=&assigneeId=`. */
export class WineryApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: WineryApplicationStatusEnum,
    enumName: 'ApplicationStatus',
    description: 'Sin él, todas menos las `UNVERIFIED`',
  })
  @IsOptional()
  @IsEnum(WineryApplicationStatusEnum, { message: 'Estado no válido' })
  status?: WineryApplicationStatusEnum;

  @ApiPropertyOptional({
    description:
      'Busca en razón social, nombre comercial, NIT, contacto (nombre y correo) y región',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'assigneeId debe ser un UUID' })
  assigneeId?: string;
}

export class AddApplicationNoteDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  text!: string;
}

export class ScheduleMeetingDto {
  @ApiProperty({
    example: '2026-09-30T15:00:00-04:00',
    description: 'ISO 8601 con zona',
  })
  @IsISO8601(
    { strict: true },
    { message: 'scheduledAt debe ser una fecha ISO 8601' },
  )
  scheduledAt!: string;

  @ApiProperty({ enum: MeetingChannelEnum, enumName: 'MeetingChannel' })
  @IsEnum(MeetingChannelEnum, { message: 'Canal no válido' })
  channel!: MeetingChannelEnum;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class MeetingDoneDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  notes!: string;
}

/** `POST …/{id}/approve`: por defecto el dueño es el contacto de la solicitud. */
export class ApproveApplicationDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(lower)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255)
  ownerEmail?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  ownerFullName?: string | null;

  @OptionalReasonProperty('Motivo (opcional; queda en la bitácora)')
  reason?: string | null;
}

export class RejectApplicationDto {
  @ReasonProperty(
    'Motivo del rechazo (se envía al contacto y queda en la bitácora)',
  )
  reason!: string;
}

export class ApproveApplicationResponseDto {
  @ApiProperty({ type: WineryApplicationDto })
  application!: WineryApplicationDto;

  @ApiProperty({ type: WineryDetailDto })
  winery!: WineryDetailDto;

  @ApiProperty({ type: InvitationDto })
  invitation!: InvitationDto;
}
