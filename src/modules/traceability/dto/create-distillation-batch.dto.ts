import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsDateString,
  IsBoolean,
  Max,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `POST /v1/production-batches/distillation` (contrato O2 §5.2): abre la
 * destilación con el vino base que entra. El fin, los cortes tipados y el
 * grado del corazón van en `POST /v1/production-batches/{id}/close`.
 */
export class CreateDistillationBatchDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description:
      'Tanque `COMPLETED` con destino `SINGANI_DIST` del que sale el vino base',
  })
  @IsUUID()
  @IsNotEmpty()
  fermentationTankId!: string;

  @ApiProperty({
    example: 'Alambique de Cobre Charentais AL-01 (1,500 L)',
    description: 'Identificador del equipo de destilación',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentIdentifier!: string;

  @ApiProperty({
    example: '2026-04-01',
    description:
      'Inicio de la destilación (YYYY-MM-DD): no futuro ni anterior al fin de la fermentación',
  })
  @IsDateString()
  @IsNotEmpty()
  processStartDate!: string;

  @ApiProperty({
    example: 10000.0,
    description:
      'Vino base cargado al alambique (litros): ≤ lo disponible del tanque',
  })
  @IsNumber()
  @IsPositive()
  inputVolumeLiters!: number;

  @ApiPropertyOptional({
    example: 11.8,
    description: 'Grado alcohólico del vino base que entra (% v/v)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(100)
  initialAlcoholPercentage?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'Última destilación del tanque: pasa a `TRANSFERRED` aunque le quede volumen (queda como merma de trasiego). Sin él, el tanque se transfiere solo al agotarse su volumen (contrato O2 §4.2)',
  })
  @IsOptional()
  @IsBoolean()
  closeTank?: boolean;

  @ApiPropertyOptional({
    example:
      'Destilación lenta a fuego directo con separación estricta de cabezas',
    description: 'Notas del maestro destilador',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
