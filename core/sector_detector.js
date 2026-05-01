'use strict';

/**
 * MIIA â€” Sector Detector (T155)
 * Detecta automaticamente el sector del negocio desde descripcion libre.
 */

const SECTOR_KEYWORDS = Object.freeze({
  retail: ['tienda','ropa','zapatos','moda','boutique','indumentaria','accesorios','joyeria','relojeria'],
  food: ['restaurante','comida','pizza','hamburguesa','panaderia','cafe','cafeteria','helados','sushi','cocina','gastronomia','delivery','menu'],
  health: ['clinica','medico','doctor','dentista','farmacia','salud','nutricionista','psicologo','terapia','hospital','consultorio'],
  beauty: ['salon','peluqueria','estetica','barberia','spa','manicure','pedicure','belleza','cosmetica','maquillaje'],
  fitness: ['gym','gimnasio','crossfit','yoga','pilates','entrenamiento','fitness','personal trainer','deporte','natacion'],
  tech: ['software','tecnologia','programacion','app','desarrollo','sistemas','informatica','computadoras','redes','startup'],
  education: ['escuela','colegio','academia','clases','tutoria','cursos','educacion','capacitacion','universidad','idiomas'],
  real_estate: ['inmobiliaria','propiedades','arriendos','alquiler','venta inmuebles','casas','apartamentos','bienes raices'],
  auto: ['taller','mecanico','autos','carros','motos','repuestos','autopartes','concesionario','vehiculos'],
  services: ['consultoria','asesoria','legal','abogado','contador','contabilidad','marketing','publicidad','diseÃ±o'],
  construction: ['construccion','arquitectura','plomero','electricista','albanil','obra','reformas','decoracion','pintura'],
  hospitality: ['hotel','hostal','airbnb','alojamiento','turismo','viajes','agencia','tours'],
});

const SECTOR_LABELS = Object.freeze({
  retail: 'Tienda / Comercio',
  food: 'Restaurante / Gastronomia',
  health: 'Salud / Medicina',
  beauty: 'Belleza / Estetica',
  fitness: 'Fitness / Deporte',
  tech: 'Tecnologia / Software',
  education: 'Educacion / Formacion',
  real_estate: 'Inmobiliaria',
  auto: 'Automotriz / Mecanica',
  services: 'Servicios Profesionales',
  construction: 'Construccion / Reformas',
  hospitality: 'Hoteleria / Turismo',
});

/**
 * Detecta el sector del negocio desde texto libre.
 * @param {string} text - descripcion del negocio
 * @returns {{ sector, label, confidence, scores }}
 */
function detectSector(text) {
  if (!text || typeof text !== 'string') throw new Error('text requerido');

  const lower = text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  
  const scores = {};
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += 1;
    }
    if (score > 0) scores[sector] = score;
  }

  if (Object.keys(scores).length === 0) {
    return { sector: 'other', label: 'Otro', confidence: 0, scores: {} };
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topSector = sorted[0][0];
  const topScore = sorted[0][1];
  const totalScore = sorted.reduce((sum, [, s]) => sum + s, 0);
  const confidence = Math.min(topScore / Math.max(totalScore, 1), 1);

  return {
    sector: topSector,
    label: SECTOR_LABELS[topSector] || topSector,
    confidence: Math.round(confidence * 100) / 100,
    scores: Object.fromEntries(sorted),
  };
}

/**
 * Retorna todos los sectores disponibles.
 */
function listSectors() {
  return Object.entries(SECTOR_LABELS).map(([sector, label]) => ({ sector, label }));
}

/**
 * Verifica si un sector es valido.
 */
function isValidSector(sector) {
  return sector === 'other' || sector in SECTOR_LABELS;
}

module.exports = {
  detectSector, listSectors, isValidSector,
  SECTOR_KEYWORDS, SECTOR_LABELS,
};
