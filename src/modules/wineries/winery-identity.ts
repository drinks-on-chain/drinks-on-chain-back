/**
 * Identidad pública y de lote de una bodega (contrato O1 §4, ORG-05):
 *
 * - `slug`: ruta pública (`/v1/public/wineries/{slug}`), única y estable.
 * - `lotPrefix`: prefijo del código de lote, 3–5 letras mayúsculas, único y
 *   definitivo; se asigna al activarse la bodega.
 *
 * Mismo criterio que `@drinks-on-chain/mocks` (`slugify`, `uniqueSlug`,
 * `deriveLotPrefix`) y que la migración `o1_solicitudes_bodegas_equipo`.
 */

export const LOT_PREFIX_PATTERN = /^[A-Z]{3,5}$/;
export const SLUG_MAX_LENGTH = 100;

const DIACRITICS = /[̀-ͯ]/g;

function unaccent(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS, '');
}

/** "Bodega Altos de Calamuchita" → "altos-de-calamuchita". */
export function slugify(name: string): string {
  return (
    unaccent(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^bodegas?-/, '')
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/g, '') || 'bodega'
  );
}

/** `slug` libre frente a los tomados (añade `-2`, `-3`…). */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E']);
const GENERIC = new Set([
  'BODEGA',
  'BODEGAS',
  'DESTILERIA',
  'VINEDOS',
  'VINEDO',
  'VINAS',
  'CASA',
  'CERVECERIA',
  'FINCA',
]);

/**
 * Candidatos de prefijo por orden de preferencia: 3 letras (iniciales de las
 * palabras significativas, completadas con letras de la última), alargado a 4
 * y 5 con el resto de letras, y como último recurso las dos primeras con otra
 * letra final.
 */
export function lotPrefixCandidates(tradeName: string): string[] {
  const words = unaccent(tradeName)
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const significant = words.filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w));
  const pool = significant.length
    ? significant
    : words.length
      ? words
      : ['DOC'];
  const last = pool[pool.length - 1];
  let base =
    pool.length === 1
      ? last.slice(0, 3)
      : pool
          .map((w) => w[0])
          .join('')
          .slice(0, 3);
  for (let i = 1; base.length < 3 && i < last.length; i++) {
    base += last[i];
  }
  base = base.padEnd(3, 'X');
  const letters = pool.join('');
  const candidates = [base];
  for (let len = 4; len <= 5; len++) {
    candidates.push((base + letters.slice(3)).slice(0, len));
  }
  for (let code = 65; code <= 90; code++) {
    candidates.push(base.slice(0, 2) + String.fromCharCode(code));
  }
  return candidates.filter(
    (c, i, all) => LOT_PREFIX_PATTERN.test(c) && all.indexOf(c) === i,
  );
}

/** Primer prefijo libre para el nombre comercial (o `null` si no queda ninguno). */
export function deriveLotPrefix(
  tradeName: string,
  taken: ReadonlySet<string>,
): string | null {
  return lotPrefixCandidates(tradeName).find((c) => !taken.has(c)) ?? null;
}
