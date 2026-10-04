import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

/** PDF mínimo: lo que la subida reconoce por su firma de bytes (`%PDF-`). */
export const TEST_PDF = Buffer.from('%PDF-1.4 informe de prueba de la suite');

/** Huella SHA-256 (hexadecimal) de un archivo, como la guarda la API. */
export function sha256Of(file: Buffer): string {
  return createHash('sha256').update(file).digest('hex');
}

/**
 * Sube un archivo privado con `POST /v1/uploads` y devuelve su `key`: lo que
 * los registros de la trazabilidad guardan (informes de laboratorio y de
 * dictamen, etiquetas). Desde H2 las entradas ya no admiten una URL.
 */
export async function uploadTraceFile(
  app: INestApplication,
  token: string,
  options: {
    folder?: 'lab' | 'inspections' | 'labels' | 'lotes';
    file?: Buffer;
    name?: string;
    ip?: string;
  } = {},
): Promise<string> {
  const req = request(app.getHttpServer())
    .post(`/v1/uploads?folder=${options.folder ?? 'lab'}`)
    .set('Authorization', `Bearer ${token}`);
  if (options.ip) req.set('X-Forwarded-For', options.ip);
  const res = await req
    .attach('file', options.file ?? TEST_PDF, options.name ?? 'informe.pdf')
    .expect(201);
  return (res.body as { data: { key: string } }).data.key;
}
