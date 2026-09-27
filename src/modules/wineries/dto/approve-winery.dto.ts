import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveWineryDto {
  @ApiPropertyOptional({
    example:
      'Verificación legal y sanitaria SENASAG completada satisfactoriamente.',
    description: 'Notas u observaciones del Platform Admin en la aprobación',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approvalNotes?: string;
}
