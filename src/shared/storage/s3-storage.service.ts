import { Logger } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_SIGNED_URL_TTL_SECONDS,
  ObjectStorage,
  isSafeStorageKey,
} from './storage.interface';

export interface S3StorageOptions {
  endpoint?: string;
  /** Endpoint con el que se prefirman las URL (el que ve el navegador). */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  defaultTtlSeconds?: number;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.$metadata?.httpStatusCode === 404 ||
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.name === 'NoSuchBucket'
    );
  }
  return false;
}

/**
 * Driver S3 compatible (MinIO en local y en desarrollo). Objetos privados
 * (el bucket no tiene política pública) y lectura por URL prefirmadas de
 * corta vida. Crea el bucket al arrancar si no existe.
 */
export class S3StorageService implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly defaultTtl: number;
  private bucketReady = false;

  constructor(private readonly options: S3StorageOptions) {
    const base = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.presignClient =
      options.publicEndpoint && options.publicEndpoint !== options.endpoint
        ? new S3Client({ ...base, endpoint: options.publicEndpoint })
        : this.client;
    this.defaultTtl =
      options.defaultTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  get bucket(): string {
    return this.options.bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.checkKey(key);
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        CacheControl: 'private, max-age=0, no-store',
      }),
    );
  }

  async getSignedUrl(
    key: string,
    ttlSeconds = this.defaultTtl,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.checkKey(key);
    const ttl = Math.min(Math.max(1, ttlSeconds), MAX_SIGNED_URL_TTL_SECONDS);
    const url = await getSignedUrl(
      this.presignClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async exists(key: string): Promise<boolean> {
    this.checkKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.checkKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Crea el bucket si no existe; reintenta mientras el servicio arranca. */
  async ensureReady(attempts = 10, delayMs = 2000): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ensureBucket();
        return;
      } catch (error) {
        if (attempt >= attempts) throw error;
        this.logger.warn({
          message: `Almacenamiento no disponible (intento ${attempt}/${attempts})`,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log({
          message: `Bucket ${this.bucket} creado (privado)`,
          bucket: this.bucket,
        });
      } catch (createError) {
        // Otra réplica lo creó a la vez
        const name = (createError as { name?: string }).name;
        if (
          name !== 'BucketAlreadyOwnedByYou' &&
          name !== 'BucketAlreadyExists'
        ) {
          throw createError;
        }
      }
    }
    this.bucketReady = true;
  }

  private checkKey(key: string): void {
    if (!isSafeStorageKey(key)) {
      throw new Error(`Clave de almacenamiento inválida: ${key}`);
    }
  }
}
