import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Query,
  UseGuards,
  Inject,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../shared/storage/storage.interface';
import { UploadResponseDto } from './dto/upload-response.dto';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';

const ALLOWED_MIME_TYPES = [
  // Imágenes
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
  // Documentos
  'application/pdf',
];

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

@ApiTags('Uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storageService: IStorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Subir archivo o imagen (PDF, JPG, PNG, WEBP, SVG)',
    description:
      'Almacena un archivo localmente o en el servicio externo configurado (S3/Cloud). Retorna la URL pública accesible que debe asociarse al flujo correspondiente (inspección fitosanitaria, certificados D.O., etiqueta de lote o informe de laboratorio).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({
    name: 'folder',
    required: false,
    description:
      'Subcarpeta o categoría de destino (ej. "inspections", "labels", "lab-reports", "certificates", "logos")',
    example: 'inspections',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Archivo binario a subir (Máx 15MB. Formatos: PDF, JPEG, PNG, WEBP, SVG, GIF)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Archivo almacenado con éxito.',
    type: UploadResponseDto,
  })
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR en `file`: archivo faltante o tipo MIME no permitido.',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 413,
    description: 'El archivo excede el tamaño máximo (15MB).',
    type: ApiErrorResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
      },
      fileFilter: (_req, file, callback) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          return callback(
            ValidationException.forField(
              'file',
              `Tipo de archivo no permitido: '${file.mimetype}'. Se permiten únicamente imágenes (JPEG, PNG, WEBP, SVG, GIF) y documentos PDF.`,
            ),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ): Promise<UploadResponseDto> {
    if (!file) {
      throw ValidationException.forField(
        'file',
        'Debe proporcionar un archivo en el campo multipart/form-data "file".',
      );
    }

    const result = await this.storageService.uploadFile(file, folder);

    return {
      url: result.url,
      key: result.key,
      originalName: result.originalName,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
    };
  }
}
