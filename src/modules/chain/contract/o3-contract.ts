import { HttpStatus } from '@nestjs/common';
import { ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { MembershipRole } from '@modules/organizations/organization.constants';

/**
 * Apertura de la Ola 3 (contrato O3 §12.1): las rutas de la cadena y la
 * tokenización se publican en el OpenAPI con su forma definitiva y responden
 * `501 NOT_IMPLEMENTED` hasta que llega su paso de la Etapa 3 (docs-back/08
 * §7). Las comprobaciones de sesión, organización, rol, `Idempotency-Key`,
 * `reason` y cuerpo ya son las reales: un 501 significa "llegaste hasta la
 * lógica, que aún no existe".
 */
export type O3Step = '3.1' | '3.2' | '3.3' | '3.4' | '3.5' | '3.6';

const STEP_NAMES: Record<O3Step, string> = {
  '3.1': 'Firmante y transacciones',
  '3.2': 'Identidad de la bodega',
  '3.3': 'Solicitud de tokenización',
  '3.4': 'Emisión y preventa',
  '3.5': 'Anclaje',
  '3.6': 'Conciliación y cierre',
};

/** 501 `NOT_IMPLEMENTED` de una ruta cuya lógica llega con el paso `step`. */
export function notImplementedO3(step: O3Step): AppException {
  return new AppException(
    HttpStatus.NOT_IMPLEMENTED,
    ErrorCode.NOT_IMPLEMENTED,
    `Ruta del contrato de la Ola 3 aún sin lógica (llega con el paso ${step} de la Etapa 3: ${STEP_NAMES[step]})`,
    [
      {
        field: null,
        message: `Disponible con el paso ${step}; mientras tanto, usa los mocks`,
        meta: { step },
      },
    ],
  );
}

/**
 * Los errores van siempre en JSON con el envoltorio común, también en las
 * rutas que producen otro tipo (`text/plain`, una imagen): por eso el
 * contenido se declara explícito y no con `type`.
 */
const ERROR_CONTENT = {
  'application/json': {
    schema: { $ref: getSchemaPath(ApiErrorResponseDto) },
  },
};

export const ApiNotImplementedO3 = (step: O3Step) =>
  ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    content: ERROR_CONTENT,
    description: `NOT_IMPLEMENTED: llega con el paso ${step} de la Etapa 3 (${STEP_NAMES[step]})`,
  });

/** Error con el envoltorio común; la descripción lista los códigos (§9). */
export const ApiErrorCodes = (status: number, codes: readonly string[]) =>
  ApiResponse({
    status,
    content: ERROR_CONTENT,
    description: codes.join(', '),
  });

export const ApiRoleForbidden = () =>
  ApiErrorCodes(HttpStatus.FORBIDDEN, ['AUTH_INSUFFICIENT_PERMISSIONS (rol)']);

/** 422 de una operación con cuerpo o filtros: `VALIDATION_ERROR` más sus reglas. */
export const ApiRuleErrors = (codes: readonly string[] = []) =>
  ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, [
    'VALIDATION_ERROR',
    ...codes,
  ]);

/** Miembros de una bodega que leen su tokenización (§10). */
export const WINERY_TOKENIZATION_READERS: MembershipRole[] = [
  'OWNER',
  'ENOLOGIST',
  'ACCOUNTANT',
];
/** Todos los miembros de la bodega (cuenta de la bodega, ORG-12). */
export const WINERY_MEMBERS: MembershipRole[] = [
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
];
/** Lista de NFT y cierre con faltante en el ERP. */
export const WINERY_TOKEN_READERS: MembershipRole[] = ['OWNER', 'ACCOUNTANT'];
