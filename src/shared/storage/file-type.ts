/**
 * Tipos de archivo admitidos en las subidas (SE-04): se reconoce el tipo
 * **real** por la firma de sus primeros bytes, no por el MIME ni la extensión
 * que declara el cliente. Sin SVG (XSS almacenado) ni nada ejecutable.
 */
export interface AllowedFileType {
  mimeType: string;
  extension: string;
  /** Tamaño máximo en bytes. */
  maxBytes: number;
  kind: 'image' | 'document';
}

const MB = 1024 * 1024;

export const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = [
  {
    mimeType: 'image/jpeg',
    extension: '.jpg',
    maxBytes: 5 * MB,
    kind: 'image',
  },
  { mimeType: 'image/png', extension: '.png', maxBytes: 5 * MB, kind: 'image' },
  {
    mimeType: 'image/webp',
    extension: '.webp',
    maxBytes: 5 * MB,
    kind: 'image',
  },
  { mimeType: 'image/gif', extension: '.gif', maxBytes: 5 * MB, kind: 'image' },
  {
    mimeType: 'application/pdf',
    extension: '.pdf',
    maxBytes: 15 * MB,
    kind: 'document',
  },
];

/** Límite de la subida entera (el mayor de los tipos admitidos). */
export const MAX_UPLOAD_BYTES = Math.max(
  ...ALLOWED_FILE_TYPES.map((t) => t.maxBytes),
);

/** MIME declarados que se aceptan en la petición (luego se comprueba la firma). */
export const ALLOWED_DECLARED_MIME_TYPES = new Set([
  ...ALLOWED_FILE_TYPES.map((t) => t.mimeType),
  'image/jpg',
  'image/pjpeg',
]);

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

function ascii(buffer: Buffer, text: string, offset = 0): boolean {
  return startsWith(
    buffer,
    [...text].map((c) => c.charCodeAt(0)),
    offset,
  );
}

/** Tipo real del contenido, o `null` si no es uno de los admitidos. */
export function detectFileType(buffer: Buffer): AllowedFileType | null {
  const byMime = (mime: string) =>
    ALLOWED_FILE_TYPES.find((t) => t.mimeType === mime) ?? null;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return byMime('image/jpeg');
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return byMime('image/png');
  }
  if (ascii(buffer, 'GIF87a') || ascii(buffer, 'GIF89a')) {
    return byMime('image/gif');
  }
  if (ascii(buffer, 'RIFF') && ascii(buffer, 'WEBP', 8)) {
    return byMime('image/webp');
  }
  if (ascii(buffer, '%PDF-')) return byMime('application/pdf');
  return null;
}

/** Normaliza el MIME declarado (`image/jpg` → `image/jpeg`). */
export function normalizeDeclaredMime(mime: string | undefined): string {
  const value = (mime ?? '').toLowerCase().split(';')[0].trim();
  return value === 'image/jpg' || value === 'image/pjpeg'
    ? 'image/jpeg'
    : value;
}

/** Tipo por extensión de una clave guardada (para servir el archivo local). */
export function fileTypeForKey(key: string): AllowedFileType | null {
  const lower = key.toLowerCase();
  return (
    ALLOWED_FILE_TYPES.find(
      (t) =>
        lower.endsWith(t.extension) ||
        (t.extension === '.jpg' && lower.endsWith('.jpeg')),
    ) ?? null
  );
}

/**
 * Archivos que genera el propio backend (no se suben): el driver local los
 * sirve como descarga con su URL firmada (p. ej. el ZIP de códigos de botella
 * para la imprenta, contrato O2 §7.2).
 */
export const GENERATED_FILE_TYPES: readonly {
  mimeType: string;
  extension: string;
}[] = [{ mimeType: 'application/zip', extension: '.zip' }];

/** Tipo de un archivo generado por su extensión, o `null`. */
export function generatedFileTypeForKey(
  key: string,
): { mimeType: string; extension: string } | null {
  const lower = key.toLowerCase();
  return GENERATED_FILE_TYPES.find((t) => lower.endsWith(t.extension)) ?? null;
}
