import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDataDto {
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'degraded'],
    description:
      'Estado general. En `/health`: base de datos y Redis. En `/health/ready`: `ok` si todo está bien; `degraded` si falta una dependencia (503) o solo el worker (200: la API sirve, pero no se procesan colas ni correos)',
  })
  status!: 'ok' | 'degraded';

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
    example: 'up',
    enum: ['up', 'down'],
    description:
      'Worker (outbox, colas, correo): `up` si su latido en Redis es reciente (`WORKER_HEARTBEAT_MAX_AGE_MS`). No hace fallar la readiness',
  })
  worker!: 'up' | 'down';

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
    type: String,
    example: 'a928324',
    nullable: true,
    description: 'Release desplegada (RELEASE_SHA), si se conoce',
  })
  release!: string | null;
}
