import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty({
    description:
      'URL pública completa accesible para consultar o descargar el archivo',
    example:
      'http://localhost:3000/uploads/inspections/1742880000000-a1b2c3d4.pdf',
  })
  url!: string;

  @ApiProperty({
    description: 'Ruta relativa / clave de almacenamiento único',
    example: 'inspections/1742880000000-a1b2c3d4.pdf',
  })
  key!: string;

  @ApiProperty({
    description: 'Nombre original del archivo',
    example: 'certificado_fitosanitario_2026.pdf',
  })
  originalName!: string;

  @ApiProperty({
    description: 'Tipo MIME del archivo',
    example: 'application/pdf',
  })
  mimeType!: string;

  @ApiProperty({
    description: 'Tamaño en bytes del archivo',
    example: 204850,
  })
  sizeBytes!: number;
}
