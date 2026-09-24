import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { STORAGE_SERVICE } from './storage.interface';
import { LocalStorageService } from './local-storage.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    LocalStorageService,
    {
      provide: STORAGE_SERVICE,
      useFactory: (configService: ConfigService, localStorageService: LocalStorageService) => {
        const driver = configService.get<string>('STORAGE_DRIVER', 'local').toLowerCase();

        switch (driver) {
          case 'local':
          default:
            return localStorageService;
          // En fases futuras o integración con cloud:
          // case 's3':
          //   return new S3StorageService(configService);
          // case 'supabase':
          //   return new SupabaseStorageService(configService);
        }
      },
      inject: [ConfigService, LocalStorageService],
    },
  ],
  exports: [STORAGE_SERVICE, LocalStorageService],
})
export class StorageModule {}
