import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhytoStatusEnum } from '@prisma/client';

export class UpdatePhytoStatusDto {
  @ApiProperty({
    enum: PhytoStatusEnum,
    example: PhytoStatusEnum.APPROVED,
    description: 'Nuevo dictamen fitosanitario',
  })
  @IsEnum(PhytoStatusEnum)
  @IsNotEmpty()
  phytosanitaryStatus!: PhytoStatusEnum;

  @ApiPropertyOptional({
    example: 'https://storage.drinksonchain.com/inspections/phyto-2026-04.pdf',
    description: 'URL del informe o acta de inspección fitosanitaria firmada',
  })
  @IsOptional()
  @IsUrl()
  phytoInspectionPdfUrl?: string;

  @ApiPropertyOptional({
    example: 'Lote aprobado sin presencia de botritis ni plagas cuarentenarias.',
    description: 'Notas o justificación del dictamen enológico/agronómico',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
