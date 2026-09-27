import { Module } from '@nestjs/common';
import { AuthModule } from '@modules/auth/auth.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

/** Subidas privadas; el almacenamiento lo da `StorageModule` (global). */
@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
