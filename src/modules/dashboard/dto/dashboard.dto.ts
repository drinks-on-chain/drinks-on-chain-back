import { ApiProperty } from '@nestjs/swagger';
import { AuditEventDto } from '@modules/audit/dto/audit-event.dto';
import {
  CHAIN_NETWORKS,
  RECONCILIATION_STATUSES,
  type ChainNetwork,
} from '@modules/chain/chain.constants';

export class DashboardApplicationsDto {
  @ApiProperty({ minimum: 0 }) unverified!: number;
  @ApiProperty({ minimum: 0 }) received!: number;
  @ApiProperty({ minimum: 0 }) inReview!: number;
  @ApiProperty({ minimum: 0 }) meetingScheduled!: number;
}

export class DashboardWineriesDto {
  @ApiProperty({ minimum: 0 }) invited!: number;
  @ApiProperty({ minimum: 0 }) active!: number;
  @ApiProperty({ minimum: 0 }) suspended!: number;
}

export class DashboardInvitationsDto {
  @ApiProperty({ minimum: 0, description: 'Pendientes y no vencidas' })
  pending!: number;

  @ApiProperty({
    minimum: 0,
    description: 'Pendientes que caducan en menos de 24 h',
  })
  expiringIn24h!: number;
}

export class DashboardTeamDto {
  @ApiProperty({
    minimum: 0,
    description: 'Membresías bloqueadas (bodegas y plataforma)',
  })
  blockedMembers!: number;
}

export class DashboardWaitlistDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Consumidores inscritos',
  })
  consumers!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Bodegas inscritas',
  })
  wineries!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Inscripciones de las últimas 24 h (los dos tipos)',
  })
  last24h!: number;
}

const int = (description?: string) =>
  ApiProperty({ type: 'integer', minimum: 0, description });

/** Tokenización (contrato O3 §11). */
export class DashboardTokenizationDto {
  @int('Solicitudes enviadas, sin tomar')
  submitted!: number;

  @int('Solicitudes en revisión')
  inReview!: number;

  @int('Solicitudes que esperan cambios de la bodega')
  changesRequested!: number;

  @int('Horas que lleva abierta la solicitud abierta más antigua (0 si no hay)')
  oldestOpenHours!: number;

  @int('Colecciones con la emisión inicial sin confirmar')
  collectionsMinting!: number;

  @int('Colecciones con la última emisión fallida')
  mintFailures!: number;

  @int()
  collectionsPublished!: number;

  @int('Cierres de lote con faltante sin decidir')
  shortfallsOpen!: number;
}

export class DashboardChainOpenAlertsDto {
  @int() critical!: number;
  @int() warning!: number;
}

export class DashboardLastReconciliationDto {
  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({
    enum: RECONCILIATION_STATUSES,
    enumName: 'ReconciliationStatus',
  })
  status!: (typeof RECONCILIATION_STATUSES)[number];
}

/** Cadena (contrato O3 §11). */
export class DashboardChainDto {
  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({
    example: '9873.4512300',
    description:
      'Saldo de la cuenta de operaciones en XLM (`"0.0000000"` mientras no se haya leído de la red)',
  })
  operationsBalanceXlm!: string;

  @ApiProperty({ example: '12.0000000' })
  anchorBalanceXlm!: string;

  @int('Transacciones `FAILED` sin abandonar')
  failedTransactions!: number;

  @int('Transacciones `SUBMITTED` o `RETRYING` desde hace más de 15 min')
  stuckTransactions!: number;

  @ApiProperty({ type: () => DashboardChainOpenAlertsDto })
  openAlerts!: DashboardChainOpenAlertsDto;

  @ApiProperty({ type: () => DashboardLastReconciliationDto, nullable: true })
  lastReconciliation!: DashboardLastReconciliationDto | null;

  @int('Retraso del indexador de eventos, en segundos (0 sin cursor)')
  indexerLagSeconds!: number;
}

export class DashboardAlertDto {
  @ApiProperty({
    example: 'applications-unassigned',
    description: 'Estable por tipo de alerta',
  })
  id!: string;

  @ApiProperty({ enum: ['INFO', 'WARNING', 'CRITICAL'] })
  level!: 'INFO' | 'WARNING' | 'CRITICAL';

  @ApiProperty()
  message!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '/solicitudes',
    description: 'Ruta sugerida dentro del back office',
  })
  link!: string | null;
}

/** `GET /v1/platform/dashboard` (contrato O1 §8). */
export class DashboardDto {
  @ApiProperty({ type: DashboardApplicationsDto })
  applications!: DashboardApplicationsDto;

  @ApiProperty({ type: DashboardWineriesDto })
  wineries!: DashboardWineriesDto;

  @ApiProperty({ type: DashboardInvitationsDto })
  invitations!: DashboardInvitationsDto;

  @ApiProperty({ type: DashboardTeamDto })
  team!: DashboardTeamDto;

  @ApiProperty({
    type: DashboardWaitlistDto,
    description: 'Lista de espera (contrato O1b §2)',
  })
  waitlist!: DashboardWaitlistDto;

  @ApiProperty({
    type: DashboardTokenizationDto,
    description: 'Tokenización (contrato O3 §11)',
  })
  tokenization!: DashboardTokenizationDto;

  @ApiProperty({
    type: DashboardChainDto,
    description: 'Cadena (contrato O3 §11)',
  })
  chain!: DashboardChainDto;

  @ApiProperty({ type: DashboardAlertDto, isArray: true })
  alerts!: DashboardAlertDto[];

  @ApiProperty({
    type: AuditEventDto,
    isArray: true,
    maxItems: 5,
    description: 'Los 5 eventos más recientes de la bitácora',
  })
  recentAudit!: AuditEventDto[];
}
