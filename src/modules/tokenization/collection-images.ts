/** Ruta de la API que sirve una imagen pública de una colección (U-5). */
export const PUBLIC_COLLECTION_IMAGE_PATH = '/v1/public/collections/images';

/**
 * URL pública de una imagen de colección: `{API_PUBLIC_URL}/v1/public/collections/images/{id}`
 * (o la ruta relativa, que la app resuelve contra su proxy, si la API no
 * tiene origen público configurado). Es lo que llevan `CollectionImage.url` y
 * `coverImageUrl` de una colección publicada.
 */
export function publicCollectionImageUrl(
  publicApiBaseUrl: string | null,
  imageId: string,
): string {
  return `${publicApiBaseUrl ?? ''}${PUBLIC_COLLECTION_IMAGE_PATH}/${imageId}`;
}

/**
 * Una colección sirve sus imágenes en público desde que se publica (§5.5) y
 * las sigue sirviendo en pausa o cerrada: los NFT ya vendidos las enlazan en
 * sus metadatos.
 */
export function collectionImagesArePublic(collection: {
  publishedAt: Date | null;
}): boolean {
  return collection.publishedAt !== null;
}
