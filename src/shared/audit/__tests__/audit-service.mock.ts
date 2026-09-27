import type { AuditEventInput } from '../audit.types';

/**
 * Doble de `AuditService` para pruebas unitarias con Prisma simulado:
 * `transaction(work, describe)` ejecuta `work` con el mismo simulado de
 * Prisma (como si fuera la transacción) y guarda la entrada descrita en
 * `recorded`.
 */
export function createAuditServiceMock(prismaMock: unknown) {
  const recorded: AuditEventInput[] = [];
  const mock = {
    recorded,
    record: jest.fn(async (_tx: unknown, input: AuditEventInput) => {
      recorded.push(input);
      return { id: 'audit-id', ...input };
    }),
    recordStandalone: jest.fn(async (input: AuditEventInput) => {
      recorded.push(input);
      return { id: 'audit-id', ...input };
    }),
    transaction: jest.fn(
      async <T>(
        work: (tx: unknown) => Promise<T>,
        describe: (result: T) => AuditEventInput,
      ): Promise<T> => {
        const result = await work(prismaMock);
        recorded.push(describe(result));
        return result;
      },
    ),
    verifyChain: jest.fn(),
  };
  return mock;
}
