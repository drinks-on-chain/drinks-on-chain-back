import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserRepository } from './repositories/user.repository';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuthModule } from '@modules/auth/auth.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';

@Module({
  imports: [PrismaModule, WalletsModule, AuthModule, OrganizationsModule],
  controllers: [UsersController],
  providers: [UsersService, UserRepository],
  exports: [UsersService, UserRepository],
})
export class UsersModule {}
