import { createHash } from 'node:crypto';

/**
 * Prueba Merkle de un código de botella (contrato O2 §10 y §12.2). Las hojas
 * son `SHA-256("{serie}:{código}:{sal}")` ordenadas por serie; la raíz la
 * escribe el cierre del expediente en `lot_dossiers.bottle_merkle_root`.
 *
 * El contrato fija la hoja pero no cómo se combinan los nodos, así que el
 * pasaporte **no supone** una construcción: prueba las habituales contra la
 * raíz guardada (`findMerkleVariant`) y solo publica una prueba que verifica.
 * Si ninguna reproduce la raíz, no hay prueba (`null`) en lugar de una falsa.
 */
export interface MerkleVariant {
  /** Nivel impar: se duplica el último nodo o sube tal cual. */
  odd: 'DUPLICATE' | 'PROMOTE';
  /** El padre es el hash de los bytes concatenados o del texto hexadecimal. */
  concat: 'BYTES' | 'HEX';
}

export const MERKLE_VARIANTS: readonly MerkleVariant[] = [
  { odd: 'DUPLICATE', concat: 'BYTES' },
  { odd: 'PROMOTE', concat: 'BYTES' },
  { odd: 'DUPLICATE', concat: 'HEX' },
  { odd: 'PROMOTE', concat: 'HEX' },
];

export interface MerkleStep {
  /** Lado en el que va el nodo hermano al combinar. */
  side: 'L' | 'R';
  hash: string;
}

const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** Hoja de una botella: `SHA-256("{serie}:{código}:{sal}")` en hexadecimal. */
export function bottleLeaf(serial: number, code: string, salt: string): string {
  return sha256(`${serial}:${code}:${salt}`);
}

function parent(left: string, right: string, concat: MerkleVariant['concat']) {
  return concat === 'HEX'
    ? sha256(left + right)
    : sha256(
        Buffer.concat([Buffer.from(left, 'hex'), Buffer.from(right, 'hex')]),
      );
}

/** Niveles del árbol, de las hojas (índice 0) a la raíz. */
export function merkleLevels(
  leaves: readonly string[],
  variant: MerkleVariant,
): string[][] {
  if (leaves.length === 0) return [];
  const levels: string[][] = [[...leaves]];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(parent(current[i], current[i + 1], variant.concat));
      } else if (variant.odd === 'DUPLICATE') {
        next.push(parent(current[i], current[i], variant.concat));
      } else {
        next.push(current[i]);
      }
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(
  leaves: readonly string[],
  variant: MerkleVariant,
): string | null {
  const levels = merkleLevels(leaves, variant);
  return levels.length > 0 ? levels[levels.length - 1][0] : null;
}

/** Camino de la hoja `index` a la raíz (los nodos hermanos, de abajo arriba). */
export function merkleProof(
  levels: readonly (readonly string[])[],
  index: number,
  variant: MerkleVariant,
): MerkleStep[] {
  const path: MerkleStep[] = [];
  let position = index;
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth];
    const isRight = position % 2 === 1;
    const sibling = isRight ? position - 1 : position + 1;
    if (sibling < level.length) {
      path.push({ side: isRight ? 'L' : 'R', hash: level[sibling] });
    } else if (variant.odd === 'DUPLICATE') {
      path.push({ side: 'R', hash: level[position] });
    }
    position = Math.floor(position / 2);
  }
  return path;
}

/** Recalcula la raíz desde una hoja y su camino. */
export function verifyMerkleProof(
  leaf: string,
  path: readonly MerkleStep[],
  root: string,
  concat: MerkleVariant['concat'],
): boolean {
  let node = leaf;
  for (const step of path) {
    node =
      step.side === 'L'
        ? parent(step.hash, node, concat)
        : parent(node, step.hash, concat);
  }
  return node === root.toLowerCase();
}

/** Construcción que reproduce la raíz guardada, o `null` si ninguna lo hace. */
export function findMerkleVariant(
  leaves: readonly string[],
  root: string,
): MerkleVariant | null {
  const target = root.toLowerCase();
  return (
    MERKLE_VARIANTS.find((variant) => merkleRoot(leaves, variant) === target) ??
    null
  );
}
