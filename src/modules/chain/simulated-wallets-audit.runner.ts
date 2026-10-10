import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { PrismaService } from '@shared/prisma/prisma.service';

/** Candado de transacción para que dos réplicas no escriban la entrada a la vez. */
const RUNNER_LOCK_KEY = 4_155_444_955;

export const SIMULATED_WALLETS_MIGRATION = '20261008120000_o3_cadena_expand';

export interface SimulatedWalletsInvalidation {
  userWallets: number;
  wineries: number;
}

/**
 * SE-02 (contrato O3 §3.3, paso 6): entrada `CHAIN_SIMULATED_WALLETS_INVALIDATED`
 * de la bitácora, con el número de filas que la migración `o3_cadena_expand`
 * dejó inválidas. La escribe la API al arrancar, una sola vez: la bitácora va
 * encadenada por hash y no se puede escribir desde el SQL de la migración.
 * En una base sin billeteras simuladas (nueva) no escribe nada.
 */
@Injectable()
export class SimulatedWalletsAuditRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(SimulatedWalletsAuditRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const recorded = await this.run();
      if (recorded) {
        this.logger.log(
          `SE-02: ${recorded.userWallets} billeteras y ${recorded.wineries} bodegas con direcciones simuladas invalidadas, anotado en la bitácora`,
        );
      }
    } catch (error) {
      // Nunca impide arrancar: se reintenta en el siguiente arranque
      this.logger.warn(
        `No se pudo anotar CHAIN_SIMULATED_WALLETS_INVALIDATED: ${(error as Error).message}`,
      );
    }
  }

  /** Devuelve lo anotado, o `null` si ya estaba o no había nada que anotar. */
  async run(): Promise<SimulatedWalletsInvalidation | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUNNER_LOCK_KEY}::bigint)`;
      const existing = await tx.auditEvent.findFirst({
        where: { action: AuditAction.CHAIN_SIMULATED_WALLETS_INVALIDATED },
        select: { id: true },
      });
      if (existing) return null;
      const [userWallets, wineries] = await Promise.all([
        tx.userWallet.count({ where: { status: 'INVALID_SIMULATED' } }),
        tx.winery.count({
          where: { legacySimulatedData: { not: Prisma.DbNull } },
        }),
      ]);
      if (userWallets + wineries === 0) return null;
      await this.audit.record(tx, {
        action: AuditAction.CHAIN_SIMULATED_WALLETS_INVALIDATED,
        resource: { type: 'chain', id: null },
        actor: null,
        after: {
          userWallets,
          wineries,
          migration: SIMULATED_WALLETS_MIGRATION,
        },
        reason:
          'SE-02: las direcciones simuladas (sin clave) dejan de usarse; las cuentas reales las crea la Ola 3',
      });
      return { userWallets, wineries };
    }, AUDIT_TX_OPTIONS);
  }
}
