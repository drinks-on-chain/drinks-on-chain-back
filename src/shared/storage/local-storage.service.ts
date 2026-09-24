import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IStorageService, StoredFileResult } from './storage.interface';

@Injectable()
export class LocalStorageService implements IStorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly uploadBasePath: string;
  private readonly storageBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const rawPath = this.configService.get<string>('STORAGE_LOCAL_PATH', './uploads');
    this.uploadBasePath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);

    const rawBaseUrl = this.configService.get<string>(
      'STORAGE_BASE_URL',
      `http://localhost:${this.configService.get<number>('PORT', 3000)}/uploads`,
    );
    // Eliminar barra final si existe
    this.storageBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Sanitiza el nombre de la carpeta para evitar Directory Traversal (CWE-22)
   */
  private sanitizeFolder(folder?: string): string {
    if (!folder) return 'general';
    // Permitir únicamente caracteres alfanuméricos, guiones y guiones bajos
    const sanitized = folder.replace(/[^a-zA-Z0-9_-]/g, '').trim();
    return sanitized.length > 0 ? sanitized : 'general';
  }

  /**
   * Almacena un archivo localmente en disco
   */
  async uploadFile(
    file: Express.Multer.File,
    folder = 'general',
  ): Promise<StoredFileResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No se ha proporcionado un archivo válido para almacenar.');
    }

    const safeFolder = this.sanitizeFolder(folder);
    const targetDir = path.join(this.uploadBasePath, safeFolder);

    // Asegurar que el directorio exista recursivamente
    await fs.mkdir(targetDir, { recursive: true });

    // Sanitizar extensión y armar nombre de archivo único verificando correspondencia con el tipo MIME
    const allowedExtensionsMap: Record<string, string[]> = {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'image/webp': ['.webp'],
      'image/svg+xml': ['.svg'],
      'image/gif': ['.gif'],
      'application/pdf': ['.pdf'],
    };

    const rawExt = path.extname(file.originalname).toLowerCase();
    const validExtensions = allowedExtensionsMap[file.mimetype] || [];
    // Si la extensión original es válida para el MIME se conserva; de lo contrario se usa la extensión canónica
    const safeExt = validExtensions.includes(rawExt)
      ? rawExt
      : validExtensions[0] || '.bin';

    const uniqueFileName = `${Date.now()}-${uuidv4()}${safeExt}`;
    const destinationPath = path.join(targetDir, uniqueFileName);

    // Guardar el buffer en disco
    await fs.writeFile(destinationPath, file.buffer);

    const relativeKey = `${safeFolder}/${uniqueFileName}`;
    const publicUrl = this.getFileUrl(relativeKey);

    this.logger.log(
      `Archivo guardado localmente: ${relativeKey} (${file.size} bytes, ${file.mimetype}) -> ${publicUrl}`,
    );

    return {
      url: publicUrl,
      key: relativeKey,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  /**
   * Elimina un archivo local dado su relative key
   */
  async deleteFile(key: string): Promise<void> {
    if (!key) return;
    try {
      // Normalizar y sanitizar el key asegurando que permanezca dentro de uploadBasePath (CWE-22)
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      const filePath = path.resolve(this.uploadBasePath, safeKey);

      // Prevenir escape de directorio raíz
      if (!filePath.startsWith(path.resolve(this.uploadBasePath))) {
        this.logger.warn(`Intento de acceso a ruta fuera del directorio permitido: ${key}`);
        return;
      }

      await fs.unlink(filePath);
      this.logger.log(`Archivo eliminado: ${safeKey}`);
    } catch (error) {
      this.logger.warn(`No se pudo eliminar el archivo local: ${key}`, (error as Error).message);
    }
  }

  /**
   * Retorna la URL pública accesible del archivo
   */
  getFileUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.storageBaseUrl}/${cleanKey}`;
  }
}
