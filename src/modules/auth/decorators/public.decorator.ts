import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { PUBLIC_OPERATION_EXTENSION } from '../../../openapi/openapi';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Ruta sin autenticación. En OpenAPI la operación queda sin candado
 * (`security: []`), aunque el controlador declare `@ApiBearerAuth()`.
 */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(PUBLIC_OPERATION_EXTENSION, true),
  );
