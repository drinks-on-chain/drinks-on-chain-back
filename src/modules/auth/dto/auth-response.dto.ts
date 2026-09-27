import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRoleEnum } from '@prisma/client';

export class AuthUserDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'juan.perez@bodega.bo' })
  email!: string;

  @ApiProperty({ example: 'Juan Pérez' })
  fullName!: string;

  @ApiProperty({ enum: UserRoleEnum, example: UserRoleEnum.CONSUMER })
  userRole!: UserRoleEnum;

  @ApiPropertyOptional({ example: '+59170012345' })
  phoneNumber?: string | null;

  @ApiProperty({ example: 'es' })
  preferredLocale!: string;

  @ApiPropertyOptional({ example: 'winery-uuid-1234' })
  wineryId?: string | null;

  @ApiPropertyOptional({ example: 'ENOLOGIST' })
  memberRole?: string | null;
}

export class AuthTokensDto {
  @ApiProperty({
    description: 'Token de acceso JWT (válido por 7 días)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'Token de actualización JWT (válido por 30 días)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({
    example: 604800,
    description: 'Tiempo de vida en segundos (7 días)',
  })
  expiresIn!: number;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ type: AuthTokensDto })
  tokens!: AuthTokensDto;
}
