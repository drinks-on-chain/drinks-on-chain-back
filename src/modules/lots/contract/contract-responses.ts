import { HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';

/**
 * Respuestas de error comunes de las rutas del contrato de la Ola 2 que se
 * publican en la apertura (§16.1) con `501` hasta que llega su paso.
 */

/** 501 `NOT_IMPLEMENTED` de una ruta cuya lógica llega con el paso `step`. */
export const ApiNotImplemented = (step: string) =>
  ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    type: ApiErrorResponseDto,
    description: `NOT_IMPLEMENTED: llega con el paso ${step} de la Etapa 2`,
  });

/** Error con el envoltorio común; la descripción lista los códigos (§13). */
export const ApiErrorCodes = (status: number, codes: readonly string[]) =>
  ApiResponse({
    status,
    type: ApiErrorResponseDto,
    description: codes.join(', '),
  });

/** 404 del lote (inexistente o de otra bodega; nunca 403). */
export const ApiLotNotFound = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND']);

/** Escritura de la trazabilidad: la plataforma solo lee (S-25). */
export const ApiPlatformReadOnly = () =>
  ApiErrorCodes(HttpStatus.FORBIDDEN, ['TRC_PLATFORM_READ_ONLY']);

/**
 * 422 de una operación con cuerpo: `VALIDATION_ERROR` más los códigos de
 * regla que puede devolver (§13).
 */
export const ApiRuleErrors = (codes: readonly string[] = []) =>
  ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, [
    'VALIDATION_ERROR',
    ...codes,
  ]);
