import { Global, Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { ObjectStorage, STORAGE_SERVICE } from './storage.interface';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';

/** Origen público de la API a partir de `STORAGE_BASE_URL` (o `PORT`). */
export function publicBaseUrl(config: ConfigService): string {
  const raw = (config.get<string>('STORAGE_BASE_URL') ?? '').trim();
  if (raw) {
    // Compatibilidad: antes era la URL de la carpeta pública (…/uploads)
    return raw.replace(/\/+$/, '').replace(/\/uploads$/, '');
  }
  return `http://localhost:${config.get<number>('PORT', 4000)}`;
}

export function createObjectStorage(config: ConfigService): ObjectStorage {
  const driver = (
    config.get<string>('STORAGE_DRIVER') ?? 'local'
  ).toLowerCase();
  const ttl = Number(config.get('STORAGE_SIGNED_URL_TTL_SECONDS') ?? 900);

  if (driver === 's3') {
    const endpoint = config.get<string>('S3_ENDPOINT') || undefined;
    return new S3StorageService({
      endpoint,
      publicEndpoint: config.get<string>('S3_PUBLIC_ENDPOINT') || endpoint,
      region: config.get<string>('S3_REGION') ?? 'us-east-1',
      bucket: config.getOrThrow<string>('S3_BUCKET'),
      accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
      secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
      forcePathStyle:
        String(config.get('S3_FORCE_PATH_STYLE') ?? 'true') === 'true',
      defaultTtlSeconds: ttl,
    });
  }

  // El secreto de las URL locales: el propio o uno derivado del de JWT
  const signingSecret =
    config.get<string>('STORAGE_SIGNING_SECRET') ||
    createHmac('sha256', config.get<string>('JWT_SECRET') ?? 'local-only')
      .update('doc:storage:signed-url')
      .digest('hex');
  return new LocalStorageService({
    basePath: config.get<string>('STORAGE_LOCAL_PATH') ?? './uploads',
    publicBaseUrl: publicBaseUrl(config),
    signingSecret,
    defaultTtlSeconds: ttl,
  });
}

/**
 * Almacenamiento de objetos privado (docs/arquitectura/correo-y-archivos.md).
 * `STORAGE_DRIVER=s3` (MinIO) o `local`. Al arrancar prepara el bucket o la
 * carpeta; si no puede, lo registra y la readiness lo refleja.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      inject: [ConfigService],
      useFactory: createObjectStorage,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule implements OnModuleInit {
  private readonly logger = new Logger('Storage');

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.storage.ensureReady();
      this.logger.log({
        message: `Almacenamiento listo (${this.storage.driver})`,
        driver: this.storage.driver,
      });
    } catch (error) {
      this.logger.error({
        message: `Almacenamiento no disponible (${this.storage.driver})`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
