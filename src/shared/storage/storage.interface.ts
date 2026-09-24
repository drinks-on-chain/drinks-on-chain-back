export interface StoredFileResult {
  /** URL pública accesible para consultar/descargar el archivo */
  url: string;
  /** Identificador único o ruta relativa de almacenamiento (ej. "inspections/1742880000000-uuid.pdf") */
  key: string;
  /** Nombre original del archivo subido */
  originalName: string;
  /** Tipo MIME detectado (ej. "application/pdf", "image/png") */
  mimeType: string;
  /** Tamaño del archivo en bytes */
  sizeBytes: number;
}

export interface IStorageService {
  /**
   * Almacena un archivo en el proveedor configurado (Local, S3, R2, Supabase, etc.)
   * @param file Archivo recibido vía Multer
   * @param folder Subcarpeta o namespace (ej. 'inspections', 'labels', 'lab-reports')
   */
  uploadFile(
    file: Express.Multer.File,
    folder?: string,
  ): Promise<StoredFileResult>;

  /**
   * Elimina un archivo a partir de su clave de almacenamiento
   * @param key Identificador o ruta relativa del archivo
   */
  deleteFile?(key: string): Promise<void>;

  /**
   * Retorna la URL pública accesible de un archivo dado su key
   * @param key Identificador o ruta relativa del archivo
   */
  getFileUrl(key: string): string;
}

export const STORAGE_SERVICE = 'IStorageService';
