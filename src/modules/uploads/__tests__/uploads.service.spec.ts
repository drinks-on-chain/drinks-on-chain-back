import { Readable } from 'stream';
import { UploadsService } from '../uploads.service';
import type { ObjectStorage } from '@shared/storage/storage.interface';
import type { AuditService } from '@shared/audit/audit.service';
import {
  RequestContext,
  runWithRequestContext,
} from '@shared/context/request-context';

const ORG = '0b5c1f3e-8a2d-4c1e-9f7a-2d3e4f5a6b7c';
const PDF = Buffer.from('%PDF-1.4 informe');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function file(
  buffer: Buffer,
  mimetype: string,
  originalname = 'x',
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    buffer,
    size: buffer.length,
    stream: Readable.from([]),
    destination: '',
    filename: '',
    path: '',
  };
}

const STAFF: Partial<RequestContext> = {
  userId: 'u-1',
  audience: 'STAFF',
  organizationId: ORG,
  organizationType: 'WINERY',
};

describe('UploadsService', () => {
  function setup() {
    const storage: jest.Mocked<ObjectStorage> = {
      driver: 'local',
      put: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue({
        url: 'https://signed.example/x',
        expiresAt: new Date('2026-09-27T12:00:00Z'),
      }),
      exists: jest.fn().mockResolvedValue(true),
      delete: jest.fn(),
      ensureReady: jest.fn(),
      ping: jest.fn(),
    } as unknown as jest.Mocked<ObjectStorage>;
    const audit = { recordStandalone: jest.fn().mockResolvedValue({}) };
    const service = new UploadsService(
      storage,
      audit as unknown as AuditService,
    );
    return { storage, audit, service };
  }

  it('guarda bajo el prefijo de la organización con el tipo real y devuelve URL firmada', async () => {
    const { storage, audit, service } = setup();
    const result = await runWithRequestContext(STAFF, () =>
      service.upload(file(PDF, 'application/pdf', 'informe.pdf'), '../insp!'),
    );
    expect(result).toMatchObject({
      url: 'https://signed.example/x',
      expiresAt: '2026-09-27T12:00:00.000Z',
      mimeType: 'application/pdf',
      originalName: 'informe.pdf',
      sizeBytes: PDF.length,
    });
    expect(result.key).toMatch(
      new RegExp(`^org/${ORG}/insp/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(storage.put).toHaveBeenCalledWith(
      result.key,
      PDF,
      'application/pdf',
    );
    expect(audit.recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FILE_UPLOADED', organizationId: ORG }),
    );
  });

  it('consumidores o personal sin organización → 403', async () => {
    const { service, storage } = setup();
    await expect(
      runWithRequestContext({ userId: 'c', audience: 'CONSUMER' }, () =>
        service.upload(file(PNG, 'image/png')),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      runWithRequestContext({ userId: 's', audience: 'STAFF' }, () =>
        service.upload(file(PNG, 'image/png')),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('el contenido debe coincidir con el tipo declarado (sin SVG ni disfraces)', async () => {
    const { service } = setup();
    await expect(
      runWithRequestContext(STAFF, () =>
        service.upload(file(Buffer.from('fake-png-content'), 'image/png')),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      errorCode: 'FILE_TYPE_NOT_ALLOWED',
    });
    await expect(
      runWithRequestContext(STAFF, () =>
        service.upload(file(PDF, 'image/png')),
      ),
    ).rejects.toMatchObject({ errorCode: 'FILE_TYPE_NOT_ALLOWED' });
    await expect(
      runWithRequestContext(STAFF, () =>
        service.upload(file(Buffer.from('<svg/>'), 'image/svg+xml')),
      ),
    ).rejects.toMatchObject({ errorCode: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('límite por tipo: una imagen de más de 5 MB → 413', async () => {
    const { service } = setup();
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    await expect(
      runWithRequestContext(STAFF, () =>
        service.upload(file(big, 'image/png')),
      ),
    ).rejects.toMatchObject({ statusCode: 413, errorCode: 'FILE_TOO_LARGE' });
  });

  it('sin archivo → 422 VALIDATION_ERROR en file', async () => {
    const { service } = setup();
    await expect(
      runWithRequestContext(STAFF, () => service.upload(undefined)),
    ).rejects.toMatchObject({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'file', message: expect.any(String) }],
    });
  });

  it('URL nueva solo para archivos de la organización activa', async () => {
    const { service, storage } = setup();
    const own = `org/${ORG}/labels/2026/09/a.png`;
    await expect(
      runWithRequestContext(STAFF, () => service.signedUrl(own)),
    ).resolves.toMatchObject({ key: own, url: 'https://signed.example/x' });
    await expect(
      runWithRequestContext(STAFF, () =>
        service.signedUrl('org/otra-bodega/labels/2026/09/a.png'),
      ),
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'FILE_NOT_FOUND' });
    await expect(
      runWithRequestContext(STAFF, () => service.signedUrl('../../etc')),
    ).rejects.toMatchObject({ statusCode: 404 });
    // La plataforma lee cualquiera
    await expect(
      runWithRequestContext(
        { userId: 'a', audience: 'STAFF', organizationType: 'PLATFORM' },
        () => service.signedUrl('org/otra-bodega/labels/2026/09/a.png'),
      ),
    ).resolves.toMatchObject({ url: 'https://signed.example/x' });
    storage.exists.mockResolvedValueOnce(false);
    await expect(
      runWithRequestContext(STAFF, () => service.signedUrl(own)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
