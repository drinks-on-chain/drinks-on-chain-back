import { Prisma, WineryApplicationStatusEnum } from '@prisma/client';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';

type Client = Pick<Prisma.TransactionClient, 'winery' | 'wineryApplication'>;

/**
 * Solicitudes "abiertas" para el NIT (contrato O1 §3): recibidas, en revisión
 * o con reunión, y las sin verificar cuyo enlace aún vale (una sin verificar
 * caducada no bloquea el NIT).
 */
export function openApplicationWhere(
  now: Date = new Date(),
): Prisma.WineryApplicationWhereInput {
  return {
    OR: [
      {
        status: {
          in: [
            WineryApplicationStatusEnum.RECEIVED,
            WineryApplicationStatusEnum.IN_REVIEW,
            WineryApplicationStatusEnum.MEETING_SCHEDULED,
          ],
        },
      },
      {
        status: WineryApplicationStatusEnum.UNVERIFIED,
        verifyExpiresAt: { gt: now },
      },
    ],
  };
}

/**
 * ¿Hay una bodega (en cualquier estado: el NIT es único en `wineries`) o una
 * solicitud abierta con ese NIT? Se excluyen la solicitud y la bodega de la
 * propia operación.
 */
export async function taxIdTaken(
  client: Client,
  taxId: string,
  except: { applicationId?: string; wineryId?: string } = {},
  now: Date = new Date(),
): Promise<boolean> {
  const [winery, application] = await Promise.all([
    client.winery.findFirst({
      where: {
        taxIdNit: taxId,
        ...(except.wineryId ? { id: { not: except.wineryId } } : {}),
      },
      select: { id: true },
    }),
    client.wineryApplication.findFirst({
      where: {
        taxId,
        ...openApplicationWhere(now),
        ...(except.applicationId ? { id: { not: except.applicationId } } : {}),
      },
      select: { id: true },
    }),
  ]);
  return Boolean(winery || application);
}

export function taxIdTakenError(taxId: string): AppException {
  return new AppException(
    409,
    ErrorCode.ORG_TAX_ID_TAKEN,
    `Ya hay una bodega o una solicitud abierta con el NIT ${taxId}`,
    [{ field: 'taxId', message: 'NIT ya registrado' }],
  );
}

export async function assertTaxIdFree(
  client: Client,
  taxId: string,
  except: { applicationId?: string; wineryId?: string } = {},
): Promise<void> {
  if (await taxIdTaken(client, taxId, except)) {
    throw taxIdTakenError(taxId);
  }
}

/** El registro SENASAG también es único en `wineries`. */
export async function assertSenasagFree(
  client: Pick<Prisma.TransactionClient, 'winery'>,
  senasag: string | null | undefined,
  exceptWineryId?: string,
): Promise<void> {
  if (!senasag) return;
  const other = await client.winery.findFirst({
    where: {
      senasagSanitaryReg: senasag,
      ...(exceptWineryId ? { id: { not: exceptWineryId } } : {}),
    },
    select: { id: true },
  });
  if (other) {
    throw new AppException(
      409,
      ErrorCode.CONFLICT,
      'Ese registro SENASAG ya pertenece a otra bodega',
      [{ field: 'senasagRegistration', message: 'Registro ya usado' }],
    );
  }
}
