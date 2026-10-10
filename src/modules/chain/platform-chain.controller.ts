import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { RequiresReason } from '@shared/audit/requires-reason';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { platformRolesWith } from '@modules/platform-users/permissions';
import {
  ApiErrorCodes,
  ApiRoleForbidden,
  ApiRuleErrors,
} from './contract/o3-contract';
import {
  ChainActionDto,
  ChainAlertDto,
  ChainAlertsQueryDto,
  ChainEventDto,
  ChainEventsQueryDto,
  ChainTransactionDto,
  ChainTransactionsQueryDto,
  PlatformChainAccountsDto,
  ReconciliationRunDetailDto,
  ReconciliationRunDto,
  ReconciliationRunsQueryDto,
  ResolveChainAlertDto,
  StartReconciliationDto,
} from './dto/chain.dto';
import { PlatformAccountsService } from './accounts/platform-accounts.service';
import { ChainMonitoringService } from './monitoring/chain-monitoring.service';
import { ChainTransactionsService } from './tx/chain-transactions.service';

/** Ver: administración, operaciones y soporte. */
const READERS = platformRolesWith('chain', 'FULL', 'READ');
/** Reintentar, lanzar la conciliación y resolver alertas: administración y operaciones. */
const OPERATORS = platformRolesWith('chain', 'FULL');
/** Abandonar una transacción: administración. */
const ADMINS = platformRolesWith('chain.admin', 'FULL');

/**
 * Back office · cadena (contrato O3 §2.4, §8.1 y §8.2; CHN-05, CHN-06,
 * CHN-11, CHN-12). Ninguna ruta recibe una transacción ya construida ni firma
 * nada: registran intenciones que el worker valida, firma y envía.
 */
@ApiTags('Chain')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/chain')
export class PlatformChainController {
  constructor(
    private readonly transactions: ChainTransactionsService,
    private readonly platformAccounts: PlatformAccountsService,
    private readonly monitoring: ChainMonitoringService,
  ) {}

  // ── Transacciones (§2.4) ─────────────────────────────────────────────────

  @Get('transactions')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Transacciones de la cadena',
    description:
      'Contrato O3 §2.4. Orden `-createdAt`. Filtros: `status`, `kind`, `wineryId`, `subjectType`, `subjectId`, ' +
      '`from` y `to` (fecha de creación).',
  })
  @ApiPaginatedResponse(ChainTransactionDto)
  @ApiRoleForbidden()
  @ApiRuleErrors()
  listTransactions(
    @Query() query: ChainTransactionsQueryDto,
  ): Promise<Paginated<ChainTransactionDto>> {
    return this.transactions.list(query);
  }

  @Get('transactions/:id')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Transacción con su historial de intentos',
    description: 'Contrato O3 §2.3 y §2.4.',
  })
  @ApiOkResponse({ type: ChainTransactionDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['CHN_TX_NOT_FOUND'])
  getTransaction(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChainTransactionDto> {
    return this.transactions.detail(id);
  }

  @Post('transactions/:id/retry')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @Idempotent({ required: true })
  @RequiresReason()
  @ApiOperation({
    summary: 'Reintentar una transacción fallida',
    description:
      'Contrato O3 §2.4: `FAILED → PENDING`; el worker la reconstruye con secuencia y comisión nuevas. ' +
      '`Idempotency-Key` obligatoria.',
  })
  @ApiOkResponse({ type: ChainTransactionDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['CHN_TX_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_TX_NOT_RETRYABLE (estado distinto de `FAILED` o abandonada; `meta.status`)',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  retryTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChainActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChainTransactionDto> {
    return this.transactions.retry(id, dto.reason, user);
  }

  @Post('transactions/:id/abandon')
  @HttpCode(HttpStatus.OK)
  @Roles(...ADMINS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Abandonar una transacción fallida',
    description:
      'Contrato O3 §2.4: deja constancia de que no se reintentará. Las emisiones, los anclajes y la identidad ' +
      'de una bodega deben terminar: no se abandonan.',
  })
  @ApiOkResponse({ type: ChainTransactionDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['CHN_TX_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_TX_NOT_ABANDONABLE (`MINT_BATCH`, `ANCHOR_DOSSIER`, `CREATE_WINERY_ACCOUNT`, `DEPLOY_WINERY_CONTRACT`, o estado distinto de `FAILED`; `meta.kind`, `meta.status`)',
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  abandonTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChainActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChainTransactionDto> {
    return this.transactions.abandon(id, dto.reason, user);
  }

  @Get('accounts')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Cuentas de la plataforma en la red y sus saldos',
    description:
      'Contrato O3 §2.4: cuenta de operaciones (paga comisiones y renta) y de anclaje, con su saldo, el mínimo ' +
      'configurado y el estado (`OK`, `LOW`, `MISSING`); código del contrato NFT y los días de vida que le quedan.',
  })
  @ApiOkResponse({ type: PlatformChainAccountsDto })
  @ApiRoleForbidden()
  accounts(): Promise<PlatformChainAccountsDto> {
    return this.platformAccounts.view();
  }

  // ── Indexador (§8.1) ─────────────────────────────────────────────────────

  @Get('events')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Eventos de los contratos leídos por el indexador',
    description:
      'Contrato O3 §8.1. `unmatched=true`: solo los que no originó el sistema (alerta `UNEXPECTED_EVENT`).',
  })
  @ApiPaginatedResponse(ChainEventDto)
  @ApiRoleForbidden()
  @ApiRuleErrors()
  listEvents(
    @Query() query: ChainEventsQueryDto,
  ): Promise<Paginated<ChainEventDto>> {
    return this.monitoring.events(query);
  }

  // ── Conciliación y alertas (§8.2) ────────────────────────────────────────

  @Get('reconciliation/runs')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Ejecuciones de la conciliación',
    description: 'Contrato O3 §8.2. Orden `-startedAt`.',
  })
  @ApiPaginatedResponse(ReconciliationRunDto)
  @ApiRoleForbidden()
  @ApiRuleErrors()
  listRuns(
    @Query() query: ReconciliationRunsQueryDto,
  ): Promise<Paginated<ReconciliationRunDto>> {
    return this.monitoring.listRuns(query);
  }

  @Get('reconciliation/runs/:id')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Una conciliación con sus alertas' })
  @ApiOkResponse({ type: ReconciliationRunDetailDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['NOT_FOUND'])
  getRun(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReconciliationRunDetailDto> {
    return this.monitoring.run(id);
  }

  @Post('reconciliation/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...OPERATORS)
  @ApiOperation({
    summary: 'Lanzar una conciliación',
    description:
      'Contrato O3 §8.2: `202` con la ejecución `RUNNING`; el worker compara la base con la red y abre alertas. ' +
      'Una diferencia nunca se corrige sola (S-19).',
  })
  @ApiAcceptedResponse({ type: ReconciliationRunDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_RECONCILIATION_RUNNING (ya hay una en curso para ese alcance; `meta.runId`)',
    'CHN_DISABLED (la cadena no está configurada en este entorno)',
  ])
  @ApiRuleErrors(['(`subjectId` no es un contrato o una colección existente)'])
  startRun(
    @Body() dto: StartReconciliationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReconciliationRunDto> {
    return this.monitoring.startRun(dto, user);
  }

  @Get('alerts')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Alertas de la cadena',
    description:
      'Contrato O3 §8.2. Por defecto, las abiertas (`status=open`), por nivel y antigüedad. Alimentan `alerts` ' +
      'del tablero.',
  })
  @ApiPaginatedResponse(ChainAlertDto)
  @ApiRoleForbidden()
  @ApiRuleErrors()
  listAlerts(
    @Query() query: ChainAlertsQueryDto,
  ): Promise<Paginated<ChainAlertDto>> {
    return this.monitoring.alerts(query);
  }

  @Post('alerts/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @ApiOperation({
    summary: 'Resolver una alerta',
    description: 'Contrato O3 §8.2: con una nota de lo comprobado.',
  })
  @ApiOkResponse({ type: ChainAlertDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.CONFLICT, ['CHN_ALERT_ALREADY_RESOLVED'])
  @ApiRuleErrors()
  resolveAlert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveChainAlertDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChainAlertDto> {
    return this.monitoring.resolveAlert(id, dto.note, user);
  }
}
