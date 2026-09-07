import { UserRoleEnum } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  userRole: UserRoleEnum;
  wineryId?: string | null;
  memberRole?: string | null;
  iat?: number;
  exp?: number;
}
