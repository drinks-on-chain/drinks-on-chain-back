# Ruta de Desarrollo (Roadmap v4) - Backend NestJS + Soroban Stellar
## _Estrategia de Construcción y Secuencia Técnica para el MVP_

Esta guía técnica reorganiza y profundiza las fases de implementación del backend de **Drinks on Chain (DoC)** bajo un enfoque de desarrollo ágil dirigido por dependencias lógicas. Se elimina cualquier infraestructura intermedia y se consolida todo sobre un ecosistema unificado en **NestJS + PostgreSQL + Soroban (Stellar)**.

---

## Estructura Secuencial del Roadmap (Grafo de Dependencias)

El orden propuesto mitiga riesgos de integración técnica al congelar primero las interfaces de blockchain y el core de seguridad antes de construir la lógica transaccional, el ERP y los módulos de venta:

```
┌─────────────────────────────────┐
│     FASE 1: CONFIGURACIÓN       │ ◄── Inicialización de entornos, Postgres y NestJS.
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│       FASE 2: CONTRATOS         │ ◄── Codificación y congelamiento de Smart Contracts (Rust).
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     FASE 3: JWT Y TENANTS       │ ◄── Seguridad Multi-tenant y Autenticación.  // Sabado
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│      FASE 4: MÓDULO ERP         │ ◄── Lógica física, base de datos y patrón Strategy de bebidas. // Domingo
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ FASE 5: CONEXIÓN ERP-BLOCKCHAIN │ ◄── Integración con Stellar SDK y Oráculo de Consenso.
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  FASE 6: GESTIÓN DE RESERVAS    │ ◄── Backoffice B2B Admin (Tokenomics, Precios, Supply).
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│   FASE 7: ADQUISICIÓN Y CANJE   │ ◄── Marketplace B2C (Mint), Redención (Burn) y POS App.
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  FASE 8: PRUEBAS Y DESPLIEGUE   │ ◄── Auditoría de seguridad RLS, QA y Deploy.
└─────────────────────────────────┘
```

---

## FASE 1: Configuración de Entornos e Inicialización del Sistema

El objetivo de esta fase es estructurar el espacio de trabajo local y de base de datos, asegurando que todos los desarrolladores compartan el mismo ecosistema.

### 1.1. Inicialización de Base de Datos PostgreSQL (Local)
*   Configurar un contenedor de Docker (`docker-compose.yml`) con una base de datos PostgreSQL de desarrollo.
*   Crear los esquemas y ejecutar las migraciones DDL iniciales para soportar las tablas esenciales:
    *   `tenants` (Bodegas/Empresas).
    *   `planes` y `suscripciones` (SaaS Control).
    *   `usuarios` (Usuarios internos y clientes).
    *   `tiendas` (Puntos de retiro).
    *   `lotes` (Activos RWA).
    *   `hitos_trazabilidad` (Registro histórico).
    *   `clientes_asociados` (Relación multi-tienda).
*   Configurar un script de seeding (`npm run seed`) para insertar:
    *   El usuario administrador global del sistema (`ADMIN_DOC`).
    *   Tres planes estándar de suscripción (`Básico`, `Premium`, `Corporativo`) con sus restricciones lógicas.

### 1.2. Inicialización de NestJS Skeleton
*   Crear la estructura del proyecto NestJS:
    ```bash
    npm i -g @nestjs/cli
    nest new drinks-on-chain-backend
    ```
*   Configurar e integrar el módulo de configuración global (`@nestjs/config`) para la carga e inyección segura del archivo `.env` (credenciales de DB, claves de red Stellar, etc.).
*   Integrar un ORM (TypeORM o Prisma) configurando la conexión hacia el PostgreSQL local con soporte de pools transaccionales.

---

## FASE 2: Desarrollo e Inmutabilidad de Contratos Inteligentes (Soroban)

Antes de programar lógica transaccional en el backend, se deben congelar las interfaces y lógicas inmutables de la blockchain en **Stellar Soroban (Rust)**.

### 2.1. Configuración de Entorno Soroban
*   Instalar la cadena de herramientas de Rust, el target de compilación WebAssembly (`wasm32-unknown-unknown`) y el CLI de Soroban.
*   Crear un espacio de trabajo Cargo multi-contrato para administrar el código de manera modular.

### 2.2. Implementación de Contratos
1.  **`TenantRegistry` (Registro de Negocios):**
    *   Guarda la clave pública de Stellar de las bodegas activas.
    *   Permite al Administrador DoC configurar los límites de acuñación y fechas de expiración de planes de suscripción.
2.  **`PreSaleEscrow` (Fideicomiso Simple):**
    *   Custodia el 100% de los pagos de preventa en Stablecoins de Stellar.
    *   Implementa el algoritmo de consenso multifirma (Oráculo Opción B): requiere firmas digitales de al menos **2 de las 3 cuentas autorizadas** (Bodega, Backend NestJS, Administrador DoC) para liberar el capital proporcional asignado al hito completado.
    *   Función de cancelación: permite al Administrador DoC anular el lote y reembolsar el 100% del dinero a las billeteras de los compradores.
3.  **`DrinksToken` (RWA Token/NFT):**
    *   Acuña tokens que equivalen conceptual y contractualmente a 1 botella de un lote.
    *   Bloquea el método `burn_for_claim` si la variable `is_redeemable` está en `false`. Solo `PreSaleEscrow` o el oráculo pueden activar la redención tras finalizarse el embotellado.

### 2.3. Pruebas Unitarias de Blockchain
*   Escribir pruebas en Rust (`#[test]`) simulando llamadas cruzadas entre contratos, validación de límites de acuñación y firma de oráculo multisig.

---

## FASE 3: Autenticación JWT y Arquitectura Multi-tenant en NestJS

Esta fase establece las fronteras lógicas del software. Asegura que ningún usuario pueda ver o alterar datos de otra empresa y provee un marco seguro de roles corporativos (RBAC).

### 3.1. Autenticación Nativa NestJS
*   Crear el `AuthModule` utilizando `@nestjs/passport` y `@nestjs/jwt`.
*   Implementar login tradicional con cifrado de contraseñas mediante `bcrypt`.
*   El JWT devuelto al iniciar sesión debe encapsular: `userId`, `rol` (`ADMIN_DOC`, `BODEGA_ADMIN`, `ENOLOGO`, `OPERARIO_BODEGA`, `CLIENTE`, `PUNTO_RETIRO`), y de manera mandatoria, el `tenantId`.

### 3.2. Aislamiento Lógico Multi-tenant (PostgreSQL RLS)
*   Configurar un `TenantInterceptor` global en NestJS que extraiga el `tenantId` del JWT decodificado o de la cabecera `X-Tenant-ID` de la petición.
*   Implementar un servicio scoped (`TenantContext`) para encapsular el tenant de la transacción.
*   La capa de base de datos de NestJS (TypeORM o Prisma) debe ejecutar de manera obligatoria como primer comando de cada consulta a la base de datos:
    ```sql
    SET LOCAL app.current_tenant_id = 'uuid_del_tenant_actual';
    ```
*   Configurar las políticas de **Row-Level Security (RLS)** en Postgres para que filtre automáticamente las lecturas y escrituras basados en la inyección de este parámetro.

### 3.3. Guards de Roles (RBAC)
*   Crear el decorador `@Roles()` y el guard `RolesGuard` para validar que los usuarios ejecuten únicamente las rutas permitidas en su rango laboral.

---

## FASE 4: Implementación del Módulo ERP (Datos y Trazabilidad Lógica)

Con el sistema de multi-tenancy y seguridad consolidado, se programa la lógica física de la trazabilidad y la gestión de lotes en la base de datos PostgreSQL.

### 4.1. Módulo de Lotes (`LotesModule`
*   Servicios de creación y administración de lotes (`lotes` tabla).
*   **Interceptor de Límites de Suscripción:** Antes de crear un lote, NestJS valida la suscripción de la bodega. Si la cantidad de botellas estimadas supera el límite contratado en el plan o la suscripción expiró, bloquea la acción arrojando un error `403 Forbidden`.

### 4.2. Patrón Strategy + Factory en NestJS (`TrazabilidadModule`)
*   Definir la interfaz abstracta `ITraceabilityStrategy` en NestJS para controlar las variaciones físicas de las bebidas.
*   Implementar **`WineTraceabilityStrategy`**: Valida las reglas y metadatos de los 5 hitos del vino (viñedo, vendimia, fermentación, crianza, embotellado).
*   Implementar **`SinganiTraceabilityStrategy`**:\n    *   *Fase 1 (Altura):* Valida estrictamente que el campo `altitud_msnm` ingresado sea `> 1600` m.s.n.m. y que la cepa sea 100% `Moscatel de Alejandría`.\n    *   *Fase 4 (Destilación):* Exige registro de volúmenes de cabezas, colas y el corazón puro del destilado en alambiques de cobre.\n    *   *Fase 5 (Reposo):* El backend NestJS compara la fecha de inicio del reposo. Bloquea de manera inquebrantable el registro del hito 6 si no se comprueba un tiempo de reposo de **al menos 180 días (6 meses)** en tanques de acero inoxidables neutros.\n*   Implementar `TraceabilityFactory`: Resuelve dinámicamente qué estrategia inyectar según el campo `bebida_tipo` del lote en consulta.

---

## FASE 5: Conexión de ERP con Contratos de Trazabilidad (Stellar Gateway)

Esta fase vincula la lógica del ERP físico del backend con las pruebas criptográficas inmutables de la red Stellar.

### 5.1. Implementación del `StellarModule` y SDK
*   Integrar la librería `stellar-sdk` en NestJS.
*   Crear servicios centralizados de blockchain para armar transacciones, estimar comisiones y conectarse con los nodos de Stellar Testnet/Livenet.

### 5.2. Anclaje de Datos (Hash Anchoring)
*   Cada vez que un operario registra un hito en el ERP (ej: fin de destilación), NestJS procesa el JSON de metadatos, genera un hash SHA-256 criptográfico y ejecuta de forma asíncrona una llamada a Soroban para anclar el hash en el smart contract `PreSaleEscrow`. Esto permite certificar a auditorías externas que los metadatos de la web no han sido alterados posteriormente.

### 5.3. Oráculo de Consenso Multifirma
*   Implementar el endpoint seguro para firmas de hitos.
*   Cuando la bodega solicita la liberación de capital del hito completado, proporciona su firma. NestJS ejecuta su propia validación lógica interna y firma automáticamente con la llave del backend como segunda firma del oráculo. El administrador de DoC proporciona la tercera firma desde su panel.
*   Al consolidarse las 2 firmas en el backend, la transacción se envía a `PreSaleEscrow` para liberar el capital proporcional asignado en stablecoins a la billetera de la bodega.

---

## FASE 6: Módulo de Gestión de Reservas y Campañas (Backoffice B2B Admin)

Esta fase actúa como el puente de control entre la producción física real y la oferta comercial digital, otorgando a los administradores de la plataforma el control absoluto sobre la tokenomics y el inventario digital antes de su publicación en el Marketplace.

### 6.1. Definición y Reservas de Tokens por Lote
*   **Separación Lógica (Estimación vs. Emisión):** Una bodega puede registrar una estimación física de 5,000 botellas en el ERP. Sin embargo, por estrategia comercial o de mitigación de riesgos, los administradores de la plataforma configuran cuántas de esas botellas se "reservarán" para el entorno digital.
*   **Endpoints de Configuración de Oferta:**
    *   `POST /admin/lotes/:id/campaña`: Inicializa la campaña digital del lote definiendo el `supply_inicial` (cantidad de tokens a emitir).
    *   `PUT /admin/lotes/:id/supply`: Permite a los administradores de DoC incrementar o disminuir dinámicamente el límite de tokens para la venta basándose en auditorías físicas o ajustes en la merma del lote antes de cerrar la preventa.

### 6.2. Motor de Precios Dinámicos y Ventanas de Venta
*   **Configuración de Tarifas:** Implementar endpoints para asignar precios específicos a las diferentes etapas del ciclo de vida:
    *   *Precio Preventa Temprana:* Descuento agresivo aplicable a los primeros hitos (ej. Viñedo/Vendimia).
    *   *Precio Preventa Estándar:* Precio regular aplicable a hitos avanzados (ej. Crianza/Reposo).
*   **Regulación por Hito:** NestJS controla de forma automática qué precio inyectar al Marketplace basándose en el hito de trazabilidad activo del lote en la base de datos PostgreSQL.

### 6.3. Sincronización con Blockchain (`PreSaleEscrow` Cap)
*   Cuando el administrador redefine la cantidad máxima de tokens a emitir para un lote en el Backoffice, NestJS ejecuta de forma segura una llamada transaccional al smart contract `PreSaleEscrow` en Soroban para actualizar la variable de tope máximo (`max_supply`), blindando la emisión en la blockchain contra cualquier intento de sobreventa.

---

## FASE 7: Módulo de Adquisición y Canje Físico (Marketplace B2C y POS Terminal)

Fase donde se completa el ciclo comercial: los clientes visualizan la oferta configurada en la Fase 6, compran tokens de preventa y se procesa el canje inmutable por el producto físico en las tiendas.

### 7.1. Catálogo Público y Adquisición del Token (Preventas)
*   Módulo de visualización en el Marketplace. Consume directamente las variables de precio y disponibilidad del supply configuradas por los administradores en la Fase 6.
*   Los usuarios compran botellas virtuales enviando stablecoins directamente al contrato `PreSaleEscrow` en Soroban. El contrato ejecuta el minting automático del token `DrinksToken` hacia la billetera conectada del usuario.

### 7.2. Generación del QR Temporal de Canje
*   Endpoint seguro en NestJS para la solicitud de canje físico.
*   *Restricción de Lockup:* NestJS bloquea la generación del QR si el lote del token en cuestión tiene `is_redeemable = false` (aún en maduración/reposo).
*   *QR Tokenizado:* Si `is_redeemable = true`, NestJS genera un token firmado (con un JWT de corta duración, ej: 15 minutos) que encapsula el ID del token y la billetera del cliente. Este se proyecta en pantalla como un código QR dinámico.

### 7.3. API para la Terminal de Puntos de Retiro (POS App)
*   El cajero de la licorería asociada inicia sesión en la tablet POS mediante un PIN de seguridad rápido (hasheado y validado en base de datos).
*   Al escanear el QR del cliente, la tablet consulta el endpoint `/canje/validar-ticket`.
*   El backend NestJS valida la firma del QR, la vigencia y si no fue canjeado previamente. Devuelve un Semáforo de aprobación: **Verde** (Aprobado + Foto y Nombre del producto) o **Rojo** (Rechazado).

### 7.4. Transacción de Quema Blockchain (`Burn`)
*   Al confirmar la entrega en mano en la POS App, NestJS ejecuta un llamado seguro al smart contract `DrinksToken` para invocar la función `burn_for_claim`.
*   Se quema criptográficamente el token del cliente de forma irreversible en la blockchain, se descuenta el stock en la base de datos relacional y se cierra el ciclo físico-digital de manera segura.

---

## FASE 8: Pruebas de Calidad, Auditorías y Despliegue (Production Ready)

Garantizar la estabilidad transaccional, mitigar vulnerabilidades y desplegar el backend en entornos productivos cloud.

### 8.1. Auditoría de Seguridad Multi-tenant y Penetración Lógica
*   Escribir pruebas unitarias y de integración end-to-end con `@nestjs/testing` para simular ataques de fuga de datos.
*   Verificar mediante scripts que un tenant autenticado intente acceder a endpoints de lectura o escritura de otro tenant de forma maliciosa y que PostgreSQL RLS bloquee la consulta con éxito al 100% de las veces.

### 8.2. Pruebas de Integración con Stellar Testnet
*   Ejecutar suites de prueba simulando el ciclo de vida completo: registro de tenant -> alta de lote -> configuración de campaña (Fase 6) -> compra de tokens -> liberación de fondos por hitos -> canje por QR -> quema final en Soroban Testnet.

### 8.3. Despliegue en la Nube
*   Configurar los pipelines de Integración Continua y Despliegue Continuo (CI/CD).
*   Desplegar el backend NestJS en un entorno en la nube (ej: Render, Railway, AWS ECS, o Google Cloud Run).
*   Configurar el servidor PostgreSQL, aplicar las migraciones DDL inmutables y resguardar bajo variables de entorno cifradas las claves privadas de Stellar y JWT de producción.
