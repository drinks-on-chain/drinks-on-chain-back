import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { StorageModule } from '../../shared/storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
