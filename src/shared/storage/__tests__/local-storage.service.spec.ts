import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LocalStorageService } from '../local-storage.service';

describe('LocalStorageService', () => {
  let service: LocalStorageService;
  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'STORAGE_LOCAL_PATH') return './test-uploads';
      if (key === 'STORAGE_BASE_URL') return 'http://localhost:3000/uploads';
      if (key === 'PORT') return 3000;
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStorageService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<LocalStorageService>(LocalStorageService);
  });

  afterAll(async () => {
    // Limpiar carpeta de pruebas
    const testDir = path.resolve(process.cwd(), './test-uploads');
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignorar si no existe
    }
  });

  it('debe estar definido', () => {
    expect(service).toBeDefined();
  });

  describe('uploadFile', () => {
    it('debe almacenar exitosamente un archivo y retornar StoredFileResult', async () => {
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'inspeccion-uva.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test content'),
        size: 21,
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      const result = await service.uploadFile(mockFile, 'inspections');

      expect(result).toBeDefined();
      expect(result.originalName).toBe('inspeccion-uva.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sizeBytes).toBe(21);
      expect(result.key).toMatch(/^inspections\/\d+-[a-f0-9-]+\.pdf$/);
      expect(result.url).toBe(`http://localhost:3000/uploads/${result.key}`);

      // Verificar que el archivo realmente se escribió en disco
      const fullPath = path.resolve(process.cwd(), './test-uploads', result.key);
      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Limpiar archivo creado
      await service.deleteFile(result.key);
    });

    it('debe lanzar BadRequestException si el archivo o su buffer son nulos', async () => {
      await expect(service.uploadFile(null as any)).rejects.toThrow(BadRequestException);
    });

    it('debe sanitizar carpetas con caracteres maliciosos para prevenir Directory Traversal', async () => {
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'foto.png',
        encoding: '7bit',
        mimetype: 'image/png',
        buffer: Buffer.from('fake image'),
        size: 10,
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      // Intento de directory traversal ../../etc
      const result = await service.uploadFile(mockFile, '../../etc/malicious');

      // Debe haber limpiado los slashes y puntos
      expect(result.key).not.toContain('..');
      expect(result.key).toMatch(/^etcmalicious\/\d+-[a-f0-9-]+\.png$/);

      await service.deleteFile(result.key);
    });
  });

  describe('getFileUrl', () => {
    it('debe formatear correctamente la URL pública', () => {
      const url = service.getFileUrl('labels/etiqueta-01.png');
      expect(url).toBe('http://localhost:3000/uploads/labels/etiqueta-01.png');
    });
  });
});
