import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import {
  RequestContext,
  getRequestContext,
} from '@shared/context/request-context';
import {
  ObjectStorage,
  STORAGE_SERVICE,
  isSafeStorageKey,
} from '@shared/storage/storage.interface';
import {
  detectFileType,
  normalizeDeclaredMime,
} from '@shared/storage/file-type';
import {
  UploadResponseDto,
  SignedUrlResponseDto,
} from './dto/upload-response.dto';

/** Prefijo de los archivos de la plataforma (personal sin bodega activa). */
const PLATFORM_PREFIX = 'platform';

function sanitizeFolder(folder?: string): string {
  const safe = (folder ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  return safe.length > 0 ? safe.toLowerCase() : 'general';
}

function isPlatformActor(ctx: RequestContext | undefined): boolean {
  return ctx?.organizationType === 'PLATFORM';
}

/**
 * Subidas privadas (OPS-06, SE-04): solo personal (no consumidores), tipo real
 * por firma de bytes, límite por tipo, clave con prefijo de la organización
 * (`org/<id>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>`) y lectura por URL firmada.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
  ) {}

  /** Prefijo de la organización activa: `org/<id>`. */
  organizationPrefix(ctx = getRequestContext()): string {
    if (ctx?.audience !== 'STAFF') {
      throw new AppException(
        403,
        ErrorCode.FORBIDDEN,
        'Solo el personal de una organización puede subir archivos',
      );
    }
    if (ctx.organizationId) return `org/${ctx.organizationId}`;
    if (isPlatformActor(ctx)) return `org/${PLATFORM_PREFIX}`;
    throw new AppException(
      403,
      ErrorCode.FORBIDDEN,
      'Necesitas una organización activa para subir archivos',
    );
  }

  async upload(
    file: Express.Multer.File | undefined,
    folder?: string,
  ): Promise<UploadResponseDto> {
    if (!file || !file.buffer || file.size === 0) {
      throw ValidationException.forField(
        'file',
        'Debe proporcionar un archivo en el campo multipart/form-data "file".',
      );
    }
    const prefix = this.organizationPrefix();

    const detected = detectFileType(file.buffer);
    const declared = normalizeDeclaredMime(file.mimetype);
    if (!detected || detected.mimeType !== declared) {
      throw new ValidationException(
        [
          {
            field: 'file',
            message: `Tipo de archivo no permitido: el contenido no es ${declared || 'un tipo admitido'}. Se admiten JPEG, PNG, WEBP, GIF y PDF.`,
          },
        ],
        'Tipo de archivo no permitido',
        ErrorCode.FILE_TYPE_NOT_ALLOWED,
      );
    }
    if (file.buffer.length > detected.maxBytes) {
      throw new AppException(
        413,
        ErrorCode.FILE_TOO_LARGE,
        `El archivo supera el máximo de ${Math.round(detected.maxBytes / (1024 * 1024))} MB para ${detected.mimeType}`,
      );
    }

    const now = new Date();
    const key = [
      prefix,
      sanitizeFolder(folder),
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${randomUUID()}${detected.extension}`,
    ].join('/');

    await this.storage.put(key, file.buffer, detected.mimeType);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const originalName = (file.originalname ?? 'archivo')
      .replace(/[\r\n"]/g, '')
      .slice(0, 255);

    await this.audit.recordStandalone({
      action: AuditAction.FILE_UPLOADED,
      resource: { type: 'file', id: key.slice(0, 100) },
      organizationId: getRequestContext()?.organizationId ?? null,
      after: {
        key,
        mimeType: detected.mimeType,
        sizeBytes: file.buffer.length,
        sha256,
        originalName,
      },
    });

    const signed = await this.storage.getSignedUrl(key);
    this.logger.log({
      message: 'Archivo subido',
      key,
      mimeType: detected.mimeType,
      sizeBytes: file.buffer.length,
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      key,
      originalName,
      mimeType: detected.mimeType,
      sizeBytes: file.buffer.length,
      sha256,
    };
  }

  /**
   * URL firmada nueva para un archivo de la organización activa (la
   * plataforma puede leer cualquiera). Otro prefijo o inexistente → 404.
   */
  async signedUrl(key: string): Promise<SignedUrlResponseDto> {
    const ctx = getRequestContext();
    const notFound = new AppException(
      404,
      ErrorCode.FILE_NOT_FOUND,
      'Archivo no encontrado',
    );
    if (!key || !isSafeStorageKey(key) || !key.startsWith('org/')) {
      throw notFound;
    }
    if (!isPlatformActor(ctx)) {
      const prefix = this.organizationPrefix(ctx);
      if (!key.startsWith(`${prefix}/`)) throw notFound;
    }
    if (!(await this.storage.exists(key))) throw notFound;
    const signed = await this.storage.getSignedUrl(key);
    return { key, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
