import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '@shared/audit/audit.service';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { MailModule } from '@modules/mail/mail.module';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ChainCoreModule } from '../chain-core.module';
import { CHAIN_SETTINGS } from '../chain.config';
import { createKeyCustody } from '../custody/custody.factory';
import { KEY_CUSTODY } from '../custody/key-custody';
import { ChainBootstrap } from './chain-bootstrap.service';
import { CHAIN_JOB_HANDLERS } from './chain-jobs.handlers';
import { ChainJobsQueue } from './chain-jobs.queue';
import { ChainTxLifecycle } from './chain-tx-lifecycle.service';
import { ChainTxSweeper } from './chain-tx.sweeper';
import { CHAIN_GATEWAY } from './gateway/chain-gateway';
import { createChainGateway } from './gateway/stellar-chain-gateway';
import { AnchorDossierHandler } from './handlers/anchor-dossier.handler';
import {
  PauseContractHandler,
  UnpauseContractHandler,
} from './handlers/contract-pause.handlers';
import { FundAccountHandler } from './handlers/fund-account.handler';
import { MintBatchHandler } from './handlers/mint-batch.handler';
import { SetTokenUriBaseHandler } from './handlers/token-uri-base.handler';
import {
  CreateWineryAccountHandler,
  DeployWineryContractHandler,
} from './handlers/winery-identity.handlers';
import { PlatformAccountsSync } from './platform-accounts.sync';
import { ChainSigner } from './signer/chain-signer.service';
import { INTENT_HANDLERS, type IntentHandler } from './signer/intent-handler';
import { WineryIdentityProvisioner } from './winery-identity.provisioner';

/**
 * Intenciones que el firmante acepta (§2.2): identidad, pausa, emisión
 * (`MINT_BATCH`, `SET_TOKEN_URI_BASE`) y anclaje (`ANCHOR_DOSSIER`). Las de
 * mantenimiento y el cierre con faltante llegan con el paso 3.6: se añaden
 * aquí con su manejador. Una intención sin manejador se rechaza
 * (`CHN_INTENT_REJECTED`).
 */
const INTENT_HANDLER_CLASSES = [
  CreateWineryAccountHandler,
  DeployWineryContractHandler,
  PauseContractHandler,
  UnpauseContractHandler,
  FundAccountHandler,
  MintBatchHandler,
  SetTokenUriBaseHandler,
  AnchorDossierHandler,
];

/**
 * Cadena en el worker (contrato O3 §2 y §3): el custodio de claves, el
 * firmante aislado, las colas `chain` y `chain-poll` y las tareas
 * programadas. La API no lo carga: nunca tiene claves ni habla con la red.
 */
@Module({
  imports: [PrismaModule, ChainCoreModule, MailModule],
  providers: [
    {
      provide: KEY_CUSTODY,
      useFactory: createKeyCustody,
      inject: [CHAIN_SETTINGS, ConfigService, PrismaService],
    },
    {
      provide: CHAIN_GATEWAY,
      useFactory: createChainGateway,
      inject: [CHAIN_SETTINGS],
    },
    // La bitácora se escribe con `AuditService` directamente (actor sistema)
    AuditService,
    ...INTENT_HANDLER_CLASSES,
    {
      provide: INTENT_HANDLERS,
      useFactory: (...handlers: IntentHandler[]) => handlers,
      inject: INTENT_HANDLER_CLASSES,
    },
    ChainTxLifecycle,
    ChainJobsQueue,
    ChainSigner,
    ChainTxSweeper,
    PlatformAccountsSync,
    WineryIdentityProvisioner,
    ChainBootstrap,
    ...CHAIN_JOB_HANDLERS,
  ],
  exports: [KEY_CUSTODY, ChainCoreModule, WineryIdentityProvisioner],
})
export class ChainJobsModule {}
