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
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required().messages({
    'any.required': 'JWT_REFRESH_SECRET is a required environment variable',
    'string.min': 'JWT_REFRESH_SECRET must be at least 32 characters long',
  }),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),

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

  // Almacenamiento de archivos (local hoy; objetos privados en la Ola 0 · 0.9)
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./uploads'),
  // Si falta, se deriva de PORT: http://localhost:<PORT>/uploads
  STORAGE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),

  // Indexador (opcional hasta la Ola 3)
  STELLAR_INDEXER_POLL_INTERVAL_MS: Joi.number().min(1000).default(5000),
  STELLAR_INDEXER_START_LEDGER: Joi.number().min(0).default(0),

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
