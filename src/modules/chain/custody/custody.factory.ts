import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { ChainSettings } from '../chain.config';
import { DerivationIndexLookup, EnvKeyCustody } from './env-key-custody';
import { DisabledKeyCustody, KeyCustody } from './key-custody';
import { LocalKeyCustody } from './local-key-custody';

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
      return new EnvKeyCustody(
        {
          operations: config.get<string>('CHAIN_SECRET_OPERATIONS'),
          anchor: config.get<string>('CHAIN_SECRET_ANCHOR'),
          winerySeed: config.get<string>('CHAIN_DEV_WINERY_SEED'),
        },
        derivationIndexFromDatabase(prisma, settings.network),
      );
    default:
      return new DisabledKeyCustody();
  }
}
