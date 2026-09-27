import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import {
  OPTIONAL_AUTH_OPERATION_EXTENSION,
  PUBLIC_OPERATION_EXTENSION,
} from '../../../openapi/openapi';

export const IS_PUBLIC_KEY = 'isPublic';
export const OPTIONAL_AUTH_KEY = 'optionalAuth';

/**
 * Ruta sin autenticación. En OpenAPI la operación queda sin candado
 * (`security: []`), aunque el controlador declare `@ApiBearerAuth()`.
 */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(PUBLIC_OPERATION_EXTENSION, true),
  );

/**
 * Ruta pública que también acepta una sesión: si llega `Authorization`, el
 * guard de acceso lo valida como en una privada (401 si no vale) y deja la
 * persona en `request.user`; si no llega, sigue sin persona. Se usa con
 * `@Public()` (p. ej. aceptar una invitación con la cuenta existente).
 */
export const OptionalAuth = () =>
  applyDecorators(
    SetMetadata(OPTIONAL_AUTH_KEY, true),
    ApiExtension(OPTIONAL_AUTH_OPERATION_EXTENSION, true),
  );
