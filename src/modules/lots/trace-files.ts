import { createHash } from 'node:crypto';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  isSafeStorageKey,
  ObjectStorage,
} from '@shared/storage/storage.interface';
import { ruleError, violation } from './domain/trace-errors';

/**
 * Archivos privados que referencian los registros de la trazabilidad por su
 * `key` de `POST /v1/uploads` (contrato O2 §0): informes de dictamen y de
 * laboratorio. La `key` debe ser de la bodega (`org/{wineryId}/…`) y existir
 * → si no, 422 `TRC_FILE_NOT_FOUND`. Devuelve la huella SHA-256 del contenido
 * (hexadecimal): es lo que el registro guarda junto a la `key`, de modo que el
 * informe queda atado a sus bytes y no a una URL (§0).
 */
export async function assertWineryFile(
  storage: ObjectStorage,
  wineryId: string,
  key: string,
  field: string,
  message: string,
): Promise<string> {
  const own = isSafeStorageKey(key) && key.startsWith(`org/${wineryId}/`);
  const body = own ? await storage.get(key) : null;
  if (body) return createHash('sha256').update(body).digest('hex');
  throw ruleError(ErrorCode.TRC_FILE_NOT_FOUND, message, [
    violation(ErrorCode.TRC_FILE_NOT_FOUND, 'Archivo no encontrado', {
      field,
      meta: { field },
    }),
  ]);
}

/** URL firmada de corta vida de un archivo; `null` si no se puede firmar. */
export async function signedFileUrl(
  storage: ObjectStorage,
  key: string,
): Promise<string | null> {
  try {
    return (await storage.getSignedUrl(key)).url;
  } catch {
    return null;
  }
}
