import * as Joi from 'joi';

/**
 * Validación de variables de entorno (OP-03).
 *
 * Solo es obligatorio lo que el backend usa hoy: base de datos, Redis y JWT.
 * Las integraciones que aún no existen (cadena, indexador) son opcionales y se
 * validan solo si se definen. Las variables de proveedores descartados
 * (Dynamic, Supabase, pasarela bancaria, contratos CONTRACT_* antiguos) ya no
 * se leen; si siguen en un .env antiguo se ignoran (`allowUnknown`).
 */
export const envValidationSchema = Joi.object({
  // Servidor HTTP
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  // 4000 en local: el 3000 lo usa el sitio de bodegas
  PORT: Joi.number().port().default(4000),
  APP_NAME: Joi.string().default('Drinks on Chain Backend'),

  // Base de Datos PostgreSQL
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required()
    .messages({
      'any.required': 'DATABASE_URL is a required environment variable',
      'string.uri': 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),

  // Redis (salud hoy; BullMQ en la Ola 0 · 0.4)
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required()
    .messages({
      'any.required': 'REDIS_URL is a required environment variable',
      'string.uri': 'REDIS_URL must be a valid Redis connection string',
    }),

  // JWT
  JWT_SECRET: Joi.string().min(32).required().messages({
    'any.required': 'JWT_SECRET is a required environment variable',
    'string.min': 'JWT_SECRET must be at least 32 characters long',
  }),
  // Acceso de 15 min (contrato O0 §5): un valor mayor se recorta a 900 s
  JWT_EXPIRES_IN: Joi.string()
    .pattern(/^\d+\s*(ms|s|m|h|d)?$/i)
    .default('900s'),
  // Clave de la cadena de refrescos (HMAC), distinta de JWT_SECRET
  JWT_REFRESH_SECRET: Joi.string().min(32).required().messages({
    'any.required': 'JWT_REFRESH_SECRET is a required environment variable',
    'string.min': 'JWT_REFRESH_SECRET must be at least 32 characters long',
  }),

  // Obsoleta desde 0.5: la renovación dura 7 días (personal) o 30
  // (consumidores), ver SESSION_TTL_*. Se acepta para no romper .env antiguos.
  JWT_REFRESH_EXPIRES_IN: Joi.string().optional(),

  // Sesiones (contrato O0 §5). Sin valores por defecto aquí: los pone el
  // código (src/modules/auth/sessions/session.config.ts).
  SESSION_TTL_STAFF_DAYS: Joi.number().integer().min(1).max(90).optional(),
  SESSION_TTL_CONSUMER_DAYS: Joi.number().integer().min(1).max(365).optional(),
  REFRESH_GRACE_SECONDS: Joi.number().integer().min(1).max(120).optional(),
  // SE-05: 403 ORG_NOT_ACTIVE en el ERP con la bodega no ACTIVE (Ola 1)
  FEATURE_ENFORCE_ACTIVE_ORG: Joi.boolean().optional(),

  // IP real detrás de nginx (SE-06): número de saltos de proxy (1) o lista de Express
  TRUST_PROXY: Joi.string().allow('').invalid('true').optional().messages({
    'any.invalid':
      'TRUST_PROXY=true confiaría en cualquier X-Forwarded-For; usa el número de saltos (1 con nginx)',
  }),
  // Límites de peticiones por IP y minuto (SE-06, IAM-07)
  RATE_LIMIT_GLOBAL_PER_MINUTE: Joi.number().integer().min(1).optional(),
  RATE_LIMIT_AUTH_PER_MINUTE: Joi.number().integer().min(1).optional(),
  RATE_LIMIT_LOGIN_PER_MINUTE: Joi.number().integer().min(1).optional(),
  RATE_LIMIT_SIGNUP_PER_MINUTE: Joi.number().integer().min(1).optional(),
  RATE_LIMIT_REFRESH_PER_MINUTE: Joi.number().integer().min(1).optional(),
  // Bloqueo progresivo del login: fallos antes del primer bloqueo
  LOGIN_LOCK_EMAIL_THRESHOLD: Joi.number().integer().min(1).optional(),
  LOGIN_LOCK_IP_THRESHOLD: Joi.number().integer().min(1).optional(),

  // Stellar / Soroban (opcional hasta la Ola 3)
  STELLAR_NETWORK: Joi.string()
    .valid('testnet', 'mainnet', 'futurenet', 'standalone')
    .default('testnet'),
  STELLAR_HORIZON_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://horizon-testnet.stellar.org'),
  STELLAR_SOROBAN_RPC_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://soroban-testnet.stellar.org'),
  STELLAR_RELAYER_SECRET_KEY: Joi.string()
    .regex(/^S[A-Z0-9]{55}$/)
    .optional()
    .messages({
      'string.pattern.base':
        'STELLAR_RELAYER_SECRET_KEY must be a valid 56-character Stellar secret seed starting with S',
    }),

  // Almacenamiento de objetos privado (OPS-06, SE-04): s3 (MinIO) o local
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./uploads'),
  // Origen público de la API para las URL firmadas del driver local
  // (por defecto http://localhost:<PORT>)
  STORAGE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  // Vida de las URL firmadas de lectura (máx. 1 h)
  STORAGE_SIGNED_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(900),
  // Secreto de las URL firmadas del driver local (por defecto, derivado de JWT_SECRET)
  STORAGE_SIGNING_SECRET: Joi.string().min(32).allow('').optional(),
  S3_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  // Endpoint que ve el navegador, si difiere del interno (p. ej. detrás de nginx)
  S3_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
  S3_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .when('STORAGE_DRIVER', { is: 's3', then: Joi.required() }),
  S3_ACCESS_KEY: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
  }),
  S3_SECRET_KEY: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
  }),

  // Logs: json (por defecto, una línea por entrada) o text (legible en local)
  LOG_FORMAT: Joi.string().valid('json', 'text').default('json'),

  // Indexador (opcional hasta la Ola 3)
  STELLAR_INDEXER_POLL_INTERVAL_MS: Joi.number().min(1000).default(5000),
  STELLAR_INDEXER_START_LEDGER: Joi.number().min(0).default(0),

  // Swagger UI en /docs y documento en /docs-json (SE-08). Sin definir:
  // activo fuera de producción, apagado en producción. El contrato versionado
  // es openapi.json.
  SWAGGER_ENABLED: Joi.boolean().optional(),

  // CORS: lista de orígenes exactos separada por comas; sin comodines.
  // Obligatoria en producción. El formato de cada origen se valida al
  // arrancar (src/config/cors.config.ts).
  CORS_ALLOWED_ORIGINS: Joi.string()
    .allow('')
    .pattern(/^[^*]*$/)
    .messages({
      'string.pattern.base':
        'CORS_ALLOWED_ORIGINS must list exact origins; "*" is not allowed',
    })
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().required().invalid('').messages({
        'any.required': 'CORS_ALLOWED_ORIGINS is required in production',
        'any.invalid': 'CORS_ALLOWED_ORIGINS is required in production',
      }),
    }),
});
