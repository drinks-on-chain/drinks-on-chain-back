import { Injectable } from '@nestjs/common';
import { ITraceabilityStrategy } from './interfaces/traceability-strategy.interface';
import { WineTraceabilityStrategy } from './wine-traceability.strategy';
import { SinganiTraceabilityStrategy } from './singani-traceability.strategy';
import { BeerTraceabilityStrategy } from './beer-traceability.strategy';
import { BeverageTypeEnum, WineryCategoryEnum } from '@prisma/client';
import { DomainException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';

@Injectable()
export class TraceabilityStrategyFactory {
  constructor(
    private readonly wineStrategy: WineTraceabilityStrategy,
    private readonly singaniStrategy: SinganiTraceabilityStrategy,
    private readonly beerStrategy: BeerTraceabilityStrategy,
  ) {}

  getStrategy(
    type: BeverageTypeEnum | WineryCategoryEnum | string,
  ): ITraceabilityStrategy {
    const normalized = type.toUpperCase();

    if (normalized === 'WINE' || normalized === 'WINERY') {
      return this.wineStrategy;
    }

    if (normalized === 'SINGANI' || normalized === 'DISTILLERY') {
      return this.singaniStrategy;
    }

    if (normalized === 'BEER' || normalized === 'BREWERY') {
      return this.beerStrategy;
    }

    // Default fallback para otros destilados o bebidas
    if (normalized.includes('SINGANI') || normalized.includes('SPIRIT')) {
      return this.singaniStrategy;
    }

    throw new DomainException(
      ErrorCode.TRACEABILITY_STRATEGY_NOT_FOUND,
      `No se encontró una estrategia de trazabilidad registrada para el tipo de bebida "${type}"`,
    );
  }
}
