# Guía de Pruebas Manuales — Flujo Singani Boliviano D.O. (Destilación y Reposo Inerte)

> **Drinks on Chain — Trazabilidad B2B & Pasaporte Digital Web3**  
> Este documento contiene el flujo manual paso a paso con **datos ficticios realistas** para **Singani Boliviano D.O. de Altura** (San Lorenzo, Tarija — 1,850 msnm) para probar y verificar los endpoints del backend usando Postman, Insomnia o `curl`.
>
> ⏱️ **Nota sobre Fechas y Regla de 180 Días:** Para que el endpoint de embotellado (`POST /v1/bottling`) no sea bloqueado por la regla de los 180 días de reposo inerte (`now - processEndDate >= 180`), las fechas de vendimia y destilación en esta guía están situadas con **~220+ días de antigüedad** (fecha fin de destilación en mayo/junio 2025) para que el reposo calculado supere ampliamente los 190 días.

---

## 📱 1. ¿Cómo funciona el QR y qué datos devuelve al Frontend?

### 🔗 Arquitectura del Código QR

1. **Generación al Embotellar (`POST /v1/bottling`):**
   Al registrar el lote de embotellado, el sistema genera automáticamente:
   - **`internationalLotCode`:** Código estándar internacional: `{CÓDIGO_BODEGA}-{AÑO}-{TIPO_BEBIDA}-{SECUENCIA}` (ejemplo: `CAS-2026-SINGANI-001`).
   - **`qrBatchUrl`:** URL pública apuntando al visor o pasaporte digital: `https://drinksonchain.com/trace/batch/CAS-2026-SINGANI-001`.
   - **`blockchainDataHash`:** Hash criptográfico canónico SHA-256 (`0x...` de 64 caracteres) listo para ser certificado y anclado en Stellar Soroban.

2. **Acceso del Consumidor / Escaneo QR:**
   Cualquier consumidor o inspector que escanee el código QR físico en la botella accede a la URL pública. El frontend consulta el endpoint público:
   - **`GET /v1/traceability/public/:lotCode`** (sin autenticación).

---

---

## 📁 2. Gestión Desacoplada de Archivos e Imágenes (Almacenamiento Local / Cloud)

El backend incorpora un subsistema de almacenamiento desacoplado mediante la interfaz `IStorageService`. Actualmente opera con **almacenamiento local** (servido estáticamente en `http://localhost:3000/uploads/...`) y está preparado arquitectónicamente para alternar a proveedores externos (AWS S3, Cloudflare R2 o Supabase) simplemente cambiando la variable de entorno `STORAGE_DRIVER` sin alterar ningún endpoint del negocio.

### 📤 ¿Cómo subir un archivo o imagen?
Cualquier usuario autenticado puede subir un documento (PDF) o imagen (PNG, JPG, WEBP, SVG) al endpoint multiparte:
```bash
curl -X POST http://localhost:3000/v1/uploads?folder=inspections \
  -H "Authorization: Bearer {{TOKEN}}" \
  -F "file=@/ruta/a/tu/archivo.pdf"
```
**Respuesta:**
```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "url": "http://localhost:3000/uploads/inspections/1742880000000-a1b2c3d4.pdf",
    "key": "inspections/1742880000000-a1b2c3d4.pdf",
    "originalName": "archivo.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 204800
  }
}
```
> 📌 La `url` retornada por este endpoint es la que se envía en los payloads de los flujos de negocio (`phytoInspectionPdfUrl`, `labelDesignUrl`, `laboratoryReportPdfUrl`, `logoUrl`, etc.).

---

## 🚀 3. Flujo Manual de Pruebas Paso a Paso

> 💡 **Nota:** La URL base para las peticiones locales es `http://localhost:3000`. Reemplaza las variables `{{TOKEN}}`, `{{WINERY_ID}}`, `{{TERROIR_ID}}`, etc., con los IDs devueltos en cada paso.

---

### Paso 1: Inicialización y Login de Platform Admin
Por motivos de seguridad, el rol `PLATFORM_ADMIN` no puede registrarse públicamente. Se inicializa mediante el seeder idempotente y se realiza login con las credenciales de `.env`:

```bash
# 1.1 Ejecutar Seeder (solo la primera vez o tras reiniciar la BD)
# pnpm prisma:seed

# 1.2 Login del Superadmin
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin.master@drinksonchain.bo",
    "password": "Password123!"
  }'
```
*Guarda el `accessToken` como `{{ADMIN_TOKEN}}`.*

---

### Paso 2: Registro de Bodega y Propietario (Winery Admin)
El representante legal crea su cuenta pública como `WINERY_ADMIN` y solicita el alta de la bodega.

```bash
# 2.1 Registro de Usuario Winery Admin
curl -X POST http://localhost:3000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gerencia@casareal.bo",
    "password": "Password123!",
    "fullName": "Gerente General San Lorenzo",
    "userRole": "WINERY_ADMIN"
  }'
```
*Guarda el `accessToken` temporal devuelto como `{{TEMP_WINERY_TOKEN}}`.*

```bash
# 2.2 (Opcional) Subir Logo Institucional de la Bodega
curl -X POST "http://localhost:3000/v1/uploads?folder=logos" \
  -H "Authorization: Bearer {{TEMP_WINERY_TOKEN}}" \
  -F "file=@./logo-casareal.png"
# Guarda la URL devuelta en data.url como {{LOGO_URL}}
```

```bash
# 2.3 Solicitud de Onboarding de Bodega
curl -X POST http://localhost:3000/v1/wineries \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{TEMP_WINERY_TOKEN}}" \
  -d '{
    "legalName": "Destilería San Lorenzo S.A.",
    "commercialName": "Casa Real Singani",
    "beverageCategory": "DISTILLERY",
    "taxIdNit": "1028374029",
    "senasagSanitaryReg": "SENASAG-TAR-00491",
    "geographicRegion": "Valle de San Lorenzo, Tarija",
    "contactEmail": "contacto@casareal.bo",
    "contactPhone": "+59146641234",
    "logoUrl": "http://localhost:3000/uploads/logos/logo-casareal.png"
  }'
```
*Guarda el ID de la bodega devuelto en la respuesta como `{{WINERY_ID}}`.*

---

### Paso 3: Aprobación Institucional de Bodega (Platform Admin)
El Platform Admin aprueba la bodega y emite su Onchain Producer ID.

```bash
curl -X POST http://localhost:3000/v1/wineries/{{WINERY_ID}}/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ADMIN_TOKEN}}" \
  -d '{
    "approvalNotes": "Certificación SENASAG e inspección técnica verificada favorablemente."
  }'
```

```bash
# Re-login de Winery Admin para obtener token con wineryId activo
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gerencia@casareal.bo",
    "password": "Password123!"
  }'
```
*Actualiza `{{WINERY_ADMIN_TOKEN}}` con el nuevo `accessToken`.*

---

### Paso 4: Creación de Personal Operativo por la Bodega (Agrónomo y Enólogo)
El `WINERY_ADMIN` da de alta a su personal operativo de forma atómica (creando credenciales de acceso, billetera custodial en Stellar y membresía activa):

```bash
# 4.1 Alta directa del Agrónomo
curl -X POST http://localhost:3000/v1/wineries/my/members/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{WINERY_ADMIN_TOKEN}}" \
  -d '{
    "email": "agronomo@casareal.bo",
    "password": "Password123!",
    "fullName": "Ing. Mateo Gutiérrez",
    "memberRole": "AGRONOMIST",
    "professionalLicenseNumber": "CIA-TAR-892"
  }'

# 4.2 Alta directa de la Enóloga
curl -X POST http://localhost:3000/v1/wineries/my/members/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{WINERY_ADMIN_TOKEN}}" \
  -d '{
    "email": "enologa@casareal.bo",
    "password": "Password123!",
    "fullName": "Lic. Valeria Soliz",
    "memberRole": "ENOLOGIST",
    "professionalLicenseNumber": "COL-ENOL-TAR-402"
  }'
```

```bash
# 4.3 Login del Agrónomo para obtener {{AGRO_TOKEN}}
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "agronomo@casareal.bo",
    "password": "Password123!"
  }'

# 4.4 Login de la Enóloga para obtener {{ENOL_TOKEN}}
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "enologa@casareal.bo",
    "password": "Password123!"
  }'
```

---

### Paso 5: Registro de Parcela / Terroir
El agrónomo registra la parcela a **1,850 m.s.n.m.** con uva **Moscatel de Alejandría**.

```bash
curl -X POST http://localhost:3000/v1/terroirs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{AGRO_TOKEN}}" \
  -d '{
    "parcelName": "Cuartel 4 - La Finca El Potrero",
    "cadastreCode": "CAT-TL-4022",
    "surfaceHectares": 4.5,
    "altitudeMasl": 1850.0,
    "latitude": -21.48512,
    "longitude": -64.78921,
    "rawMaterialType": "uva",
    "varietyName": "100% Moscatel de Alejandría",
    "isDoEligible": true,
    "doType": "D.O. Singani"
  }'
```
*Guarda el ID devuelto como `{{TERROIR_ID}}`.*

---

### Paso 6: Recepción y Pesaje en Báscula (Vendimia)
Se registra la llegada de 15,000 kg brutos con tara de 150 kg (**14,850 kg netos**).

```bash
curl -X POST http://localhost:3000/v1/harvest-batches \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{AGRO_TOKEN}}" \
  -d '{
    "terroirId": "{{TERROIR_ID}}",
    "intakeDate": "2025-05-10",
    "harvestYear": 2025,
    "grossWeightKg": 15000.0,
    "tareWeightKg": 150.0,
    "brixDegrees": 22.4,
    "initialPh": 3.45,
    "initialAcidityGl": 6.8,
    "temperatureAtIntakeC": 16.5,
    "notes": "Uva madura de cosecha manual matutina en cajas de 18 kg."
  }'
```
*Guarda el ID devuelto como `{{HARVEST_BATCH_ID}}`.*

---

### Paso 7: Aprobación Fitosanitaria y Subida de Informe Técnico
La enóloga inspecciona el lote, sube el informe técnico en PDF al almacenamiento del backend y dictamina `APPROVED`.

```bash
# 7.1 Subir Informe Técnico Fitosanitario (PDF)
curl -X POST "http://localhost:3000/v1/uploads?folder=inspections" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./inspeccion-potrero.pdf"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/inspections/1742880000000-phyto.pdf",
    "key": "inspections/1742880000000-phyto.pdf"
  }
}
```

```bash
# 7.2 Dictaminar Aprobación Fitosanitaria asociando la URL
curl -X PATCH http://localhost:3000/v1/harvest-batches/{{HARVEST_BATCH_ID}}/phyto-status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "phytosanitaryStatus": "APPROVED",
    "phytoInspectionPdfUrl": "http://localhost:3000/uploads/inspections/1742880000000-phyto.pdf",
    "notes": "Uva sana sin presencia de botritis ni plagas cuarentenarias."
  }'
```

---

### Paso 8: Vinificación en Cuba de Inox y Control Térmico
Se descarga el mosto en la cuba `TK-03` para fermentar el vino base.

```bash
# 8.1 Registro de cuba de fermentación
curl -X POST http://localhost:3000/v1/fermentation-tanks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "harvestBatchId": "{{HARVEST_BATCH_ID}}",
    "tankCode": "TK-03",
    "capacityLiters": 15000.0,
    "material": "Acero Inoxidable AISI 316",
    "volumeFilledLiters": 10100.0,
    "destinationType": "SINGANI_DIST",
    "startDate": "2025-05-10T14:30:00Z"
  }'
```
*Guarda el ID de la cuba como `{{TANK_ID}}`.*

```bash
# 8.2 Agregar lectura térmica (append-only)
curl -X POST http://localhost:3000/v1/fermentation-tanks/{{TANK_ID}}/logs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "temperatureCelsius": 15.2,
    "specificGravity": 1.045,
    "phValue": 3.42,
    "co2Observations": "Fermentación activa controlada a 15°C",
    "recordedAt": "2025-05-11T08:00:00Z"
  }'

# 8.3 Registrar adición enológica autorizada SENASAG
curl -X POST http://localhost:3000/v1/fermentation-tanks/{{TANK_ID}}/treatments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "treatmentType": "SO2_ADDITION",
    "additiveName": "Metabisulfito de potasio",
    "dosageAppliedGPerHl": 30.0,
    "regulatoryAuthCode": "SENASAG-REG-2024-88",
    "appliedAt": "2025-05-10T15:00:00Z"
  }'
```

---

### Paso 9: Destilación en Alambique Charentais (Singani)
Se destilan 10,000 L de vino base obteniendo **1,750 L de corazón al 70.2% ABV**.  
*(Con `processEndDate: "2025-05-25"`, habrán transcurrido más de 220 días respecto a hoy, superando ampliamente los 180 días obligatorios y permitiendo el embotellado).*

```bash
curl -X POST http://localhost:3000/v1/production-batches/distillation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "fermentationTankId": "{{TANK_ID}}",
    "equipmentIdentifier": "Alambique de Cobre Charentais AL-01",
    "processStartDate": "2025-05-20",
    "processEndDate": "2025-05-25",
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
  }'
```
*Guarda el ID del lote de producción como `{{PRODUCTION_BATCH_ID}}`.*

---

### Paso 10: Consulta de Reposo Inerte (Verificación de Días Transcurridos)

```bash
curl -X GET http://localhost:3000/v1/production-batches/{{PRODUCTION_BATCH_ID}}/rest-status \
  -H "Authorization: Bearer {{ENOL_TOKEN}}"
```
*Respuesta esperada:*
```json
{
  "success": true,
  "data": {
    "id": "{{PRODUCTION_BATCH_ID}}",
    "restStatus": "READY",
    "daysElapsed": 210,
    "daysRemaining": 0,
    "isRestCompleted": true
  }
}
```

---

### Paso 11: Dilución Hidroalcohólica, Subida de Etiqueta y Embotellado
Se diluyen 1,750 L a 70.2% con 1,321 L de agua osmotizada $\rightarrow$ **4,080 botellas de 750 ml a 40.0% ABV**.

```bash
# 11.1 Subir Imagen del Diseño de Etiqueta Frontal
curl -X POST "http://localhost:3000/v1/uploads?folder=labels" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./etiqueta-singani-aniversario.png"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/labels/1742880000000-singani-aniversario.png",
    "key": "labels/1742880000000-singani-aniversario.png"
  }
}
```

```bash
# 11.2 Registrar el Embotellado asociando la URL de la etiqueta
curl -X POST http://localhost:3000/v1/bottling \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "productionBatchId": "{{PRODUCTION_BATCH_ID}}",
    "productType": "SINGANI",
    "finalAlcoholAbv": 40.0,
    "waterDilutionLiters": 1321.0,
    "totalBottlesPackaged": 4080,
    "packagingFormatCl": 75,
    "bottleType": "Vidrio Extra-Flint 750ml",
    "labelDesignUrl": "http://localhost:3000/uploads/labels/1742880000000-singani-aniversario.png",
    "bottlingDate": "2026-03-01"
  }'
```
*Guarda el ID del embotellado como `{{BOTTLING_BATCH_ID}}` y el código de lote `internationalLotCode` (ej. `CAS-2026-SINGANI-001`).*

---

### Paso 12: Certificación Oficial de Laboratorio (ISO 17025 / SENASAG)
Se sube el certificado del laboratorio acreditado en PDF y se registra el dictamen analítico oficial.

```bash
# 12.1 Subir Certificado Oficial de Laboratorio (PDF)
curl -X POST "http://localhost:3000/v1/uploads?folder=lab-reports" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./informe-laboratorio-iso17025.pdf"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/lab-reports/1742880000000-lab-iso-0492.pdf",
    "key": "lab-reports/1742880000000-lab-iso-0492.pdf"
  }
}
```

```bash
# 12.2 Registro de Parámetros Bromatológicos y Toxicológicos
curl -X POST http://localhost:3000/v1/lab-analyses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "bottlingBatchId": "{{BOTTLING_BATCH_ID}}",
    "certifiedLaboratoryName": "Laboratorio de Servicios Analíticos ISO 17025",
    "accreditedLabCertificationCode": "LAB-SENASAG-2026-991",
    "analysisRequestDate": "2026-03-02",
    "testPerformedAt": "2026-03-04",
    "actualAlcoholAbv": 40.05,
    "totalAcidityTartaricGl": 4.8,
    "volatileAcidityAceticGl": 0.22,
    "methanolContentMgL": 48.0,
    "copperContentMgL": 0.02,
    "laboratoryReportPdfUrl": "http://localhost:3000/uploads/lab-reports/1742880000000-lab-iso-0492.pdf",
    "conformsToSenasagStandards": true
  }'
```

---

### Paso 13: Consulta Pública del Pasaporte Digital (Escaneo QR)
Cualquier consumidor o aplicación web puede consultar la trazabilidad pública completa **sin necesidad de token de autenticación**:

```bash
# Consulta pública por Código de Lote (proveniente del QR)
curl -X GET http://localhost:3000/v1/traceability/public/CAS-2026-SINGANI-001
```

```bash
# O consulta interna autorizada por UUID de lote
curl -X GET http://localhost:3000/v1/traceability/dag/{{BOTTLING_BATCH_ID}} \
  -H "Authorization: Bearer {{ENOL_TOKEN}}"
```

---

### Paso 14 (Opcional): Certificación y Trámites de Exportación

> ℹ️ **Paso Opcional:** En Drinks on Chain, el 100% de las botellas producidas mantienen su trazabilidad completa sin importar si se venden en Bolivia o se exportan. Si se desea marcar la bodega como exportadora certificada:

```bash
curl -X PATCH http://localhost:3000/v1/wineries/my \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{WINERY_ADMIN_TOKEN}}" \
  -d '{
    "address": "Camino a San Lorenzo Km 12, Tarija, Bolivia"
  }'
```

