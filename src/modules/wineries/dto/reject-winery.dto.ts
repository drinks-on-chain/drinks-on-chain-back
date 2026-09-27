import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RejectWineryDto {
  @ApiProperty({
    example:
      'Registro sanitario SENASAG inválido o documentación de constitución incompleta.',
    description: 'Motivo formal del rechazo de la solicitud de bodega',
  })
  @IsString()
  @IsNotEmpty({ message: 'El motivo de rechazo es obligatorio' })
  @MaxLength(500)
  rejectionReason!: string;
}
