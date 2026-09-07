import { Module } from '@nestjs/common';
import { HarvestBatchesController } from './harvest-batches.controller';
import { HarvestBatchesService } from './harvest-batches.service';
import { PrismaModule } from '@shared/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HarvestBatchesController],
  providers: [HarvestBatchesService],
  exports: [HarvestBatchesService],
})
export class HarvestBatchesModule {}
