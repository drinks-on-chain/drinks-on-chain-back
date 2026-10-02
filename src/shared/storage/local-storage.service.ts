import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_SIGNED_URL_TTL_SECONDS,
  ObjectStorage,
  isSafeStorageKey,
} from './storage.interface';

export interface LocalStorageOptions {
  /** Carpeta de los archivos (absoluta o relativa al directorio de trabajo). */
  basePath: string;
  /** Origen público de la API: las URL firmadas apuntan a `/v1/uploads/local`. */
  publicBaseUrl: string;
  /** Secreto del HMAC de las URL firmadas. */
  signingSecret: string;
  defaultTtlSeconds?: number;
}

/** Ruta de la API que sirve los archivos locales con URL firmada. */
export const LOCAL_FILES_PATH = '/v1/uploads/local';

/**
 * Driver local (pruebas y desarrollo sin MinIO): archivos en disco, nunca
 * servidos como estáticos. Se leen con URL firmadas por HMAC
 * (`?key&expires&signature`) que valida `GET /v1/uploads/local`.
 */
export class LocalStorageService implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly basePath: string;
  private readonly publicBaseUrl: string;
  private readonly defaultTtl: number;

  constructor(private readonly options: LocalStorageOptions) {
    this.basePath = path.resolve(process.cwd(), options.basePath);
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.defaultTtl =
      options.defaultTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  /** Ruta en disco de una clave, sin salir de la carpeta base (CWE-22). */
  resolvePath(key: string): string {
    if (!isSafeStorageKey(key)) {
      throw new Error(`Clave de almacenamiento inválida: ${key}`);
    }
    const target = path.resolve(this.basePath, key);
    if (!target.startsWith(this.basePath + path.sep)) {
      throw new Error(`Clave fuera del almacenamiento: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolvePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { mode: 0o600 });
  }

  async getSignedUrl(
    key: string,
    ttlSeconds = this.defaultTtl,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.resolvePath(key);
    const ttl = Math.min(Math.max(1, ttlSeconds), MAX_SIGNED_URL_TTL_SECONDS);
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      signature: this.sign(key, expires),
    });
    return Promise.resolve({
      url: `${this.publicBaseUrl}${LOCAL_FILES_PATH}?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
    });
  }

  /** Comprueba la firma y la caducidad de una URL local. */
  verifySignature(key: string, expires: number, signature: string): boolean {
    if (!Number.isInteger(expires) || expires < Date.now() / 1000) return false;
    if (!isSafeStorageKey(key)) return false;
    const expected = Buffer.from(this.sign(key, expires));
    const received = Buffer.from(signature ?? '');
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.resolvePath(key));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolvePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({
          message: `No se pudo borrar ${key}`,
          error: (error as Error).message,
        });
      }
    }
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  async ping(): Promise<boolean> {
    try {
      await fs.access(this.basePath);
      return true;
    } catch {
      return false;
    }
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.options.signingSecret)
      .update(`${key}\n${expires}`)
      .digest('base64url');
  }
}
