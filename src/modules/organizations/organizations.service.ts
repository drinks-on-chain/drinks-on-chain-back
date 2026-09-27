import { Injectable } from '@nestjs/common';
import {
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  Prisma,
  Winery,
  WineryStatusEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';

/** Estado de la organización equivalente al de la bodega (mismo conjunto). */
export function organizationStatusForWinery(
  status: WineryStatusEnum,
): OrganizationStatusEnum {
  return OrganizationStatusEnum[status];
}

/**
 * Organizaciones (contrato O0 §4). La de una bodega comparte id con la bodega
 * y se escribe en la misma transacción que ella: alta, cambio de nombre
 * comercial y cambio de estado.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crea la organización WINERY de una bodega recién creada. */
  async createForWinery(
    tx: Prisma.TransactionClient,
    winery: Pick<Winery, 'id' | 'commercialName' | 'certificationStatus'>,
  ) {
    return tx.organization.create({
      data: {
        id: winery.id,
        type: OrganizationTypeEnum.WINERY,
        name: winery.commercialName,
        status: organizationStatusForWinery(winery.certificationStatus),
        wineryId: winery.id,
      },
    });
  }

  /** Copia nombre comercial y estado de la bodega a su organización. */
  async syncWinery(
    tx: Prisma.TransactionClient,
    winery: Pick<Winery, 'id' | 'commercialName' | 'certificationStatus'>,
  ) {
    return tx.organization.upsert({
      where: { id: winery.id },
      create: {
        id: winery.id,
        type: OrganizationTypeEnum.WINERY,
        name: winery.commercialName,
        status: organizationStatusForWinery(winery.certificationStatus),
        wineryId: winery.id,
      },
      update: {
        name: winery.commercialName,
        status: organizationStatusForWinery(winery.certificationStatus),
      },
    });
  }

  async findWinery(organizationId: string) {
    return this.prisma.organization.findFirst({
      where: { id: organizationId, type: OrganizationTypeEnum.WINERY },
    });
  }
}
