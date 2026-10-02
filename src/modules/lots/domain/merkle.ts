import { createHash } from 'node:crypto';

/**
 * Raíz Merkle de los códigos de botella del expediente (contrato O2 §10 y
 * §20). El expediente es público y los códigos son el antifalsificación de la
 * etiqueta, así que no van en claro: va la raíz de un árbol cuyas hojas son
 * `SHA-256("{serie}:{código}:{sal}")` (texto UTF-8; la sal son 16 bytes
 * aleatorios en hexadecimal, una por botella, que impide descubrir códigos
 * vecinos por fuerza bruta).
 *
 * Construcción (`sha256-merkle/serial-code-salt`):
 * 1. Hojas ordenadas por número de serie ascendente.
 * 2. Cada nivel empareja los nodos de izquierda a derecha:
 *    `padre = SHA-256(izquierdo ‖ derecho)` sobre los 32 bytes de cada
 *    resumen (no sobre su texto hexadecimal).
 * 3. Un nodo sin pareja al final de un nivel **sube tal cual** (no se
 *    duplica).
 * 4. La raíz es el único nodo del último nivel, en hexadecimal en minúsculas.
 *    Sin hojas, la raíz es `SHA-256("")`.
 *
 * Quien verifica siempre calcula la hoja a partir de la serie, el código y la
 * sal (nunca acepta un resumen de hoja suelto), así que un nodo interno no
 * puede hacerse pasar por una hoja.
 */
export const BOTTLE_MERKLE_ALGORITHM = 'sha256-merkle/serial-code-salt';

/** Paso de una prueba: el hermano y de qué lado queda. */
export interface MerkleStep {
  /** `L`: el hermano va a la izquierda (`SHA-256(hermano ‖ actual)`); `R`: a la derecha. */
  side: 'L' | 'R';
  /** Resumen del hermano (hexadecimal). */
  hash: string;
}

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Texto de la hoja de una botella: `{serie}:{código}:{sal}`. */
export function bottleLeafPreimage(
  serial: number,
  code: string,
  salt: string,
): string {
  return `${serial}:${code}:${salt}`;
}

/** Hoja de una botella: `SHA-256("{serie}:{código}:{sal}")` en hexadecimal. */
export function bottleLeafHash(
  serial: number,
  code: string,
  salt: string,
): string {
  return sha256(Buffer.from(bottleLeafPreimage(serial, code, salt), 'utf8'))
    .toString('hex')
    .toLowerCase();
}

function nextLevel(level: Buffer[]): Buffer[] {
  const next: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(
      i + 1 < level.length
        ? sha256(Buffer.concat([level[i], level[i + 1]]))
        : level[i],
    );
  }
  return next;
}

function toNodes(leafHashes: readonly string[]): Buffer[] {
  return leafHashes.map((hex) => {
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error('Hoja Merkle inválida: se espera un SHA-256 hexadecimal');
    }
    return Buffer.from(hex, 'hex');
  });
}

/** Raíz Merkle (hexadecimal) de las hojas en el orden dado. */
export function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return sha256('').toString('hex');
  let level = toNodes(leafHashes);
  while (level.length > 1) level = nextLevel(level);
  return level[0].toString('hex');
}

/** Prueba de inclusión de la hoja `index` (de la hoja a la raíz). */
export function merkleProof(
  leafHashes: readonly string[],
  index: number,
): MerkleStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= leafHashes.length) {
    throw new Error('Índice de hoja fuera del árbol');
  }
  const path: MerkleStep[] = [];
  let level = toNodes(leafHashes);
  let position = index;
  while (level.length > 1) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < level.length) {
      path.push({
        side: position % 2 === 0 ? 'R' : 'L',
        hash: level[sibling].toString('hex'),
      });
    }
    level = nextLevel(level);
    position = Math.floor(position / 2);
  }
  return path;
}

/** ¿La prueba lleva de la hoja a la raíz? */
export function verifyMerkleProof(
  leafHash: string,
  path: readonly MerkleStep[],
  root: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(leafHash)) return false;
  let node: Buffer = Buffer.from(leafHash, 'hex');
  for (const step of path) {
    if (!/^[0-9a-f]{64}$/i.test(step.hash)) return false;
    const sibling = Buffer.from(step.hash, 'hex');
    node =
      step.side === 'L'
        ? sha256(Buffer.concat([sibling, node]))
        : sha256(Buffer.concat([node, sibling]));
  }
  return node.toString('hex') === root.toLowerCase();
}
