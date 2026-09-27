import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { MailModule } from '@modules/mail/mail.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { AuthModule } from '@modules/auth/auth.module';
import { InvitationsModule } from '@modules/invitations/invitations.module';
import { PlatformUsersService } from './platform-users.service';
import { PlatformUsersController } from './platform-users.controller';

/**
 * Back office (contrato O1 §5, PLT-02…05): usuarios internos, matriz de
 * permisos y acciones de la plataforma sobre personas.
 */
@Module({
  imports: [
    PrismaModule,
    MailModule,
    OrganizationsModule,
    AuthModule,
    InvitationsModule,
  ],
  controllers: [PlatformUsersController],
  providers: [PlatformUsersService],
  exports: [PlatformUsersService],
})
export class PlatformUsersModule {}
