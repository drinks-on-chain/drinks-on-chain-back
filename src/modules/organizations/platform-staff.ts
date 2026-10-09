import type { Prisma, PrismaClient } from '@prisma/client';
import { PLATFORM_ORGANIZATION_ID } from './organization.constants';

/**
 * Personal de administración y operaciones activo: a quién se avisa por
 * correo de lo que tiene que decidir o revisar (faltantes, alertas críticas
 * de la cadena; contrato O3 §11).
 */
export async function platformOperationsStaff(
  client: PrismaClient | Prisma.TransactionClient,
): Promise<{ email: string; fullName: string }[]> {
  const rows = await client.membership.findMany({
    where: {
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: { in: ['ADMIN', 'OPERATIONS'] },
      status: 'ACTIVE',
      user: { isActive: true },
    },
    include: { user: { select: { email: true, fullName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => row.user);
}
