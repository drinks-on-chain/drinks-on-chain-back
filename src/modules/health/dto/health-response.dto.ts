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
    example: 42.15,
    description: 'Segundos de actividad continua',
  })
  uptime!: number;
}
