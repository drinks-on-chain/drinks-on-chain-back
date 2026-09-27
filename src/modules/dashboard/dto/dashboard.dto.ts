import { ApiProperty } from '@nestjs/swagger';
import { AuditEventDto } from '@modules/audit/dto/audit-event.dto';

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
