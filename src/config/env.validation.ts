import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Servidor HTTP
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  APP_NAME: Joi.string().default('Drinks on Chain Backend'),

  // Base de Datos PostgreSQL
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required()
    .messages({
      'any.required': 'DATABASE_URL is a required environment variable',
      'string.uri': 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),

  // Redis (BullMQ)
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

  // Stellar / Soroban Blockchain
  STELLAR_NETWORK: Joi.string()
    .valid('testnet', 'mainnet', 'futurenet', 'standalone')
    .default('testnet'),
  STELLAR_HORIZON_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required()
    .messages({
      'any.required': 'STELLAR_HORIZON_URL is a required environment variable',
    }),
  STELLAR_SOROBAN_RPC_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required()
    .messages({
      'any.required':
        'STELLAR_SOROBAN_RPC_URL is a required environment variable',
    }),
  STELLAR_RELAYER_SECRET_KEY: Joi.string()
    .regex(/^S[A-Z0-9]{55}$/)
    .required()
    .messages({
      'any.required':
        'STELLAR_RELAYER_SECRET_KEY is a required environment variable',
      'string.pattern.base':
        'STELLAR_RELAYER_SECRET_KEY must be a valid 56-character Stellar secret seed starting with S',
    }),

  // Contratos Soroban (Direcciones C...)
  CONTRACT_PRODUCER_REGISTRY: Joi.string()
    .regex(/^C[A-Z0-9]{55}$/)
    .required()
    .messages({
      'any.required': 'CONTRACT_PRODUCER_REGISTRY is required',
      'string.pattern.base':
        'CONTRACT_PRODUCER_REGISTRY must be a valid 56-character Soroban contract address starting with C',
    }),
  CONTRACT_BATCH_ANCHOR: Joi.string()
    .regex(/^C[A-Z0-9]{55}$/)
    .required()
    .messages({
      'any.required': 'CONTRACT_BATCH_ANCHOR is required',
      'string.pattern.base':
        'CONTRACT_BATCH_ANCHOR must be a valid 56-character Soroban contract address starting with C',
    }),
  CONTRACT_PRODUCT_NFT: Joi.string()
    .regex(/^C[A-Z0-9]{55}$/)
    .required()
    .messages({
      'any.required': 'CONTRACT_PRODUCT_NFT is required',
      'string.pattern.base':
        'CONTRACT_PRODUCT_NFT must be a valid 56-character Soroban contract address starting with C',
    }),
  CONTRACT_CLAIM_ESCROW: Joi.string()
    .regex(/^C[A-Z0-9]{55}$/)
    .required()
    .messages({
      'any.required': 'CONTRACT_CLAIM_ESCROW is required',
      'string.pattern.base':
        'CONTRACT_CLAIM_ESCROW must be a valid 56-character Soroban contract address starting with C',
    }),

  // Dynamic Wallets
  DYNAMIC_ENVIRONMENT_ID: Joi.string().required().messages({
    'any.required': 'DYNAMIC_ENVIRONMENT_ID is required for custodial wallets',
  }),
  DYNAMIC_API_KEY: Joi.string().required().messages({
    'any.required': 'DYNAMIC_API_KEY is required for Dynamic integration',
  }),

  // Almacenamiento de Archivos e Imágenes (Local / S3 / Supabase)
  STORAGE_DRIVER: Joi.string()
    .valid('local', 's3', 'supabase')
    .default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./uploads'),
  STORAGE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000/uploads'),

  // Proveedores Externos Opcionales (Supabase / S3)
  SUPABASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().optional(),

  // Pasarela de Pagos (Banco API)
  PAYMENT_BANK_API_KEY: Joi.string().required().messages({
    'any.required': 'PAYMENT_BANK_API_KEY is required for payments',
  }),
  PAYMENT_BANK_API_SECRET: Joi.string().required().messages({
    'any.required': 'PAYMENT_BANK_API_SECRET is required for payments',
  }),
  PAYMENT_BANK_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required()
    .messages({
      'any.required': 'PAYMENT_BANK_BASE_URL is required',
    }),
  PAYMENT_BANK_WEBHOOK_SECRET: Joi.string().required().messages({
    'any.required':
      'PAYMENT_BANK_WEBHOOK_SECRET is required for HMAC validation',
  }),

  // Indexer
  STELLAR_INDEXER_POLL_INTERVAL_MS: Joi.number().min(1000).default(5000),
  STELLAR_INDEXER_START_LEDGER: Joi.number().min(0).default(0),

  // CORS
  CORS_ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000'),
});
