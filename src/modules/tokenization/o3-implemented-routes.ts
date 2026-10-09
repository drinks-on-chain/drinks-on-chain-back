/**
 * Rutas del contrato de la Ola 3 a las que el paso 3.3 (solicitud de
 * tokenización y colecciones sin red) dio lógica: dejaron de declarar y de
 * responder `501 NOT_IMPLEMENTED`. Las usan las pruebas de la apertura para
 * separar lo implementado de lo que sigue pendiente de su paso.
 */
export const O3_STEP_3_3_ROUTES: readonly string[] = [
  // ERP · solicitudes y colecciones de la bodega (§5.3)
  'GET /v1/lots/{id}/tokenization',
  'POST /v1/lots/{id}/tokenization-requests',
  'GET /v1/tokenization-requests',
  'GET /v1/tokenization-requests/{id}',
  'PATCH /v1/tokenization-requests/{id}',
  'POST /v1/tokenization-requests/{id}/resubmit',
  'POST /v1/tokenization-requests/{id}/withdraw',
  'GET /v1/collections',
  'GET /v1/collections/{id}',
  'GET /v1/collections/{id}/tokens',
  // Back office · bandeja (§5.4)
  'GET /v1/platform/tokenization-requests',
  'GET /v1/platform/tokenization-requests/{id}',
  'POST /v1/platform/tokenization-requests/{id}/take',
  'POST /v1/platform/tokenization-requests/{id}/notes',
  'PATCH /v1/platform/tokenization-requests/{id}',
  'POST /v1/platform/tokenization-requests/{id}/request-changes',
  'POST /v1/platform/tokenization-requests/{id}/approve',
  'POST /v1/platform/tokenization-requests/{id}/reject',
  // Back office · colecciones y métricas (§6.4, §8.5)
  'GET /v1/platform/collections',
  'GET /v1/platform/collections/{id}',
  'PATCH /v1/platform/collections/{id}',
  'POST /v1/platform/collections/{id}/publish',
  'POST /v1/platform/collections/{id}/pause',
  'POST /v1/platform/collections/{id}/resume',
  'POST /v1/platform/collections/{id}/close',
  'GET /v1/platform/collections/{id}/tokens',
  'GET /v1/platform/collections/{id}/transactions',
  'GET /v1/platform/collections/{id}/metrics',
  // Público (§6.5 y las imágenes de las colecciones)
  'GET /v1/public/nft/{winerySlug}/{tokenId}',
  'GET /v1/public/collections/images/{imageId}',
];
