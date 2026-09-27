import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { LocalStorageService } from '@shared/storage/local-storage.service';
import {
  ALLOWED_DECLARED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  fileTypeForKey,
} from '@shared/storage/file-type';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { UploadsService } from './uploads.service';
import {
  SignedUrlResponseDto,
  UploadResponseDto,
} from './dto/upload-response.dto';

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Subir un archivo privado (PDF, JPEG, PNG, WEBP, GIF)',
    description:
      'Solo personal de una organización (no consumidores). El tipo se reconoce por el contenido (firma de bytes), no por el nombre ni el MIME declarado; sin SVG. Máximo 5 MB por imagen y 15 MB por PDF. El archivo queda privado bajo el prefijo de la organización activa; se devuelve su `key` (lo que se guarda) y una URL firmada de corta vida para verlo ahora. Para verlo después, `GET /v1/uploads/url?key=`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({
    name: 'folder',
    required: false,
    description:
      'Categoría (ej. "inspections", "labels", "lab-reports", "certificates", "logos"); solo letras, números, "-" y "_"',
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
            'Archivo (PDF hasta 15 MB; JPEG, PNG, WEBP o GIF hasta 5 MB)',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: UploadResponseDto })
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR (falta el archivo) o FILE_TYPE_NOT_ALLOWED (el contenido no es un tipo admitido o no coincide con el declarado)',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 413,
    description: 'FILE_TOO_LARGE: supera el máximo de su tipo',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Consumidor o personal sin organización activa',
    type: ApiErrorResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      fileFilter: (_req, file, callback) => {
        const declared = (file.mimetype ?? '').toLowerCase();
        if (!ALLOWED_DECLARED_MIME_TYPES.has(declared)) {
          return callback(
            new ValidationException(
              [
                {
                  field: 'file',
                  message: `Tipo de archivo no permitido: '${file.mimetype}'. Se admiten JPEG, PNG, WEBP, GIF y PDF.`,
                },
              ],
              'Tipo de archivo no permitido',
              ErrorCode.FILE_TYPE_NOT_ALLOWED,
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
    return this.uploads.upload(file, folder);
  }

  @Get('url')
  @ApiOperation({
    summary: 'URL firmada nueva de un archivo',
    description:
      'Para mostrar un archivo guardado por su `key`. Solo archivos de la organización activa (la plataforma, cualquiera).',
  })
  @ApiQuery({ name: 'key', required: true })
  @ApiResponse({ status: 200, type: SignedUrlResponseDto })
  @ApiNotFoundResponse({
    description: 'FILE_NOT_FOUND: no existe o no es de tu organización',
    type: ApiErrorResponseDto,
  })
  async signedUrl(@Query('key') key: string): Promise<SignedUrlResponseDto> {
    return this.uploads.signedUrl(key);
  }

  /** Lectura de un archivo del driver local con URL firmada (sin sesión). */
  @Get('local')
  @Public()
  @ApiExcludeEndpoint()
  async serveLocal(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!(this.storage instanceof LocalStorageService)) {
      throw new AppException(404, ErrorCode.NOT_FOUND, 'Recurso no encontrado');
    }
    if (!this.storage.verifySignature(key, Number(expires), signature)) {
      throw new AppException(
        403,
        ErrorCode.FORBIDDEN,
        'URL firmada inválida o caducada',
      );
    }
    const type = fileTypeForKey(key);
    if (!type || !(await this.storage.exists(key))) {
      throw new AppException(
        404,
        ErrorCode.FILE_NOT_FOUND,
        'Archivo no encontrado',
      );
    }
    const remaining = Math.max(
      0,
      Number(expires) - Math.floor(Date.now() / 1000),
    );
    res.setHeader('Content-Type', type.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', `private, max-age=${remaining}`);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(this.storage.resolvePath(key));
  }
}
