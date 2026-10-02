import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
  ValidationArguments,
} from 'class-validator';
import {
  WaitlistInterestEnum,
  WaitlistProducesEnum,
  WaitlistStatusEnum,
  WaitlistTypeEnum,
} from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { NullableFields } from '@shared/pipes/optional-nulls';
import { MAX_CAPTCHA_TOKEN_LENGTH } from '@shared/captcha/captcha.service';
import { AuditRangeQueryDto } from '@modules/audit/dto/audit-query.dto';

export const WAITLIST_LOCALES = ['es', 'en'] as const;
export type WaitlistLocale = (typeof WAITLIST_LOCALES)[number];

/** WhatsApp: 7–20 caracteres entre dígitos, espacios y `+ - ( )`. */
export const WAITLIST_PHONE_PATTERN = /^[0-9+\-() ]{7,20}$/;
/** Origen de la inscripción: hasta 40 caracteres `[a-z0-9-]`. */
export const WAITLIST_SOURCE_PATTERN = /^[a-z0-9-]{1,40}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Correo normalizado: minúsculas y sin espacios. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const emptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const lowerOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};
const present = (value: unknown) => value !== undefined && value !== null;

/**
 * `isAdult`: obligatorio y `true` en consumidores (Ley 259); en bodegas,
 * opcional (un booleano si llega).
 */
function IsAdultWhenConsumer() {
  return ValidateBy({
    name: 'isAdultWhenConsumer',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const type = (args?.object as { type?: unknown } | undefined)?.type;
        if (type === WaitlistTypeEnum.CONSUMER) return value === true;
        return !present(value) || typeof value === 'boolean';
      },
      defaultMessage: (args?: ValidationArguments) =>
        (args?.object as { type?: unknown } | undefined)?.type ===
        WaitlistTypeEnum.CONSUMER
          ? 'Debes confirmar que eres mayor de edad'
          : 'isAdult debe ser verdadero o falso',
    },
  });
}

/** `POST /v1/public/waitlist` (landing: `CONSUMER`; sitio de bodegas: `WINERY`). */
export class JoinWaitlistDto {
  @ApiProperty({ enum: WaitlistTypeEnum, enumName: 'WaitlistType' })
  @IsEnum(WaitlistTypeEnum, { message: 'Tipo de lista no válido' })
  type!: WaitlistTypeEnum;

  @ApiProperty({
    minLength: 2,
    maxLength: 120,
    example: 'Lucía Fernández',
    description: 'Persona (consumidor) o persona de contacto (bodega)',
  })
  @Transform(trim)
  @IsString({ message: 'El nombre es obligatorio' })
  @Length(2, 120, { message: 'El nombre debe tener entre 2 y 120 caracteres' })
  fullName!: string;

  @ApiProperty({
    example: 'lucia@example.com',
    description: 'Se normaliza a minúsculas y sin espacios',
  })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @MaxLength(255, { message: 'El correo es demasiado largo' })
  email!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 7,
    maxLength: 20,
    example: '+591 72110022',
    description: 'WhatsApp: dígitos, espacios y + - ( )',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @Matches(WAITLIST_PHONE_PATTERN, {
    message:
      'El teléfono debe tener entre 7 y 20 caracteres: dígitos, espacios y + - ( )',
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 80,
    example: 'Tarija',
    description: 'Consumidor',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(80, { message: 'La ciudad admite hasta 80 caracteres' })
  city?: string | null;

  @ApiPropertyOptional({
    enum: WaitlistInterestEnum,
    enumName: 'WaitlistInterest',
    nullable: true,
    description: 'Consumidor: qué le interesa',
  })
  @IsOptional()
  @IsEnum(WaitlistInterestEnum, { message: 'Interés no válido' })
  interest?: WaitlistInterestEnum | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 2,
    maxLength: 160,
    example: 'Viñas del Alto Camargo',
    description: 'Obligatorio si `type` = `WINERY`',
  })
  @Transform(emptyToNull)
  @ValidateIf(
    (o: JoinWaitlistDto) =>
      o.type === WaitlistTypeEnum.WINERY || present(o.wineryName),
  )
  @IsString({ message: 'El nombre de la bodega es obligatorio' })
  @Length(2, 160, {
    message: 'El nombre de la bodega debe tener entre 2 y 160 caracteres',
  })
  wineryName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 80,
    example: 'Valle de Cinti',
    description: 'Bodega: valle o región',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(80, { message: 'La región admite hasta 80 caracteres' })
  region?: string | null;

  @ApiPropertyOptional({
    enum: WaitlistProducesEnum,
    enumName: 'WaitlistProduces',
    nullable: true,
    description: 'Bodega: qué produce',
  })
  @IsOptional()
  @IsEnum(WaitlistProducesEnum, { message: 'Producción no válida' })
  produces?: WaitlistProducesEnum | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500, { message: 'El mensaje admite hasta 500 caracteres' })
  message?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Mayoría de edad (Ley 259). Obligatorio y `true` si `type` = `CONSUMER`',
  })
  @IsAdultWhenConsumer()
  isAdult?: boolean | null;

  @ApiProperty({
    type: Boolean,
    enum: [true],
    description: 'Acepta ser contactado y el aviso de privacidad',
  })
  @Equals(true, {
    message: 'Debes aceptar el aviso de privacidad para inscribirte',
  })
  consent!: true;

  @ApiPropertyOptional({ enum: WAITLIST_LOCALES, default: 'es' })
  @IsOptional()
  @IsIn(WAITLIST_LOCALES, { message: 'Idioma no válido (es o en)' })
  locale?: WaitlistLocale;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 40,
    pattern: '^[a-z0-9-]{1,40}$',
    example: 'tarija-2026',
    description: 'Origen de la inscripción (se pasa a minúsculas)',
  })
  @IsOptional()
  @Transform(lowerOrNull)
  @IsString()
  @Matches(WAITLIST_SOURCE_PATTERN, {
    message:
      'El origen admite hasta 40 caracteres: letras minúsculas, números y guiones',
  })
  source?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Token de Cloudflare Turnstile. Solo se comprueba (y se exige) con `WAITLIST_CAPTCHA_REQUIRED=true`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CAPTCHA_TOKEN_LENGTH)
  captchaToken?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Campo trampa: debe llegar vacío (si no, 201 sin guardar nada). No se muestra al usuario',
    example: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string | null;
}

export class WaitlistJoinResponseDto {
  @ApiProperty({ enum: WaitlistTypeEnum, enumName: 'WaitlistType' })
  type!: WaitlistTypeEnum;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 42,
    description: 'Número de orden dentro de su tipo (desde 1)',
  })
  position!: number;
}

/** `GET /v1/public/waitlist/stats`. */
export class WaitlistStatsDto {
  @ApiProperty({ type: 'integer', minimum: 0, example: 128 })
  consumers!: number;

  @ApiProperty({ type: 'integer', minimum: 0, example: 14 })
  wineries!: number;
}

/** Inscripción vista desde el back office (contrato O1b §2). */
export class WaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: WaitlistTypeEnum, enumName: 'WaitlistType' })
  type!: WaitlistTypeEnum;

  @ApiProperty({ type: 'integer', minimum: 1 })
  position!: number;

  @ApiProperty({ enum: WaitlistStatusEnum, enumName: 'WaitlistStatus' })
  status!: WaitlistStatusEnum;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  city!: string | null;

  @ApiProperty({
    enum: WaitlistInterestEnum,
    enumName: 'WaitlistInterest',
    nullable: true,
  })
  interest!: WaitlistInterestEnum | null;

  @ApiProperty({ type: String, nullable: true })
  wineryName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  region!: string | null;

  @ApiProperty({
    enum: WaitlistProducesEnum,
    enumName: 'WaitlistProduces',
    nullable: true,
  })
  produces!: WaitlistProducesEnum | null;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ enum: WAITLIST_LOCALES })
  locale!: WaitlistLocale;

  @ApiProperty({ type: String, nullable: true, example: 'tarija-2026' })
  source!: string | null;

  @ApiProperty({ format: 'date-time' })
  consentAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  contactedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Valeria Méndez',
    description: 'Nombre de quien lo marcó como contactado',
  })
  contactedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;
}

/** Filtros de la lista y de la exportación. */
export class WaitlistFiltersDto extends AuditRangeQueryDto {
  @ApiPropertyOptional({ enum: WaitlistTypeEnum, enumName: 'WaitlistType' })
  @IsOptional()
  @IsEnum(WaitlistTypeEnum, { message: 'Tipo de lista no válido' })
  type?: WaitlistTypeEnum;

  @ApiPropertyOptional({
    enum: WaitlistStatusEnum,
    enumName: 'WaitlistStatus',
  })
  @IsOptional()
  @IsEnum(WaitlistStatusEnum, { message: 'Estado no válido' })
  status?: WaitlistStatusEnum;

  @ApiPropertyOptional({
    example: 'tarija-2026',
    description: 'Origen exacto de la inscripción',
  })
  @IsOptional()
  @Transform(lower)
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional({
    description: 'Busca en nombre, correo, bodega y teléfono',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** `GET /v1/platform/waitlist`: filtros y página (más reciente primero). */
export class WaitlistListQueryDto extends IntersectionType(
  PaginationQueryDto,
  WaitlistFiltersDto,
) {}

/** `GET /v1/platform/waitlist/sources?type=`. */
export class WaitlistSourcesQueryDto {
  @ApiPropertyOptional({ enum: WaitlistTypeEnum, enumName: 'WaitlistType' })
  @IsOptional()
  @IsEnum(WaitlistTypeEnum, { message: 'Tipo de lista no válido' })
  type?: WaitlistTypeEnum;
}

export class WaitlistSourceDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'tarija-2026',
    description: '`null` = inscripciones sin origen',
  })
  source!: string | null;

  @ApiProperty({ type: 'integer', minimum: 1 })
  count!: number;
}

/** `PATCH /v1/platform/waitlist/{id}`: estado y notas internas. */
@NullableFields('notes')
export class UpdateWaitlistEntryDto {
  @ApiPropertyOptional({
    enum: WaitlistStatusEnum,
    enumName: 'WaitlistStatus',
    description:
      'Al pasar a `CONTACTED` se guardan `contactedAt` y quién; al volver a `NEW` se borran',
  })
  @IsOptional()
  @IsEnum(WaitlistStatusEnum, { message: 'Estado no válido' })
  status?: WaitlistStatusEnum;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 1000,
    description: 'Notas internas; `null` o vacío las borra',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000, { message: 'Las notas admiten hasta 1000 caracteres' })
  notes?: string | null;
}
