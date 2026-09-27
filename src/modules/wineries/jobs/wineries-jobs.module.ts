import { Module } from '@nestjs/common';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { WineryCreatedHandler } from './winery-created.handler';
import { MemberAddedHandler } from './member-added.handler';
import { WineryActivatedHandler } from './winery-activated.handler';

/**
 * Procesadores del módulo de bodegas. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia.
 */
@Module({
  imports: [WalletsModule],
  providers: [WineryCreatedHandler, MemberAddedHandler, WineryActivatedHandler],
})
export class WineriesJobsModule {}
