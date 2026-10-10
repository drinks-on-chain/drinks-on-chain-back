import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import {
  passportUrl,
  resolvePassportBaseUrl,
} from '@modules/lots/bottle-units';
import { PassportLookupLimiter } from '@modules/lots/passport/passport-lookup-limiter';
import { AppLinks } from '@modules/mail/app-links';
import {
  collectionImagesArePublic,
  publicCollectionImageUrl,
} from './collection-images';
import { CollectionImagesService } from './collection-images.service';
import type { PublicNftMetadataDto } from './dto/public-nft.dto';
import type { TokenStatus } from './tokenization.constants';

/** Caché de los metadatos (§6.5). */
export const NFT_METADATA_CACHE_CONTROL = 'public, max-age=300';
/** Los 404 se guardan poco, como en el pasaporte. */
export const NFT_NOT_FOUND_CACHE_CONTROL = 'public, max-age=30';
/** Una imagen publicada no cambia: su id identifica sus bytes. */
export const COLLECTION_IMAGE_CACHE_CONTROL =
  'public, max-age=86400, immutable';

const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = {
  MINTED: 'Emitido',
  RESERVED: 'Reservado',
  SOLD: 'Vendido',
  REDEEMABLE: 'Canjeable',
  PASS_ACTIVE: 'Con pase de canje',
  REDEEMED: 'Canjeado',
  BURNED: 'Quemado',
  EXPIRED: 'Vencido',
};

const PRODUCT_LABELS: Record<string, string> = {
  WINE: 'Vino',
  SINGANI: 'Singani',
};

const MAX_TOKEN_ID = 4_294_967_295; // u32

/**
 * Lo público de la tokenización (contrato O3 §6.5 y §5.5): metadatos de los
 * NFT (`token_uri`) e imágenes de las colecciones publicadas. Sin sesión y
 * sin datos del consumidor.
 */
@Injectable()
export class PublicTokenizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly links: AppLinks,
    private readonly limiter: PassportLookupLimiter,
    private readonly images: CollectionImagesService,
    @Inject(CHAIN_SETTINGS) private readonly chain: ChainSettings,
  ) {}

  /**
   * `GET /v1/public/nft/{winerySlug}/{tokenId}`. Token inexistente en el
   * contrato de esa bodega → 404 `PUB_TOKEN_NOT_FOUND` (cuenta para el freno a
   * la enumeración, como los códigos del pasaporte). Un token quemado sigue
   * respondiendo, con `status: BURNED`.
   */
  async nftMetadata(
    winerySlug: string,
    tokenId: number,
    ip: string | null,
  ): Promise<PublicNftMetadataDto> {
    await this.limiter.assertAllowed(ip);
    const slug = winerySlug.trim().toLowerCase();
    const token =
      Number.isInteger(tokenId) && tokenId >= 0 && tokenId <= MAX_TOKEN_ID
        ? await this.prisma.token.findFirst({
            where: {
              tokenId,
              contract: { network: this.chain.network, winery: { slug } },
            },
            include: {
              contract: {
                select: {
                  address: true,
                  winery: { select: { slug: true, commercialName: true } },
                },
              },
              collection: {
                select: {
                  slug: true,
                  name: true,
                  description: true,
                  quota: true,
                  publishedAt: true,
                  images: {
                    where: { isCover: true },
                    select: { id: true },
                    take: 1,
                  },
                  lot: {
                    select: {
                      reference: true,
                      lotCode: true,
                      productType: true,
                      harvestYear: true,
                    },
                  },
                },
              },
            },
          })
        : null;
    if (!token) {
      await this.limiter.registerMiss(ip);
      throw new AppException(
        404,
        ErrorCode.PUB_TOKEN_NOT_FOUND,
        'NFT no encontrado',
      );
    }
    const { collection, contract } = token;
    const lot = collection.lot;
    const winery = {
      slug: contract.winery.slug ?? slug,
      tradeName: contract.winery.commercialName,
    };
    const published = collectionImagesArePublic(collection);
    const cover = collection.images[0] ?? null;
    const passport = lot.lotCode
      ? passportUrl(this.passportBaseUrl(), lot.lotCode)
      : null;
    const status = token.status as TokenStatus;
    const product = lot.productType
      ? (PRODUCT_LABELS[lot.productType] ?? lot.productType)
      : null;
    return {
      name: `${collection.name} · Botella ${token.bottleNumber} de ${collection.quota}`,
      description: published
        ? collection.description
        : `Botella ${token.bottleNumber} del lote ${lot.reference} de ${winery.tradeName}, con trazabilidad registrada en Drinks on Chain.`,
      image:
        published && cover
          ? publicCollectionImageUrl(this.chain.publicApiBaseUrl, cover.id)
          : null,
      external_url:
        passport ??
        // El `slug` de la colección es único por bodega: la ficha se
        // resuelve con el de la bodega delante
        `${this.links.base('MARKETPLACE')}/colecciones/${encodeURIComponent(winery.slug)}/${encodeURIComponent(collection.slug)}`,
      attributes: [
        { trait_type: 'Bodega', value: winery.tradeName },
        { trait_type: 'Lote', value: lot.reference },
        ...(product ? [{ trait_type: 'Bebida', value: product }] : []),
        { trait_type: 'Añada', value: lot.harvestYear },
        { trait_type: 'Botella n.º', value: token.bottleNumber },
        { trait_type: 'Colección', value: collection.name },
        { trait_type: 'Estado', value: TOKEN_STATUS_LABELS[status] ?? status },
      ],
      properties: {
        winery,
        lotReference: lot.reference,
        lotCode: lot.lotCode,
        bottleNumber: token.bottleNumber,
        collectionSize: collection.quota,
        tokenId: token.tokenId,
        contract: contract.address ?? '',
        status,
        passportUrl: passport,
      },
    };
  }

  /**
   * `GET /v1/public/collections/images/{imageId}`: los bytes de una imagen de
   * una colección **publicada**. Una imagen de una colección sin publicar (o
   * cualquier otro archivo del almacenamiento) responde 404, igual que una
   * inexistente: solo se sirve lo que figura en `collection_images`.
   */
  async collectionImage(
    imageId: string,
  ): Promise<{ body: Buffer; mimeType: string; sha256: string }> {
    const notFound = new AppException(
      404,
      ErrorCode.FILE_NOT_FOUND,
      'Imagen no encontrada',
    );
    const image = await this.prisma.collectionImage.findUnique({
      where: { id: imageId },
      select: {
        key: true,
        sha256: true,
        collection: { select: { publishedAt: true } },
      },
    });
    if (!image || !collectionImagesArePublic(image.collection)) throw notFound;
    const file = await this.images.read(image.key);
    if (!file) throw notFound;
    return { ...file, sha256: image.sha256 };
  }

  private passportBaseUrl(): string {
    return resolvePassportBaseUrl({
      PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
      APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
    });
  }
}
