const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'pin',
  'pin_hash',
  'pinhash',
  'secret',
  'api_key',
  'apikey',
  'apisecret',
  'api_secret',
  'webhooksecret',
  'webhook_secret',
  'private_key',
  'relayer_secret_key',
  'relayersecretkey',
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'cvv',
  'cardnumber',
  'creditcardnumber',
]);

export function sanitizeLogData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeLogData);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '***REDACTED***';
    } else if (
      typeof value === 'string' &&
      value.startsWith('S') &&
      value.length === 56
    ) {
      // Enmascarar claves privadas de Stellar (Ed25519 Secret Seed)
      sanitized[key] = 'S***[STELLAR_SECRET_REDACTED]***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
