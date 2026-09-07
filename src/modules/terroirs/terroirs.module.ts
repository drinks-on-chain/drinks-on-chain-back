import { Module } from '@nestjs/common';
import { TerroirsController } from './terroirs.controller';
import { TerroirsService } from './terroirs.service';
import { PrismaModule } from '@shared/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TerroirsController],
  providers: [TerroirsService],
  exports: [TerroirsService],
})
export class TerroirsModule {}
