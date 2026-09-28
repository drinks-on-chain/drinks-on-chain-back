import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * `POST /v1/auth/switch-organization` (contrato O0 §5). El refresco de la
 * sesión viaja solo en la cookie `doc_rt` (el cuerpo dejó de aceptarlo en H1).
 */
export class SwitchOrganizationDto {
  @ApiProperty({ example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f' })
  @IsUUID('all', { message: 'organizationId debe ser un UUID' })
  organizationId!: string;
}
