import { v5 as uuidv5 } from 'uuid';

/**
 * Espacio de nombres de los UUID v5 de `@drinks-on-chain/mocks`
 * (`src/shared/uuid.ts` y `generate.py`): la semilla deriva los mismos ids que
 * los fixtures a partir de la misma clave legible.
 */
export const MOCKS_NAMESPACE = '6b2f4c1e-9c3a-4d5e-8f70-1a2b3c4d5e6f';

/** Id determinista de los mocks (`uid` de los mocks), p. ej. `winery:altos`. */
export function mockId(key: string): string {
  return uuidv5(key, MOCKS_NAMESPACE);
}

/** Id de la membresía de plataforma de una persona (`derive.ts` de los mocks). */
export function platformMembershipId(userId: string): string {
  return mockId(`membership:platform:${userId}`);
}
