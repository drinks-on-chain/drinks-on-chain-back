import { ApiProperty } from '@nestjs/swagger';
import {
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
} from '@prisma/client';

/** Membresía de una persona (contrato O0 §4). */
export class MembershipDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '8d7e2c1a-4b5f-4c3d-9e8f-1a2b3c4d5e6f' })
  organizationId!: string;

  @ApiProperty({
    enum: OrganizationTypeEnum,
    enumName: 'OrganizationType',
    example: OrganizationTypeEnum.WINERY,
  })
  organizationType!: OrganizationTypeEnum;

  @ApiProperty({ example: 'Bodega Kohlberg' })
  organizationName!: string;

  @ApiProperty({
    enum: OrganizationStatusEnum,
    enumName: 'OrganizationStatus',
    example: OrganizationStatusEnum.ACTIVE,
  })
  organizationStatus!: OrganizationStatusEnum;

  @ApiProperty({
    enum: MembershipRoleEnum,
    enumName: 'MembershipRole',
    example: MembershipRoleEnum.OWNER,
    description:
      'Rol en la organización: plataforma (SUPERADMIN, ADMIN, OPERATIONS, SUPPORT), bodega (OWNER, ENOLOGIST, AGRONOMIST, OPERATOR, ACCOUNTANT) o punto de canje (MANAGER, CASHIER)',
  })
  role!: MembershipRoleEnum;

  @ApiProperty({
    enum: MembershipStatusEnum,
    enumName: 'MembershipStatus',
    example: MembershipStatusEnum.ACTIVE,
  })
  status!: MembershipStatusEnum;
}
