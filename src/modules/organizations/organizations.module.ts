import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { SessionsModule } from '@modules/auth/sessions/sessions.module';
import { OrganizationsService } from './organizations.service';
import { MembershipsService } from './memberships.service';

/** Organizaciones y membresías (contrato O0 §4). */
@Module({
  imports: [PrismaModule, SessionsModule],
  providers: [OrganizationsService, MembershipsService],
  exports: [OrganizationsService, MembershipsService],
})
export class OrganizationsModule {}
