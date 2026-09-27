import { ApiProperty } from '@nestjs/swagger';
import { CLIENT_APPS, type ClientApp } from '@shared/context/request-context';

export class AuditActorDto {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'null = el sistema',
  })
  userId!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Jorge Salinas' })
  fullName!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'ADMIN' })
  role!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Organización desde la que actuó',
  })
  organizationId!: string | null;

  @ApiProperty({
    description: 'Actuó el back office (organización de plataforma)',
  })
  viaPlatform!: boolean;
}

export class AuditSourceDto {
  @ApiProperty({
    enum: CLIENT_APPS,
    description: 'Cabecera X-Client-App (API sin ella; WORKER el sistema)',
  })
  app!: ClientApp;

  @ApiProperty({ nullable: true, type: String })
  ip!: string | null;

  @ApiProperty({ nullable: true, type: String })
  deviceId!: string | null;
}

export class AuditResourceDto {
  @ApiProperty({ example: 'setting' })
  type!: string;

  @ApiProperty({ nullable: true, type: String, example: 'canje.ventanaDias' })
  id!: string | null;
}

/** Entrada de la bitácora (contrato O1 §7). */
export class AuditEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1, example: 42 })
  seq!: number;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: AuditActorDto })
  actor!: AuditActorDto;

  @ApiProperty({ type: AuditSourceDto })
  source!: AuditSourceDto;

  @ApiProperty({ example: 'SETTING_CHANGED' })
  action!: string;

  @ApiProperty({ type: AuditResourceDto })
  resource!: AuditResourceDto;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Organización afectada',
  })
  organizationId!: string | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Valores antes (sin datos sensibles)',
  })
  before!: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Valores después (sin datos sensibles)',
  })
  after!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  correlationId!: string | null;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description: 'SHA-256 del contenido canónico',
  })
  hash!: string;

  @ApiProperty({ nullable: true, type: String, pattern: '^[0-9a-f]{64}$' })
  prevHash!: string | null;
}

/** `GET /v1/platform/audit/verify`. */
export class AuditVerifyResultDto {
  @ApiProperty()
  valid!: boolean;

  @ApiProperty({ minimum: 0, description: 'Entradas comprobadas' })
  checked!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Primera entrada rota (null si la cadena es válida)',
  })
  firstBrokenSeq!: number | null;
}
