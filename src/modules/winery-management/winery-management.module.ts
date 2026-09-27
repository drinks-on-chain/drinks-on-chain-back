import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { MailModule } from '@modules/mail/mail.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { AuthModule } from '@modules/auth/auth.module';
import { InvitationsModule } from '@modules/invitations/invitations.module';
import { WineryManagementService } from './winery-management.service';
import {
  CurrentOrganizationController,
  PlatformWineriesController,
  PublicWineriesController,
} from './winery-management.controller';

/**
 * Bodegas (contrato O1 §4): directorio y acciones del back office, perfil de
 * la bodega activa, perfil público y activación al aceptar el dueño. Exporta
 * `WineryManagementService` para la aprobación de solicitudes.
 */
@Module({
  imports: [
    PrismaModule,
    OutboxModule,
    MailModule,
    OrganizationsModule,
    AuthModule,
    InvitationsModule,
  ],
  controllers: [
    PlatformWineriesController,
    CurrentOrganizationController,
    PublicWineriesController,
  ],
  providers: [WineryManagementService],
  exports: [WineryManagementService],
})
export class WineryManagementModule {}
