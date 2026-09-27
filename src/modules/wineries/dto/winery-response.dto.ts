import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  WineryCategoryEnum,
  WineryStatusEnum,
  WineryMemberRoleEnum,
} from '@prisma/client';

export class WineryMemberItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  userId!: string;

  @ApiProperty({ example: 'Valeria Soliz' })
  fullName!: string;

  @ApiProperty({ example: 'enologo@kohlberg.bo' })
  email!: string;

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

export class WineryResponseDto {
  @ApiProperty({ example: 'winery-uuid-1234' })
  id!: string;

  @ApiProperty({ example: 'Sociedad Agroindustrial Kohlberg S.A.' })
  legalName!: string;

  @ApiProperty({ example: 'Bodega Kohlberg' })
  commercialName!: string;

  @ApiProperty({ enum: WineryCategoryEnum, example: WineryCategoryEnum.WINERY })
  beverageCategory!: WineryCategoryEnum;

  @ApiProperty({ example: '1028374029' })
  taxIdNit!: string;

  @ApiPropertyOptional({ example: '08-01-03-01-0001' })
  senasagSanitaryReg?: string | null;

  @ApiProperty({ example: 'Valle Central de Tarija' })
  geographicRegion!: string;

  @ApiProperty({ example: 'BO' })
  countryCode!: string;

  @ApiPropertyOptional({ example: 'Km 15 Carretera a Bermejo' })
  address?: string | null;

  @ApiProperty({ example: 'contacto@kohlberg.bo' })
  contactEmail!: string;

  @ApiPropertyOptional({ example: '+59146642345' })
  contactPhone?: string | null;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/logos/kohlberg.png',
  })
  logoUrl?: string | null;

  @ApiPropertyOptional({
    example: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
  })
  stellarPublicKey?: string | null;

  @ApiPropertyOptional({ example: 'PROD_BO_1028374029' })
  onchainProducerId?: string | null;

  @ApiPropertyOptional({ example: '0x_simulated_tx_88a1b2c3' })
  onchainRegisterTxHash?: string | null;

  @ApiProperty({ example: false })
  isExportCertified!: boolean;

  @ApiProperty({ enum: WineryStatusEnum, example: WineryStatusEnum.PENDING })
  certificationStatus!: WineryStatusEnum;

  @ApiPropertyOptional({ example: '2026-09-06T21:00:00.000Z' })
  approvedAt?: Date | null;

  @ApiProperty({ example: '2026-09-06T20:00:00.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({ type: [WineryMemberItemDto] })
  members?: WineryMemberItemDto[];
}
