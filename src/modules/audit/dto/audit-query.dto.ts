import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateBy,
  ValidationOptions,
  buildMessage,
} from 'class-validator';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';

/** `AAAA-MM-DD` (día completo, UTC) o fecha y hora ISO 8601. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

export function isAuditDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!DAY_PATTERN.test(value) && !ISO_PATTERN.test(value)) return false;
  const ms = Date.parse(DAY_PATTERN.test(value) ? `${value}T00:00:00Z` : value);
  return !Number.isNaN(ms);
}

/**
 * Límite de un rango: `from` = inicio del día, `to` = fin del día (UTC) si
 * llega solo la fecha.
 */
export function parseAuditDate(
  value: string | undefined,
  bound: 'from' | 'to',
): Date | undefined {
  if (!value) return undefined;
  if (DAY_PATTERN.test(value)) {
    return new Date(
      `${value}T${bound === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`,
    );
  }
  return new Date(value);
}

function IsAuditDate(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isAuditDate',
      validator: {
        validate: (value: unknown) => isAuditDate(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property debe ser una fecha AAAA-MM-DD o ISO 8601`,
          options,
        ),
      },
    },
    options,
  );
}

const DATE_DOC = {
  description: 'AAAA-MM-DD (día completo, UTC) o fecha y hora ISO 8601',
  example: '2026-09-27',
};

/** Rango de fechas (`verify` y base de los filtros). */
export class AuditRangeQueryDto {
  @ApiPropertyOptional({
    ...DATE_DOC,
    description: `Desde: ${DATE_DOC.description}`,
  })
  @IsOptional()
  @IsAuditDate()
  from?: string;

  @ApiPropertyOptional({
    ...DATE_DOC,
    description: `Hasta (incluido): ${DATE_DOC.description}`,
  })
  @IsOptional()
  @IsAuditDate()
  to?: string;
}

/** Filtros comunes de la bitácora (contrato O1 §7), sin la organización. */
export class AuditOwnFiltersDto extends AuditRangeQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Persona que actuó' })
  @IsOptional()
  @IsUUID('all', { message: 'actorId debe ser un UUID' })
  actorId?: string;

  @ApiPropertyOptional({
    example: 'SETTING_CHANGED',
    description: 'Código de acción (UPPER_SNAKE_CASE)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{2,99}$/, {
    message: 'action debe ser un código en MAYÚSCULAS_CON_GUIONES',
  })
  action?: string;

  @ApiPropertyOptional({ example: 'setting', description: 'Tipo de recurso' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType?: string;

  @ApiPropertyOptional({
    example: 'canje.ventanaDias',
    description: 'Id del recurso',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;
}

/** Filtros del back office: además, la organización afectada. */
export class AuditFiltersDto extends AuditOwnFiltersDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Organización afectada' })
  @IsOptional()
  @IsUUID('all', { message: 'organizationId debe ser un UUID' })
  organizationId?: string;
}

/** `GET /v1/platform/audit`: filtros y página (orden descendente por `seq`). */
export class AuditListQueryDto extends IntersectionType(
  PaginationQueryDto,
  AuditFiltersDto,
) {}

/**
 * `GET /v1/organizations/current/audit`: bitácora de la bodega activa. El
 * personal de plataforma indica la bodega con `wineryId` (OP-07); a un dueño
 * que indique otra le responde 404.
 */
export class OrganizationAuditQueryDto extends IntersectionType(
  PaginationQueryDto,
  AuditOwnFiltersDto,
) {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo personal de plataforma: bodega consultada',
  })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;
}
