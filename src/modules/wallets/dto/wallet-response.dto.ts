import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletPurposeEnum, WalletTypeEnum } from '@prisma/client';

export class WalletResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  userId!: string;

  @ApiPropertyOptional({ example: 'winery-uuid-1234' })
  wineryId?: string | null;

  @ApiProperty({
    example: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
    description: 'Dirección pública de Stellar (56 caracteres)',
  })
  stellarPublicAddress!: string;

  @ApiProperty({ enum: WalletTypeEnum, example: WalletTypeEnum.CUSTODIAL })
  walletType!: WalletTypeEnum;

  @ApiProperty({
    enum: WalletPurposeEnum,
    example: WalletPurposeEnum.CONSUMER_NFT,
  })
  walletPurpose!: WalletPurposeEnum;

  @ApiProperty({ example: true })
  isPrimary!: boolean;

  @ApiProperty({ example: '2026-09-06T20:00:00.000Z' })
  createdAt!: Date;
}
