import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Marcas de corrección de un registro de la trazabilidad (contrato O2 §9):
 * el recurso devuelve siempre el **valor vigente** (con sus correcciones) y
 * dice qué campos se corrigieron, si está anulado y con qué correcciones. El
 * valor original está en `changes[].before` de cada corrección
 * (`GET /v1/lots/{id}/corrections`).
 *
 * Solo las llevan los registros que responde su propia ruta; los anidados
 * dentro de otro recurso pueden no traerlas.
 */
export class CorrectableResponseDto {
  @ApiPropertyOptional({
    type: String,
    isArray: true,
    example: ['grossWeightKg'],
    description: 'Campos con el valor corregido (vacío si nunca se corrigió)',
  })
  correctedFields?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'Anulado por una corrección `VOID`: el registro ya no cuenta',
  })
  voided?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    isArray: true,
    description: 'Correcciones del registro, de la más antigua a la más nueva',
  })
  correctionIds?: string[];
}
