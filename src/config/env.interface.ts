export interface EnvironmentVariables {
  // Servidor HTTP
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  APP_NAME: string;

  // Base de Datos PostgreSQL
  DATABASE_URL: string;

  // Redis
  REDIS_URL: string;
  QUEUE_PREFIX: string;

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
  PROXY_SHARED_SECRET?: string;
  RATE_LIMIT_GLOBAL_PER_MINUTE?: number;
  RATE_LIMIT_AUTH_PER_MINUTE?: number;
  RATE_LIMIT_LOGIN_PER_MINUTE?: number;
  RATE_LIMIT_SIGNUP_PER_MINUTE?: number;
  RATE_LIMIT_REFRESH_PER_MINUTE?: number;
  LOGIN_LOCK_EMAIL_THRESHOLD?: number;
  LOGIN_LOCK_IP_THRESHOLD?: number;

  // Lista de espera (contrato O1b §1)
  WAITLIST_LIMIT_IP_MINUTE?: number;
  WAITLIST_LIMIT_IP_HOUR?: number;
  WAITLIST_LIMIT_EMAIL_HOUR?: number;
  WAITLIST_CAPTCHA_REQUIRED?: boolean;

  // Cuenta, segundo factor e invitaciones (contrato O1 §1–§2)
  MFA_ENCRYPTION_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  APP_URL_BODEGAS?: string;
  APP_URL_ERP?: string;
  APP_URL_BACKOFFICE?: string;
  APP_URL_POS?: string;
  APP_URL_MARKETPLACE?: string;

  // Cadena (Ola 3, contrato O3 §2.1): todas opcionales. Los secretos
  // (CHAIN_SECRET_*, CHAIN_DEV_WINERY_SEED, CHAIN_CONSUMER_MASTER_SEED) solo
  // los lee el custodio ENV, en el worker
  STELLAR_NETWORK: 'TESTNET' | 'PUBLIC' | 'LOCAL';
  STELLAR_NETWORK_PASSPHRASE?: string;
  STELLAR_RPC_URL?: string;
  STELLAR_EXPLORER_BASE_URL?: string;
  STELLAR_HOME_DOMAIN?: string;
  WINERY_NFT_WASM_HASH?: string;
  CHAIN_CUSTODY_DRIVER?: 'ENV' | 'LOCAL' | '';
  CHAIN_MINT_ENABLED?: boolean | '';
  CHAIN_TX_MAX_FEE_STROOPS?: string;
  CHAIN_OPERATIONS_MIN_BALANCE_XLM?: string;
  CHAIN_ANCHOR_MIN_BALANCE_XLM?: string;
  CHAIN_WINERY_STARTING_BALANCE_XLM?: string;
  CHAIN_TTL_EXTEND_BELOW_DAYS?: number | '';
  CHAIN_CONSUMER_SEED_CHECK_ADDRESS?: string;
  PASSPORT_BASE_URL?: string;
  API_PUBLIC_URL?: string;

  // Almacenamiento de objetos privado
  STORAGE_DRIVER: 'local' | 's3';
  STORAGE_LOCAL_PATH: string;
  STORAGE_BASE_URL?: string;
  STORAGE_SIGNED_URL_TTL_SECONDS: number;
  STORAGE_SIGNING_SECRET?: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;

  // Logs
  LOG_FORMAT: 'json' | 'text';

  // Swagger UI (/docs) y documento (/docs-json)
  SWAGGER_ENABLED?: boolean;

  // CORS: orígenes exactos separados por comas
  CORS_ALLOWED_ORIGINS?: string;
}
