import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';

/**
 * Datos comerciales de una colección (contrato O3 §5.5; TOK-03, TOK-04). El
 * borrador vive en la solicitud (lo envía la bodega y lo completa
 * operaciones); al aprobar se copia a la colección.
 */

export interface CommercialImage {
  key: string;
  alt: string;
  isCover: boolean;
}

export interface CommercialDraft {
  name: string | null;
  description: string | null;
  tastingNotes: string | null;
  pairing: string | null;
  imageKeys: CommercialImage[];
  estimatedRedeemDate: string | null;
}

/** Entrada parcial (`Partial<CollectionCommercialInput>`): lo ausente no se toca. */
export interface CommercialInput {
  name?: string;
  description?: string;
  tastingNotes?: string | null;
  pairing?: string | null;
  imageKeys?: { key: string; alt: string; isCover?: boolean }[];
  estimatedRedeemDate?: string | null;
}

export const EMPTY_COMMERCIAL_DRAFT: CommercialDraft = {
  name: null,
  description: null,
  tastingNotes: null,
  pairing: null,
  imageKeys: [],
  estimatedRedeemDate: null,
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** Borrador guardado (JSON de la base) con su forma completa. */
export function parseCommercialDraft(raw: unknown): CommercialDraft {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const images = Array.isArray(value.imageKeys) ? value.imageKeys : [];
  return {
    name: text(value.name),
    description: text(value.description),
    tastingNotes: text(value.tastingNotes),
    pairing: text(value.pairing),
    imageKeys: normalizeImages(
      images
        .filter(
          (i): i is Record<string, unknown> => !!i && typeof i === 'object',
        )
        .map((i) => ({
          key: String(i.key ?? ''),
          alt: String(i.alt ?? ''),
          isCover: i.isCover === true,
        }))
        .filter((i) => i.key.length > 0),
    ),
    estimatedRedeemDate: text(value.estimatedRedeemDate),
  };
}

/**
 * Una sola portada: la primera marcada; las demás marcas se quitan. No se
 * elige portada por la bodega: sin ninguna marcada, falta la portada (S-10).
 */
function normalizeImages(
  images: { key: string; alt: string; isCover?: boolean }[],
): CommercialImage[] {
  let cover = false;
  return images.map((image) => {
    const isCover = image.isCover === true && !cover;
    if (isCover) cover = true;
    return { key: image.key, alt: image.alt.trim(), isCover };
  });
}

/** Claves de imagen repetidas en la entrada (cada imagen, una vez). */
export function duplicatedImageKeys(input: CommercialInput): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const image of input.imageKeys ?? []) {
    if (seen.has(image.key)) repeated.add(image.key);
    seen.add(image.key);
  }
  return [...repeated];
}

/** Aplica una entrada parcial sobre el borrador. */
export function mergeCommercial(
  draft: CommercialDraft,
  input: CommercialInput | undefined,
): CommercialDraft {
  if (!input) return draft;
  return {
    name: input.name !== undefined ? text(input.name) : draft.name,
    description:
      input.description !== undefined
        ? text(input.description)
        : draft.description,
    tastingNotes:
      input.tastingNotes !== undefined
        ? text(input.tastingNotes)
        : draft.tastingNotes,
    pairing: input.pairing !== undefined ? text(input.pairing) : draft.pairing,
    imageKeys:
      input.imageKeys !== undefined
        ? normalizeImages(input.imageKeys)
        : draft.imageKeys,
    estimatedRedeemDate:
      input.estimatedRedeemDate !== undefined
        ? text(input.estimatedRedeemDate)
        : draft.estimatedRedeemDate,
  };
}

/** Campos del borrador que cambian con la entrada (para la bitácora). */
export function changedCommercialFields(
  before: CommercialDraft,
  after: CommercialDraft,
): string[] {
  return (Object.keys(after) as (keyof CommercialDraft)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/**
 * Lo que falta para aprobar o publicar (S-10): nombre, descripción y una
 * imagen de portada; el precio no (A-32). Un `ErrorDetail` por campo, con el
 * código `TOK_COMMERCIAL_DATA_INCOMPLETE`.
 */
export function commercialMissing(data: {
  name: string | null;
  description: string | null;
  hasCover: boolean;
}): ErrorDetail[] {
  const code = ErrorCode.TOK_COMMERCIAL_DATA_INCOMPLETE;
  const missing: ErrorDetail[] = [];
  if (!data.name) {
    missing.push({
      field: 'commercial.name',
      code,
      message: 'Falta el nombre de la colección',
    });
  }
  if (!data.description) {
    missing.push({
      field: 'commercial.description',
      code,
      message: 'Falta la descripción de la colección',
    });
  }
  if (!data.hasCover) {
    missing.push({
      field: 'commercial.imageKeys',
      code,
      message: 'Falta la imagen de portada (marca una imagen como portada)',
    });
  }
  return missing;
}

/**
 * `slug` de la colección (§5.5): generado desde el nombre, en minúsculas, sin
 * tildes ni signos, con guiones; como mucho 140 caracteres.
 */
export function collectionSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'coleccion';
}

/** Importe del precio (A-06, A-32): entero de centavos ≥ 1 en `BOB`. */
export function priceViolations(
  price: { amountMinor: unknown; currency: unknown } | null | undefined,
  field = 'price',
): ErrorDetail[] {
  if (price === null || price === undefined) return [];
  const code = ErrorCode.TOK_PRICE_INVALID;
  const violations: ErrorDetail[] = [];
  if (
    typeof price.amountMinor !== 'number' ||
    !Number.isInteger(price.amountMinor) ||
    price.amountMinor < 1 ||
    price.amountMinor > 2_147_483_647
  ) {
    violations.push({
      field: `${field}.amountMinor`,
      code,
      message: 'El precio debe ser un entero de centavos de al menos 1',
      actual: price.amountMinor,
      meta: { field: `${field}.amountMinor` },
    });
  }
  if (price.currency !== 'BOB') {
    violations.push({
      field: `${field}.currency`,
      code,
      message: 'La moneda debe ser BOB',
      expected: 'BOB',
      actual: price.currency,
      meta: { field: `${field}.currency` },
    });
  }
  return violations;
}

/** `180,00 Bs` a partir de centavos, para textos (correos, bitácora). */
export function formatPrice(amountMinor: number): string {
  return `${(amountMinor / 100).toLocaleString('es-BO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} Bs`;
}
