import { Prisma } from '@prisma/client';
import { generateBottleCode, generateBottleSalt } from './domain/bottle-code';

const CHUNK = 5_000;

/**
 * Genera un código de botella por botella, con número de serie
 * `1…count` (§7.1), en la transacción `tx`. Los códigos son únicos en toda la
 * plataforma: ante una colisión (índice único) se genera otro para esa serie.
 */
export async function generateBottleUnits(
  tx: Prisma.TransactionClient,
  input: { lotId: string; bottlingBatchId: string; count: number },
): Promise<number> {
  let missing = Array.from({ length: input.count }, (_, i) => i + 1);
  for (let attempt = 0; missing.length > 0; attempt++) {
    if (attempt > 5) {
      throw new Error('No se pudieron generar códigos de botella únicos');
    }
    for (let i = 0; i < missing.length; i += CHUNK) {
      const serials = missing.slice(i, i + CHUNK);
      const codes = new Set<string>();
      const data = serials.map((serial) => {
        let code = generateBottleCode();
        while (codes.has(code)) code = generateBottleCode();
        codes.add(code);
        return {
          code,
          serial,
          lotId: input.lotId,
          bottlingBatchId: input.bottlingBatchId,
          salt: generateBottleSalt(),
        };
      });
      await tx.bottleUnit.createMany({ data, skipDuplicates: true });
    }
    const present = await tx.bottleUnit.findMany({
      where: { lotId: input.lotId, serial: { in: missing } },
      select: { serial: true },
    });
    const have = new Set(present.map((p) => p.serial));
    missing = missing.filter((s) => !have.has(s));
  }
  return input.count;
}

/** URL del pasaporte: `{PASSPORT_BASE_URL}/b/{código}` (OP-06, ERP-16). */
export function passportUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/b/${encodeURIComponent(code)}`;
}

/**
 * URL base del pasaporte público: `PASSPORT_BASE_URL`; si no, la del
 * Marketplace (`APP_URL_MARKETPLACE`); si tampoco, la de desarrollo local.
 */
export function resolvePassportBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.PASSPORT_BASE_URL?.trim() ||
    env.APP_URL_MARKETPLACE?.trim() ||
    'http://localhost:3005'
  );
}
