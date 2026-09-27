/**
 * `TRUST_PROXY` → valor de `trust proxy` de Express (SE-06). Con él,
 * `request.ip` es la IP real del cliente (la que añade nginx a
 * `X-Forwarded-For`) y no la del proxy: la usan el límite de peticiones y el
 * bloqueo por intentos.
 *
 * - vacío o `false`: no se confía en ningún proxy (conexión directa, local);
 * - un número: saltos de proxy de confianza (`1` = una sola capa, nginx);
 * - otra cadena: lista de Express (`loopback`, `10.0.0.0/8`…).
 *
 * `true` (confiar en cualquier `X-Forwarded-For`) se rechaza: permitiría a
 * cualquiera elegir su IP.
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true confiaría en cualquier X-Forwarded-For: indica el número de saltos (p. ej. 1 para nginx)',
    );
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}
