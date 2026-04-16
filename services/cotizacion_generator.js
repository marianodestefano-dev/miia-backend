'use strict';

/**
 * COTIZACION GENERATOR v1
 * Genera PDF de cotización Medilink y lo envía por WhatsApp.
 *
 * Uso:
 *   const cg = require('./cotizacion_generator');
 *   await cg.enviarCotizacionWA(whatsappClient, phone, params);
 *
 * params = {
 *   nombre, pais, moneda, usuarios, citasMes,
 *   incluirWA, bolsaWAForzada,
 *   incluirFirma, bolsaFirmaForzada,
 *   incluirFactura, bolsaFacturaForzada,
 *   descuento, vigencia, fecha
 * }
 */

const fs        = require('fs');
const path      = require('path');
let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch(e) {
  console.warn('[COTIZACION] puppeteer-core no disponible — generación de PDF deshabilitada');
}

// ─────────────────────────────────────────────────────────────────────
// MATRICES DE PRECIOS (fuente: prompt_maestro.md)
// ─────────────────────────────────────────────────────────────────────

const PRECIOS = {

  CLP: {
    planes: { S: 35000, M: 55000, L: 85000 },
    // Adicionales escalonados por total de usuarios
    adic1: { S: 15000, M: 16000, L: 18000 },   // 2–5
    adic2: { S: 12500, M: 13500, L: 15500 },   // 6–10
    adic3: { S:  9500, M: 10500, L: 12000 },   // 11+
    bolsas: {
      WA:      { S: 17780,  M: 38894,  L:  83671, XL: 197556 },
      factura: { S: 10000,  M: 13000,  L:  20000, XL:  30000 },
      firma:   { S: 20833,  M: 39063,  L:  69444, XL: 164474 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L:  800, XL: 2000 },
      factura: { S:  50, M: 200, L:  500, XL: 1000 },
      firma:   { S:  50, M: 200, L:  500, XL: 1000 }
    }
  },

  COP: {
    planes: { S: 125000, M: 150000, L: 225000 },
    adic1: { S: 35000, M: 40000, L: 55000 },
    adic2: { S: 35000, M: 40000, L: 55000 },
    adic3: { S: 35000, M: 40000, L: 55000 },
    bolsas: {
      WA:      { S:  11000, M:  23000, L:  75000, XL: 120000 },
      factura: { S:  32000, M:  50000, L:  88000, XL: 165000 },
      firma:   { S:  15000, M:  30000, L:  70000, XL: 140000 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L:  800, XL: 2000 },
      factura: { S:  50, M: 200, L:  500, XL: 1000 },
      firma:   { S:  50, M: 200, L:  500, XL: 1000 }
    }
  },

  MXN: {
    planes: { S: 842.80, M: 1180, L: 1297 },
    adic1: { S: 250, M: 300, L: 450 },
    adic2: { S: 250, M: 300, L: 450 },
    adic3: { S: 250, M: 300, L: 450 },
    bolsas: {
      WA:      { S:  210, M:  360, L:  680, XL: 1300 },
      factura: { S:  160, M:  270, L:  440, XL:  500 },
      firma:   { S:  450, M:  790, L: 1400, XL: 3300 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      factura: { S:  50, M: 100, L: 200, XL:  500 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  },

  USD: {
    planes: { S: 45, M: 65, L: 85 },
    adic1: { S: 12, M: 13, L: 14 },
    adic2: { S: 12, M: 13, L: 14 },
    adic3: { S: 12, M: 13, L: 14 },
    bolsas: {
      WA:      { S: 15, M:  35, L:  70, XL: 170 },
      factura: { S: 10, M:  17, L:  35, XL:  60 },
      firma:   { S: 25, M:  40, L:  70, XL: 170 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      factura: { S:  50, M: 100, L: 200, XL:  500 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  },

  // España (EUR) — PRECIOS ANUALES (×12 meses). Solo se vende modalidad anual.
  EUR: {
    planes: { S: 840, M: 1200, L: 1440 },
    adic1: { S: 120, M: 192, L: 240 },
    adic2: { S: 120, M: 192, L: 240 },
    adic3: { S: 120, M: 192, L: 240 },
    bolsas: {
      WA:      { S: 180, M:  396, L:  864, XL: 2040 },
      factura: { S: 120, M:  204, L:  420, XL:  720 },
      firma:   { S: 300, M:  540, L:  960, XL: 2400 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      factura: { S:  50, M: 100, L: 200, XL:  500 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

/** Formatea un número como moneda con separador de miles apropiado */
function fmt(value, moneda) {
  try {
    const n = Number(value);
    if (moneda === 'EUR') {
      return '€ ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }
    const sepMiles = (moneda === 'USD' || moneda === 'MXN') ? ',' : '.';
    if (moneda === 'MXN' && n % 1 !== 0) {
      const int = Math.floor(n);
      const dec = Math.round((n - int) * 100).toString().padStart(2, '0');
      return '$ ' + int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, sepMiles) + '.' + dec;
    }
    return '$ ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sepMiles);
  } catch(e) {
    console.error(`[FMT-ERROR] value=${value}, moneda=${moneda}, error=${e.message}`);
    throw e;
  }
}

/** Formatea número plano (para rangos de bolsas) */
function fmtNum(n) {
  try {
    const result = Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return result;
  } catch(e) {
    console.error(`[FMTNUM-ERROR] n=${n}, error=${e.message}`);
    throw e;
  }
}

/** Precio del usuario adicional según total de usuarios */
function getPrecioAdic(planKey, totalUsuarios, moneda) {
  const p = PRECIOS[moneda];
  if (totalUsuarios >= 11) return p.adic3[planKey];
  if (totalUsuarios >= 6)  return p.adic2[planKey];
  return p.adic1[planKey];
}

/** Selecciona el tier de bolsa más pequeño que cubre los envíos requeridos */
function selectTier(enviosRequeridos, rangos) {
  for (const tier of ['S', 'M', 'L', 'XL']) {
    if (enviosRequeridos <= rangos[tier]) return tier;
  }
  return 'XL';
}

/** Devuelve { tier, limiteEnvios, precio } para un módulo */
function getBolsa(modulo, envios, moneda, tierForzado) {
  const p = PRECIOS[moneda];
  const tier = tierForzado || selectTier(envios, p.rangos[modulo]);
  return { tier, limiteEnvios: p.rangos[modulo][tier], precio: p.bolsas[modulo][tier] };
}

// ─────────────────────────────────────────────────────────────────────
// VIGENCIA Y CUPOS DINÁMICOS DE PROMOCIÓN
// ─────────────────────────────────────────────────────────────────────

function getPromoVigencia() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const day = now.getDate();
  const month = now.getMonth();
  const year = now.getFullYear();

  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

  let vigencia, cupos;
  if (day >= 1 && day < 15) {
    vigencia = `15 de ${months[month]} de ${year}`;
    cupos = 11;
  } else if (day >= 15 && day < 22) {
    vigencia = `25 de ${months[month]} de ${year}`;
    cupos = 7;
  } else if (day >= 22 && day < 27) {
    vigencia = `30 de ${months[month]} de ${year}`;
    cupos = 4;
  } else {
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear  = month === 11 ? year + 1 : year;
    vigencia = `5 de ${months[nextMonth]} de ${nextYear}`;
    cupos = 4;
  }
  return { vigencia, cupos };
}

// ─────────────────────────────────────────────────────────────────────
// CÁLCULO DE COTIZACIÓN
// ─────────────────────────────────────────────────────────────────────

function calcularCotizacion(params) {
  const {
    moneda          = 'CLP',
    usuarios        = 1,
    citasMes        = 70,   // FIX COT-4a (C-113): default 100→70, consistente con prompt
    incluirWA        = true,
    bolsaWA          = null,
    incluirFirma     = true,
    bolsaFirma       = null,
    incluirFactura   = true,
    bolsaFactura     = null,
    incluirRecetaAR  = false,
    modalidad: modalidadParam = 'mensual',
    descuentoCustom = null,   // Descuento dinámico (MIIA negocia: 10-30% según contexto)
    usuariosBonus   = 0,      // Usuarios médicos gratis (estrategia de retención)
  } = params;

  // España (EUR) → SOLO modalidad anual
  const modalidad = (moneda === 'EUR') ? 'anual' : modalidadParam;

  // Descuento: si MIIA envió uno custom, usarlo (validado con tope)
  // Topes: mensual=30%, semestral=15%, anual=20%
  const DESCUENTOS_TOPE = { mensual: 30, semestral: 15, anual: 20 };
  const tope = DESCUENTOS_TOPE[modalidad] || 30;
  const descuento = descuentoCustom ? Math.min(descuentoCustom, tope) : tope;

  // Multiplicador de meses según modalidad
  // EUR ya tiene precios anuales en PRECIOS, no multiplicar de nuevo
  const MESES = { mensual: 1, semestral: 6, anual: 12 };
  const multiplicador = (moneda === 'EUR') ? 1 : (MESES[modalidad] || 1);

  // Usuarios bonus: se suman al total pero NO se cobran (regalo de retención)
  const totalUsuarios = usuarios + (usuariosBonus || 0);
  console.log(`[COTIZ-DEBUG] calcularCotizacion: moneda=${moneda}, usuarios=${usuarios}${usuariosBonus ? `+${usuariosBonus} bonus` : ''}, modalidad=${modalidad}, descuento=${descuento}%${descuentoCustom ? ' (custom)' : ''}, multiplicador=${multiplicador}`);
  if (!PRECIOS[moneda]) throw new Error(`Moneda no soportada: ${moneda}`);

  // Solo cobrar los usuarios pagos, no los bonus
  const nAdic = Math.max(0, usuarios - 1);
  const pct   = descuento / 100;
  // Fórmula: citasMes = citas TOTALES del lead (no por usuario)
  // WA: citasMes × 1.33 (recordatorios + confirmaciones)
  // Factura y Firma: citasMes × 1
  const enviosWA       = Math.ceil(citasMes * 1.33);
  const enviosFactura  = citasMes;
  const enviosFirma    = citasMes;

  const planes  = {};
  const bolsas  = {};

  // FIX COT-3 (C-113): si viene plan específico, calcular solo ese
  const PLAN_MAP = [['S','esencial'],['M','pro'],['L','titanium']];
  const planFilter = params.plan ? params.plan.toLowerCase() : null;
  const planesToCalc = planFilter
    ? PLAN_MAP.filter(([, label]) => label === planFilter)
    : PLAN_MAP;
  if (planFilter && planesToCalc.length === 0) {
    console.warn(`[COTIZ-DEBUG] Plan "${params.plan}" no reconocido, calculando todos`);
  }
  const finalPlanList = planesToCalc.length > 0 ? planesToCalc : PLAN_MAP;

  for (const [key, label] of finalPlanList) {
    const baseMensual     = PRECIOS[moneda].planes[key];
    const precAdicMensual = getPrecioAdic(key, usuarios, moneda);
    // Multiplicar por meses según modalidad
    const base     = baseMensual * multiplicador;
    const precAdic = precAdicMensual * multiplicador;
    const subtotal = base + precAdic * nAdic;
    const desc     = Math.round(subtotal * pct);
    const neto     = subtotal - desc;
    const planData = { base, precAdic, subtotal, descuento: desc, neto, modalidad };

    // IVA México 16% — solo sobre plan (no módulos)
    if (moneda === 'MXN') {
      planData.ivaPromo    = Math.round(neto * 0.16 * 100) / 100;
      planData.ivaSinPromo = Math.round(subtotal * 0.16 * 100) / 100;
    }

    planes[label] = planData;
  }

  if (incluirWA)      bolsas.wa      = getBolsa('WA',      enviosWA,      moneda, bolsaWA);
  if (incluirFirma)   bolsas.firma   = getBolsa('firma',   enviosFirma,   moneda, bolsaFirma);
  if (incluirFactura) bolsas.factura = getBolsa('factura', enviosFactura, moneda, bolsaFactura);

  // Multiplicar bolsas por meses según modalidad
  for (const bKey of Object.keys(bolsas)) {
    bolsas[bKey].precio = bolsas[bKey].precio * multiplicador;
  }

  const PRECIO_RECETA_AR = 3; // USD por usuario/mes
  const recetaTotal = incluirRecetaAR ? (PRECIO_RECETA_AR * usuarios * multiplicador) : 0;
  const bolsasTotal = Object.values(bolsas).reduce((s, b) => s + b.precio, 0) + recetaTotal;
  for (const lbl of Object.keys(planes)) {
    const ivaPromo    = planes[lbl].ivaPromo    || 0;
    const ivaSinPromo = planes[lbl].ivaSinPromo || 0;
    planes[lbl].totalPromo    = planes[lbl].neto     + bolsasTotal + ivaPromo;
    planes[lbl].totalSinPromo = planes[lbl].subtotal + bolsasTotal + ivaSinPromo;
  }

  // FIX COT-3 (C-113): planLabels indica qué planes se calcularon
  const planLabels = Object.keys(planes);
  return { planes, bolsas, bolsasTotal, nAdic, totalUsuarios, usuariosBonus: usuariosBonus || 0, enviosWA, enviosFactura, enviosFirma, descuento, recetaAR: recetaTotal, moneda, modalidad, multiplicador, planLabels };
}

// ─────────────────────────────────────────────────────────────────────
// DATOS COMPARATIVA DE FUNCIONALIDADES
// ─────────────────────────────────────────────────────────────────────

const FEATURES = [
  { section: 'ATENCIÓN DE PACIENTES', items: [
    { name: 'Gestión de recursos',          S:'I', M:'I', L:'I' },
    { name: 'Agenda médica',                S:'I', M:'I', L:'I' },
    { name: 'Telemedicina',                 S:'I', M:'I', L:'I' },
    { name: 'Documentos personalizables',   S:'I', M:'I', L:'I' },
    { name: 'Recetas con Vademécum',        S:'I', M:'I', L:'I' },
    { name: 'Consentimientos informados',   S:'I', M:'I', L:'I' },
    { name: 'Ficha clínica electrónica',    S:'I', M:'I', L:'I' },
    { name: 'Agendamiento online',          S:'I', M:'I', L:'I' },
    { name: 'Ficha estética facial',        S:'A', M:'A', L:'I' },
    { name: 'Firma electrónica digital',    S:'A', M:'A', L:'A' },
    { name: 'Facturador electrónico',       S:'A', M:'A', L:'A' },
    { name: 'WhatsApp — Recordatorios',     S:'A', M:'A', L:'A' }
  ]},
  { section: 'GESTIÓN CLÍNICA', items: [
    { name: 'Inventario',                   S:'N', M:'I', L:'I' },
    { name: 'Pagos y Gastos',               S:'N', M:'I', L:'I' },
    { name: 'Remuneraciones',               S:'N', M:'I', L:'I' },
    { name: 'Laboratorios y exámenes',      S:'N', M:'N', L:'I' },
    { name: 'Convenios',                    S:'I', M:'I', L:'I' }
  ]},
  { section: 'CONTROL DE OPERACIONES', items: [
    { name: 'Tareas automáticas de citas',  S:'N', M:'N', L:'I' },
    { name: 'Reportes Excel',               S:'N', M:'I', L:'I' },
    { name: 'Flujo de caja automático',     S:'N', M:'I', L:'I' },
    { name: 'Gestión de sucursales',        S:'N', M:'I', L:'I' },
    { name: 'Integración con Siigo',        S:'N', M:'N', L:'I' },
    { name: 'Recaudación y Cajas',          S:'I', M:'I', L:'I' }
  ]},
  { section: 'FIDELIZACIÓN Y RETENCIÓN', items: [
    { name: 'Campañas de Agendamiento',     S:'N', M:'I', L:'I' },
    { name: 'Panel de desempeño',           S:'N', M:'I', L:'I' },
    { name: 'Email marketing y promociones',S:'N', M:'N', L:'I' },
    { name: 'Encuestas de satisfacción',    S:'N', M:'N', L:'I' },
    { name: 'Datáfono',                     S:'N', M:'N', L:'I' }
  ]}
];

function renderCell(v) {
  if (v === 'I') return '<td class="cell-yes"><span class="ck">&#10003;</span> Incluido</td>';
  if (v === 'N') return '<td class="cell-no"><span class="ds">&#8212;</span> No incluido</td>';
  return          '<td class="cell-add"><span class="pl">+</span> Adicional</td>';
}

// ─────────────────────────────────────────────────────────────────────
// LOGO BASE64
// ─────────────────────────────────────────────────────────────────────

function getLogoBase64() {
  // Buscar logo en múltiples rutas (services/ y raíz del proyecto)
  const candidates = [
    path.join(__dirname, 'Medilink_logo.png'),
    path.join(__dirname, '..', 'Medilink_logo.png'),
    path.resolve('/app/Medilink_logo.png'),
    path.resolve('/app/services/Medilink_logo.png'),
  ];
  for (const logoPath of candidates) {
    try {
      const buf = fs.readFileSync(logoPath);
      console.log(`[COTIZ-DEBUG] Logo encontrado en: ${logoPath} (${buf.length} bytes)`);
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch (_) { /* intentar siguiente */ }
  }
  console.error(`[COTIZ-DEBUG] Logo NO encontrado en ninguna ruta: ${candidates.join(', ')}`);
  return '';
}

// ─────────────────────────────────────────────────────────────────────
// HTML TEMPLATE
// ─────────────────────────────────────────────────────────────────────

// Normativas legales por país para el PDF
const NORMATIVAS = {
  COLOMBIA:            'Res. 256/2016 (calidad: eventos adversos, oportunidad, satisfacción), Res. 2275/2023 (HC electrónica interoperable, RIPS), Res. 3100/2019 (habilitación servicios de salud), Res. 1888/2024 (interoperabilidad), Ley 1581/2012 (habeas data)',
  CHILE:               'Ley 20.584 (derechos del paciente), Ley 19.628 (protección datos), DS 41/2012 (HC digitales), Ley 20.285 (transparencia)',
  MEXICO:              'NOM-024-SSA3-2012 (HC electrónicas), NOM-035-SSA3-2012 (Telemedicina), Ley Federal de Protección de Datos Personales',
  ARGENTINA:           'Ley 26.529 (derechos del paciente/HC), Ley 25.326 (protección datos), Res. 1-E/2017 (HC digital)',
  REPUBLICA_DOMINICANA:'Ley 42-01 (Salud), Ley 172-13 (protección datos), Res. DGH-00014/2021 (HC electrónicas)',
  ESPAÑA:              'Reglamento (UE) 2016/679 (RGPD), Ley Orgánica 3/2018 (LOPD-GDD), Ley 41/2002 (autonomía del paciente), RD 1277/2003 (centros sanitarios)',
  INTERNACIONAL:       'Normativa local vigente en privacidad de datos clínicos y Telemedicina'
};

// Símbolo de moneda para mostrar en el PDF
const SIMBOLO_MONEDA = { CLP: 'CLP $', COP: 'COP $', MXN: 'MXN $', USD: 'USD $', EUR: 'EUR €' };

function buildHTML(params) {
  const {
    nombre          = 'Lead',
    pais            = 'CHILE',
    moneda          = 'CLP',
    usuarios        = 1,
    citasMes        = 70,   // FIX COT-4a (C-113): consistente con prompt y calcularCotizacion
    incluirWA        = true,
    incluirFirma     = true,
    incluirFactura   = true,
    incluirRecetaAR  = false,
    modalidad: modalidadParam2 = 'mensual',
    ownerName        = 'Asesor Medilink',
    ownerEmail       = '',
    ownerPhone       = '',
    fecha           = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
  } = params;

  // España (EUR) → SOLO modalidad anual
  const modalidad = (moneda === 'EUR') ? 'anual' : modalidadParam2;

  // Vigencia y cupos dinámicos
  const promo = getPromoVigencia();
  const vigencia = `${promo.vigencia} — ${promo.cupos} cupos disponibles`;

  console.log(`[COTIZ-DEBUG] buildHTML iniciado para ${nombre}, moneda=${moneda}, modalidad=${modalidad}`);
  const logo  = getLogoBase64();
  console.log(`[COTIZ-DEBUG] Logo obtenido, llamando calcularCotizacion...`);
  const calc  = calcularCotizacion(params);
  console.log(`[COTIZ-DEBUG] calcularCotizacion completado`);
  console.log(`[COTIZ-DEBUG] calc.bolsas =`, calc.bolsas ? Object.keys(calc.bolsas) : 'undefined');
  const { planes, bolsas, nAdic, totalUsuarios, usuariosBonus, enviosWA, enviosFactura, enviosFirma, descuento, recetaAR, planLabels } = calc;

  // FIX COT-3/GRUPO 5 (C-113): columnas dinámicas según planLabels
  const PLAN_DISPLAY = { esencial: 'ESENCIAL', pro: 'PRO', titanium: 'TITANIUM' };
  const PLAN_KEY     = { esencial: 'S', pro: 'M', titanium: 'L' };
  const PLAN_TOKENS  = { esencial: 80, pro: 250, titanium: 400 };
  const nPlanes      = planLabels.length;
  const colWidth     = nPlanes === 1 ? '56%' : `${(56 / nPlanes).toFixed(1)}%`;
  const p     = PRECIOS[moneda];
  console.log(`[COTIZ-DEBUG] PRECIOS[${moneda}] =`, p ? 'OK' : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] Construyendo logoTag...`);

  const logoTag = logo
    ? `<img class="logo-img" src="${logo}" alt="Medilink">`
    : '<span class="logo-txt">medilink</span>';
  console.log(`[COTIZ-DEBUG] logoTag construido`);

  // ── Filas de bolsas ──────────────────────────────────────────────
  let bolsasRows = '';
  console.log(`[COTIZ-DEBUG] Iniciando bolsasRows, incluirWA=${incluirWA}, bolsas.wa=${bolsas.wa ? 'OK' : 'undefined'}`);

  if (incluirWA && bolsas.wa) {
    console.log(`[COTIZ-DEBUG] Entrando en sección WA bolsa...`);
    const b = bolsas.wa;
    console.log(`[COTIZ-DEBUG] b.wa object:`, JSON.stringify(b));
    console.log(`[COTIZ-DEBUG] b.tier=${b.tier}, b.limiteEnvios=${b.limiteEnvios}, b.precio=${b.precio}`);
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      console.log(`[COTIZ-DEBUG] limiteFormatted: ${limiteFormatted}`);
      const precioFormatted = fmt(b.precio, moneda);
      console.log(`[COTIZ-DEBUG] precioFormatted: ${precioFormatted}`);
      bolsasRows += `
      <tr class="row-even">
        <td class="td-desc">BOLSA WHATSAPP — RECORDATORIOS
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        ${planLabels.map(() => `<td class="td-price">${precioFormatted}</td>`).join('')}
      </tr>`;
      console.log(`[COTIZ-DEBUG] Sección WA bolsa completada exitosamente`);
    } catch(e) {
      console.error(`[COTIZ-ERROR-WA] Error en sección WA: ${e.message}`);
      console.error(`[COTIZ-ERROR-WA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirFirma && bolsas.firma) {
    const b = bolsas.firma;
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      const precioFormatted = fmt(b.precio, moneda);
      bolsasRows += `
      <tr class="row-odd">
        <td class="td-desc">BOLSA FIRMA ELECTRÓNICA
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        ${planLabels.map(() => `<td class="td-price">${precioFormatted}</td>`).join('')}
      </tr>`;
    } catch(e) {
      console.error(`[COTIZ-ERROR-FIRMA] Error en sección Firma: ${e.message}`);
      console.error(`[COTIZ-ERROR-FIRMA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirFactura && bolsas.factura) {
    const b = bolsas.factura;
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      const precioFormatted = fmt(b.precio, moneda);
      bolsasRows += `
      <tr class="row-even">
        <td class="td-desc">FACTURADOR ELECTRÓNICO
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        ${planLabels.map(() => `<td class="td-price">${precioFormatted}</td>`).join('')}
      </tr>`;
    } catch(e) {
      console.error(`[COTIZ-ERROR-FACTURA] Error en sección Factura: ${e.message}`);
      console.error(`[COTIZ-ERROR-FACTURA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirRecetaAR) {
    bolsasRows += `
      <tr class="row-odd">
        <td class="td-desc">RECETA DIGITAL AR
          <span class="td-sub">Módulo exclusivo Argentina — prescripción médica digital (${fmt(3, 'USD')}/usuario × ${usuarios})</span></td>
        ${planLabels.map(() => `<td class="td-price">${fmt(recetaAR, moneda)}</td>`).join('')}
      </tr>`;
  }

  // ── Tabla de rangos de bolsas ────────────────────────────────────
  console.log(`[COTIZ-DEBUG] p.rangos =`, p.rangos ? JSON.stringify(p.rangos) : 'UNDEFINED');
  const rWA  = p.rangos.WA;
  const rFac = p.rangos.factura;
  const rFir = p.rangos.firma;
  console.log(`[COTIZ-DEBUG] rWA =`, rWA ? JSON.stringify(rWA) : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] rFac =`, rFac ? JSON.stringify(rFac) : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] rFir =`, rFir ? JSON.stringify(rFir) : 'UNDEFINED');

  let bolsasRangos = '';
  try {
    if (incluirWA)      bolsasRangos += `<tr><td>WhatsApp — Recordatorios</td><td><b>${fmtNum(enviosWA)}</b></td><td>${rWA.S}</td><td>${rWA.M}</td><td>${fmtNum(rWA.L)}</td><td>${fmtNum(rWA.XL)}</td></tr>`;
    if (incluirFactura) bolsasRangos += `<tr><td>Facturación Electrónica</td><td><b>${enviosFactura}</b></td><td>${rFac.S}</td><td>${rFac.M}</td><td>${rFac.L}</td><td>${rFac.XL}</td></tr>`;
    if (incluirFirma)   bolsasRangos += `<tr><td>Firma Electrónica</td><td><b>${enviosFirma}</b></td><td>${rFir.S}</td><td>${rFir.M}</td><td>${rFir.L}</td><td>${rFir.XL}</td></tr>`;
    console.log(`[COTIZ-DEBUG] bolsasRangos construida exitosamente`);
  } catch(e) {
    console.error(`[COTIZ-ERROR-RANGOS] Error en tabla de rangos: ${e.message}`);
    console.error(`[COTIZ-ERROR-RANGOS] Stack: ${e.stack}`);
    throw e;
  }

  let bolsasAsignadas = '';
  // FIX COT-4b (C-113): label ×1.33/usuario → ×1.33 (multiplicador es sobre citas totales, no por usuario)
  if (incluirWA && bolsas.wa)         bolsasAsignadas += `<tr><td>WhatsApp — Recordatorios</td><td>&#215;1.33</td><td>${fmtNum(citasMes)}</td><td>${fmtNum(enviosWA)} envíos</td><td><b>${bolsas.wa.tier}: hasta ${fmtNum(bolsas.wa.limiteEnvios)} envíos</b></td></tr>`;
  if (incluirFactura && bolsas.factura) bolsasAsignadas += `<tr><td>Facturación Electrónica</td><td>&#215;1</td><td>${fmtNum(citasMes)}</td><td>${enviosFactura} envíos</td><td><b>${bolsas.factura.tier}: hasta ${fmtNum(bolsas.factura.limiteEnvios)} envíos</b></td></tr>`;
  if (incluirFirma && bolsas.firma)   bolsasAsignadas += `<tr><td>Firma Electrónica</td><td>&#215;1</td><td>${fmtNum(citasMes)}</td><td>${enviosFirma} envíos</td><td><b>${bolsas.firma.tier}: hasta ${fmtNum(bolsas.firma.limiteEnvios)} envíos</b></td></tr>`;

  // ── Comparativa ──────────────────────────────────────────────────
  // Build dynamic features: add Argentina-specific items if needed
  const featuresForPais = FEATURES.map(sec => {
    if (sec.section === 'ATENCIÓN DE PACIENTES' && pais === 'ARGENTINA') {
      return {
        ...sec,
        items: [
          ...sec.items.filter(it => it.name !== 'Facturador electrónico'),
          { name: 'Receta Digital AR (excl. Argentina)', S:'A', M:'A', L:'A' }
        ]
      };
    }
    if (sec.section === 'ATENCIÓN DE PACIENTES' && pais !== 'ARGENTINA') {
      return {
        ...sec,
        items: sec.items.filter(it => it.name !== 'Receta Digital AR (excl. Argentina)')
      };
    }
    return sec;
  });

  // FIX COT-3/GRUPO 5 (C-113): comparativa dinámica según planLabels
  let featRows = '';
  featuresForPais.forEach((sec) => {
    featRows += `<tr class="row-sec"><td colspan="${1 + nPlanes}">${sec.section}</td></tr>`;
    sec.items.forEach((it, i) => {
      const cells = planLabels.map(lbl => renderCell(it[PLAN_KEY[lbl]])).join('');
      featRows += `<tr class="${i % 2 === 0 ? 'row-odd' : 'row-even'}"><td class="td-fn">${it.name}</td>${cells}</tr>`;
    });
  });

  const usuariosStr = `${usuarios} ${usuarios === 1 ? 'usuario' : 'usuarios'}`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
@page{size:A4;margin:8mm 10mm}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:190mm;background:#fff}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;font-size:11px;color:#2c2c2c}

/* ── HEADER ── */
.hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 24px 10px;border-top:4px solid #00AEEF;border-bottom:1px solid #d6f0fa;background:#fff}
.logo-img{height:40px;width:auto}
.logo-txt{font-size:22px;font-weight:900;color:#00AEEF;letter-spacing:.5px}
.hdr-r{text-align:right}
.hdr-title{font-size:32px;font-weight:900;letter-spacing:4px;color:#1A6B8A;line-height:1}
.hdr-sub{font-size:11px;font-weight:600;color:#007BA5;margin-top:3px;letter-spacing:.8px}
.hdr-date{font-size:9px;color:#9E9E9E;margin-top:2px}

/* ── META BAR ── */
.meta{background:#007BA5;display:flex}
.mi{flex:1;padding:7px 14px;border-right:1px solid rgba(255,255,255,.15)}
.mi:last-child{border-right:none}
.ml{font-size:7.5px;font-weight:600;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1.3px;margin-bottom:2px}
.mv{font-size:10.5px;font-weight:700;color:#fff}

/* ── SECTION ── */
.sec{padding:6px 24px}
.sec-t{font-size:10px;font-weight:700;color:#007BA5;text-transform:uppercase;letter-spacing:.8px;border-left:4px solid #00AEEF;padding:2px 0 2px 8px;margin-bottom:7px}

/* ── PRICING TABLE ── */
.pt{width:100%;border-collapse:collapse}
.pt thead th{background:#1A6B8A;color:#fff;padding:8px 11px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
.pt thead th:first-child{text-align:left;font-size:9px;letter-spacing:.4px}
.pt thead th:not(:first-child){text-align:center;border-left:1px solid rgba(255,255,255,.1)}
.row-odd td{background:#F5FCFF}
.row-even td{background:#DCF2FB}
.pt tbody td{padding:5px 11px;border-bottom:1px solid rgba(0,174,239,.1);vertical-align:middle}
.td-desc{font-size:9.5px;color:#2c2c2c;font-weight:500}
.td-sub{display:block;font-size:8px;color:#9E9E9E;font-weight:400;margin-top:1px}
.td-price{text-align:right;font-weight:700;font-size:10.5px;color:#1A6B8A}
.row-disc td{background:#C5EAF5!important;font-weight:700!important;border-bottom:1px solid rgba(0,144,195,.2)!important}
.row-disc .td-desc{color:#0090C3;font-style:italic}
.row-disc .td-price{color:#0090C3!important}
.bdg{display:inline-block;margin-left:6px;background:#0090C3;color:#fff;font-size:7.5px;font-weight:800;padding:1px 6px;border-radius:10px;vertical-align:middle;font-style:normal;letter-spacing:.4px}
.row-tp td{background:#1A6B8A!important;color:#fff!important;font-weight:800!important;font-size:12px!important;border-top:2px solid #00AEEF!important;border-bottom:none!important;padding:11px 13px!important}
.row-tn td{background:#007BA5!important;color:rgba(255,255,255,.82)!important;font-weight:600!important;font-size:10.5px!important;border-bottom:none!important}

/* ── BOLSAS CALC TABLE ── */
.ct{width:100%;border-collapse:collapse;margin-bottom:6px}
.ct th{background:#0090C3;color:#fff;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;padding:4px 8px;text-align:left}
.ct td{padding:4px 8px;font-size:9px;border-bottom:1px solid #DCF2FB;color:#2c2c2c}
.ct tr:nth-child(even) td{background:#F5FCFF}

/* ── QUE INCLUYE ── */
.inc-list{list-style:none;columns:2;column-gap:16px}
.inc-list li{padding:3px 0;font-size:9px;color:#2c2c2c;border-bottom:1px solid #DCF2FB;display:flex;align-items:flex-start;gap:4px;break-inside:avoid}
.ckn{color:#0090C3;font-weight:900;font-size:11px;flex-shrink:0;line-height:1.3}

/* ── TOKENS TABLE ── */
.tt{width:100%;border-collapse:collapse}
.tt thead th{background:#1A6B8A;color:#fff;font-size:9.5px;font-weight:700;letter-spacing:1px;padding:7px 11px;text-align:center}
.tt thead th:first-child{text-align:left}
.tt tbody td{padding:5px 11px;border-bottom:1px solid #DCF2FB;font-size:9.5px;text-align:center;color:#2c2c2c}
.tt tbody td:first-child{text-align:left;font-weight:500}
.tt tbody tr:nth-child(even) td{background:#DCF2FB}
.pill{display:inline-block;background:#00AEEF;color:#fff;font-size:10px;font-weight:800;padding:2px 11px;border-radius:20px}
.inc-b{color:#0090C3;font-weight:700}

/* ── FOOTER ── */
.ftr{padding:6px 24px 6px;border-top:2px solid #00AEEF;display:flex;align-items:center;justify-content:space-between;margin-top:2px;page-break-inside:avoid}
.ftr-logo img{height:26px;width:auto;opacity:.75}
.ftr-logo .logo-txt{font-size:16px;font-weight:900;color:#00AEEF}
.ftr-cnt{text-align:center;font-size:9px;color:#9E9E9E}
.ftr-cnt strong{color:#007BA5;font-weight:700;font-size:10px}
.ftr-note{font-size:8px;color:#BDBDBD;text-align:right;max-width:175px;line-height:1.4}

/* ── NOTE ── */
.note{font-size:8.5px;color:#9E9E9E;margin-top:4px;line-height:1.4;font-style:italic}

/* ── Evitar página vacía entre contenido y footer ── */
.sec:last-of-type{page-break-after:avoid}

/* ── PAGE 2 ── */
.pg2{page-break-before:always}
.cmp-hdr{padding:10px 24px 8px;border-top:4px solid #00AEEF}
.cmp-title{font-size:13px;font-weight:900;color:#1A6B8A;text-align:center;text-transform:uppercase;letter-spacing:2px;margin-bottom:2px}
.cmp-sub{font-size:8px;color:#9E9E9E;text-align:center}

.cmp{width:100%;border-collapse:collapse}
.cmp thead th{background:#1A6B8A;color:#fff;font-size:10px;font-weight:700;letter-spacing:1.2px;padding:8px 11px;text-align:center}
.cmp thead th:first-child{text-align:left;width:46%}
.row-sec td{background:#0090C3!important;color:#fff!important;font-size:9.5px!important;font-weight:800!important;text-transform:uppercase;letter-spacing:.8px;padding:6px 11px!important}
.cmp tbody .row-odd td{background:#F5FCFF}
.cmp tbody .row-even td{background:#fff}
.cmp tbody td{padding:5px 11px;border-bottom:1px solid rgba(0,174,239,.08);font-size:9.5px;text-align:center}
.cmp tbody td:first-child{text-align:left}
.td-fn{font-weight:500;color:#2c2c2c}
.cell-yes{background:#D6F0FA!important;color:#007BA5;font-weight:600}
.cell-no{color:#9E9E9E;font-weight:400}
.cell-add{background:#E8F5FD!important;color:#0090C3;font-weight:600}
.ck{font-weight:900;color:#00AEEF;margin-right:3px}
.ds{font-weight:400;color:#BDBDBD;margin-right:3px}
.pl{font-weight:900;color:#0090C3;margin-right:3px}
.cmp-fn{padding:10px 28px;font-size:8px;color:#9E9E9E;font-style:italic;text-align:center;border-top:1px solid #DCF2FB}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<!-- ═══════ PÁGINA 1 ═══════ -->

<div class="hdr">
  <div>${logoTag}</div>
  <div class="hdr-r">
    <div class="hdr-title">COTIZACIÓN</div>
    <div class="hdr-sub">MEDILINK SOFTWARE</div>
    <div class="hdr-date">Emitido: ${fecha}</div>
  </div>
</div>

<div class="meta">
  <div class="mi"><div class="ml">País / Moneda</div><div class="mv">${pais.replace('_',' ')} · ${SIMBOLO_MONEDA[moneda] || moneda}</div></div>
  <div class="mi"><div class="ml">Usuarios</div><div class="mv">${usuariosStr}</div></div>
  <div class="mi"><div class="ml">Dirigido a</div><div class="mv">${nombre}</div></div>
  <div class="mi"><div class="ml">Vigencia</div><div class="mv">${vigencia}</div></div>
</div>

<div class="sec">
  <table class="pt">
    <thead>
      <tr>
        <th style="width:44%">DETALLES / PLANES (${modalidad.toUpperCase()})</th>
        ${planLabels.map(lbl => `<th style="width:${colWidth}">${PLAN_DISPLAY[lbl]}</th>`).join('\n        ')}
      </tr>
    </thead>
    <tbody>
      <tr class="row-odd">
        <td class="td-desc">SOFTWARE PLAN BASE (Licencia 1er Usuario)</td>
        ${planLabels.map(lbl => `<td class="td-price">${fmt(planes[lbl].base, moneda)}</td>`).join('\n        ')}
      </tr>
      ${nAdic > 0 ? `
      <tr class="row-even">
        <td class="td-desc">USUARIOS ADICIONALES &#215; ${nAdic}</td>
        ${planLabels.map(lbl => `<td class="td-price">${fmt(planes[lbl].precAdic * nAdic, moneda)}</td>`).join('\n        ')}
      </tr>` : ''}
      ${usuariosBonus > 0 ? `
      <tr class="row-even" style="background:#e8f5e9">
        <td class="td-desc">🎁 USUARIOS MÉDICOS EXTRAS &#215; ${usuariosBonus} <span class="bdg" style="background:#4caf50;color:#fff">GRATIS</span>
          <span class="td-sub">Total: ${totalUsuarios} usuarios médicos (${params.usuarios} pagos + ${usuariosBonus} extras)</span></td>
        ${planLabels.map(() => `<td class="td-price" style="color:#4caf50;font-weight:700">$0</td>`).join('\n        ')}
      </tr>` : ''}
      <tr class="row-disc">
        <td class="td-desc">DESCUENTO ${descuento < (({'mensual':30,'semestral':15,'anual':20})[modalidad]||30) ? 'ESPECIAL' : 'PROMO'} ${modalidad.toUpperCase()} (Ahorro del &#8722;${descuento}%) <span class="bdg">&#8722;${descuento}%</span></td>
        ${planLabels.map(lbl => `<td class="td-price">&#8722; ${fmt(planes[lbl].descuento, moneda)}</td>`).join('\n        ')}
      </tr>
      ${moneda === 'MXN' ? `
      <tr class="row-odd">
        <td class="td-desc">IVA 16% (CON PROMO)
          <span class="td-sub">Sobre el neto del plan con descuento</span></td>
        ${planLabels.map(lbl => `<td class="td-price">${fmt(planes[lbl].ivaPromo, moneda)}</td>`).join('\n        ')}
      </tr>` : ''}
      ${bolsasRows}
      <tr class="row-tp">
        <td>TOTAL MES 1 AL 3 (CON PROMO)${moneda === 'MXN' ? ' <span style="font-size:8px;font-weight:400">IVA incluido</span>' : ''}</td>
        ${planLabels.map(lbl => `<td style="text-align:right">${fmt(planes[lbl].totalPromo, moneda)}</td>`).join('\n        ')}
      </tr>
      ${moneda === 'MXN' ? `
      <tr class="row-odd">
        <td class="td-desc">IVA 16% (SIN PROMO)
          <span class="td-sub">Sobre el subtotal sin descuento — aplica desde mes 4</span></td>
        ${planLabels.map(lbl => `<td class="td-price">${fmt(planes[lbl].ivaSinPromo, moneda)}</td>`).join('\n        ')}
      </tr>` : ''}
      <tr class="row-tn">
        <td>TOTAL DESDE MES 4 (Sin Promo)${moneda === 'MXN' ? ' <span style="font-size:8px;font-weight:400">IVA incluido</span>' : ''}</td>
        ${planLabels.map(lbl => `<td style="text-align:right">${fmt(planes[lbl].totalSinPromo, moneda)}</td>`).join('\n        ')}
      </tr>
    </tbody>
  </table>
  <p class="note">Nota: Las bolsas de módulos son opcionales. Puede aumentarlas, disminuirlas o eliminarlas según su volumen real. Los precios de la promoción base permanecen vigentes independientemente.</p>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Cómo se calculan las bolsas</div>
  <p style="font-size:9px;color:#555;margin-bottom:8px;line-height:1.5">Las bolsas propuestas son según la cantidad de usuarios (${usuarios} profesional${usuarios > 1 ? 'es' : ''}). Cada módulo tiene su propia bolsa asignada independientemente:</p>
  <table class="ct">
    <thead><tr><th style="width:32%">Módulo</th><th>Envíos requeridos</th><th>S (hasta...)</th><th>M (hasta...)</th><th>L (hasta...)</th><th>XL (hasta...)</th></tr></thead>
    <tbody>${bolsasRangos}</tbody>
  </table>
  <table class="ct">
    <thead><tr><th style="width:32%">Módulo</th><th>×/Usuario</th><th>Usuarios</th><th>Envíos requeridos</th><th>Bolsa asignada</th></tr></thead>
    <tbody>${bolsasAsignadas}</tbody>
  </table>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Qué incluye ${nPlanes === 1 ? `el plan ${PLAN_DISPLAY[planLabels[0]]}` : 'su plan'}</div>
  <ul class="inc-list">
    <li><span class="ckn">&#10003;</span> Historias Clínicas 100% personalizables por especialidad.</li>
    <li><span class="ckn">&#10003;</span> Agenda Online + link de auto-agendamiento para pacientes.</li>
    <li><span class="ckn">&#10003;</span> ${usuariosStr} médico${usuarios > 1 ? 's' : ''} + usuarios administrativos ilimitados, sin costo adicional.</li>
    <li><span class="ckn">&#10003;</span> Normativa: ${NORMATIVAS[pais.toUpperCase().replace(/ /g,'_')] || NORMATIVAS[pais.toUpperCase()] || NORMATIVAS['INTERNACIONAL']}</li>
    <li><span class="ckn">&#10003;</span> Contact Center IA: 2 meses gratis (requiere WhatsApp Business con tarjeta META).</li>
    <li><span class="ckn">&#10003;</span> Telemedicina: videoconsultas ilimitadas sin costo adicional.</li>
    <li><span class="ckn">&#10003;</span> Certificado de validez legal firmado por Ingeniero en Sistemas.</li>
    <li><span class="ckn">&#10003;</span> Certificación ISO 27001 — Protección total de su información clínica.</li>
    <li><span class="ckn">&#10003;</span> Acompañamiento con Clases y Capacitaciones Virtuales + Soporte.</li>
  </ul>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Tokens de IA incluidos${nPlanes > 1 ? ' por plan' : ''}</div>
  <table class="tt">
    <thead><tr><th style="width:44%">CAPACIDAD / FUNCIÓN</th>${planLabels.map(lbl => `<th>${PLAN_DISPLAY[lbl]}</th>`).join('')}</tr></thead>
    <tbody>
      <tr><td>Tokens Mensuales Incluidos</td>${planLabels.map(lbl => `<td><span class="pill">${PLAN_TOKENS[lbl]}</span></td>`).join('')}</tr>
      <tr><td>Dictado por Voz con IA</td>${planLabels.map(() => `<td><span class="inc-b">&#10003; Incluido</span></td>`).join('')}</tr>
      <tr><td>Resumen Clínico Automático</td>${planLabels.map(() => `<td><span class="inc-b">&#10003; Incluido</span></td>`).join('')}</tr>
      <tr><td>Contralor IA</td>${planLabels.map(() => `<td><span class="inc-b">&#10003; Incluido</span></td>`).join('')}</tr>
    </tbody>
  </table>
  <p class="note">Nota: La diferencia entre planes es la cantidad de tokens disponibles para operar estas funciones. A mayor plan, más operaciones simultáneas y avanzadas.</p>
</div>

<div class="ftr">
  <div class="ftr-logo">${logo ? `<img src="${logo}" alt="Medilink">` : '<span class="logo-txt">medilink</span>'}</div>
  <div class="ftr-cnt"><strong>Asesor: ${ownerName}</strong>${ownerEmail ? `<br>${ownerEmail}` : ''}${ownerPhone ? ` &nbsp;|&nbsp; WhatsApp: ${ownerPhone}` : ''}</div>
  <div class="ftr-note">Documento confidencial. Cotización válida hasta: ${vigencia.split('—')[0].trim()}.</div>
</div>


<!-- ═══════ PÁGINA 2 ═══════ -->
<div class="pg2">
  <div class="cmp-hdr">
    <div class="cmp-title">${nPlanes === 1 ? `Funcionalidades del plan ${PLAN_DISPLAY[planLabels[0]]}` : 'Compara las funcionalidades de todos los planes'}</div>
    <div class="cmp-sub">Todas las funcionalidades anteriores están incluidas en los tres planes. Los módulos marcados como "Adicional" tienen un costo extra (bolsa de envíos). Medilink se reserva el derecho de actualizar su catálogo de funcionalidades.</div>
  </div>
  <div style="padding:0 24px 10px">
    <table class="cmp">
      <thead><tr><th>FUNCIONALIDAD</th>${planLabels.map(lbl => `<th>${PLAN_DISPLAY[lbl]}</th>`).join('')}</tr></thead>
      <tbody>${featRows}</tbody>
    </table>
  </div>
  <div class="ftr" style="margin-top:0">
    <div class="ftr-logo">${logo ? `<img src="${logo}" alt="Medilink">` : '<span class="logo-txt">medilink</span>'}</div>
    <div class="ftr-cnt"><strong>Asesor: ${ownerName}</strong>${ownerEmail ? `<br>${ownerEmail}` : ''}${ownerPhone ? ` &nbsp;|&nbsp; WhatsApp: ${ownerPhone}` : ''}</div>
    <div class="ftr-note">Medilink se reserva el derecho de actualizar su catálogo de funcionalidades.</div>
  </div>
</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// GENERAR PDF
// ─────────────────────────────────────────────────────────────────────

async function generarPDF(params) {
  console.log(`[PDF-INIT] generarPDF iniciado, puppeteer available: ${!!puppeteer}`);
  if (!puppeteer) throw new Error('puppeteer no instalado — PDF no disponible');
  let browser;
  try {
    console.log(`[PDF-INIT] Llamando buildHTML...`);
    const html = buildHTML(params);
    console.log(`[PDF-INIT] buildHTML completado, html length: ${html.length}`);
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    console.log(`[PDF-INIT] setContent iniciado...`);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[PDF-INIT] setContent completado, generando PDF...`);
    const pdfResult = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: 30000
    });
    if (!pdfResult) {
      throw new Error('page.pdf() retornó null/undefined');
    }
    const buffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
    console.log(`[PDF-INIT] PDF generado exitosamente, size: ${buffer.length} bytes`);
    return buffer;
  } catch (e) {
    console.error(`[PDF-INIT] Error generando PDF:`, e.message);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// ENVIAR POR WHATSAPP
// ─────────────────────────────────────────────────────────────────────

async function enviarCotizacionWA(sendFn, phone, params, isSelfChat = false) {
  // Nombre del lead: usar nombre si existe, si no "Cotizacion_Especial"
  const phoneBase    = phone.replace(/[@\w.]+$/, '').replace('@', '') || phone;
  // Extraer teléfono real (sin LID) — para tracking en nombre del archivo
  const phoneTracking = phoneBase.replace(/[^0-9]/g, '');
  const nombreMostrar = (params.nombre && params.nombre !== 'Cliente' && params.nombre !== 'Lead')
    ? params.nombre
    : 'Cotizacion_Especial';
  // Para el nombre del archivo: sin acentos, sin caracteres especiales, con teléfono como tracking
  const nombreLimpio = nombreMostrar
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // Quitar acentos
    .replace(/[^a-zA-Z0-9\s]/g, '')                     // Solo alfanuméricos y espacios
    .replace(/\s+/g, '_')                               // Espacios a guiones bajos
    .replace(/_+/g, '_')                                // No duplicar guiones bajos
    .replace(/^_|_$/g, '');                             // No empezar/terminar con _

  const modalidad    = (params.moneda === 'EUR') ? 'anual' : (params.modalidad || 'mensual');

  // Caption del documento — breve, sin texto hardcodeado de promo ni demo
  // MIIA ya se encarga de comunicar promos y demos con sentido común según el contexto
  // FIX COT-2 (C-113): caption vacío — no exponer metadata de sistema al lead
  const caption = '';

  // Generar el PDF
  const buffer = await generarPDF(params);
  console.log(`[COTIZ] Enviando PDF a ${phone}, isSelfChat=${isSelfChat}, buffer=${buffer.length} bytes`);

  // Delegar envío a safeSendMessage (maneja conversión @lid para self-chat correctamente)
  await sendFn(phone, {
    document: buffer,
    mimetype: 'application/pdf',
    fileName: `Cotizacion_Medilink_${nombreLimpio}_${phoneTracking}.pdf`,
    caption
  }, { isSelfChat });
}

// ─────────────────────────────────────────────────────────────────────
module.exports = { calcularCotizacion, generarPDF, enviarCotizacionWA, buildHTML, PRECIOS, fmt, getPromoVigencia };
