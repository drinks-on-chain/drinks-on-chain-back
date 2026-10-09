import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { ChainJobsQueue } from './chain-jobs.queue';
import { PlatformAccountsSync } from './platform-accounts.sync';

/** Intentos del arranque si la red o la base fallan justo entonces. */
const START_ATTEMPTS = 3;
const START_RETRY_MS = 2_000;

/**
 * Arranque de la cadena en el worker: registra las cuentas de la plataforma,
 * lee sus saldos, pide Friendbot si hace falta (solo `TESTNET` y `LOCAL`) y
 * lanza el relleno de identidades (§3.3 paso 4). No bloquea el arranque ni lo
 * rompe si la red no responde: las tareas programadas lo repiten.
 */
@Injectable()
export class ChainBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChainBootstrap.name);
  private startup: Promise<void> = Promise.resolve();

  constructor(
    private readonly accounts: PlatformAccountsSync,
    private readonly jobs: ChainJobsQueue,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  onApplicationBootstrap(): void {
    const { enabled, network, custodyDriver, mintEnabled } = this.settings;
    this.logger.log(
      enabled
        ? `Cadena habilitada: red ${network}, custodio ${custodyDriver}, emisión ${mintEnabled ? 'activa' : 'apagada (CHAIN_MINT_ENABLED=false)'}`
        : 'Cadena deshabilitada: faltan CHAIN_CUSTODY_DRIVER o STELLAR_RPC_URL',
    );
    if (enabled) this.startup = this.start();
  }

  /** Termina cuando acabó el arranque (lo esperan las pruebas). */
  ready(): Promise<void> {
    return this.startup;
  }

  private async start(): Promise<void> {
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
      try {
        const synced = await this.accounts.syncAddresses();
        this.logger.log({
          message: 'Cuentas de la plataforma registradas',
          accounts: synced,
        });
        const funded = await this.accounts.fundIfNeeded();
        if (funded.length > 0) {
          this.logger.log(`Friendbot pedido para: ${funded.join(', ')}`);
        }
        break;
      } catch (error) {
        this.logger.warn(
          `Arranque de la cadena incompleto (intento ${attempt}/${START_ATTEMPTS}; las tareas programadas lo repiten): ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
        );
        if (attempt < START_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
        }
      }
    }
    await this.jobs.backfill();
  }
}
