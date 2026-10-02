import { ApiProperty } from '@nestjs/swagger';

export class SignedUrlResponseDto {
  @ApiProperty({
    description:
      'Clave del archivo en el almacenamiento privado. Es lo que se guarda en los registros; la URL se pide de nuevo cuando se va a mostrar.',
    example:
      'org/0b5c1f3e-8a2d-4c1e-9f7a-2d3e4f5a6b7c/inspections/2026/09/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d.pdf',
  })
  key!: string;

  @ApiProperty({
    description:
      'URL firmada de lectura, de corta vida (15 min por defecto). No se guarda: caduca.',
    example:
      'https://storage.example.com/doc-uploads/org/…/inspections/2026/09/….pdf?X-Amz-Signature=…',
  })
  url!: string;

  @ApiProperty({
    description: 'Momento en que caduca la URL (ISO 8601, UTC)',
    example: '2026-09-27T12:15:00.000Z',
  })
  expiresAt!: string;
}

export class UploadResponseDto extends SignedUrlResponseDto {
  @ApiProperty({
    description: 'Nombre original del archivo',
    example: 'certificado_fitosanitario_2026.pdf',
  })
  originalName!: string;

  @ApiProperty({
    description: 'Tipo real del archivo, reconocido por su contenido',
    example: 'application/pdf',
    enum: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
    ],
  })
  mimeType!: string;

  @ApiProperty({ description: 'Tamaño en bytes del archivo', example: 204850 })
  sizeBytes!: number;

  @ApiProperty({
    description:
      'Huella SHA-256 (hexadecimal) del contenido: la que guardan los registros de la trazabilidad junto a la `key` (contrato O2 §0)',
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    pattern: '^[0-9a-f]{64}$',
  })
  sha256!: string;
}
