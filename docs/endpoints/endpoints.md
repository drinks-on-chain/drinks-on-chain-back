# Catálogo de Endpoints de la API — Drinks on Chain

> Guía de referencia exhaustiva y actualizada de endpoints de la API para desarrolladores Frontend y clientes de integración.
>
> 📌 **Formato Estándar de Respuesta:** Todos los endpoints responden bajo una estructura unificada:
> ```json
> {
>   "success": true,
>   "statusCode": 200,
>   "timestamp": "2026-09-24T18:00:00.000Z",
>   "path": "/v1/...",
>   "data": { ... }
> }
> ```
>
> 🔒 **Autenticación Bearer:** Para rutas protegidas, enviar el encabezado:  
> `Authorization: Bearer <accessToken>`
>
> 🏢 **Multi-Tenancy Automático:** El middleware/guardia de tenant vincula automáticamente al usuario a su bodega activa (`wineryId`). El `PLATFORM_ADMIN` tiene visibilidad global transversal y omite la restricción de tenant.

---

## 🌐 1. Sistema & Monitoreo

### `GET /v1/health`
Verifica el estado del servicio, conectividad con PostgreSQL y Redis.

- **Autenticación:** Pública
- **Rate Limit:** 100 req/min
- **Swagger Tag:** `Sistema`

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/health",
  "data": {
    "status": "ok",
    "database": "connected",
    "redis": "connected",
    "uptime": 12.34
  }
}
```

---

## 🔐 2. Autenticación (`/v1/auth`)

### `POST /v1/auth/signup`
Registra un nuevo usuario en la plataforma (por defecto con rol `CONSUMER`) y aprovisiona automáticamente su billetera custodial en Stellar.
> 💡 *Nota:* Para crear personal de bodega (enólogos, agrónomos, etc.), se utiliza el endpoint autenticado `POST /v1/wineries/my/members/create`.

- **Autenticación:** Pública
- **Rate Limit:** 5 req/min
- **Swagger Tag:** `Autenticación`

#### Body (JSON)
```json
{
  "email": "juan.perez@bodega.bo",
  "password": "Password123!",
  "fullName": "Juan Pérez",
  "phoneNumber": "+59170012345",
  "preferredLocale": "es"
}
```

#### Respuesta (201 Created)
```json
{
  "success": true,
  "statusCode": 201,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/auth/signup",
  "data": {
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "juan.perez@bodega.bo",
      "fullName": "Juan Pérez",
      "userRole": "CONSUMER",
      "phoneNumber": "+59170012345",
      "preferredLocale": "es",
      "wineryId": null,
      "memberRole": null
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer",
      "expiresIn": 604800
    }
  }
}
```

---

### `POST /v1/auth/login`
Autentica con email y contraseña, retornando el par de tokens y el perfil con la bodega vinculada.

- **Autenticación:** Pública
- **Rate Limit:** 5 req/min
- **Swagger Tag:** `Autenticación`

#### Body (JSON)
```json
{
  "email": "admin@kohlberg.bo",
  "password": "Password123!"
}
```

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/auth/login",
  "data": {
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "admin@kohlberg.bo",
      "fullName": "Julio Kohlberg",
      "userRole": "WINERY_ADMIN",
      "phoneNumber": "+59170012345",
      "preferredLocale": "es",
      "wineryId": "winery-uuid-1234",
      "memberRole": "OWNER"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer",
      "expiresIn": 604800
    }
  }
}
```

---

### `POST /v1/auth/refresh`
Renueva el `accessToken` a partir de un `refreshToken` válido.

- **Autenticación:** Pública
- **Rate Limit:** 10 req/min
- **Swagger Tag:** `Autenticación`

#### Body (JSON)
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/auth/refresh",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "tokenType": "Bearer",
    "expiresIn": 604800
  }
}
```

---

## 👤 3. Perfil de Usuario (`/v1/users`)

### `GET /v1/users/me`
Obtiene el perfil del usuario autenticado, roles, membresías de bodega y dirección de billetera pública en Stellar.

- **Autenticación:** Requerida (`Bearer`)
- **Swagger Tag:** `Usuarios`

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/users/me",
  "data": {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "email": "enologo@kohlberg.bo",
    "fullName": "Ing. Valeria Mendoza",
    "userRole": "ENOLOGIST",
    "phoneNumber": "+59171234567",
    "preferredLocale": "es",
    "stellarPublicKey": "GBXX...KOL",
    "memberships": [
      {
        "wineryId": "winery-uuid-1234",
        "wineryName": "Bodega Kohlberg",
        "memberRole": "ENOLOGIST",
        "professionalLicenseNumber": "MP-BOL-2024-9981"
      }
    ]
  }
}
```

---

### `PATCH /v1/users/me`
Actualiza datos de perfil del usuario (nombre, teléfono, idioma).

- **Autenticación:** Requerida (`Bearer`)

#### Body (JSON)
```json
{
  "fullName": "Ing. Valeria Mendoza P.",
  "phoneNumber": "+59171234567",
  "preferredLocale": "es"
}
```

---

### `GET /v1/users/me/wallet`
Obtiene la dirección pública en Stellar y estado de la billetera custodial del usuario.

- **Autenticación:** Requerida (`Bearer`)

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/users/me/wallet",
  "data": {
    "id": "wallet-uuid-1",
    "userId": "user-uuid-1",
    "stellarPublicKey": "GBXX...KOL",
    "keyManagementType": "CUSTODIAL",
    "isActive": true,
    "createdAt": "2026-09-24T18:00:00.000Z"
  }
}
```

---

## 🍷 4. Bodegas y Productores (`/v1/wineries`)

### `POST /v1/wineries`
Registra una nueva bodega en estado `PENDING`. Asocia al solicitante como `OWNER` / `WINERY_ADMIN` y aprovisiona una billetera custodial institucional.

- **Autenticación:** Requerida (`Bearer`)
- **Swagger Tag:** `Bodegas y Productores`

#### Body (JSON)
```json
{
  "commercialName": "Bodega Kohlberg",
  "legalBusinessName": "Julio Kohlberg Chavarría e Hijos S.A.",
  "taxIdNit": "1028374029",
  "wineryCategory": "INDUSTRIAL",
  "sanitaryRegistrationSenasag": "SENASAG-TR-01-0023-2024",
  "department": "Tarija",
  "province": "Cercado",
  "municipality": "Santa Ana la Nueva",
  "altitudeMasl": 1950.0,
  "latitude": -21.5833,
  "longitude": -64.6500,
  "contactEmail": "contacto@kohlberg.bo",
  "contactPhone": "+59146642345",
  "websiteUrl": "https://kohlberg.bo",
  "logoUrl": "http://localhost:3000/uploads/logos/kohlberg.png"
}
```

---

### `GET /v1/wineries`
Lista todas las bodegas con soporte de filtros por estado, categoría y paginación.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** Exclusivo `PLATFORM_ADMIN`
- **Query Params:** `page`, `limit`, `status` (`PENDING`, `ACTIVE`, `REJECTED`, `SUSPENDED`), `category`, `search`

---

### `GET /v1/wineries/my`
Retorna los datos institucionales de la bodega asociada al usuario autenticado.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** Miembros de la bodega (`WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, etc.)

---

### `PATCH /v1/wineries/my`
Actualiza datos de la bodega (dirección, teléfono, logo, correo institucional).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `PLATFORM_ADMIN`

---

### `POST /v1/wineries/my/members`
Asocia un usuario existente a la bodega con un rol operativo específico.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `PLATFORM_ADMIN`

#### Body (JSON)
```json
{
  "userId": "user-uuid-enologo",
  "memberRole": "ENOLOGIST",
  "professionalLicenseNumber": "MP-BOL-2024-9981",
  "professionalLicensePdfUrl": "http://localhost:3000/uploads/licenses/valeria.pdf"
}
```

---

### `POST /v1/wineries/my/members/create`
Crea la cuenta de usuario, aprovisiona su billetera custodial y lo incorpora a la bodega en una sola operación atómica.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `PLATFORM_ADMIN`

#### Body (JSON)
```json
{
  "email": "enologo@bodega.bo",
  "password": "Password123!",
  "fullName": "Ing. Carlos Mendoza",
  "phoneNumber": "+59172099881",
  "memberRole": "ENOLOGIST",
  "professionalLicenseNumber": "MP-BOL-ENOL-8891",
  "professionalLicensePdfUrl": "http://localhost:3000/uploads/licenses/carlos.pdf"
}
```

---

### `GET /v1/wineries/my/members`
Lista todos los miembros operativos activos en la bodega del usuario.

- **Autenticación:** Requerida (`Bearer`)

---

### `GET /v1/wineries/pending`
Lista todas las solicitudes de bodegas pendientes de aprobación.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** Exclusivo `PLATFORM_ADMIN`

---

### `POST /v1/wineries/:id/approve`
Aprueba y certifica la bodega, cambiando su estado a `ACTIVE` y ejecutando el hook on-chain para el contrato **C-01 ProducerRegistry**.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** Exclusivo `PLATFORM_ADMIN`

#### Body (Opcional)
```json
{
  "approvalNotes": "Inspección técnica SENASAG y legal aprobada con dictamen favorable."
}
```

---

### `POST /v1/wineries/:id/reject`
Rechaza una solicitud de registro de bodega consignando formalmente el motivo legal o técnico.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** Exclusivo `PLATFORM_ADMIN`

#### Body (JSON)
```json
{
  "rejectionReason": "Registro sanitario SENASAG vencido o no acreditable."
}
```

---

## 📁 5. Almacenamiento de Archivos e Imágenes (`/v1/uploads`)

Drinks on Chain implementa una arquitectura de almacenamiento desacoplada (`IStorageService`) que permite almacenar archivos localmente (`LocalStorageService`) o en la nube (S3/Cloudflare R2/GCS) de manera transparente.

### `POST /v1/uploads`
Sube un archivo o imagen binaria. Valida el tipo MIME (imágenes JPEG, PNG, WEBP, SVG, GIF y documentos PDF) y el tamaño máximo (15 MB). Retorna la URL pública y la clave canónica del archivo.

- **Autenticación:** Requerida (`Bearer`)
- **Content-Type:** `multipart/form-data`
- **Query Params:**
  - `folder` *(opcional)*: Categoría o subcarpeta organizativa (`inspections`, `labels`, `lab-reports`, `certificates`, `logos`).
- **Body:** Campo multipart llamado `file`.

#### Ejemplo cURL
```bash
curl -X POST "http://localhost:3000/v1/uploads?folder=inspections" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./acta_fitosanitaria.pdf"
```

#### Respuesta (201 Created)
```json
{
  "success": true,
  "statusCode": 201,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/uploads",
  "data": {
    "url": "http://localhost:3000/uploads/inspections/1742880000000-acta_fitosanitaria.pdf",
    "key": "inspections/1742880000000-acta_fitosanitaria.pdf",
    "originalName": "acta_fitosanitaria.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 204800
  }
}
```

### `GET /uploads/:folder/:filename`
Acceso público directo a los archivos estáticos servidos por el servidor local de desarrollo.

---

## 🍇 6. Parcelas y Terroirs (`/v1/terroirs`)

### `POST /v1/terroirs`
Crea una nueva parcela agrícola con altitud msnm, georreferenciación (polígono GeoJSON opcional) y elegibilidad D.O.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `AGRONOMIST`
- **Swagger Tag:** `Terroirs y Parcelas`

#### Body (JSON)
```json
{
  "parcelName": "Parcela Los Crespones - Cañón de Cinti",
  "cadastreCode": "CAT-CINTI-102",
  "surfaceHectares": 3.2,
  "altitudeMasl": 2000.0,
  "latitude": -20.65412,
  "longitude": -65.23189,
  "soilType": "Franco-arenoso con grava fluvial y lecho de río calcáreo",
  "rawMaterialType": "uva",
  "varietyName": "Cabernet Sauvignon",
  "isDoEligible": true,
  "doType": "Valles Altos de Bolivia",
  "doCertificateUrl": "http://localhost:3000/uploads/certificates/do-cinti.pdf"
}
```

---

### `GET /v1/terroirs`
Lista todas las parcelas activas de la bodega con filtros por varietal y elegibilidad D.O.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `AGRONOMIST`, `ENOLOGIST`

---

### `GET /v1/terroirs/:id`
Obtiene el detalle agronómico de una parcela y sus lotes de vendimia históricos.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `AGRONOMIST`, `ENOLOGIST`

---

### `PATCH /v1/terroirs/:id`
Actualiza datos de la parcela (superficie, sistema de riego, suelo, polígono GeoJSON).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `AGRONOMIST`

---

## 🚛 7. Vendimia y Pesaje en Báscula (`/v1/harvest-batches`)

### `POST /v1/harvest-batches`
Registra el ingreso de uva con pesaje en báscula (peso bruto y tara con cálculo automático del peso neto) y parámetros de madurez (°Bx, pH, acidez).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `AGRONOMIST`, `ENOLOGIST`
- **Swagger Tag:** `Vendimia y Pesaje`

#### Body (JSON)
```json
{
  "terroirId": "terroir-uuid",
  "intakeDate": "2025-01-10",
  "harvestYear": 2025,
  "grossWeightKg": 8500.0,
  "tareWeightKg": 100.0,
  "brixDegrees": 24.5,
  "phValue": 3.60,
  "titratableAcidityGl": 5.8,
  "notes": "Cosecha manual matutina en cajas de 15 kg para preservar frescura aromática."
}
```

---

### `GET /v1/harvest-batches`
Lista los lotes de vendimia de la bodega con filtros por año de cosecha y estado fitosanitario.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`

---

### `GET /v1/harvest-batches/:id`
Obtiene el detalle de un lote de vendimia, pesaje, análisis enológico y tanques de fermentación vinculados.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`

---

### `PATCH /v1/harvest-batches/:id/phyto-status`
Dictamina el estado fitosanitario del lote (`APPROVED`, `REJECTED`, `QUARANTINE`) con respaldo de acta o informe PDF.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `AGRONOMIST`, `ENOLOGIST`

#### Body (JSON)
```json
{
  "phytosanitaryStatus": "APPROVED",
  "phytoInspectionPdfUrl": "http://localhost:3000/uploads/inspections/1742880000000-phyto-crespones.pdf",
  "notes": "Excelente madurez fenólica, hollejo íntegro y libre de botritis."
}
```

---

## 🍷 8. Vinificación & Fermentación (`/v1/fermentation-tanks`)

### `POST /v1/fermentation-tanks`
Registra una cuba o tanque de fermentación de acero inoxidable asociándolo al lote de vendimia. Define el destino del proceso (`SINGANI_BASE_WINE`, `WINE_AGING`, `DIRECT_BOTTLING`).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`
- **Swagger Tag:** `Vinificación y Fermentación`

#### Body (JSON)
```json
{
  "harvestBatchId": "harvest-uuid",
  "tankIdentifier": "TK-RED-01",
  "tankCapacityLiters": 10000.0,
  "initialVolumeLiters": 6800.0,
  "processTarget": "WINE_AGING",
  "yeastStrain": "Saccharomyces cerevisiae (cepa seleccionada)",
  "macerationDays": 14,
  "startDate": "2025-01-11"
}
```

---

### `GET /v1/fermentation-tanks`
Lista las cubas de fermentación de la bodega con filtros por estado (`FERMENTING`, `COMPLETED`, `RESTING`) y lote de vendimia.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`

---

### `GET /v1/fermentation-tanks/:id`
Retorna el detalle completo de la cuba junto con su historial de lecturas térmicas y tratamientos enológicos.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`

---

### `POST /v1/fermentation-tanks/:id/logs`
Registra una lectura append-only de control térmico, densidad Baumé y observaciones.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `POS_OPERATOR`

#### Body (JSON)
```json
{
  "recordedAt": "2025-01-15T08:00:00Z",
  "temperatureCelsius": 26.5,
  "densitySg": 1.025,
  "brixValue": 6.5,
  "visualObservations": "Fermentación tumultuosa regular, sombrero bien hidratado",
  "notes": "Remontado matutino de 30 minutos completado con aireación controlada"
}
```

---

### `POST /v1/fermentation-tanks/:id/treatments`
Registra un tratamiento enológico autorizado por normativa SENASAG (adición de SO2, corrección de acidez, nutrientes de levadura, etc.).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `ENOLOGIST`, `WINERY_ADMIN`

#### Body (JSON)
```json
{
  "treatmentType": "NUTRIENT_ADDITION",
  "productName": "Nutrientes complejos de fermentación fosfato diamónico",
  "dosageGhl": 20.0,
  "commercialBrand": "Enartis Nutriferm",
  "appliedAt": "2025-01-12T10:00:00Z",
  "notes": "Adición al primer tercio de fermentación para asegurar cinética celular"
}
```

---

## 🪵 9. Crianza en Barricas (`/v1/wine-aging`)

### `POST /v1/wine-aging`
Inicia un lote de crianza en barricas de roble a partir de una cuba de fermentación completada. Calcula automáticamente la fecha de bloqueo (`lockUntilDate`) impidiendo el embotellado prematuro antes de completar el tiempo reglamentario de guarda.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`
- **Swagger Tag:** `Crianza en Madera y Guarda (Vino)`

#### Body (JSON)
```json
{
  "fermentationTankId": "tank-uuid",
  "barrelRoomIdentifier": "Cava Subterránea Bóveda 1 - Cañón de Cinti",
  "woodType": "FRENCH_OAK",
  "toastLevel": "MEDIUM_PLUS",
  "barrelCount": 15,
  "volumeLiters": 3375.0,
  "agingStartDate": "2025-02-01",
  "plannedMonths": 12,
  "notes": "Crianza en barricas de primer y segundo uso a 14°C y 75% HR"
}
```

---

### `GET /v1/wine-aging`
Lista todos los lotes de crianza en guarda de la bodega.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`

---

### `GET /v1/wine-aging/:id`
Obtiene el detalle de un lote de crianza, historial de barricas, meses planificados y fecha límite de bloqueo para fraccionamiento.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`

---

## ⚗️ 10. Destilación & Producción (`/v1/production-batches`)

### `POST /v1/production-batches/distillation`
Registra la destilación de Singani en alambique tradicional con balance de masa (fraccionamiento de cabezas, corazón, colas), validación de altitud D.O. ($\ge 1,600$ msnm) y fijación de los 180 días obligatorios de reposo inerte.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`
- **Swagger Tag:** `Destilación y Procesos Especiales (Singani)`

#### Body (JSON)
```json
{
  "fermentationTankId": "tank-uuid",
  "equipmentIdentifier": "Alambique de Cobre Charentais AL-01",
  "processStartDate": "2026-04-01",
  "processEndDate": "2026-04-03",
  "inputVolumeLiters": 10000.0,
  "outputVolumeLiters": 1750.0,
  "wasteVolumeLiters": 570.0,
  "initialAlcoholPercentage": 70.2,
  "isDoEligible": true,
  "additionalParams": {
    "headDiscardLiters": 120,
    "heartYieldLiters": 1750,
    "tailDiscardLiters": 450
  }
}
```

---

### `GET /v1/production-batches/:id/rest-status`
Consulta el avance del reposo inerte obligatorio de 180 días para D.O. Singani (días transcurridos, días restantes y dictamen `RESTING` / `READY`).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `PLATFORM_ADMIN`

---

### `GET /v1/production-batches`
Lista los lotes de destilación y producción con filtros por tipo de proceso y estado.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`

---

### `GET /v1/production-batches/:id`
Retorna los datos completos de destilación, cortes de alambique y cuba de vino base de origen.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`

---

## 🍾 11. Embotellado (`/v1/bottling`)

### `POST /v1/bottling`
Fracciona y envasa el producto tras validar el cumplimiento de los días reglamentarios de reposo inerte o guarda en barrica. Genera el código internacional de lote, URL QR y hash SHA-256 canónico para registro on-chain.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`
- **Swagger Tag:** `Fraccionamiento y Embotellado`

#### Body (JSON)
```json
{
  "wineAgingBatchId": "wine-aging-uuid",
  "productType": "VINO",
  "finalAlcoholAbv": 14.2,
  "totalBottlesPackaged": 4200,
  "packagingFormatCl": 75,
  "bottleType": "Bordelesa Canónica 750ml Vidrio Verde Oliva",
  "labelDesignUrl": "http://localhost:3000/uploads/labels/etiqueta-crespones-2025.png",
  "bottlingDate": "2026-03-01"
}
```

---

### `GET /v1/bottling`
Lista los lotes embotellados de la bodega con filtros por tipo de bebida (`SINGANI`, `VINO`).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `PLATFORM_ADMIN`

---

### `GET /v1/bottling/:id`
Obtiene el detalle de un lote embotellado, código público internacional y certificado de laboratorio asociado.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `PLATFORM_ADMIN`

---

## 🔬 12. Certificación de Laboratorio (`/v1/lab-analyses`)

### `POST /v1/lab-analyses`
Registra el certificado físico-químico oficial emitido por laboratorio ISO 17025 / SENASAG con validación toxicológica (metanol $< 200$ mg/100ml, cobre $< 0.05$ mg/L) y dictamen de conformidad normativa (NB 324001).

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `PLATFORM_ADMIN`
- **Swagger Tag:** `Laboratorio Físico-Químico`

#### Body (JSON)
```json
{
  "bottlingBatchId": "bottling-uuid",
  "certifiedLaboratoryName": "Laboratorio de Servicios Analíticos ISO 17025",
  "accreditedLabCertificationCode": "LAB-SENASAG-2026-880",
  "analysisRequestDate": "2026-03-02",
  "testPerformedAt": "2026-03-04",
  "actualAlcoholAbv": 14.22,
  "totalAcidityTartaricGl": 5.60,
  "volatileAcidityAceticGl": 0.45,
  "freeSulfurDioxideMgL": 32.0,
  "totalSulfurDioxideMgL": 85.0,
  "reducingSugarsGl": 1.80,
  "laboratoryReportPdfUrl": "http://localhost:3000/uploads/lab-reports/1742880000000-lab-report-cinti-880.pdf",
  "conformsToSenasagStandards": true
}
```

---

### `GET /v1/lab-analyses/batch/:bottlingBatchId`
Obtiene el informe físico-químico oficial emitido para un lote de embotellado específico.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, `PLATFORM_ADMIN`, `CONSUMER`

---

## 🕸️ 13. Trazabilidad & Linaje Agroalimentario (`/v1/traceability`)

### `GET /v1/traceability/dag/:bottlingBatchId`
Reconstruye el grafo acíclico dirigido (DAG) completo de linaje agroalimentario (Parcela $\rightarrow$ Vendimia $\rightarrow$ Vinificación $\rightarrow$ Destilación/Guarda $\rightarrow$ Embotellado) con hashes y métricas tipadas para el contrato Soroban `trazabilidad.rs`.

- **Autenticación:** Requerida (`Bearer`)
- **Roles:** `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, `PLATFORM_ADMIN`
- **Swagger Tag:** `Grafo DAG de Trazabilidad`

---

### `GET /v1/traceability/public/:lotCode`
**Pasaporte Digital Público de Trazabilidad (Acceso QR Consumidor).**
Endpoint público sin necesidad de credenciales de autenticación. Diseñado específicamente para ser consultado cuando un consumidor escanea el código QR impreso en la botella física. Retorna el linaje completo, georreferenciación, altitud, análisis enológico y enlaces a los certificados oficiales.

- **Autenticación:** **Pública** (sin encabezado `Authorization`)
- **Swagger Tag:** `Grafo DAG de Trazabilidad`
- **Parámetro:** `:lotCode` (Código público de lote, ej: `CIN-2026-WINE-001` o UUID de embotellado)

#### Respuesta (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-09-24T18:00:00.000Z",
  "path": "/v1/traceability/public/CIN-2026-WINE-001",
  "data": {
    "lotCode": "CIN-2026-WINE-001",
    "winery": {
      "commercialName": "Bodega y Viñedos Cañón de Cinti",
      "department": "Chuquisaca",
      "altitudeMasl": 2000.0
    },
    "product": {
      "productType": "VINO",
      "alcoholAbv": 14.2,
      "bottlesPackaged": 4200,
      "packagingFormatCl": 75,
      "bottlingDate": "2026-03-01T00:00:00.000Z"
    },
    "terroir": {
      "parcelName": "Parcela Los Crespones - Cañón de Cinti",
      "altitudeMasl": 2000.0,
      "varietyName": "Cabernet Sauvignon",
      "doEligible": true,
      "doType": "Valles Altos de Bolivia"
    },
    "laboratoryCertification": {
      "certifiedLaboratoryName": "Laboratorio de Servicios Analíticos ISO 17025",
      "accreditedLabCertificationCode": "LAB-SENASAG-2026-880",
      "actualAlcoholAbv": 14.22,
      "totalAcidityTartaricGl": 5.6,
      "volatileAcidityAceticGl": 0.45,
      "conformsToSenasagStandards": true,
      "reportPdfUrl": "http://localhost:3000/uploads/lab-reports/1742880000000-lab-report-cinti-880.pdf"
    },
    "blockchainIntegrity": {
      "sha256Hash": "a9f8b4c7...",
      "network": "Stellar Testnet",
      "status": "VERIFIED_ON_CHAIN"
    }
  }
}
```

---

## 📚 14. Documentación Interactiva (Swagger OpenAPI)

- **URL Local:** `http://localhost:3000/docs`
- **Especificación JSON:** `http://localhost:3000/docs-json`
