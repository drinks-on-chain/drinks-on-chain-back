import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDataDto {
  @ApiProperty({ example: 'ok', description: 'Estado general del servicio' })
  status!: string;

  @ApiProperty({
    example: 'connected',
    description: 'Estado de la conexión a PostgreSQL',
  })
  database!: string;

  @ApiProperty({
    example: 'connected',
    description: 'Estado de la conexión a Redis',
  })
  redis!: string;

  @ApiProperty({
    example: 'connected',
    enum: ['connected', 'disconnected', 'not_configured'],
    description:
      'Estado del almacenamiento de objetos (MinIO/S3 o carpeta local); cuenta en la readiness',
  })
  storage!: 'connected' | 'disconnected' | 'not_configured';

  @ApiProperty({
    example: 42.15,
    description: 'Segundos de actividad continua',
  })
  uptime!: number;
}

export class LivenessDataDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({
    example: 42.15,
    description: 'Segundos de actividad continua',
  })
  uptime!: number;

  @ApiProperty({
    example: 'a928324',
    nullable: true,
    description: 'Release desplegada (RELEASE_SHA), si se conoce',
  })
  release!: string | null;
}
