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
  JWT_REFRESH_EXPIRES_IN: string;

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

  // CORS: orígenes exactos separados por comas
  CORS_ALLOWED_ORIGINS?: string;
}
