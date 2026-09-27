export interface EnvironmentVariables {
  // Servidor HTTP
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  APP_NAME: string;

  // Base de Datos PostgreSQL
  DATABASE_URL: string;

  // Redis
  REDIS_URL: string;

  // JWT
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_REFRESH_SECRET: string;

  // Sesiones y límites (contrato O0 §5, SE-06, IAM-07)
  SESSION_TTL_STAFF_DAYS?: number;
  SESSION_TTL_CONSUMER_DAYS?: number;
  REFRESH_GRACE_SECONDS?: number;
  FEATURE_ENFORCE_ACTIVE_ORG?: boolean;
  TRUST_PROXY?: string;
  RATE_LIMIT_GLOBAL_PER_MINUTE?: number;
  RATE_LIMIT_AUTH_PER_MINUTE?: number;
  RATE_LIMIT_LOGIN_PER_MINUTE?: number;
  RATE_LIMIT_SIGNUP_PER_MINUTE?: number;
  RATE_LIMIT_REFRESH_PER_MINUTE?: number;
  LOGIN_LOCK_EMAIL_THRESHOLD?: number;
  LOGIN_LOCK_IP_THRESHOLD?: number;

  // Stellar / Soroban (opcional hasta la Ola 3)
  STELLAR_NETWORK: 'testnet' | 'mainnet' | 'futurenet' | 'standalone';
  STELLAR_HORIZON_URL: string;
  STELLAR_SOROBAN_RPC_URL: string;
  STELLAR_RELAYER_SECRET_KEY?: string;

  // Almacenamiento de archivos
  STORAGE_DRIVER: 'local' | 's3';
  STORAGE_LOCAL_PATH: string;
  STORAGE_BASE_URL?: string;

  // Indexador (opcional hasta la Ola 3)
  STELLAR_INDEXER_POLL_INTERVAL_MS: number;
  STELLAR_INDEXER_START_LEDGER: number;

  // Swagger UI (/docs) y documento (/docs-json)
  SWAGGER_ENABLED: boolean;

  // CORS: orígenes exactos separados por comas
  CORS_ALLOWED_ORIGINS?: string;
}
