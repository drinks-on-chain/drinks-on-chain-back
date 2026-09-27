/**
 * Almacenamiento de objetos privado (OPS-06, SE-04). Nada es público: los
 * archivos se leen con URL firmadas de corta vida. Dos drivers:
 *
 * - `s3`: cualquier servicio compatible con S3 (MinIO en local y en
 *   desarrollo). URL prefirmadas del propio servicio.
 * - `local`: carpeta en disco (pruebas y desarrollo sin MinIO). URL firmadas
 *   con HMAC que sirve la propia API en `GET /v1/uploads/local`.
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';

  /** Guarda un objeto privado en `key`. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** URL firmada de lectura válida `ttlSeconds` (por defecto, la configurada). */
  getSignedUrl(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ url: string; expiresAt: Date }>;

  /** `true` si el objeto existe. */
  exists(key: string): Promise<boolean>;

  /** Borra un objeto (no falla si no existe). */
  delete(key: string): Promise<void>;

  /** Prepara el almacenamiento (crea el bucket o la carpeta si falta). */
  ensureReady(): Promise<void>;

  /** Comprobación de salud (readiness). */
  ping(): Promise<boolean>;
}

export const STORAGE_SERVICE = 'IStorageService';

/** Vida por defecto de una URL firmada: 15 minutos. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;
/** Vida máxima que se puede pedir: 1 hora. */
export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/** Claves admitidas: `org/<id>/<carpeta>/…`, sin `..` ni caracteres raros. */
export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;

export function isSafeStorageKey(key: string): boolean {
  return (
    STORAGE_KEY_PATTERN.test(key) &&
    !key.includes('..') &&
    !key.includes('//') &&
    !key.endsWith('/')
  );
}
