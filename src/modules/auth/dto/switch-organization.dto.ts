import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** `POST /v1/auth/switch-organization` (contrato O0 §5). */
export class SwitchOrganizationDto {
  @ApiProperty({ example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f' })
  @IsUUID('all', { message: 'organizationId debe ser un UUID' })
  organizationId!: string;

  @ApiPropertyOptional({
    description:
      'Compatibilidad hasta H1: el refresco, si el cliente no usa la cookie `doc_rt`',
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}
