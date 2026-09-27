import { ApiProperty } from '@nestjs/swagger';

/** Detalle de un error (contrato O0 §1). */
export class ErrorDetailDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'grossWeightKg',
    description:
      'Campo con notación de puntos para los anidados (`items.0.quantity`); `null` si el error no es de un campo',
  })
  field!: string | null;

  @ApiProperty({ example: 'grossWeightKg must be a positive number' })
  message!: string;
}

export class ErrorBodyDto {
  @ApiProperty({
    example: 'VALIDATION_ERROR',
    description: 'Código estable con prefijo de dominio (ver docs/rules/03)',
  })
  code!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiProperty({
    type: [ErrorDetailDto],
    nullable: true,
    description: 'Lista de `{ field, message }` o `null`',
  })
  details!: ErrorDetailDto[] | null;
}

/** Envoltorio de error de la API (contrato O0 §1). */
export class ApiErrorResponseDto {
  @ApiProperty({ example: false, enum: [false] })
  success!: false;

  @ApiProperty({ example: 422 })
  statusCode!: number;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: '/v1/harvest-batches' })
  path!: string;

  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}
