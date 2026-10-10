import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  HandlesJob,
  JobHandler,
  ScheduledTask,
} from '@shared/queue/job-handler';
import {
  QUEUE_CHAIN,
  QUEUE_CHAIN_POLL,
  QUEUE_DEFAULT,
} from '@shared/queue/queue.constants';
import {
  WINERY_STATUS_CHANGED,
  type WineryStatusChangedPayload,
} from '@modules/wineries/wineries.events';
import { AppLinks } from '@modules/mail/app-links';
import { MailService } from '@modules/mail/mail.service';
import { platformOperationsStaff } from '@modules/organizations/platform-staff';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { IDENTITY_TX_KINDS } from '../chain.constants';
import {
  CHAIN_ALERT_RAISED,
  CHAIN_ANCHOR_BACKFILL_JOB,
  CHAIN_BALANCE_CHECK_TASK,
  CHAIN_IDENTITY_BACKFILL_JOB,
  CHAIN_INDEXER_POLL_TASK,
  CHAIN_RECONCILE_FULL_TASK,
  CHAIN_RECONCILE_TASK,
  CHAIN_RECONCILIATION_REQUESTED,
  CHAIN_TESTNET_FUND_TASK,
  CHAIN_TTL_EXTEND_TASK,
  CHAIN_TTL_REVIEW_JOB,
  CHAIN_TX_CONFIRMED,
  CHAIN_TX_CONFIRM_JOB,
  CHAIN_TX_FAILED,
  CHAIN_TX_POLL_TASK,
  CHAIN_TX_PROCESS_JOB,
  CHAIN_TX_REQUESTED,
  WINERY_CHAIN_IDENTITY_READY,
  type ChainAlertRaisedPayload,
  type ChainReconciliationRequestedPayload,
  type ChainTxEventPayload,
  type ChainTxFailedPayload,
  type ChainTxJobData,
  type WineryChainIdentityReadyPayload,
} from '../chain.events';
import { DossierAnchorService } from '../anchor/dossier-anchor.service';
import { ChainJobsQueue } from './chain-jobs.queue';
import { ChainTxSweeper } from './chain-tx.sweeper';
import { ChainIndexer } from './indexer/chain-indexer.service';
import { PlatformAccountsSync } from './platform-accounts.sync';
import { ChainReconciler } from './reconcile/chain-reconciler.service';
import { ChainTtlService } from './ttl/chain-ttl.service';
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

/** Tipos que dejan entradas nuevas en el contrato: se revisa su TTL (§8.3). */
const TTL_REVIEW_AFTER: readonly string[] = [
  'MINT_BATCH',
  'BURN_UNSOLD',
  'DEPLOY_WINERY_CONTRACT',
];

/**
 * `chain.tx.confirmed`: una cuenta de la plataforma recién fondeada relanza
 * los rellenos que la esperaban; una emisión, una quema o un despliegue
 * dejan entradas con el TTL mínimo de la red (7 días en testnet) y se
 * revisan en seguida, sin esperar a la tarea diaria; una restauración
 * despierta a la transacción que la pidió.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TX_CONFIRMED)
export class ChainTxConfirmedHandler implements JobHandler<
  OutboxJobData<ChainTxEventPayload>
> {
  constructor(
    private readonly jobs: ChainJobsQueue,
    private readonly prisma: PrismaService,
    private readonly accounts: PlatformAccountsSync,
  ) {}

  async handle(data: OutboxJobData<ChainTxEventPayload>): Promise<void> {
    const { kind, transactionId } = data.payload;
    if (kind === 'FUND_ACCOUNT') {
      // Saldo nuevo: la alerta `LOW_BALANCE` de la cuenta se cierra ya
      await this.accounts.checkBalances().catch(() => undefined);
      await this.jobs.backfill();
      await this.jobs.anchorBackfill();
    }
    if (TTL_REVIEW_AFTER.includes(kind)) await this.jobs.ttlReview(2_000);
    if (kind === 'RESTORE_ENTRIES') {
      const restore = await this.prisma.chainTransaction.findUnique({
        where: { id: transactionId },
        select: { intent: true },
      });
      const waiting = (restore?.intent as { forTransactionId?: unknown })
        ?.forTransactionId;
      if (typeof waiting === 'string') await this.jobs.process(waiting);
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
 * `chain.alert.raised` (§8.2 y §11): queda en el log con su nivel y, si es
 * `CRITICAL`, se avisa por correo a administración y operaciones (un correo
 * por persona y alerta: reprocesar el evento no lo repite). La alerta se ve
 * y se resuelve en el back office.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_ALERT_RAISED)
export class ChainAlertRaisedHandler implements JobHandler<
  OutboxJobData<ChainAlertRaisedPayload>
> {
  private readonly logger = new Logger('ChainAlert');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async handle(data: OutboxJobData<ChainAlertRaisedPayload>): Promise<void> {
    const { alertId, code, level, wineryId } = data.payload;
    const entry = {
      message: `Alerta de la cadena ${level}: ${code}`,
      alertId,
      code,
      level,
      wineryId,
    };
    if (level !== 'CRITICAL') {
      this.logger.warn(entry);
      return;
    }
    this.logger.error(entry);
    const alert = await this.prisma.chainAlert.findUnique({
      where: { id: alertId },
    });
    // Ya cerrada (su causa desapareció antes de avisar): nada que revisar
    if (!alert || alert.resolvedAt !== null) return;
    await this.prisma.$transaction(async (tx) => {
      for (const staff of await platformOperationsStaff(tx)) {
        await this.mail.enqueue(tx, {
          template: 'alerta-cadena',
          to: staff.email,
          idempotencyKey: `chain-alert:${alert.id}:${staff.email}`,
          organizationId: alert.wineryId,
          variables: {
            nombre: staff.fullName,
            codigo: alert.code,
            red: this.settings.network,
            mensaje: alert.message,
            detectada: alert.detectedAt.toISOString(),
            enlace: this.links.base('BACKOFFICE'),
          },
        });
      }
    });
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
 * contrato en la red (§3.5). Suspender y reactivar no tocan la red (S-8),
 * pero al **reactivarse** se despiertan sus emisiones en espera
 * (`CHN_WINERY_NOT_ACTIVE`), sin esperar al barrido.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_STATUS_CHANGED)
export class WineryStatusChangedHandler implements JobHandler<
  OutboxJobData<WineryStatusChangedPayload>
> {
  constructor(
    private readonly provisioner: WineryIdentityProvisioner,
    private readonly prisma: PrismaService,
    private readonly jobs: ChainJobsQueue,
  ) {}

  async handle(data: OutboxJobData<WineryStatusChangedPayload>): Promise<void> {
    const { wineryId, to, auditEventId } = data.payload;
    if (to === 'REVOKED') {
      await this.provisioner.pauseRevoked(wineryId, auditEventId);
    }
    if (to === 'ACTIVE') {
      const held = await this.prisma.chainTransaction.findMany({
        where: {
          wineryId,
          kind: 'MINT_BATCH',
          status: 'PENDING',
          abandonedAt: null,
          lastError: { path: ['code'], equals: 'CHN_WINERY_NOT_ACTIVE' },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      for (const { id } of held) await this.jobs.process(id);
    }
  }
}

// ── Mantenimiento, indexador y conciliación (§8) ────────────────────────────

/** `chain.ttl.review`: revisión del TTL fuera de su hora (tras una emisión). */
@Injectable()
@HandlesJob(QUEUE_CHAIN, CHAIN_TTL_REVIEW_JOB)
export class ChainTtlReviewHandler implements JobHandler {
  constructor(private readonly ttl: ChainTtlService) {}

  async handle(): Promise<void> {
    await this.ttl.run();
  }
}

/**
 * `chain.reconciliation.requested` (outbox): una conciliación lanzada desde
 * el back office o por un hueco del indexador. Va por la cola `default`: lee
 * mucho de la red y no debe frenar al firmante.
 */
@Injectable()
@HandlesJob(QUEUE_DEFAULT, CHAIN_RECONCILIATION_REQUESTED)
export class ChainReconciliationRequestedHandler implements JobHandler<
  OutboxJobData<ChainReconciliationRequestedPayload>
> {
  constructor(private readonly reconciler: ChainReconciler) {}

  async handle(
    data: OutboxJobData<ChainReconciliationRequestedPayload>,
  ): Promise<void> {
    await this.reconciler.execute(data.payload.runId);
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

@Injectable()
@ScheduledTask({
  name: CHAIN_INDEXER_POLL_TASK,
  every: 60_000,
  quiet: true,
  description:
    'Indexador: eventos de los contratos desde el cursor guardado (§8.1)',
})
export class ChainIndexerPollTask implements JobHandler {
  constructor(private readonly indexer: ChainIndexer) {}

  async handle(): Promise<void> {
    await this.indexer.poll();
  }
}

@Injectable()
@ScheduledTask({
  name: CHAIN_RECONCILE_TASK,
  every: 60 * 60_000,
  description: 'Conciliación ligera de la base con la red (§8.2)',
})
export class ChainReconcileTask implements JobHandler {
  constructor(private readonly reconciler: ChainReconciler) {}

  async handle(): Promise<void> {
    await this.reconciler.runNow('LIGHT');
  }
}

@Injectable()
@ScheduledTask({
  name: CHAIN_RECONCILE_FULL_TASK,
  // 02:30 America/La_Paz (UTC-4, sin horario de verano) = 06:30 UTC
  pattern: '30 6 * * *',
  description: 'Conciliación completa, a las 02:30 de La Paz (§8.2)',
})
export class ChainReconcileFullTask implements JobHandler {
  constructor(private readonly reconciler: ChainReconciler) {}

  async handle(): Promise<void> {
    await this.reconciler.runNow('FULL');
  }
}

@Injectable()
@ScheduledTask({
  name: CHAIN_TTL_EXTEND_TASK,
  // 03:00 America/La_Paz = 07:00 UTC
  pattern: '0 7 * * *',
  description:
    'Extiende a 120 días las entradas de los contratos y el código que bajen del umbral (§8.3)',
})
export class ChainTtlExtendTask implements JobHandler {
  constructor(private readonly ttl: ChainTtlService) {}

  async handle(): Promise<void> {
    await this.ttl.run();
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
  ChainTtlReviewHandler,
  ChainReconciliationRequestedHandler,
  ChainTxPollTask,
  ChainBalanceCheckTask,
  ChainTestnetFundTask,
  ChainIndexerPollTask,
  ChainReconcileTask,
  ChainReconcileFullTask,
  ChainTtlExtendTask,
];
