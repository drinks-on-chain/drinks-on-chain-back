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
  ApiNotImplementedO3,
  ApiRoleForbidden,
  ApiRuleErrors,
  notImplementedO3,
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
  @ApiNotImplementedO3('3.1')
  listTransactions(
    @Query() _query: ChainTransactionsQueryDto,
  ): Promise<Paginated<ChainTransactionDto>> {
    throw notImplementedO3('3.1');
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
  @ApiNotImplementedO3('3.1')
  getTransaction(
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<ChainTransactionDto> {
    throw notImplementedO3('3.1');
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
    'CHN_TX_NOT_RETRYABLE (estado distinto de `FAILED`; `meta.status`)',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  @ApiNotImplementedO3('3.1')
  retryTransaction(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ChainActionDto,
  ): Promise<ChainTransactionDto> {
    throw notImplementedO3('3.1');
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
    'CHN_TX_NOT_ABANDONABLE (`MINT_BATCH`, `ANCHOR_DOSSIER`, `CREATE_WINERY_ACCOUNT`, `DEPLOY_WINERY_CONTRACT`; `meta.kind`)',
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  @ApiNotImplementedO3('3.1')
  abandonTransaction(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ChainActionDto,
  ): Promise<ChainTransactionDto> {
    throw notImplementedO3('3.1');
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
  @ApiNotImplementedO3('3.1')
  accounts(): Promise<PlatformChainAccountsDto> {
    throw notImplementedO3('3.1');
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
  @ApiNotImplementedO3('3.6')
  listEvents(
    @Query() _query: ChainEventsQueryDto,
  ): Promise<Paginated<ChainEventDto>> {
    throw notImplementedO3('3.6');
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
  @ApiNotImplementedO3('3.6')
  listRuns(
    @Query() _query: ReconciliationRunsQueryDto,
  ): Promise<Paginated<ReconciliationRunDto>> {
    throw notImplementedO3('3.6');
  }

  @Get('reconciliation/runs/:id')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Una conciliación con sus alertas' })
  @ApiOkResponse({ type: ReconciliationRunDetailDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['NOT_FOUND'])
  @ApiNotImplementedO3('3.6')
  getRun(
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<ReconciliationRunDetailDto> {
    throw notImplementedO3('3.6');
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
  ])
  @ApiRuleErrors()
  @ApiNotImplementedO3('3.6')
  startRun(
    @Body() _dto: StartReconciliationDto,
  ): Promise<ReconciliationRunDto> {
    throw notImplementedO3('3.6');
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
  @ApiNotImplementedO3('3.6')
  listAlerts(
    @Query() _query: ChainAlertsQueryDto,
  ): Promise<Paginated<ChainAlertDto>> {
    throw notImplementedO3('3.6');
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
  @ApiNotImplementedO3('3.6')
  resolveAlert(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ResolveChainAlertDto,
  ): Promise<ChainAlertDto> {
    throw notImplementedO3('3.6');
  }
}
