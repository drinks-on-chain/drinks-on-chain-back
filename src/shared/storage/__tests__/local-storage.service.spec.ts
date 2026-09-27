import * as fs from 'fs/promises';
import * as path from 'path';
import { LocalStorageService } from '../local-storage.service';
import { isSafeStorageKey } from '../storage.interface';
import {
  detectFileType,
  fileTypeForKey,
  normalizeDeclaredMime,
} from '../file-type';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

describe('LocalStorageService', () => {
  const basePath = './test-uploads-local';
  const service = new LocalStorageService({
    basePath,
    publicBaseUrl: 'http://localhost:4000/',
    signingSecret: 'test-secret',
    defaultTtlSeconds: 60,
  });

  afterAll(async () => {
    await fs.rm(path.resolve(process.cwd(), basePath), {
      recursive: true,
      force: true,
    });
  });

  it('guarda, comprueba y borra un objeto', async () => {
    const key = 'org/o1/labels/2026/09/a.png';
    await service.ensureReady();
    await service.put(key, PNG);
    await expect(service.exists(key)).resolves.toBe(true);
    await service.delete(key);
    await expect(service.exists(key)).resolves.toBe(false);
    // Borrar lo que no existe no falla
    await expect(service.delete(key)).resolves.toBeUndefined();
  });

  it('rechaza claves que salen de la carpeta (CWE-22)', async () => {
    await expect(service.put('../fuera.png', PNG)).rejects.toThrow(/inválida/);
    await expect(service.put('org/../../x.png', PNG)).rejects.toThrow();
    await expect(service.put('/etc/passwd', PNG)).rejects.toThrow();
  });

  it('firma URL de corta vida que solo valen para su clave y hasta que caducan', async () => {
    const key = 'org/o1/labels/2026/09/b.png';
    const { url, expiresAt } = await service.getSignedUrl(key);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'http://localhost:4000/v1/uploads/local',
    );
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const expires = Number(parsed.searchParams.get('expires'));
    const signature = parsed.searchParams.get('signature') ?? '';
    expect(service.verifySignature(key, expires, signature)).toBe(true);
    expect(
      service.verifySignature(
        'org/o2/labels/2026/09/b.png',
        expires,
        signature,
      ),
    ).toBe(false);
    expect(service.verifySignature(key, expires + 1, signature)).toBe(false);
    expect(service.verifySignature(key, expires, 'x')).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(service.verifySignature(key, past, signature)).toBe(false);
  });
});

describe('claves y tipos de archivo', () => {
  it('isSafeStorageKey', () => {
    expect(isSafeStorageKey('org/abc/labels/2026/09/x.pdf')).toBe(true);
    expect(isSafeStorageKey('org/../x.pdf')).toBe(false);
    expect(isSafeStorageKey('/org/x.pdf')).toBe(false);
    expect(isSafeStorageKey('org//x.pdf')).toBe(false);
    expect(isSafeStorageKey('org/x y.pdf')).toBe(false);
  });

  it('reconoce el tipo real por la firma de bytes', () => {
    expect(detectFileType(PNG)?.mimeType).toBe('image/png');
    expect(
      detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.mimeType,
    ).toBe('image/jpeg');
    expect(detectFileType(Buffer.from('GIF89a....'))?.mimeType).toBe(
      'image/gif',
    );
    expect(
      detectFileType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))
        ?.mimeType,
    ).toBe('image/webp');
    expect(detectFileType(Buffer.from('%PDF-1.7\n'))?.mimeType).toBe(
      'application/pdf',
    );
  });

  it('SVG, HTML, scripts o contenido desconocido no se admiten', () => {
    expect(
      detectFileType(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      ),
    ).toBeNull();
    expect(detectFileType(Buffer.from('<!doctype html><html>'))).toBeNull();
    expect(detectFileType(Buffer.from('MZ\u0090\u0000'))).toBeNull();
    expect(detectFileType(Buffer.from('fake-png-content'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });

  it('normaliza el MIME declarado y deduce el tipo por extensión', () => {
    expect(normalizeDeclaredMime('image/JPG')).toBe('image/jpeg');
    expect(normalizeDeclaredMime('application/pdf; charset=binary')).toBe(
      'application/pdf',
    );
    expect(fileTypeForKey('org/a/x.PDF')?.mimeType).toBe('application/pdf');
    expect(fileTypeForKey('org/a/x.jpeg')?.mimeType).toBe('image/jpeg');
    expect(fileTypeForKey('org/a/x.svg')).toBeNull();
  });
});
