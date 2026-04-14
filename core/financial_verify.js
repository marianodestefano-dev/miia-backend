/**
 * financial_verify.js — Verificación cruzada de datos financieros oficiales
 *
 * FEAT-005: Para cotizaciones y datos numéricos duros, MIIA verifica contra
 * fuentes oficiales antes de responder. Si hay discrepancia, informa ambos valores.
 *
 * Fuentes:
 * - TRM Colombia: API datos.gov.co (Superintendencia Financiera)
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

// ═══ Cache para no llamar a la API en cada mensaje ═══
const _cache = {
  trm: { data: null, fetchedAt: 0 }
};
const TRM_CACHE_TTL = 30 * 60 * 1000; // 30 minutos — TRM cambia 1 vez al día

/**
 * Obtiene la TRM oficial vigente HOY desde datos.gov.co
 * Filtra por vigenciadesde <= hoy para NO traer la TRM de mañana
 * (que ya está publicada pero no es la vigente)
 *
 * @returns {{ valor: number, vigencia: string, fuente: string } | null}
 */
async function fetchOfficialTRM() {
  // Check cache
  if (_cache.trm.data && (Date.now() - _cache.trm.fetchedAt) < TRM_CACHE_TTL) {
    console.log(`[FINANCIAL-VERIFY] 💰 TRM desde cache: $${_cache.trm.data.valor} vigencia=${_cache.trm.data.vigencia}`);
    return _cache.trm.data;
  }

  const today = new Date().toISOString().split('T')[0]; // "2026-04-13"
  const url = `https://www.datos.gov.co/resource/32sa-8pi3.json?$where=vigenciadesde<='${today}T23:59:59.000'&$order=vigenciadesde DESC&$limit=1`;

  console.log(`[FINANCIAL-VERIFY] 💰 Consultando TRM oficial... fecha=${today}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[FINANCIAL-VERIFY] ⚠️ datos.gov.co respondió ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!data?.[0]?.valor) {
      console.warn(`[FINANCIAL-VERIFY] ⚠️ datos.gov.co sin datos para ${today}`);
      return null;
    }

    const result = {
      valor: parseFloat(data[0].valor),
      vigencia: data[0].vigenciadesde.split('T')[0],
      vigenciaHasta: data[0].vigenciahasta?.split('T')[0] || today,
      fuente: 'Superintendencia Financiera (datos.gov.co)'
    };

    // Guardar en cache
    _cache.trm.data = result;
    _cache.trm.fetchedAt = Date.now();

    console.log(`[FINANCIAL-VERIFY] ✅ TRM oficial: $${result.valor} vigencia=${result.vigencia} hasta=${result.vigenciaHasta}`);
    return result;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn(`[FINANCIAL-VERIFY] ⚠️ Timeout consultando datos.gov.co (5s)`);
    } else {
      console.warn(`[FINANCIAL-VERIFY] ⚠️ Error consultando TRM: ${err.message}`);
    }
    return null;
  }
}

module.exports = { fetchOfficialTRM };
