import type { NextFunction, Request, Response } from 'express';
import {
  PROXY_CLIENT_IP_HEADER,
  PROXY_SIGNATURE_HEADER,
  PROXY_TIMESTAMP_HEADER,
  canonicalPathWithQuery,
  createProxyClientIpMiddleware,
  parseProxySecrets,
  proxySignaturePayload,
  resolveProxyClientIp,
  signProxyRequest,
} from '../proxy-client-ip';

const SECRET = 'test-proxy-secret-0123456789abcdef-aaaa';
const OLD_SECRET = 'old-proxy-secret-0123456789abcdef-bbbbb';
const NOW_MS = 1_790_000_000_000;
const NOW_S = String(NOW_MS / 1000);
const PATH = '/v1/auth/login?next=%2Fpanel';

function signedHeaders(
  overrides: Partial<{
    secret: string;
    method: string;
    path: string;
    ip: string;
    timestamp: string;
  }> = {},
): Record<string, string> {
  const secret = overrides.secret ?? SECRET;
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? PATH;
  const ip = overrides.ip ?? '203.0.113.7';
  const timestamp = overrides.timestamp ?? NOW_S;
  return {
    [PROXY_CLIENT_IP_HEADER]: ip,
    [PROXY_TIMESTAMP_HEADER]: timestamp,
    [PROXY_SIGNATURE_HEADER]: signProxyRequest(
      secret,
      method,
      path,
      ip,
      timestamp,
    ),
  };
}

function resolve(
  headers: Record<string, string | undefined>,
  secrets: string[] = [SECRET],
  now = NOW_MS,
) {
  return resolveProxyClientIp({
    method: 'POST',
    pathWithQuery: PATH,
    headers,
    secrets,
    now,
  });
}

describe('IP del cliente firmada por el proxy de las apps (O1-OPS-1)', () => {
  describe('parseProxySecrets', () => {
    it('separa por comas, recorta y descarta vacíos', () => {
      expect(parseProxySecrets(undefined)).toEqual([]);
      expect(parseProxySecrets('')).toEqual([]);
      expect(parseProxySecrets(` ${SECRET} , ,${OLD_SECRET}`)).toEqual([
        SECRET,
        OLD_SECRET,
      ]);
    });
  });

  it('firma MÉTODO|RUTA_CON_QUERY|IP|TIMESTAMP con el método en mayúsculas', () => {
    expect(proxySignaturePayload('post', PATH, '::1', '10')).toBe(
      `POST|${PATH}|::1|10`,
    );
    expect(signProxyRequest(SECRET, 'post', PATH, '::1', '10')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('la query se firma en forma canónica (%20 y + valen igual)', () => {
    expect(canonicalPathWithQuery('/v1/x')).toBe('/v1/x');
    expect(canonicalPathWithQuery('/v1/x?')).toBe('/v1/x');
    expect(canonicalPathWithQuery('/v1/x%20y?q=a%20b&l=1')).toBe(
      '/v1/x%20y?q=a+b&l=1',
    );
    const headers = signedHeaders({ path: '/v1/lots?q=a+b' });
    expect(
      resolveProxyClientIp({
        method: 'POST',
        pathWithQuery: '/v1/lots?q=a%20b',
        headers,
        secrets: [SECRET],
        now: NOW_MS,
      }),
    ).toEqual({ ok: true, ip: '203.0.113.7' });
  });

  it('firma válida → IP del cliente (IPv4 e IPv6)', () => {
    expect(resolve(signedHeaders())).toEqual({ ok: true, ip: '203.0.113.7' });
    expect(resolve(signedHeaders({ ip: '2001:db8::1' }))).toEqual({
      ok: true,
      ip: '2001:db8::1',
    });
  });

  it('acepta cualquiera de los secretos (rotación sin corte)', () => {
    expect(
      resolve(signedHeaders({ secret: OLD_SECRET }), [SECRET, OLD_SECRET]),
    ).toEqual({ ok: true, ip: '203.0.113.7' });
    expect(resolve(signedHeaders({ secret: OLD_SECRET }), [SECRET])).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('marca de tiempo a ±60 s', () => {
    const at = (offset: number) => String(NOW_MS / 1000 + offset);
    expect(resolve(signedHeaders({ timestamp: at(-60) })).ok).toBe(true);
    expect(resolve(signedHeaders({ timestamp: at(60) })).ok).toBe(true);
    expect(resolve(signedHeaders({ timestamp: at(-61) }))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(resolve(signedHeaders({ timestamp: at(61) }))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(resolve(signedHeaders({ timestamp: '17e8' }))).toEqual({
      ok: false,
      reason: 'invalid-timestamp',
    });
  });

  it('firma alterada: otra IP, otra ruta, otro método o firma cambiada', () => {
    const headers = signedHeaders();
    expect(
      resolve({ ...headers, [PROXY_CLIENT_IP_HEADER]: '198.51.100.1' }),
    ).toEqual({ ok: false, reason: 'invalid-signature' });
    expect(resolve(signedHeaders({ path: '/v1/auth/login' }))).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
    expect(resolve(signedHeaders({ method: 'GET' }))).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
    const sig = headers[PROXY_SIGNATURE_HEADER];
    const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    expect(resolve({ ...headers, [PROXY_SIGNATURE_HEADER]: flipped })).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
    expect(resolve({ ...headers, [PROXY_SIGNATURE_HEADER]: 'zz' })).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('IP que no es IP, cabeceras incompletas o ausentes', () => {
    expect(resolve(signedHeaders({ ip: 'no-es-ip' }))).toEqual({
      ok: false,
      reason: 'invalid-ip',
    });
    expect(
      resolve({ ...signedHeaders(), [PROXY_SIGNATURE_HEADER]: undefined }),
    ).toEqual({ ok: false, reason: 'incomplete' });
    expect(resolve({})).toEqual({ ok: false, reason: 'absent' });
  });

  it('sin secreto configurado la función está desactivada', () => {
    expect(resolve(signedHeaders(), [])).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  describe('middleware', () => {
    function run(headers: Record<string, string>, secrets = [SECRET]) {
      const req = {
        method: 'POST',
        originalUrl: PATH,
        headers,
        ip: '76.76.21.21', // la de la conexión (Vercel)
        ips: ['76.76.21.21'],
      } as unknown as Request;
      const next: NextFunction = jest.fn();
      createProxyClientIpMiddleware(secrets, () => NOW_MS)(
        req,
        {} as Response,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
      return req;
    }

    it('con firma válida sustituye request.ip y request.ips', () => {
      const req = run(signedHeaders());
      expect(req.ip).toBe('203.0.113.7');
      expect(req.ips).toEqual(['203.0.113.7']);
    });

    it('con firma inválida deja la IP de la conexión', () => {
      const req = run({
        ...signedHeaders(),
        [PROXY_CLIENT_IP_HEADER]: '198.51.100.1',
      });
      expect(req.ip).toBe('76.76.21.21');
    });

    it('sin secreto deja la IP de la conexión', () => {
      expect(run(signedHeaders(), []).ip).toBe('76.76.21.21');
    });
  });
});
