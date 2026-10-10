import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { ChainSettings } from '../chain.config';
import {
  DerivationIndexAllocator,
  DerivationIndexLookup,
  EnvKeyCustody,
} from './env-key-custody';
import { DisabledKeyCustody, KeyCustody } from './key-custody';
import { LocalKeyCustody } from './local-key-custody';
import { deriveSep5Address, masterSeedFromSecret } from './sep5';

/** Índice de derivación de una clave de bodega, leído de `chain_accounts`. */
export function derivationIndexFromDatabase(
  prisma: PrismaService,
  network: ChainSettings['network'],
): DerivationIndexLookup {
  return async (ref) => {
    const account = await prisma.chainAccount.findUnique({
      where: { network_custodyKeyRef: { network, custodyKeyRef: ref } },
      select: { derivationIndex: true },
    });
    return account?.derivationIndex ?? null;
  };
}

/**
 * Siguiente índice de derivación libre de la red para la cuenta `ref` (S-1):
 * bajo candado, uno más que el mayor asignado; nunca se reutiliza.
 */
export function derivationIndexAllocator(
  prisma: PrismaService,
  network: ChainSettings['network'],
): DerivationIndexAllocator {
  return (ref) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-derivation:${network}`}))`;
      const account = await tx.chainAccount.findUnique({
        where: { network_custodyKeyRef: { network, custodyKeyRef: ref } },
        select: { id: true, derivationIndex: true },
      });
      if (!account) return null;
      if (account.derivationIndex !== null) return account.derivationIndex;
      const last = await tx.chainAccount.aggregate({
        where: { network },
        _max: { derivationIndex: true },
      });
      const derivationIndex = (last._max.derivationIndex ?? -1) + 1;
      await tx.chainAccount.update({
        where: { id: account.id },
        data: { derivationIndex },
      });
      return derivationIndex;
    });
}

/**
 * Comprobación de la semilla de consumidores al arrancar (contrato O3 §4,
 * S-9): el índice 0, reservado, debe dar `CHAIN_CONSUMER_SEED_CHECK_ADDRESS`.
 * Si no coincide, el worker no arranca: evita emitir a direcciones de una
 * semilla equivocada. Con alguna de las dos sin definir no hay nada que
 * comprobar (las direcciones de consumidor llegan con la Ola 4).
 */
export function assertConsumerSeed(
  seed: string | null | undefined,
  checkAddress: string | null,
): void {
  if (!seed?.trim() || !checkAddress) return;
  let derived: string;
  try {
    derived = deriveSep5Address(masterSeedFromSecret(seed), 0);
  } catch {
    // Sin el error original: su mensaje podría repetir el valor
    throw new Error('CHAIN_CONSUMER_MASTER_SEED no es una semilla válida');
  }
  if (derived !== checkAddress) {
    throw new Error(
      'CHAIN_CONSUMER_SEED_CHECK_ADDRESS no corresponde a CHAIN_CONSUMER_MASTER_SEED: el worker no arranca con una semilla de consumidores distinta de la esperada',
    );
  }
}

/**
 * Custodio según `CHAIN_CUSTODY_DRIVER`. Sin driver, uno deshabilitado: la
 * aplicación arranca y cualquier intento de usar una clave falla con
 * `CUSTODY_DISABLED`. Los secretos del driver `ENV` se leen aquí y solo viven
 * dentro del custodio.
 */
export function createKeyCustody(
  settings: ChainSettings,
  config: ConfigService,
  prisma: PrismaService,
): KeyCustody {
  switch (settings.custodyDriver) {
    case 'LOCAL':
      return new LocalKeyCustody();
    case 'ENV':
      assertConsumerSeed(
        config.get<string>('CHAIN_CONSUMER_MASTER_SEED'),
        settings.consumerSeedCheckAddress,
      );
      return new EnvKeyCustody(
        {
          operations: config.get<string>('CHAIN_SECRET_OPERATIONS'),
          anchor: config.get<string>('CHAIN_SECRET_ANCHOR'),
          winerySeed: config.get<string>('CHAIN_DEV_WINERY_SEED'),
        },
        derivationIndexFromDatabase(prisma, settings.network),
        derivationIndexAllocator(prisma, settings.network),
      );
    default:
      return new DisabledKeyCustody();
  }
}
