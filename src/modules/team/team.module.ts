import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { InvitationsModule } from '@modules/invitations/invitations.module';
import { TeamService } from './team.service';
import {
  CurrentTeamController,
  PlatformTeamController,
} from './team.controller';

/** Equipo de las bodegas: dueño y back office (contrato O1 §5). */
@Module({
  imports: [PrismaModule, OrganizationsModule, InvitationsModule],
  controllers: [CurrentTeamController, PlatformTeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
