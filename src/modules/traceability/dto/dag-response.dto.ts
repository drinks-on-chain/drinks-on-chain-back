import { ApiProperty } from '@nestjs/swagger';

/** Operador que firma una etapa del grafo. */
export class DagOperatorDto {
  @ApiProperty({
    example: 'Lic. Valeria Soliz',
    description:
      'Persona de la membresía que registró la etapa; "No registrado" si no consta',
  })
  name!: string;

  @ApiProperty({
    example: 'ENOLOGIST',
    description: 'Rol en la bodega; `NOT_RECORDED` si no consta',
  })
  role!: string;

  @ApiProperty({ example: 'Destilería Cinti Viejo' })
  wineryName!: string;
}

/** Nodo del grafo (una etapa: parcela, vendimia, vinificación…). */
export class DagNodeDto {
  @ApiProperty({
    example: '0x3f1c…',
    description: 'Hash SHA-256 (0x…) que identifica el nodo en el contrato',
  })
  batchId!: string;

  @ApiProperty({
    example: 4,
    description:
      '0 parcela, 1 vendimia, 2 vinificación, 3 crianza, 4 destilación, 5 embotellado',
  })
  stage!: number;

  @ApiProperty({
    example: 'Distillation',
    enum: [
      'Plot',
      'Harvest',
      'Vinification',
      'Aging',
      'Distillation',
      'Bottling',
    ],
  })
  stageName!: string;

  @ApiProperty({ type: [String], description: 'batchId de los padres' })
  parents!: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  timestamp!: string;

  @ApiProperty({
    example: 1750,
    description: 'Hectáreas, kg, litros o botellas según la etapa',
  })
  volumeOrUnits!: number;

  @ApiProperty({
    type: [Number],
    example: [7020],
    description:
      'Métricas registradas escaladas ×100 (enteros); vacía si la etapa no tiene datos (sin valores de relleno, EA-05)',
  })
  metrics!: number[];

  @ApiProperty({ example: '0x9a0b…' })
  metadataHash!: string;

  @ApiProperty({
    example: false,
    description: 'Expediente del lote cerrado (§10); ya no es un valor fijo',
  })
  isCertified!: boolean;

  @ApiProperty({ type: DagOperatorDto })
  operator!: DagOperatorDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Datos de la etapa (números como números JSON; en el embotellado, `labAnalysis` o `null`)',
  })
  details!: Record<string, unknown>;
}

/** Grafo de trazabilidad de un lote embotellado (DAG y pasaporte público). */
export class DagGraphResponseDto {
  @ApiProperty({ example: '0x5d2e…', description: 'batchId del embotellado' })
  rootBatchId!: string;

  @ApiProperty({ example: 'CVJ-2026-SINGANI-001' })
  internationalLotCode!: string;

  @ApiProperty({ example: 'SINGANI' })
  productType!: string;

  @ApiProperty({ type: [DagNodeDto] })
  nodes!: DagNodeDto[];
}
