import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { NullableFields } from '@shared/pipes/optional-nulls';
import {
  COLLECTION_MAX_IMAGES,
  PRICE_CURRENCIES,
  PRICE_SOURCES,
  type PriceCurrency,
  type PriceSource,
} from '../tokenization.constants';

/**
 * Datos comerciales y precio de una colección (contrato O3 §5.5; TOK-03,
 * TOK-04; A-32). Dinero: entero de centavos en `BOB`; el precio puede faltar.
 */

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class UserRefDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  fullName!: string;
}

// ── Precio ─────────────────────────────────────────────────────────────────

export class CollectionPriceInputDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 18000,
    description: 'Centavos de boliviano (180,00 Bs = 18000)',
  })
  @IsInt({ message: 'amountMinor debe ser un entero de centavos' })
  @Min(1, { message: 'amountMinor debe ser al menos 1' })
  amountMinor!: number;

  @ApiProperty({ enum: PRICE_CURRENCIES, enumName: 'PriceCurrency' })
  @IsIn(PRICE_CURRENCIES, { message: 'La moneda debe ser BOB' })
  currency!: PriceCurrency;
}

export class CollectionPriceDto {
  @ApiProperty({ type: 'integer', minimum: 1, example: 18000 })
  amountMinor!: number;

  @ApiProperty({ enum: PRICE_CURRENCIES, enumName: 'PriceCurrency' })
  currency!: PriceCurrency;

  @ApiProperty({ enum: PRICE_SOURCES, enumName: 'PriceSource' })
  source!: PriceSource;

  @ApiProperty({ format: 'date-time' })
  setAt!: string;

  @ApiProperty({ type: () => UserRefDto })
  setBy!: UserRefDto;
}

/** `precio.politica` sin definir (hoy): no hay sugerencia. */
export class PriceSuggestionUnavailableDto {
  @ApiProperty({ type: Boolean, enum: [false] })
  available!: false;

  @ApiProperty({ enum: ['POLICY_UNDEFINED'] })
  reason!: 'POLICY_UNDEFINED';
}

export class PriceSuggestionAvailableDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  available!: true;

  @ApiProperty({ type: 'integer', minimum: 1 })
  amountMinor!: number;

  @ApiProperty({ enum: PRICE_CURRENCIES, enumName: 'PriceCurrency' })
  currency!: PriceCurrency;

  @ApiProperty({ enum: ['GLOBAL', 'WINERY'] })
  source!: 'GLOBAL' | 'WINERY';

  @ApiProperty({ example: '2026-10-01T12:00:00.000Z' })
  policyVersion!: string;
}

export type PriceSuggestionDto =
  PriceSuggestionUnavailableDto | PriceSuggestionAvailableDto;

// ── Datos comerciales ──────────────────────────────────────────────────────

export class CollectionImageInputDto {
  @ApiProperty({
    example:
      'org/3fa85f64-5717-4562-b3fc-2c963f66afa6/collections/2026/10/a1b2.jpg',
    description: '`key` de `POST /v1/uploads` (una imagen)',
  })
  @IsString({ message: 'key debe ser un texto' })
  @Length(1, 500)
  key!: string;

  @ApiProperty({
    maxLength: 300,
    example: 'Botella de Singani Preventa 2026 sobre una barrica',
    description: 'Texto alternativo',
  })
  @Transform(trim)
  @IsString({ message: 'alt debe ser un texto' })
  @Length(1, 300, { message: 'alt debe tener entre 1 y 300 caracteres' })
  alt!: string;

  @ApiPropertyOptional({ description: 'Portada (una sola)' })
  @IsOptional()
  @IsBoolean({ message: 'isCover debe ser true o false' })
  isCover?: boolean;
}

/**
 * Lo que envía la bodega y completa operaciones. Todos los campos son
 * opcionales en la entrada (`Partial<CollectionCommercialInput>`); para
 * **aprobar** hacen falta `name`, `description` y una imagen de portada (S-10)
 * → 422 `TOK_COMMERCIAL_DATA_INCOMPLETE` con un detalle por campo.
 */
@NullableFields('tastingNotes', 'pairing', 'estimatedRedeemDate')
export class CollectionCommercialInputDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'name debe ser un texto' })
  @Length(3, 120, { message: 'name debe tener entre 3 y 120 caracteres' })
  name?: string;

  @ApiPropertyOptional({ minLength: 20, maxLength: 4000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'description debe ser un texto' })
  @Length(20, 4000, {
    message: 'description debe tener entre 20 y 4000 caracteres',
  })
  description?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'tastingNotes debe ser un texto' })
  @MaxLength(2000)
  tastingNotes?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'pairing debe ser un texto' })
  @MaxLength(1000)
  pairing?: string | null;

  @ApiPropertyOptional({
    type: () => CollectionImageInputDto,
    isArray: true,
    maxItems: COLLECTION_MAX_IMAGES,
  })
  @IsOptional()
  @IsArray({ message: 'imageKeys debe ser una lista' })
  @ArrayMaxSize(COLLECTION_MAX_IMAGES, {
    message: `Máximo ${COLLECTION_MAX_IMAGES} imágenes`,
  })
  @ValidateNested({ each: true })
  @Type(() => CollectionImageInputDto)
  imageKeys?: CollectionImageInputDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date',
    example: '2027-03-15',
    description: 'Por defecto, la `estimatedReadyDate` del lote',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'estimatedRedeemDate debe ser AAAA-MM-DD' })
  estimatedRedeemDate?: string | null;
}

/** Borrador comercial guardado en la solicitud: lo enviado hasta ahora. */
export class CollectionCommercialDraftDto {
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  tastingNotes!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pairing!: string | null;

  @ApiProperty({ type: () => CollectionImageInputDto, isArray: true })
  imageKeys!: CollectionImageInputDto[];

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  estimatedRedeemDate!: string | null;
}

export class CollectionImageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty({ description: 'SHA-256 del archivo, en hex' })
  sha256!: string;

  @ApiProperty({
    example:
      'https://api.drinksonchain.com/v1/public/collections/images/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description:
      'Colección publicada: `GET /v1/public/collections/images/{id}` de esta API (pública y cacheable). ' +
      'Antes de publicar: URL firmada de corta vida',
  })
  url!: string;

  @ApiProperty()
  alt!: string;

  @ApiProperty()
  isCover!: boolean;
}

/** Datos comerciales de una colección ya creada. */
export class CollectionCommercialDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, nullable: true })
  tastingNotes!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pairing!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  estimatedRedeemDate!: string | null;

  @ApiProperty({ type: () => CollectionImageDto, isArray: true })
  images!: CollectionImageDto[];
}
