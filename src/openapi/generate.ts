/**
 * `pnpm openapi:generate`: escribe `openapi.json` en la raíz del repo.
 * La CI lo regenera y falla si difiere del versionado (ver README).
 *
 *   pnpm openapi:generate            # escribe openapi.json
 *   pnpm openapi:generate -- --check # solo comprueba (exit 1 si difiere)
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateOpenApiDocument } from './document';
import { serializeOpenApiDocument } from './openapi';

const OUTPUT = resolve(__dirname, '..', '..', 'openapi.json');

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const text = serializeOpenApiDocument(await generateOpenApiDocument());
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null;

  if (check) {
    if (current !== text) {
      console.error(
        'openapi.json no está al día: ejecuta `pnpm openapi:generate` y versiona el resultado.',
      );
      process.exit(1);
    }
    console.log('openapi.json al día.');
    return;
  }

  if (current === text) {
    console.log('openapi.json sin cambios.');
    return;
  }
  writeFileSync(OUTPUT, text, 'utf8');
  console.log(`openapi.json actualizado (${OUTPUT}).`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
