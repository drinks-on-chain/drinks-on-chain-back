# Identidad, sesiones y membresías

> Ola 0 · pasos 0.5 y 0.6 (IAM-02, 03, 04, 07, 08, 13; EQP-01, EQP-09; SE-01, SE-03, SE-06; OP-05, OP-07). Contrato: `plan/contratos/o0-sesiones-y-estandares.md` §4–§6 y `o1-backoffice-y-bodegas.md` §0 (estado `INVITED`). Ajusta `docs/rules/` (A-33: tokens cortos con renovación rotativa y roles por membresía).

## Modelo

```mermaid
erDiagram
  USER ||--o{ MEMBERSHIP : "tiene"
  ORGANIZATION ||--o{ MEMBERSHIP : "agrupa"
  ORGANIZATION |o--o| WINERY : "mismo id"
  USER ||--o{ SESSION : "abre"
  ORGANIZATION |o--o{ SESSION : "activa en"
  WINERY_MEMBER |o--|| MEMBERSHIP : "mismo id (obsoleto, H1)"
```

| Tabla | Qué guarda |
|---|---|
| `organizations` | `type` (`PLATFORM` \| `WINERY` \| `PICKUP_POINT`), `name`, `status` (`INVITED` \| `ACTIVE` \| `SUSPENDED` \| `REVOKED`), `winery_id` único. La de una bodega **tiene el mismo id que la bodega** y su nombre y estado se escriben en la misma transacción que ella (`OrganizationsService.syncWinery`). La de plataforma ("Drinks on Chain") tiene el id fijo `00000000-0000-4000-8000-000000000001` (migración y seeder). |
| `memberships` | Persona + organización (única), `role`, `status` (`ACTIVE` \| `BLOCKED`), `blocked_by` (`OWNER` \| `PLATFORM`), `blocked_reason`, `blocked_at`. En las bodegas el id coincide con el de `winery_members`, que sigue siendo el autor de la trazabilidad. |
| `sessions` | `id` = claim `sid`, persona, organización activa, audiencia, hash SHA-256 del refresco vigente, `generation` (rotaciones), `rotated_at`, `last_used_at`, `expires_at` (deslizante), `revoked_at`, `revoked_reason`, IP y agente. La familia de refrescos es la sesión entera. |
| `users.last_organization_id` | Última organización activa elegida (la de por defecto al iniciar sesión). |

Roles válidos por tipo: plataforma `SUPERADMIN`, `ADMIN`, `OPERATIONS`, `SUPPORT`; bodega `OWNER`, `ENOLOGIST`, `AGRONOMIST`, `OPERATOR`, `ACCOUNTANT`; punto de canje `MANAGER`, `CASHIER` (Ola 5).

**Obsoletos hasta H1** (se retiran al cerrar la Ola 1): `users.user_role` (ya no autoriza nada; solo alimenta `user.userRole` y el claim de compatibilidad) y `winery_members` (matrícula profesional y autoría; `is_active` se mantiene sincronizado con `memberships.status`).

### Migración `20260927120000_organizations_memberships_sessions`

Aditiva y de datos, probada sobre una copia con datos (semilla + bodegas `ACTIVE`/`PENDING`/`REVOKED`, una persona en dos bodegas, un `POS_OPERATOR`, un miembro inactivo):

- `winery_status_enum`: `PENDING` → `INVITED` (renombrado del valor: las filas se conservan).
- Organización de plataforma y una organización `WINERY` por bodega (mismo id, nombre comercial y estado).
- `PLATFORM_ADMIN` → membresía `SUPERADMIN` de la plataforma (`BLOCKED` si la cuenta estaba inactiva).
- `winery_members` → membresías `WINERY` con el mismo id y rol (`is_active = false` → `BLOCKED` por la plataforma).
- `POS_OPERATOR` y consumidores: sin membresía (el operario de planta conserva la suya de bodega como `OPERATOR`).

## Sesión (contrato O0 §5)

```mermaid
sequenceDiagram
  participant C as App (mismo origen, /api/v1 → API)
  participant A as API
  participant DB as PostgreSQL
  participant R as Redis
  C->>A: POST /auth/login {email, password}
  A->>R: ¿bloqueo por correo o IP?
  A->>DB: sesión nueva (hash del refresco, gen 0)
  A-->>C: {user, memberships, activeOrganizationId, tokens} + Set-Cookie doc_rt
  C->>A: GET … Authorization: Bearer <acceso 15 min>
  A->>R: ¿sid revocado?
  A->>DB: sesión viva, persona activa, membresía utilizable
  C->>A: POST /auth/refresh (cookie doc_rt)
  A->>DB: rota: gen+1 si nadie la rotó (UPDATE … WHERE generation = n)
  A->>R: guarda el acceso nuevo 20 s (periodo de gracia)
  A-->>C: misma forma que el login + cookie nueva
```

- **Acceso**: JWT HS256 de **15 min** (`JWT_EXPIRES_IN`, recortado a 900 s aunque se configure más). Claims `sub`, `aud` (`STAFF` \| `CONSUMER`), `org`, `orgType`, `role`, `sid`, `jti` y, hasta H1, `email`, `userRole`, `wineryId`, `memberRole`.
- **Refresco**: `<sid>.<generación>.<secreto>`. El secreto inicial es aleatorio; cada rotación deriva el siguiente con `HMAC-SHA256(JWT_REFRESH_SECRET, "sid.gen+1.secreto")`. Solo se guarda el hash del vigente. Viaja en la cookie `doc_rt` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age`), sin `Secure` solo con `NODE_ENV=development` y origen `localhost`; y en `tokens.refreshToken` por compatibilidad hasta H1 (también se acepta en el cuerpo de `refresh`, `switch-organization` y `logout`).
- **Duración deslizante**: 7 días el personal (`SESSION_TTL_STAFF_DAYS`), 30 los consumidores (`SESSION_TTL_CONSUMER_DAYS`); cada rotación la renueva.
- **Rotación y reutilización**: el refresco vigente rota. El inmediatamente anterior, presentado otra vez dentro del **periodo de gracia** (`REFRESH_GRACE_SECONDS`, 20 s), devuelve **el mismo par nuevo** (el refresco se recalcula por derivación; el acceso sale de Redis): dos pestañas renovando a la vez no cierran la sesión. Fuera de la gracia, o cualquier refresco más antiguo de la cadena → se revoca la sesión y **401 `AUTH_REFRESH_REUSED`**. Un refresco que no encaja en la cadena es **401 `AUTH_REFRESH_INVALID`** y no revoca nada (conocer un `sid` no permite cerrar la sesión de otro).
- **Organización activa**: la última usada si sigue siendo utilizable (membresía `ACTIVE`, organización no `REVOKED`); si no, la primera utilizable (plataforma antes que bodega, y entre bodegas la más antigua); `null` si no hay. Si la sesión no tenía (p. ej. el dueño acaba de registrar su bodega), la renovación toma la de por defecto.
- **`POST /auth/switch-organization`** `{ organizationId }`: exige el acceso y el refresco de **esa misma sesión** (cookie o cuerpo), que se rota; misma `sid`, `org` nueva, se recuerda como la última usada. Sin membresía → 404 `ORG_NOT_FOUND`; membresía bloqueada → 403 `ORG_MEMBERSHIP_BLOCKED`; organización revocada → 403 `ORG_REVOKED`.
- **`POST /auth/logout`** (pública): revoca la sesión identificada por el acceso (aunque haya caducado) o por el refresco, y borra la cookie (`Max-Age=0`). **`POST /auth/logout-all`**: todas las de la persona. Ambas 204.
- **`GET /users/me`** → `{ user, memberships, activeOrganizationId }` (`user` = perfil de 0.1 + `audience`). `PATCH /users/me` sigue devolviendo el perfil.

### Revocación inmediata (IAM-13)

Revocar = `sessions.revoked_at` + marca `auth:revoked:<sid>` en Redis durante la vida de un acceso (+60 s). El guard global mira primero Redis (sin tocar la base) y después la base (sesión no revocada, persona activa, membresía de la organización del token `ACTIVE` y organización no `REVOKED`); si Redis no responde, decide la base. Se revoca al:

| Evento | Sesiones revocadas | Motivo |
|---|---|---|
| Bloquear una membresía (`MembershipsService.block`) | Las de esa persona con esa organización activa | `MEMBERSHIP_BLOCKED` |
| Bloquear la cuenta (`UsersService.blockAccount`) | Todas las de la persona | `USER_BLOCKED` |
| Rechazar (revocar) una bodega | Todas las que la tienen activa | `ORGANIZATION_REVOKED` |
| Reutilización de un refresco | Esa sesión | `REFRESH_REUSED` |
| `logout` / `logout-all` | Esa / todas | `LOGOUT` / `LOGOUT_ALL` |

Los endpoints de bloqueo llegan con el back office (contrato O1 §5); los servicios ya están.

## Autorización (contrato O0 §6)

Guards globales (`AppModule`, en este orden): límite de peticiones → **`AccessTokenGuard`** (acceso válido + sesión viva) → **`AuthorizationGuard`** → **`TenantGuard`**. Las rutas `@Public()` solo pasan por el primero.

| Decorador | Se evalúa contra |
|---|---|
| `@Audience('STAFF')` | claim `aud` |
| `@OrgType('WINERY')` | tipo de la organización activa |
| `@Roles('OWNER', 'ENOLOGIST')` | rol en la organización activa |
| `@RequireActiveOrg()` | SE-05: bodega activa en estado `ACTIVE`. En la Ola 0 solo aviso en logs; con `FEATURE_ENFORCE_ACTIVE_ORG=true`, 403 `ORG_NOT_ACTIVE` con `details: [{ field: null, message: <estado> }]` |

- **Rutas de bodega** (`@OrgType('WINERY')`: todo el ERP y `wineries/my*`): la bodega es la activa; si la petición apunta a otra (`wineryId` en ruta, query o cuerpo) → **404**. El personal de plataforma pasa sin rol de bodega: `SUPERADMIN`, `ADMIN` y `OPERATIONS` leen y escriben, `SUPPORT` solo lee; eligen la bodega con `?wineryId=` y **las escrituras lo exigen** (422 con `details[{ field: 'wineryId' }]`, OP-07); una bodega inexistente → 404 `ORG_NOT_FOUND`.
- **Rutas de plataforma** (`GET /wineries`, `/wineries/pending`: todo el personal de plataforma; `approve`/`reject`: `SUPERADMIN`, `ADMIN`, `OPERATIONS`).
- **SE-01**: `POST /wineries/my/members` y `/members/create` (solo `OWNER` o plataforma) crean o reactivan **la membresía de esa bodega** (`MembershipsService.addToWinery`); nunca escriben `users.user_role` ni membresías de otra organización. Ya miembro activo → 409 `ORG_ALREADY_MEMBER`; bloqueada por la plataforma → 403 `ORG_BLOCKED_BY_PLATFORM`.

Matriz de roles de bodega en el ERP (docs-back/05 §3; la plataforma, como arriba):

| Ruta | OWNER | ENOLOGIST | AGRONOMIST | OPERATOR | ACCOUNTANT |
|---|---|---|---|---|---|
| Parcelas: alta y edición | ✅ | — | ✅ | — | — |
| Parcelas: lectura | ✅ | ✅ | ✅ | — | ✅ |
| Vendimia (pesaje): alta | ✅ | ✅ | ✅ | ✅ | — |
| Vendimia: lectura | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dictamen fitosanitario | ✅ | ✅ | ✅ | — | — |
| Cubas: alta y tratamientos | ✅ | ✅ | — | — | — |
| Cubas: lectura | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lecturas diarias (`…/logs`) | ✅ | ✅ | ✅ | ✅ | — |
| Crianza, destilación, embotellado: alta | ✅ | ✅ | — | — | — |
| Crianza, destilación, embotellado: lectura | ✅ | ✅ | — | — | ✅ |
| Laboratorio: alta | ✅ | ✅ | — | — | — |
| Laboratorio: lectura | ✅ | ✅ | ✅ | — | ✅ |
| `PATCH /wineries/my`, alta de miembros | ✅ | — | — | — | — |
| `GET /wineries/my`, `/my/members` | ✅ | ✅ | ✅ | ✅ | ✅ |

Cambios frente a 0.1: el operario de planta ya no es `POS_OPERATOR` (OP-05) y pesa y registra lecturas; el contador lee; el dueño dictamina; los consumidores ya no leen análisis de laboratorio por el ERP (llegará con el visor público).

## Límites (SE-06, IAM-07)

- `TRUST_PROXY=1` (una capa: nginx) → `request.ip` es la IP real de `X-Forwarded-For`. `true` se rechaza. En el servidor lo fija `deploy/dev/compose.yml`.
- Límite **global** por IP para toda la API: `RATE_LIMIT_GLOBAL_PER_MINUTE` (300). **`/auth/*`** por IP y ruta: `RATE_LIMIT_AUTH_PER_MINUTE` (20), login `RATE_LIMIT_LOGIN_PER_MINUTE` (10), signup `RATE_LIMIT_SIGNUP_PER_MINUTE` (5), refresh `RATE_LIMIT_REFRESH_PER_MINUTE` (30). 429 `TOO_MANY_REQUESTS` con `Retry-After`. `/health` no cuenta en el global. Contadores en memoria del proceso (una sola réplica); pasar a Redis cuando haya varias.
- **Bloqueo progresivo** del login en Redis, por correo (hash) y por IP: a partir de `LOGIN_LOCK_EMAIL_THRESHOLD` (5) o `LOGIN_LOCK_IP_THRESHOLD` (20) fallos en una hora, 60 s de bloqueo que se duplican con cada fallo (tope 1 h) → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After`, sin comprobar la contraseña. Un login correcto limpia el contador del correo. El 401 es el mismo para correo inexistente, contraseña mala o cuenta bloqueada (y el tiempo de respuesta también).

## Códigos de error

| Código | HTTP | Cuándo |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Correo o contraseña incorrectos, o cuenta bloqueada |
| `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 | Acceso ausente, mal firmado, de 0.1 (sin `sid`) / caducado |
| `AUTH_REFRESH_INVALID` | 401 | Refresco ausente o ajeno a la sesión |
| `AUTH_REFRESH_REUSED` | 401 | Reutilización fuera de la gracia (sesión revocada) |
| `AUTH_SESSION_REVOKED` / `AUTH_SESSION_EXPIRED` | 401 | Sesión revocada, persona o membresía bloqueada / caducada |
| `AUTH_TOO_MANY_ATTEMPTS` | 429 | Bloqueo progresivo del login |
| `AUTH_INSUFFICIENT_PERMISSIONS` | 403 | Audiencia, tipo de organización o rol insuficientes |
| `ORG_NOT_FOUND` | 404 | Sin membresía en la organización / bodega inexistente |
| `ORG_MEMBERSHIP_BLOCKED` / `ORG_REVOKED` | 403 | `switch-organization` a una membresía bloqueada / organización revocada |
| `ORG_NOT_ACTIVE` | 403 | ERP con bodega no `ACTIVE` (solo con `FEATURE_ENFORCE_ACTIVE_ORG`) |
| `ORG_BLOCKED_BY_PLATFORM` | 403 | El dueño intenta reactivar a quien bloqueó la plataforma |
| `ORG_ALREADY_MEMBER` | 409 | Ya es miembro activo |

## Pruebas

- Unitarias: `src/modules/auth/__tests__/` (cadena de refrescos, rotación, gracia, reutilización, revocación, guards, bloqueo progresivo, cookie, `TRUST_PROXY`) y `src/modules/organizations/__tests__/` (organización activa por defecto, SE-01, bloqueo).
- e2e con Postgres y Redis: `test/sessions.e2e-spec.ts` (login y cookie, rotación, dos renovaciones a la vez, reutilización tras la gracia, persona en dos bodegas con 404 cruzado, bloqueo de membresía → 401, logout/logout-all, SE-01, plataforma con `?wineryId=`, límites con `X-Forwarded-For`). Utilidades para las demás e2e: `test/helpers/identity.ts`.
