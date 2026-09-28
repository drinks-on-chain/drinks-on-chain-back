import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@modules/auth/decorators/public.decorator';
import { PublicWineryProfileDto } from '@modules/winery-management/dto/winery.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { PublicWineriesQueryDto } from './dto/public-wineries.dto';
import { PublicWineriesDirectoryService } from './public-wineries-directory.service';

/**
 * Directorio público de bodegas (contrato O2 §12.1, O2-WEB-1). El perfil de
 * una bodega (`GET /v1/public/wineries/{slug}`) sigue en
 * `PublicWineriesController`; esta ruta literal no choca con él.
 */
@ApiTags('Público')
@Controller('public/wineries')
export class PublicWineriesDirectoryController {
  constructor(private readonly directory: PublicWineriesDirectoryService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Directorio público de bodegas',
    description:
      'Solo bodegas `ACTIVE`, ordenadas por nombre comercial, con la forma de `GET /v1/public/wineries/{slug}`. ' +
      'Filtros opcionales: `region` (coincidencia parcial) y `category`. Sin sesión.',
  })
  @ApiPaginatedResponse(PublicWineryProfileDto, {
    description: 'Página de perfiles públicos',
  })
  async list(
    @Query() query: PublicWineriesQueryDto,
  ): Promise<Paginated<PublicWineryProfileDto>> {
    return this.directory.list(query);
  }
}
