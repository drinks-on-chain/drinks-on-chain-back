import { Module } from '@nestjs/common';
import { WineriesController } from './wineries.controller';
import { WineriesService } from './wineries.service';
import { WineryRepository } from './repositories/winery.repository';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuthModule } from '@modules/auth/auth.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';

@Module({
  imports: [PrismaModule, AuthModule, OrganizationsModule],
  controllers: [WineriesController],
  providers: [WineriesService, WineryRepository],
  exports: [WineriesService, WineryRepository],
})
export class WineriesModule {}
