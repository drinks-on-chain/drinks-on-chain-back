/**
 * Swagger UI (/docs) y documento (/docs-json) (SE-08). Sin valor explícito:
 * activo fuera de producción y apagado en producción. El contrato versionado
 * es openapi.json; el entorno de desarrollo del servidor lo activa a mano.
 */
export function isSwaggerEnabled(
  raw: string | boolean | undefined | null,
  nodeEnv: string | undefined,
): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return nodeEnv !== 'production';
  }
  return String(raw).trim().toLowerCase() === 'true';
}
