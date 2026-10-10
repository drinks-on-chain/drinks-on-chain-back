import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { MailModule } from '@modules/mail/mail.module';
import { SettingsModule } from '@modules/settings/settings.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { AuthModule } from '@modules/auth/auth.module';
import { InvitationsService } from './invitations.service';
import {
  CurrentOrganizationInvitationsController,
  InvitationsController,
  PublicInvitationsController,
} from './invitations.controller';

/**
 * Invitaciones (contrato O1 §2). Exporta `InvitationsService`: lo usan los
 * usuarios internos, el equipo de las bodegas desde el back office y el alta
 * de bodegas y la transferencia de titularidad (`create` + `onAccepted`).
 */
@Module({
  imports: [
    PrismaModule,
    MailModule,
    SettingsModule,
    OrganizationsModule,
    AuthModule,
  ],
  controllers: [
    PublicInvitationsController,
    InvitationsController,
    CurrentOrganizationInvitationsController,
  ],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
