import { Readable } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { UploadsController } from '../uploads.controller';
import {
  STORAGE_SERVICE,
  IStorageService,
} from '../../../shared/storage/storage.interface';

describe('UploadsController', () => {
  let controller: UploadsController;
  let mockStorageService: jest.Mocked<IStorageService>;

  beforeEach(async () => {
    mockStorageService = {
      uploadFile: jest.fn(),
      deleteFile: jest.fn(),
      getFileUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorageService,
        },
      ],
    }).compile();

    controller = module.get<UploadsController>(UploadsController);
  });

  it('debe estar definido', () => {
    expect(controller).toBeDefined();
  });

  describe('uploadFile', () => {
    it('debe delegar en storageService.uploadFile y devolver UploadResponseDto', async () => {
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'informe.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF test'),
        size: 512,
        stream: Readable.from([]),
        destination: '',
        filename: '',
        path: '',
      };

      mockStorageService.uploadFile.mockResolvedValue({
        url: 'http://localhost:3000/uploads/inspections/12345.pdf',
        key: 'inspections/12345.pdf',
        originalName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512,
      });

      const response = await controller.uploadFile(mockFile, 'inspections');

      expect(mockStorageService.uploadFile).toHaveBeenCalledWith(
        mockFile,
        'inspections',
      );
      expect(response).toEqual({
        url: 'http://localhost:3000/uploads/inspections/12345.pdf',
        key: 'inspections/12345.pdf',
        originalName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512,
      });
    });

    it('debe lanzar 422 VALIDATION_ERROR en file si no se envía ningún archivo', async () => {
      await expect(
        controller.uploadFile(null as unknown as Express.Multer.File),
      ).rejects.toMatchObject({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        details: [{ field: 'file', message: expect.any(String) }],
      });
    });
  });
});
