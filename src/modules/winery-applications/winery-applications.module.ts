import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { MailModule } from '@modules/mail/mail.module';
import { WineryManagementModule } from '@modules/winery-management/winery-management.module';
import { WineryApplicationsService } from './winery-applications.service';
import {
  PlatformWineryApplicationsController,
  PublicWineryApplicationsController,
} from './winery-applications.controller';

/** Solicitudes de alta de bodegas (contrato O1 §3; ORG-01, ORG-02). */
@Module({
  imports: [PrismaModule, MailModule, WineryManagementModule],
  controllers: [
    PublicWineryApplicationsController,
    PlatformWineryApplicationsController,
  ],
  providers: [WineryApplicationsService],
  exports: [WineryApplicationsService],
})
export class WineryApplicationsModule {}
