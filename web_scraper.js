'use strict';

/**
 * WEB SCRAPER REGULATORIO v1 — Módulo de actualización normativa para MIIA
 *
 * Cada lunes a las 02:00 AM Bogotá visita los Ministerios de Salud y sitios
 * de Medilink, extrae novedades regulatorias relevantes para clínicas/consultorios
 * y las guarda en trainingData via appendLearning().
 *
 * - Solo corre lunes a las 02:00 AM Bogotá
 * - Salta si ya corrió esta semana (usando ISO week number)
 * - READ ONLY: solo lectura de URLs públicas
 * - No agrega dependencias externas: usa fetch nativo de Node 18+
 */

// ─────────────────────────────────────────────
// FUENTES A SCRAPEAR
// ─────────────────────────────────────────────

const SOURCES = [
  { name: 'Minsalud Colombia',  url: 'https://www.minsalud.gov.co/Paginas/Default.aspx',  pais: 'COLOMBIA' },
  { name: 'Minsal Chile',       url: 'https://www.minsal.cl/',                             pais: 'CHILE' },
  { name: 'SSA Mexico',         url: 'https://www.gob.mx/salud',                           pais: 'MEXICO' },
  { name: 'Minsalud Argentina', url: 'https://www.argentina.gob.ar/salud',                 pais: 'ARGENTINA' },
  { name: 'MSP Dom. Rep.',      url: 'https://msp.gob.do/',                                pais: 'REPUBLICA_DOMINICANA' },
  { name: 'Medilink sitio',     url: 'https://medilink.cl/',                               pais: 'MEDILINK' },
  { name: 'Medilink ayuda',     url: 'https://ayuda.medilink.cl/',                         pais: 'MEDILINK' },
];

// ─────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────

let _generateAIContent   = null;
let _appendLearning      = null;
let _lastRunWeek         = '';   // ISO week string "2026-W13"
let _isRunning           = false;
let scraperPendingResults = [];  // resultados pendientes de enviar a Mariano en el briefing

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getISOWeekStr(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 8000);
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

function init({ generateAIContent, appendLearning }) {
  _generateAIContent = generateAIContent;
  _appendLearning    = appendLearning;
  console.log('[WEB SCRAPER] Módulo regulatorio listo. Ciclo: lunes 02:00 AM Bogotá.');
}

// ─────────────────────────────────────────────
// SCRAPING DE UNA FUENTE
// ─────────────────────────────────────────────

async function scrapePage(source) {
  try {
    const response = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MIIABot/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      console.warn(`[WEB SCRAPER] ${source.name}: HTTP ${response.status}`);
      return;
    }
    const html = await response.text();
    const text = stripHTML(html);

    if (!text || text.length < 100) {
      console.warn(`[WEB SCRAPER] ${source.name}: contenido insuficiente`);
      return;
    }

    const prompt = `Eres MIIA, asistente de ventas de Medilink para clínicas y consultorios médicos de Latinoamérica.
Analizá el siguiente contenido del sitio "${source.name}" (${source.pais}) y extrae SOLO lo que sea relevante para un médico o clínica que evalúa digitalizar su gestión:
- Nuevas resoluciones o exigencias regulatorias (ejemplo: Resolución 1888 Colombia)
- Cambios en normativas de salud digital: historia clínica electrónica, facturación electrónica, telemedicina, firma digital, receta digital
- Cualquier obligación nueva que un software como Medilink podría resolver para el profesional
- Plazos o fechas límite de cumplimiento

Si no hay nada relevante para digitalización de clínicas, respondé exactamente: SIN_NOVEDADES
Máximo 200 palabras. En primera persona como MIIA.

Contenido del sitio:
${text}`;

    const result = await _generateAIContent(prompt);
    if (!result || result.trim() === 'SIN_NOVEDADES') {
      console.log(`[WEB SCRAPER] ${source.name}: sin novedades relevantes.`);
      return;
    }

    const sourceKey = `${source.pais}_${source.name.replace(/\s+/g, '_').toUpperCase()}`;
    // Guardar en pendientes — el briefing de las 8:30 AM lo enviará a Mariano y luego lo moverá a trainingData
    if (scraperPendingResults.length >= 50) scraperPendingResults.shift();
    scraperPendingResults.push({
      source: sourceKey,
      text:   result,
      fecha:  new Date().toLocaleDateString('es-ES')
    });
    console.log(`[WEB SCRAPER] ${source.name}: novedad pendiente de enviar a Mariano (${result.length} chars).`);

  } catch (e) {
    console.error(`[WEB SCRAPER] Error scrapeando ${source.name}:`, e.message);
  }
}

// ─────────────────────────────────────────────
// EJECUCIÓN COMPLETA
// ─────────────────────────────────────────────

async function runScraper() {
  if (_isRunning) {
    console.log('[WEB SCRAPER] Ya en ejecución. Saltando.');
    return;
  }
  if (!_generateAIContent || !_appendLearning) {
    console.warn('[WEB SCRAPER] No inicializado. Llamar init() primero.');
    return;
  }

  _isRunning = true;
  console.log(`[WEB SCRAPER] Iniciando ciclo regulatorio — ${SOURCES.length} fuentes.`);

  for (const source of SOURCES) {
    await scrapePage(source);
    // Pausa entre fuentes para no saturar
    await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)));
  }

  _lastRunWeek = getISOWeekStr(new Date());
  console.log(`[WEB SCRAPER] Ciclo completo. Semana: ${_lastRunWeek}.`);
  _isRunning = false;
}

// ─────────────────────────────────────────────
// CRON (llamar cada 60s desde server_v2.js)
// ─────────────────────────────────────────────

async function processScraperCron() {
  try {
    const nowBogota = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const isMonday  = nowBogota.getDay() === 1;
    const isAt2AM   = nowBogota.getHours() === 2;
    const thisWeek  = getISOWeekStr(nowBogota);

    if (isMonday && isAt2AM && _lastRunWeek !== thisWeek) {
      console.log('[CRON SCRAPER] Lunes 02:00 AM — Lanzando scraper regulatorio...');
      runScraper().catch(e => console.error('[CRON SCRAPER] Error:', e.message));
    }
  } catch (e) {
    console.error('[CRON SCRAPER] Error en cron:', e.message);
  }
}

// ─────────────────────────────────────────────
// GETTERS DE PENDIENTES (usados por processMorningBriefing en server_v2.js)
// ─────────────────────────────────────────────

function getPendingResults()  { return scraperPendingResults; }
function clearPendingResults() { scraperPendingResults = []; }

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = { init, runScraper, processScraperCron, getPendingResults, clearPendingResults };
