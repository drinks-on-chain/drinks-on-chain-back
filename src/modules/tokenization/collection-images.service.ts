import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { detectFileType } from '@shared/storage/file-type';
import {
  isSafeStorageKey,
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';

export interface ImageDigest {
  sha256: string;
  mimeType: string;
}

/** Prefijo de las subidas del personal de plataforma (`UploadsService`). */
const PLATFORM_PREFIX = 'org/platform/';

/**
 * Imágenes de una colección (contrato O3 §5.5): se referencian por la `key`
 * de `POST /v1/uploads`. Deben ser de la bodega (o subidas por operaciones al
 * completar los datos comerciales), existir y ser de verdad una imagen; se
 * guarda su SHA-256 para atar la colección a los bytes y no a una URL.
 */
@Injectable()
export class CollectionImagesService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Huella de cada imagen. Una clave ajena, inexistente o que no es una
   * imagen → 422 `VALIDATION_ERROR` en `{field}.{i}.key`.
   */
  async inspect(
    wineryId: string,
    images: readonly { key: string }[],
    field = 'commercial.imageKeys',
    known: ReadonlyMap<string, ImageDigest> = new Map(),
  ): Promise<Map<string, ImageDigest>> {
    const digests = new Map<string, ImageDigest>();
    const errors: ErrorDetail[] = [];
    await Promise.all(
      images.map(async (image, index) => {
        const cached = known.get(image.key);
        if (cached) {
          digests.set(image.key, cached);
          return;
        }
        const own =
          isSafeStorageKey(image.key) &&
          (image.key.startsWith(`org/${wineryId}/`) ||
            image.key.startsWith(PLATFORM_PREFIX));
        const body = own ? await this.storage.get(image.key) : null;
        if (!body) {
          errors.push({
            field: `${field}.${index}.key`,
            message:
              'Imagen no encontrada: súbela con POST /v1/uploads y usa su key',
          });
          return;
        }
        const type = detectFileType(body);
        if (!type || !type.mimeType.startsWith('image/')) {
          errors.push({
            field: `${field}.${index}.key`,
            message: 'El archivo no es una imagen (JPEG, PNG, WEBP o GIF)',
          });
          return;
        }
        digests.set(image.key, {
          sha256: createHash('sha256').update(body).digest('hex'),
          mimeType: type.mimeType,
        });
      }),
    );
    if (errors.length > 0) {
      throw new ValidationException(
        errors.sort((a, b) => (a.field ?? '').localeCompare(b.field ?? '')),
      );
    }
    return digests;
  }

  /** Bytes y tipo de una imagen guardada; `null` si ya no existe o no es una imagen. */
  async read(key: string): Promise<{ body: Buffer; mimeType: string } | null> {
    const body = isSafeStorageKey(key) ? await this.storage.get(key) : null;
    if (!body) return null;
    const type = detectFileType(body);
    if (!type || !type.mimeType.startsWith('image/')) return null;
    return { body, mimeType: type.mimeType };
  }
}
