import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'Token de actualización JWT emitido previamente en el login o registro',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsString({ message: 'El refreshToken debe ser una cadena de texto válida' })
  @IsNotEmpty({ message: 'El refreshToken es requerido' })
  refreshToken!: string;
}
