import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuditQueryModule } from '@modules/audit/audit-query.module';
import { ChainSettingsModule } from '@modules/chain/chain-settings.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

/** Tablero del back office (contrato O1 §8). */
@Module({
  imports: [PrismaModule, AuditQueryModule, ChainSettingsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
