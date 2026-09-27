Paso 1: Origen y Polígono (Viñedo)
El Ingeniero Agrónomo registra la parcela antes de la cosecha garantizando la D.O.
	Actor: Ing. Carlos Mendoza (GCARLOS...AGRO)
	Datos Operativos / Off-chain:
	Parcela: Cuartel 4 - "La Finca El Potrero", San Lorenzo, Tarija.
	Altura: 1,850 m.s.n.m.
	Variedad: 100% Moscatel de Alejandría (Pie franco, 18 años).
	Fitosanitarios: Cobre + Azufre (última aplicación hace 28 días, carencia: 21 días cumplida).
	IPFS Metadata (QmAgro...): Archivo JSON con polígono GeoJSON y cuaderno de campo firmado.
	Transacción Soroban:
	batch_id: 0x9a4f... (LOTE-UVA-2026-04)
	stage: Stage::Harvest
	parents: [] (Sin predecesores)
	ipfs_cid_hash: Hash(QmAgro...)
	volume_or_units: 15000 (15,000 kg estimados)
	metrics: [1850] (Altitud en m.s.n.m.)
Paso 2: Vendimia, Pesaje e Inocuidad
Ingreso de uva fresca a la tolva de la destilería.
	Actor: Jefe de Báscula: Mario Cruz (GMARIO...BASCULA)
	Datos Operativos / Off-chain:
	Peso neto recibido: 14,850 kg.
	Análisis de madurez: 22.4 °Brix, pH 3.45, Temperatura: 16°C.
	Estado sanitario: Daño mecánico < 1%, Botritis 0%.
	IPFS Metadata (QmVendimia...): Ticket de báscula calibrada por IBMETRO y acta de recepción.
	Transacción Soroban:
	batch_id: 0xb12c... (LOTE-VEND-2026-04)
	stage: Stage::Harvest
	parents: [0x9a4f...] (Enlaza con la parcela)
	ipfs_cid_hash: Hash(QmVendimia...)
	volume_or_units: 14850 (kg netos)
	metrics: [2240, 345] (22.40 °Bx * 100, pH 3.45 * 100)
Paso 3: Vinificación Base (Fermentación)
Extracción del mosto y fermentación en blanco para obtener el vino base aromático.
	Actor: Enólogo Jefe: Lic. Valeria Soliz (GVALERIA...ENOL)
	Datos Operativos / Off-chain:
	Prensado neumático: Rendimiento 68% → 10,100 Litros de mosto flor.
	Inóculo: Levadura seleccionada Saccharomyces cerevisiae (cepa aroma floral).
	Sulfitado inicial: 30 mg/L SO_2.
	Fermentación: 14 días controlada a 15°C en Tanque de Acero Inoxidable TK-03.
	Vino base final: 10,000 Litros a 12.8% ABV, acidez volátil 0.28 g/L.
	IPFS Metadata (QmVinoBase...): Planilla de control térmico diario y densidad.
	Transacción Soroban:
	batch_id: 0xc34d... (LOTE-VBASE-TK03)
	stage: Stage::Vinification
	parents: [0xb12c...] (Enlaza con uva pesada)
	ipfs_cid_hash: Hash(QmVinoBase...)
	volume_or_units: 10000 (Litros vino base)
	metrics: [1280, 28] (12.80% ABV * 100, 0.28 g/L acidez volátil * 100)
Paso 4: Destilación en Alambique de Cobre y Reposo Inerte
El proceso emblemático del Singani: destilación simple en alambique discontinuo Charentais.
	Actor: Maestro Destilador: Roberto Tarija (GROBERTO...DESTIL)
	Datos Operativos / Off-chain:
	Carga alambique: 10,000 Litros de vino base LOTE-VBASE-TK03.
	Cortes de destilación (Balance de masa):
	Cabezas descartadas: 120 Litros (aldehídos/ésteres pesados).
	Corazón (Destilado noble): 1,750 Litros a 70.2% ABV.
	Colas descartadas: 450 Litros.
	Almacenamiento: Tanque Inox TK-DEST-01 (sin madera) por 6 meses para redondeo aromático.
	IPFS Metadata (QmDestil...): Ficha de destilación por alambique, temperaturas de vapor y volúmenes de corte.
	Transacción Soroban:
	batch_id: 0xd56e... (LOTE-SING-RAW-01)
	stage: Stage::Distillation
	parents: [0xc34d...] (Enlaza con el vino base)
	ipfs_cid_hash: Hash(QmDestil...)
	volume_or_units: 1750 (Litros corazón obtenidos)
	metrics: [7020] (70.20% ABV directo del alambique)
Paso 5: Certificación de Laboratorio Físico-Químico
Validación analítica obligatoria para exportación antes de fraccionar.
	Actor: Laboratorio Certificado ISO 17025 (GLAB...CERT17025)
	Datos Operativos / Off-chain:
	Muestra tomada del Tanque TK-DEST-01.
	Metanol: 48 mg/100 ml de alcohol anhidro (Límite internacional < 200 mg/100 ml).
	Acidez volátil: 0.22 g/L.
	Cobre / Plomo: No detectado (< 0.05 mg/L).
	Dictamen: APROBADO PARA EXPORTACIÓN.
	IPFS Metadata (QmCertLab...): PDF del Certificado Analítico firmado digitalmente por el perito químico.
	Transacción Soroban:
	batch_id: 0xd56e... (Mismo lote de singani a certificar)
	Invoca certify_batch():
	lab_report_cid: Hash(QmCertLab...)
	is_approved: true
	metrics: [48, 22] (Metanol: 48 mg, Acidez: 0.22 g/L)
Paso 6: Dilución, Embotellado y Empaque Secundario
Acondicionamiento final con agua tratada e insumos certificados.
	Actor: Supervisor de Embotellado: Juan Prado (GJUAN...EMBOTELLADO)
	Datos Operativos / Off-chain:
	Dilución: 1,750 L de Singani a 70.2% + 1,321 L de agua osmotizada → 3,071 Litros finales a 40.0% ABV.
	Insumos secos: Botella de vidrio extra-flint (Lote VID-981), Tapón sintético libre de TCA (Lote TAP-441).
	Producción: 4,080 botellas de 750 ml (Merma de línea: 11 Litros / 0.35%).
	Paletizado: 340 cajas de 12 unidades en 4 pallets (SSCC: 7771234500000001 al 4).
	IPFS Metadata (QmBottling...): Planilla de balance de masa de llenado, certificados de migración de envase (FCM) y trazabilidad GS1.
	Transacción Soroban:
	batch_id: 0xe78f... (LOTE-EXP-USA-2026)
	stage: Stage::Bottling
	parents: [0xd56e...] (Enlaza con el singani certificado)
	ipfs_cid_hash: Hash(QmBottling...)
	volume_or_units: 4080 (Unidades de botellas producidas)
	metrics: [4000, 750] (40.00% ABV comercial, 750 ml formato)
Paso 7: Despacho Aduanero y Exportación a EE. UU.
Consolidación de contenedor y emisión del expediente sanitario internacional.
	Actor: Agente de Comercio Exterior: Sofía Arce (GSOFIA...COMEX)
	Datos Operativos / Off-chain:
	Destino: Importador en Miami, FL, EE. UU.
	Aprobación TTB: Certificado COLA N° 26-0049182.
	Certificado Fitosanitario / Sanitario: SENASAG N° EXP-BOL-2026-8831.
	Contenedor: MSCU-884192-0 / Precinto de seguridad aduanero: BOL-ADUANA-99214.
	Documento de Transporte: Bill of Lading (B/L) MEDU9920194.
	IPFS Metadata (QmExport...): Expediente PDF consolidado (SENASAG + TTB COLA + Packing List + B/L).
	Transacción Soroban:
	batch_id: 0xff01... (DESPACHO-USA-EXP01)
	stage: Stage::Export
	parents: [0xe78f...] (Enlaza con el lote de botellas)
	ipfs_cid_hash: Hash(QmExport...)
	volume_or_units: 4080 (Botellas despachadas)
	metrics: [260049182] (Referencia truncada del ID TTB COLA)
Resultado Final: Consulta por Escaneo de QR
Cuando el consumidor en Miami o un inspector aduanero escanea el QR de la botella LOTE-EXP-USA-2026, la aplicación realiza una sola llamada RPC al nodo de Stellar y reconstruye el grafo en reversa:
[DESPACHO-USA-EXP01] (B/L MEDU9920194, Precinto BOL-99214, TTB COLA Aprobado)
        │
        ▼
[LOTE-EXP-USA-2026] (4,080 Botellas 750ml, 40.0% ABV, Insumos libres de TCA)
        │
        ▼
[LOTE-SING-RAW-01]  (1,750 Litros Corazón a 70.2% ABV, Lab Certificado: Metanol 48mg Aprobado)
        │
        ▼
[LOTE-VBASE-TK03]   (10,000 Litros Vino Base, Fermentación controlada 15°C)
        │
        ▼
[LOTE-VEND-2026-04] (14,850 Kg Uva pesada, 22.4 °Brix)
        │
        ▼
[LOTE-UVA-2026-04]  (Cuartel 4 El Potrero, 1,850 m.s.n.m., 100% Moscatel de Alejandría)
Cada paso cuenta con una firma criptográfica inmutable en Stellar, y los certificados completos (PDFs y GeoJSON) están disponibles para descarga directa desde IPFS sin intermediarios.

