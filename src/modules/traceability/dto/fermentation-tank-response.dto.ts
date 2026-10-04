import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CorrectableResponseDto } from '@modules/lots/dto/correction-marks.dto';
import { TankStatusEnum, DestinationTypeEnum } from '@prisma/client';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';
import { HarvestBatchResponseDto } from '@modules/harvest-batches/dto/harvest-batch-response.dto';
import {
  EnologicalTreatmentResponseDto,
  FermentationLogResponseDto,
} from './fermentation-records-response.dto';

/** Entrada de uva al tanque (§4.1). */
export class TankInputResponseDto {
  @ApiProperty({ format: 'uuid' })
  harvestBatchId!: string;

  @ApiProperty({ example: 12100 })
  kg!: number;
}

/** Paso del tanque por un estado (§4.2). */
export class TankTransitionResponseDto {
  @ApiProperty({ enum: TankStatusEnum, example: TankStatusEnum.COMPLETED })
  status!: TankStatusEnum;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: 'Quién lo registró (`null` = no registrado)',
  })
  by!: TraceActorDto | null;
}

export class FermentationTankResponseDto extends CorrectableResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  harvestBatchId!: string;

  @ApiProperty({ example: 'TK-03' })
  tankCode!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 15000.0 })
  capacityLiters?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Acero inoxidable AISI 316',
  })
  material?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 10100.0 })
  volumeFilledLiters?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: DestinationTypeEnum,
    example: DestinationTypeEnum.SINGANI_DIST,
  })
  destinationType?: DestinationTypeEnum | null;

  @ApiProperty({ enum: TankStatusEnum, example: TankStatusEnum.FERMENTING })
  status!: TankStatusEnum;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  startDate!: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-03-29T14:30:00.000Z',
  })
  endDate?: Date | null;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Lote (Ola 2)',
  })
  lotId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Volumen al completar la fermentación (Ola 2)',
  })
  finalVolumeLiters!: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 0,
    description:
      'Litros que quedan por transferir: el volumen final (o el de llenado) menos lo que ya pasó a la crianza o a las destilaciones; 0 con el tanque `TRANSFERRED` o `CLEANED` (lista y detalle)',
  })
  availableLiters?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 100,
    description:
      'Merma de trasiego: lo que quedó sin transferir al pasar a `TRANSFERRED`; `null` mientras el tanque no se ha transferido (lista y detalle)',
  })
  transferLossLiters?: number | null;

  @ApiPropertyOptional({
    type: () => TankTransitionResponseDto,
    isArray: true,
    description:
      'Historial de estados, empezando por el llenado (lista y detalle)',
  })
  transitions?: TankTransitionResponseDto[];

  @ApiPropertyOptional({
    type: () => TankInputResponseDto,
    isArray: true,
    description:
      'Pesajes que entraron al tanque, con sus kilos (lista y detalle)',
  })
  inputs?: TankInputResponseDto[];

  @ApiPropertyOptional({
    type: () => HarvestBatchResponseDto,
    description: 'En la lista y el detalle',
  })
  harvestBatch?: HarvestBatchResponseDto;

  @ApiPropertyOptional({
    type: () => FermentationLogResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  logs?: FermentationLogResponseDto[];

  @ApiPropertyOptional({
    type: () => EnologicalTreatmentResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  treatments?: EnologicalTreatmentResponseDto[];
}
