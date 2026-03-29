'use strict';

/**
 * ESTADÍSTICAS MIIA — Seguimiento de pipeline de ventas y conversiones
 * Guarda en v2/data/estadisticas.json
 */

const fs   = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data', 'estadisticas.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return { conversiones: [], pendientes: [] };
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return { conversiones: [], pendientes: [] };
  }
}

function save(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[STATS] Error guardando estadísticas:', e.message);
  }
}

/**
 * Registrar un lead que completó el formulario de 4 puntos (pendiente de link)
 */
function registrarInteresado(datos) {
  const stats = load();
  // Evitar duplicados
  if (!stats.pendientes.find(p => p.phone === datos.phone)) {
    stats.pendientes.push({
      ...datos,
      fecha: new Date().toLocaleDateString('es-ES'),
      estado: 'pendiente_link'
    });
    save(stats);
    console.log(`[STATS] Interesado registrado: ${datos.nombre || datos.phone}`);
  }
}

/**
 * Registrar conversión Lead → Cliente (mover de pendientes a conversiones)
 */
function registrarCliente(phone, nombre, plan, usuarios, pais) {
  const stats = load();
  const idx = stats.pendientes.findIndex(p => p.phone === phone);
  const base = idx >= 0 ? stats.pendientes.splice(idx, 1)[0] : {};
  stats.conversiones.push({
    ...base,
    phone,
    nombre: nombre || base.nombre || phone.split('@')[0],
    plan:     plan     || base.plan     || null,
    usuarios: usuarios || base.usuarios || null,
    pais:     pais     || base.pais     || null,
    fecha: new Date().toLocaleDateString('es-ES'),
    estado: 'cliente'
  });
  save(stats);
  console.log(`[STATS] Cliente registrado: ${nombre || phone}`);
}

/**
 * Retorna resumen completo
 */
function getResumen() {
  return load();
}

module.exports = { registrarInteresado, registrarCliente, getResumen };
