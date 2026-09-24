# Guía de Pruebas Manuales — Flujo Vino de Altura & Crianza en Barrica

> **Drinks on Chain — Trazabilidad B2B & Pasaporte Digital Web3**  
> Este documento contiene el flujo manual paso a paso con **datos ficticios realistas** para **Vino Tinto Gran Reserva** (Valle de Cinti, Chuquisaca / Tarija — 2,000 m.s.n.m.) con crianza en barricas de roble francés para probar y verificar los endpoints del backend usando Postman, Insomnia o `curl`.
>
> 🪵 **Nota sobre la Crianza y la Regla de Bloqueo (`lockUntilDate`):** El motor de trazabilidad enológica valida que un vino en crianza no pueda embotellarse antes de que se cumpla el período de guarda planificado (`plannedMonths`). En esta guía se usa una fecha de inicio de guarda de **hace más de 12 meses** (`startDate: "2025-02-01"` con `plannedMonths: 12`), lo que sitúa la fecha de desbloqueo en el pasado y permite el embotellado inmediato y exitoso.

---

## 📱 1. ¿Cómo funciona el Pasaporte Digital del Vino?

1. **Al Embotellar (`POST /v1/bottling`):**
   El sistema genera:
   - **`internationalLotCode`:** `{CÓDIGO_BODEGA}-{AÑO}-{TIPO_BEBIDA}-{SECUENCIA}` (ejemplo: `CIN-2026-WINE-001`).
   - **`qrBatchUrl`:** `https://drinksonchain.com/trace/batch/CIN-2026-WINE-001`.
   - **`blockchainDataHash`:** Hash canónico SHA-256 (`0x...` de 64 caracteres) listo para ser certificado y anclado en Stellar Soroban.

2. **Acceso Público del Consumidor / Escaneo QR:**
   Cualquier persona que escanee el código QR físico accede al endpoint público sin necesidad de token:
   - **`GET /v1/traceability/public/:lotCode`**

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

### Paso 2: Registro de Bodega de Vinos y Propietario (Winery Admin)
El representante legal crea su cuenta pública como `WINERY_ADMIN` y solicita el alta de la bodega.

```bash
# 2.1 Registro de Usuario Winery Admin
curl -X POST http://localhost:3000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gerencia@vinoscinti.bo",
    "password": "Password123!",
    "fullName": "Gerente General Vinos Cinti",
    "userRole": "WINERY_ADMIN"
  }'
```
*Guarda el `accessToken` temporal devuelto como `{{TEMP_WINERY_TOKEN}}`.*

```bash
# 2.2 (Opcional) Subir Logo Institucional de la Bodega
curl -X POST "http://localhost:3000/v1/uploads?folder=logos" \
  -H "Authorization: Bearer {{TEMP_WINERY_TOKEN}}" \
  -F "file=@./logo-cinti.png"
# Guarda la URL devuelta en data.url como {{LOGO_URL}}
```

```bash
# 2.3 Solicitud de Onboarding de Bodega de Vinos
curl -X POST http://localhost:3000/v1/wineries \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{TEMP_WINERY_TOKEN}}" \
  -d '{
    "legalName": "Bodega y Viñedos San Pedro S.A.",
    "commercialName": "Cinti Vinos de Altura",
    "beverageCategory": "WINERY",
    "taxIdNit": "2094837102",
    "senasagSanitaryReg": "SENASAG-CHUQ-00812",
    "geographicRegion": "Valle de Cinti, Chuquisaca",
    "contactEmail": "contacto@vinoscinti.bo",
    "contactPhone": "+59146931122",
    "logoUrl": "http://localhost:3000/uploads/logos/logo-cinti.png"
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
    "approvalNotes": "Bodega vitivinícola tradicional certificada en Valle de Cinti."
  }'
```

```bash
# Re-login de Winery Admin para obtener token con wineryId activo
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gerencia@vinoscinti.bo",
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
    "email": "agronomo@vinoscinti.bo",
    "password": "Password123!",
    "fullName": "Ing. Rodrigo Cárdenas",
    "memberRole": "AGRONOMIST",
    "professionalLicenseNumber": "CIA-CHUQ-412"
  }'

# 4.2 Alta directa de la Enóloga
curl -X POST http://localhost:3000/v1/wineries/my/members/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{WINERY_ADMIN_TOKEN}}" \
  -d '{
    "email": "enologa@vinoscinti.bo",
    "password": "Password123!",
    "fullName": "Lic. Marcela Zenteno",
    "memberRole": "ENOLOGIST",
    "professionalLicenseNumber": "COL-ENOL-CHUQ-109"
  }'
```

```bash
# 4.3 Login del Agrónomo para obtener {{AGRO_TOKEN}}
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "agronomo@vinoscinti.bo",
    "password": "Password123!"
  }'

# 4.4 Login de la Enóloga para obtener {{ENOL_TOKEN}}
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "enologa@vinoscinti.bo",
    "password": "Password123!"
  }'
```

---

### Paso 5: Registro de Parcela / Terroir de Vino Tinto (2,000 msnm)
El agrónomo registra la parcela en el Valle de Cinti a **2,000 m.s.n.m.** con uva **Cabernet Sauvignon**.

```bash
curl -X POST http://localhost:3000/v1/terroirs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{AGRO_TOKEN}}" \
  -d '{
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
    "doType": "Valles Altos de Bolivia"
  }'
```
*Guarda el ID devuelto como `{{TERROIR_ID}}`.*

---

### Paso 6: Recepción y Pesaje en Báscula (Vendimia de Uva Tinta)
Se registra la llegada de 8,500 kg brutos con tara de 100 kg (**8,400 kg netos**) con madurez fenólica óptima (**24.5 °Bx**, pH 3.60, Acidez 5.8 g/L).

```bash
curl -X POST http://localhost:3000/v1/harvest-batches \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{AGRO_TOKEN}}" \
  -d '{
    "terroirId": "{{TERROIR_ID}}",
    "intakeDate": "2025-01-10",
    "harvestYear": 2025,
    "grossWeightKg": 8500.0,
    "tareWeightKg": 100.0,
    "brixDegrees": 24.5,
    "initialPh": 3.60,
    "initialAcidityGl": 5.80,
    "temperatureAtIntakeC": 14.0,
    "notes": "Cosecha manual nocturna en cajas de 15 kg para preservar acidez."
  }'
```
*Guarda el ID devuelto como `{{HARVEST_BATCH_ID}}`.*

---

### Paso 7: Aprobación Fitosanitaria y Subida de Informe Técnico
La enóloga certifica la sanidad de la uva subiendo el informe técnico en PDF al backend y dictaminando `APPROVED`.

```bash
# 7.1 Subir Informe Técnico Fitosanitario (PDF)
curl -X POST "http://localhost:3000/v1/uploads?folder=inspections" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./inspeccion-crespones-2025.pdf"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/inspections/1742880000000-phyto-crespones.pdf",
    "key": "inspections/1742880000000-phyto-crespones.pdf"
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
    "phytoInspectionPdfUrl": "http://localhost:3000/uploads/inspections/1742880000000-phyto-crespones.pdf",
    "notes": "Excelente madurez fenólica, hollejo grueso y libre de botritis."
  }'
```

---

### Paso 8: Fermentación de Vino Tinto en Cuba de Inox
Se encuba el mosto en la cuba `TK-RED-01` con destino a crianza en madera (`WINE_AGING`).

```bash
# 8.1 Registro de cuba de fermentación
curl -X POST http://localhost:3000/v1/fermentation-tanks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "harvestBatchId": "{{HARVEST_BATCH_ID}}",
    "tankCode": "TK-RED-01",
    "capacityLiters": 10000.0,
    "material": "Acero Inoxidable AISI 316 con camisa térmica",
    "volumeFilledLiters": 5800.0,
    "destinationType": "WINE_AGING",
    "startDate": "2025-01-11T09:00:00Z"
  }'
```
*Guarda el ID de la cuba como `{{TANK_ID}}`.*

```bash
# 8.2 Registrar log de fermentación con maceración
curl -X POST http://localhost:3000/v1/fermentation-tanks/{{TANK_ID}}/logs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "temperatureCelsius": 24.5,
    "specificGravity": 1.012,
    "phValue": 3.58,
    "co2Observations": "Maceración con remontados diarios de 20 minutos a 24°C",
    "recordedAt": "2025-01-15T10:00:00Z"
  }'

# 8.3 Registrar adición de nutrientes y levaduras enológicas seleccionadas
curl -X POST http://localhost:3000/v1/fermentation-tanks/{{TANK_ID}}/treatments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "treatmentType": "NUTRIENT_ADDITION",
    "additiveName": "Nutrientes y levaduras Saccharomyces cerevisiae Lalvin EC-1118",
    "dosageAppliedGPerHl": 20.0,
    "regulatoryAuthCode": "SENASAG-REG-2024-112",
    "appliedAt": "2025-01-11T12:00:00Z"
  }'
```

---

### Paso 9: Traslado a Crianza en Barricas de Roble Francés (12 Meses)
Se trasiega el vino a barricas de roble francés de primer uso con **12 meses planificados de crianza**.  
*(Se especifica `startDate: "2025-02-01"`, lo que sitúa la fecha de desbloqueo `lockUntilDate: "2026-02-01"` en el pasado respecto a la fecha actual, permitiendo el embotellado sin bloqueo).*

```bash
curl -X POST http://localhost:3000/v1/wine-aging \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "fermentationTankId": "{{TANK_ID}}",
    "containerType": "Barrica",
    "containerMaterial": "Roble Francés Grano Fino (Allier)",
    "containerCode": "BAR-FR-012",
    "barrelUseCycle": 1,
    "volumeLiters": 225.0,
    "plannedMonths": 12,
    "startDate": "2025-02-01T00:00:00Z",
    "notes": "Cava Subterránea Bóveda 1 a 14°C y 75% humedad relativa"
  }'
```
*Guarda el ID del lote de crianza devuelto como `{{WINE_AGING_BATCH_ID}}`.*

> ⚠️ **Prueba de Bloqueo de Crianza (Opcional):** Si se registra una barrica con `startDate` de la fecha actual y `plannedMonths: 12`, al intentar embotellarla el sistema responderá **`422 Unprocessable Entity`** con el mensaje: *"El vino se encuentra bloqueado por período de crianza hasta el YYYY-MM-DD"*.

---

### Paso 10: Subida de Etiqueta y Embotellado del Vino Gran Reserva
Se envasan **300 botellas de 750 ml a 14.2% ABV** en botella Bordelesa Cónica.

```bash
# 10.1 Subir Diseño de la Etiqueta Frontal (Imagen)
curl -X POST "http://localhost:3000/v1/uploads?folder=labels" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./etiqueta-gran-reserva-cinti.png"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/labels/1742880000000-gran-reserva-cinti.png",
    "key": "labels/1742880000000-gran-reserva-cinti.png"
  }
}
```

```bash
# 10.2 Registrar el Embotellado asociando la URL de la etiqueta
curl -X POST http://localhost:3000/v1/bottling \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "wineAgingBatchId": "{{WINE_AGING_BATCH_ID}}",
    "productType": "WINE",
    "finalAlcoholAbv": 14.2,
    "totalBottlesPackaged": 300,
    "packagingFormatCl": 75,
    "bottleType": "Bordelesa Cónica Verde Antiguo 750ml",
    "labelDesignUrl": "http://localhost:3000/uploads/labels/1742880000000-gran-reserva-cinti.png",
    "bottlingDate": "2026-03-01"
  }'
```
*Guarda el ID del embotellado como `{{BOTTLING_BATCH_ID}}` y el código internacional de lote (ej. `CIN-2026-WINE-001`).*

---

### Paso 11: Certificación Oficial de Laboratorio Físico-Químico (ISO 17025)
Se sube el certificado emitido por el laboratorio acreditado en PDF y se registra el análisis enológico oficial.

```bash
# 11.1 Subir Certificado de Laboratorio Oficial (PDF)
curl -X POST "http://localhost:3000/v1/uploads?folder=lab-reports" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -F "file=@./analisis-enologico-cinti.pdf"
```
*Respuesta:*
```json
{
  "success": true,
  "data": {
    "url": "http://localhost:3000/uploads/lab-reports/1742880000000-lab-report-cinti-880.pdf",
    "key": "lab-reports/1742880000000-lab-report-cinti-880.pdf"
  }
}
```

```bash
# 11.2 Registro de Parámetros Físico-Químicos Oficiales
curl -X POST http://localhost:3000/v1/lab-analyses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{ENOL_TOKEN}}" \
  -d '{
    "bottlingBatchId": "{{BOTTLING_BATCH_ID}}",
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
  }'
```

---

### Paso 12: Consulta Pública del Pasaporte Digital (Escaneo QR)
Cualquier consumidor o distribuidor puede consultar la trazabilidad y el árbol DAG completo sin autenticación:

```bash
# Consulta pública por Código de Lote internacional
curl -X GET http://localhost:3000/v1/traceability/public/CIN-2026-WINE-001
```

```bash
# O consulta interna autorizada por UUID
curl -X GET http://localhost:3000/v1/traceability/dag/{{BOTTLING_BATCH_ID}} \
  -H "Authorization: Bearer {{ENOL_TOKEN}}"
```

---

### Paso 13 (Opcional): Habilitación de Exportación

> ℹ️ **Paso Opcional:** En Drinks on Chain, el 100% de las botellas mantienen su trazabilidad completa independientemente de si se venden en el mercado local o se exportan a Estados Unidos o Europa.

```bash
curl -X PATCH http://localhost:3000/v1/wineries/my \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{WINERY_ADMIN_TOKEN}}" \
  -d '{
    "address": "Camargo, Cañón de Cinti, Chuquisaca, Bolivia"
  }'
```
