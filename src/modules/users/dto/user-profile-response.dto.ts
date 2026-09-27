import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRoleEnum, WineryMemberRoleEnum } from '@prisma/client';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';

export class WineryMembershipDto {
  @ApiProperty({ example: 'winery-uuid-1234' })
  wineryId!: string;

  @ApiProperty({ example: 'Bodega Kohlberg' })
  wineryName!: string;

  @ApiProperty({
    enum: WineryMemberRoleEnum,
    example: WineryMemberRoleEnum.ENOLOGIST,
  })
  memberRole!: WineryMemberRoleEnum;

  @ApiPropertyOptional({ example: 'MP-BOL-2024-9981' })
  professionalLicenseNumber?: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '2026-09-06T20:00:00.000Z' })
  joinedAt!: Date;
}

export class UserProfileResponseDto {
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

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiPropertyOptional({ example: '2026-09-06T20:00:00.000Z' })
  lastLoginAt?: Date | null;

  @ApiProperty({ example: '2026-09-06T20:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: [WineryMembershipDto] })
  wineryMemberships!: WineryMembershipDto[];

  @ApiPropertyOptional({ type: WalletResponseDto })
  primaryWallet?: WalletResponseDto | null;
}
