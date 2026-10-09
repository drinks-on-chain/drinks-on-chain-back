import { Injectable, Logger } from '@nestjs/common';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import {
  HandlesJob,
  JobHandler,
  ScheduledTask,
} from '@shared/queue/job-handler';
import { QUEUE_CHAIN, QUEUE_CHAIN_POLL } from '@shared/queue/queue.constants';
import {
  WINERY_STATUS_CHANGED,
  type WineryStatusChangedPayload,
} from '@modules/wineries/wineries.events';
import { IDENTITY_TX_KINDS } from '../chain.constants';
import {
  CHAIN_ALERT_RAISED,
  CHAIN_ANCHOR_BACKFILL_JOB,
  CHAIN_BALANCE_CHECK_TASK,
  CHAIN_IDENTITY_BACKFILL_JOB,
  CHAIN_TESTNET_FUND_TASK,
  CHAIN_TX_CONFIRMED,
  CHAIN_TX_CONFIRM_JOB,
  CHAIN_TX_FAILED,
  CHAIN_TX_POLL_TASK,
  CHAIN_TX_PROCESS_JOB,
  CHAIN_TX_REQUESTED,
  WINERY_CHAIN_IDENTITY_READY,
  type ChainAlertRaisedPayload,
  type ChainTxEventPayload,
  type ChainTxFailedPayload,
  type ChainTxJobData,
  type WineryChainIdentityReadyPayload,
} from '../chain.events';
import { DossierAnchorService } from '../anchor/dossier-anchor.service';
import { ChainJobsQueue } from './chain-jobs.queue';
import { ChainTxSweeper } from './chain-tx.sweeper';
import { PlatformAccountsSync } from './platform-accounts.sync';
import { ChainSigner } from './signer/chain-signer.service';
import { WineryIdentityProvisioner } from './winery-identity.provisioner';

// ── Cola `chain`: el firmante ───────────────────────────────────────────────

/** `chain.tx.requested` (outbox): una intención recién registrada. */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TX_REQUESTED)
export class ChainTxRequestedHandler implements JobHandler<
  OutboxJobData<ChainTxEventPayload>
> {
  constructor(private readonly signer: ChainSigner) {}

  async handle(data: OutboxJobData<ChainTxEventPayload>): Promise<void> {
    await this.signer.process(data.payload.transactionId);
  }
}

/** Reintento o turno de una transacción que ya existe. */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TX_PROCESS_JOB)
export class ChainTxProcessHandler implements JobHandler<ChainTxJobData> {
  constructor(private readonly signer: ChainSigner) {}

  async handle(data: ChainTxJobData): Promise<void> {
    await this.signer.process(data.transactionId);
  }
}

// ── Cola `chain-poll`: confirmaciones ───────────────────────────────────────

@Injectable()
@HandlesJob(QUEUE_CHAIN_POLL, CHAIN_TX_CONFIRM_JOB)
export class ChainTxConfirmHandler implements JobHandler<ChainTxJobData> {
  constructor(private readonly signer: ChainSigner) {}

  async handle(data: ChainTxJobData): Promise<void> {
    await this.signer.poll(data.transactionId);
  }
}

// ── Eventos publicados por la cadena ────────────────────────────────────────

/**
 * `chain.tx.confirmed`: los pasos 3.4–3.6 enganchan aquí sus efectos
 * (emisión, anclaje). Hoy, una cuenta de la plataforma recién fondeada
 * relanza el relleno de identidades que la esperaba.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TX_CONFIRMED)
export class ChainTxConfirmedHandler implements JobHandler<
  OutboxJobData<ChainTxEventPayload>
> {
  constructor(private readonly jobs: ChainJobsQueue) {}

  async handle(data: OutboxJobData<ChainTxEventPayload>): Promise<void> {
    if (data.payload.kind === 'FUND_ACCOUNT') {
      await this.jobs.backfill();
      await this.jobs.anchorBackfill();
    }
  }
}

/** `chain.tx.failed`: si era de una identidad, el relleno sigue con otra. */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TX_FAILED)
export class ChainTxFailedHandler implements JobHandler<
  OutboxJobData<ChainTxFailedPayload>
> {
  constructor(private readonly jobs: ChainJobsQueue) {}

  async handle(data: OutboxJobData<ChainTxFailedPayload>): Promise<void> {
    if ((IDENTITY_TX_KINDS as readonly string[]).includes(data.payload.kind)) {
      await this.jobs.backfill();
    }
  }
}

/**
 * `chain.alert.raised`: queda en el log con su nivel. El correo a operaciones
 * de las `CRITICAL` y la bandeja llegan con el paso 3.6.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_ALERT_RAISED)
export class ChainAlertRaisedHandler implements JobHandler<
  OutboxJobData<ChainAlertRaisedPayload>
> {
  private readonly logger = new Logger('ChainAlert');

  handle(data: OutboxJobData<ChainAlertRaisedPayload>): Promise<void> {
    const { alertId, code, level, wineryId } = data.payload;
    const entry = {
      message: `Alerta de la cadena ${level}: ${code}`,
      alertId,
      code,
      level,
      wineryId,
    };
    if (level === 'CRITICAL') this.logger.error(entry);
    else this.logger.warn(entry);
    return Promise.resolve();
  }
}

/** `winery.chain_identity_ready`: el relleno pasa a la siguiente bodega. */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_CHAIN_IDENTITY_READY)
export class WineryChainIdentityReadyHandler implements JobHandler<
  OutboxJobData<WineryChainIdentityReadyPayload>
> {
  private readonly logger = new Logger(WineryChainIdentityReadyHandler.name);

  constructor(private readonly jobs: ChainJobsQueue) {}

  async handle(
    data: OutboxJobData<WineryChainIdentityReadyPayload>,
  ): Promise<void> {
    const { wineryId, network, account, contract } = data.payload;
    this.logger.log({
      message: 'Identidad de la bodega lista en la red',
      wineryId,
      network,
      account,
      contract,
    });
    await this.jobs.backfill();
  }
}

// ── Identidad ───────────────────────────────────────────────────────────────

/** `chain.identity.backfill`: al arrancar, bajo demanda y tras cada identidad. */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_IDENTITY_BACKFILL_JOB)
export class ChainIdentityBackfillHandler implements JobHandler {
  constructor(private readonly provisioner: WineryIdentityProvisioner) {}

  async handle(): Promise<void> {
    await this.provisioner.backfillNext();
  }
}

/**
 * `chain.anchor.backfill` (§7.1): al arrancar y bajo demanda, ancla los
 * expedientes cerrados que no tienen anclaje, por tandas.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_ANCHOR_BACKFILL_JOB)
export class ChainAnchorBackfillHandler implements JobHandler {
  constructor(
    private readonly anchors: DossierAnchorService,
    private readonly jobs: ChainJobsQueue,
  ) {}

  async handle(): Promise<void> {
    const { more } = await this.anchors.backfill();
    if (more) await this.jobs.anchorBackfill(1_000);
  }
}

/**
 * `winery.status_changed` (O1, aditivo): una bodega **revocada** pausa su
 * contrato en la red (§3.5). Suspender y reactivar no tocan la red (S-8); lo
 * que hagan con las colecciones y las solicitudes llega con los pasos 3.3 y
 * 3.4, que amplían este procesador.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_STATUS_CHANGED)
export class WineryStatusChangedHandler implements JobHandler<
  OutboxJobData<WineryStatusChangedPayload>
> {
  constructor(private readonly provisioner: WineryIdentityProvisioner) {}

  async handle(data: OutboxJobData<WineryStatusChangedPayload>): Promise<void> {
    const { wineryId, to, auditEventId } = data.payload;
    if (to === 'REVOKED') {
      await this.provisioner.pauseRevoked(wineryId, auditEventId);
    }
  }
}

// ── Tareas programadas (§11) ────────────────────────────────────────────────

@Injectable()
@ScheduledTask({
  name: CHAIN_TX_POLL_TASK,
  every: 5_000,
  quiet: true,
  description:
    'Sondea las transacciones enviadas y despierta las que esperan turno o reintento',
})
export class ChainTxPollTask implements JobHandler {
  constructor(private readonly sweeper: ChainTxSweeper) {}

  async handle(): Promise<void> {
    await this.sweeper.sweep();
  }
}

@Injectable()
@ScheduledTask({
  name: CHAIN_BALANCE_CHECK_TASK,
  every: 15 * 60_000,
  description: 'Saldos de las cuentas de operaciones y de anclaje',
})
export class ChainBalanceCheckTask implements JobHandler {
  constructor(private readonly accounts: PlatformAccountsSync) {}

  async handle(): Promise<void> {
    await this.accounts.checkBalances();
  }
}

@Injectable()
@ScheduledTask({
  name: CHAIN_TESTNET_FUND_TASK,
  every: 15 * 60_000,
  description:
    'Solo TESTNET y LOCAL: Friendbot si operaciones o anclaje bajan del mínimo',
})
export class ChainTestnetFundTask implements JobHandler {
  constructor(private readonly accounts: PlatformAccountsSync) {}

  async handle(): Promise<void> {
    await this.accounts.fundIfNeeded();
  }
}

export const CHAIN_JOB_HANDLERS = [
  ChainTxRequestedHandler,
  ChainTxProcessHandler,
  ChainTxConfirmHandler,
  ChainTxConfirmedHandler,
  ChainTxFailedHandler,
  ChainAlertRaisedHandler,
  WineryChainIdentityReadyHandler,
  ChainIdentityBackfillHandler,
  ChainAnchorBackfillHandler,
  WineryStatusChangedHandler,
  ChainTxPollTask,
  ChainBalanceCheckTask,
  ChainTestnetFundTask,
];
