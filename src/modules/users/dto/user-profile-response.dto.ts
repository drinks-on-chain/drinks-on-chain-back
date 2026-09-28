import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AudienceEnum, WineryMemberRoleEnum } from '@prisma/client';
import { MembershipDto } from '@modules/organizations/dto/membership.dto';
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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'MP-BOL-2024-9981',
  })
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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+59170012345',
  })
  phoneNumber?: string | null;

  @ApiProperty({ example: 'es' })
  preferredLocale!: string;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-06T20:00:00.000Z',
  })
  lastLoginAt?: Date | null;

  @ApiProperty({ example: '2026-09-06T20:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: [WineryMembershipDto] })
  wineryMemberships!: WineryMembershipDto[];

  @ApiPropertyOptional({ nullable: true, type: WalletResponseDto })
  primaryWallet?: WalletResponseDto | null;
}

/** Preferencias de comunicación (IAM-09). */
export class NotificationPrefsDto {
  @ApiProperty({ example: true })
  lotProgress!: boolean;

  @ApiProperty({ example: true })
  redemptionReminders!: boolean;
}

/**
 * Perfil de 0.1 más la audiencia (contrato O0 §5) y, desde la Ola 1, las
 * preferencias (contrato O1 §1).
 */
export class MeUserDto extends UserProfileResponseDto {
  @ApiProperty({
    enum: AudienceEnum,
    enumName: 'Audience',
    example: AudienceEnum.STAFF,
    description:
      '`STAFF` si tiene al menos una membresía; `CONSUMER` si no tiene ninguna',
  })
  audience!: AudienceEnum;

  @ApiPropertyOptional({ type: NotificationPrefsDto })
  notificationPrefs?: NotificationPrefsDto;

  @ApiPropertyOptional({
    example: false,
    description: 'Consentimiento de promociones (con fecha en el servidor)',
  })
  promotionsConsent?: boolean;
}

/** `GET /v1/users/me` (contrato O0 §5). */
export class MeResponseDto {
  @ApiProperty({ type: MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ type: [MembershipDto] })
  memberships!: MembershipDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f',
    description: 'Organización activa de la sesión (null si no tiene)',
  })
  activeOrganizationId!: string | null;
}
