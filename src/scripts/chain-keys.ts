import {
  chainPublicAddresses,
  generateChainEnvLines,
  parseEnvLines,
} from '../modules/chain/custody/chain-keys';

/**
 * Claves del custodio `ENV` (contrato O3 §2.1). No se usa a mano: lo llama
 * `deploy/dev/generar-claves-cadena.sh`, que redirige la salida de `generate`
 * al `.env` del entorno (nunca a la pantalla).
 *
 *   node dist/scripts/chain-keys.js generate CHAIN_SECRET_OPERATIONS …
 *     → una línea `NOMBRE=valor` por secreto, por la salida estándar
 *   node dist/scripts/chain-keys.js addresses < .env
 *     → solo direcciones públicas (`G…`), una por línea `ETIQUETA=G…`
 *
 * Sin dependencias de la base ni de la red: sirve en un contenedor sin red.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [command, ...names] = process.argv.slice(2);
  if (command === 'generate' && names.length > 0) {
    process.stdout.write(`${generateChainEnvLines(names).join('\n')}\n`);
    return;
  }
  if (command === 'addresses' && names.length === 0) {
    const addresses = chainPublicAddresses(parseEnvLines(await readStdin()));
    const lines = [
      `OPERATIONS=${addresses.operations ?? ''}`,
      `ANCHOR=${addresses.anchor ?? ''}`,
      `FIRST_WINERY=${addresses.firstWinery?.address ?? ''}`,
      `CONSUMER_SEED_CHECK=${addresses.consumerSeedCheck?.address ?? ''}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  throw new Error(
    'uso: chain-keys generate <NOMBRE>… | chain-keys addresses < .env',
  );
}

main().catch((error: unknown) => {
  // Solo el mensaje: nunca la entrada ni un valor generado
  process.stderr.write(
    `chain-keys: ${error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
