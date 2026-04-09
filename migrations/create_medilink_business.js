#!/usr/bin/env node
/**
 * Script one-time: Crear negocio MEDILINK en cuenta de mariano.destefano@gmail.com
 *
 * Ejecutar: node migrations/create_medilink_business.js [--dry-run]
 *
 * Crea:
 * 1. Negocio "Medilink" con todos los datos
 * 2. Cerebro del negocio con toda la info de Medilink
 * 3. Contact rules (keywords de leads y clientes)
 * 4. Grupo "Equipo Medilink" (vacío — Mariano agregará los integrantes después)
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Inicializar Firebase (misma lógica que server.js)
if (!admin.apps.length) {
  let credential = null;
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    pk = pk.replace(/\\n/g, '\n');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk
    });
  } else {
    console.error('❌ Faltan variables de Firebase (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
    console.log('   Asegurate de tener el .env correctamente configurado.');
    process.exit(1);
  }
  admin.initializeApp({ credential });
}
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_EMAIL = 'mariano.destefano@gmail.com';

// ═══════════════════════════════════════
// DATOS DE MEDILINK (lo que sabemos)
// ═══════════════════════════════════════

const MEDILINK_BUSINESS = {
  name: 'Medilink',
  email: 'mariano.destefano@gmail.com',
  address: 'Colombia',
  website: 'https://www.softwaremedilink.com',
  demoLink: 'https://meetings.hubspot.com/marianodestefano/demomedilink',
  description: `Medilink es un software de gestión integral para clínicas, consultorios médicos y centros de salud. Permite gestionar citas, historias clínicas electrónicas, facturación, inventario de medicamentos, reportes y más. Es una solución cloud (SaaS) que se adapta a clínicas de cualquier tamaño, desde consultorios individuales hasta redes de clínicas con múltiples sedes. Diseñado para el mercado latinoamericano con soporte para normativas de salud locales. Interfaz intuitiva, soporte en español, y precio accesible comparado con competidores internacionales.`,
  whatsapp_number: '573163937365',
  ownerRole: 'CEO / Co-Founder',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const MEDILINK_CEREBRO = `# CEREBRO DE MEDILINK — Todo lo que MIIA necesita saber

## ¿Qué es Medilink?
Medilink es un software de gestión integral para clínicas y centros de salud. Es SaaS (Software as a Service) — 100% en la nube, sin instalación. Se accede desde cualquier navegador o dispositivo.

## ¿Qué resuelve?
- Gestión de citas y agenda médica
- Historias clínicas electrónicas (HCE)
- Facturación y cobros
- Inventario de medicamentos e insumos
- Reportes y estadísticas
- Gestión de múltiples sedes
- Portal de pacientes
- Telemedicina (videollamadas integradas)
- Recordatorios automáticos de citas por WhatsApp/SMS/Email

## ¿Para quién es?
- Consultorios médicos individuales
- Clínicas con múltiples especialidades
- Centros de salud
- Redes de clínicas (multi-sede)
- Cualquier profesional de la salud que necesite digitalizar su operación

## Ventajas competitivas
- 100% en español, diseñado para Latinoamérica
- Cumple normativas de salud locales (Colombia, México, Argentina, Chile, etc.)
- Precio accesible vs competidores internacionales
- Soporte en español 24/7
- Implementación rápida (semanas, no meses)
- Sin contratos largos — pago mensual
- Interfaz intuitiva — mínima curva de aprendizaje
- API abierta para integraciones

## Datos del equipo
- CEO/Co-Founder: Mariano De Stefano
- Sede: Colombia
- Equipo distribuido en Latinoamérica

## Para agendar demo
Link de demo: https://meetings.hubspot.com/marianodestefano/demomedilink
La demo es gratuita, sin compromiso, dura aproximadamente 30 minutos. Se muestra el sistema en vivo con datos de ejemplo.

## Tono de MIIA para Medilink
- Profesional pero cercano
- Conocimiento técnico del sector salud
- Énfasis en resolver problemas reales del médico/clínica
- No ser agresivo en ventas — el producto habla por sí solo
- Escuchar primero qué necesita el lead, luego mostrar cómo Medilink resuelve ESO específico
`;

const MEDILINK_CONTACT_RULES = {
  lead_keywords: [
    'software médico', 'software clínica', 'sistema clínica', 'gestión clínica',
    'historia clínica', 'historias clínicas', 'HCE', 'agenda médica',
    'citas médicas', 'facturación clínica', 'facturación médica',
    'telemedicina', 'consultorio', 'centro de salud',
    'precios', 'planes', 'demo', 'cotización', 'cotizar',
    'cuánto cuesta', 'precio', 'prueba gratis', 'trial',
    'medilink', 'implementación', 'migración',
    'pacientes', 'recetas', 'medicamentos', 'inventario médico'
  ],
  client_keywords: [
    'soporte', 'mi cuenta', 'no puedo entrar', 'error en el sistema',
    'actualización', 'nueva función', 'factura', 'renovación',
    'mi suscripción', 'cambiar plan', 'agregar sede', 'usuario nuevo'
  ]
};

// ═══════════════════════════════════════
// EJECUCIÓN
// ═══════════════════════════════════════

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CREAR NEGOCIO MEDILINK ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'═'.repeat(60)}\n`);

  // 1. Buscar usuario por email
  console.log(`[1/5] 🔍 Buscando usuario con email: ${TARGET_EMAIL}...`);
  const usersSnap = await db.collection('users').where('email', '==', TARGET_EMAIL).get();

  if (usersSnap.empty) {
    console.error(`❌ No se encontró usuario con email ${TARGET_EMAIL}`);
    console.log('   Verificá que el usuario esté registrado en MIIA.');
    process.exit(1);
  }

  const userDoc = usersSnap.docs[0];
  const uid = userDoc.id;
  const userData = userDoc.data();
  console.log(`   ✅ Encontrado: ${userData.name || 'Sin nombre'} (UID: ${uid})`);
  console.log(`   WhatsApp: ${userData.whatsapp_number || 'No vinculado'}`);
  console.log(`   Role: ${userData.role || 'owner'}\n`);

  // 2. Verificar si ya tiene el negocio
  console.log('[2/5] 🔍 Verificando negocios existentes...');
  const existingBiz = await db.collection('users').doc(uid).collection('businesses').get();
  const hasMedilink = existingBiz.docs.some(d => d.data().name?.toLowerCase().includes('medilink'));

  console.log(`   📋 Negocios actuales: ${existingBiz.size}`);
  for (const d of existingBiz.docs) {
    const data = d.data();
    console.log(`      - ${data.name || 'Sin nombre'} (${d.id})`);
    console.log(`        email: ${data.email || '-'} | web: ${data.website || '-'} | demo: ${data.demoLink || '-'}`);
    console.log(`        desc: ${(data.description || '-').substring(0, 80)}...`);
    // Check if brain exists
    const brain = await db.collection('users').doc(uid).collection('businesses').doc(d.id).collection('brain').doc('business_cerebro').get();
    console.log(`        cerebro: ${brain.exists ? `✅ (${(brain.data()?.content || '').length} chars)` : '❌ vacío'}`);
    // Check contact rules
    const rules = await db.collection('users').doc(uid).collection('businesses').doc(d.id).collection('contact_rules').doc('rules').get();
    console.log(`        contact_rules: ${rules.exists ? '✅' : '❌ vacías'}`);
  }
  console.log('');

  // Si ya existe Medilink, actualizar en vez de crear
  const medilinkDoc = existingBiz.docs.find(d => d.data().name?.toLowerCase().includes('medilink'));
  const existingBizId = medilinkDoc ? medilinkDoc.id : null;
  if (existingBizId) {
    console.log(`   ℹ️ Medilink ya existe (${existingBizId}). Se ACTUALIZARÁ con datos completos.`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('[DRY RUN] Los siguientes datos se crearían:\n');
    console.log('Negocio:', JSON.stringify(MEDILINK_BUSINESS, null, 2));
    console.log('\nCerebro: (truncado)', MEDILINK_CEREBRO.substring(0, 200) + '...');
    console.log('\nContact Rules:', JSON.stringify(MEDILINK_CONTACT_RULES, null, 2));
    console.log('\n[DRY RUN] No se creó nada. Ejecutá sin --dry-run para crear.');
    process.exit(0);
  }

  // 3. Crear o actualizar negocio
  let bizId;
  if (existingBizId) {
    console.log(`[3/5] 🏢 Actualizando negocio Medilink (${existingBizId})...`);
    await db.collection('users').doc(uid).collection('businesses').doc(existingBizId).update({
      ...MEDILINK_BUSINESS,
      updatedAt: new Date().toISOString()
    });
    bizId = existingBizId;
    console.log(`   ✅ Negocio actualizado: ${bizId}\n`);
  } else {
    console.log('[3/5] 🏢 Creando negocio Medilink...');
    const bizRef = await db.collection('users').doc(uid).collection('businesses').add(MEDILINK_BUSINESS);
    bizId = bizRef.id;
    console.log(`   ✅ Negocio creado: ${bizId}\n`);
  }

  // Setear como default si es el único
  if (existingBiz.size <= 1) {
    await db.collection('users').doc(uid).update({ defaultBusinessId: bizId });
    console.log('   📌 Seteado como negocio default\n');
  }

  // 4. Crear cerebro
  console.log('[4/5] 🧠 Creando cerebro de Medilink...');
  await db.collection('users').doc(uid).collection('businesses').doc(bizId)
    .collection('brain').doc('business_cerebro').set({
      content: MEDILINK_CEREBRO,
      updatedAt: new Date().toISOString()
    });
  console.log('   ✅ Cerebro creado\n');

  // 4b. Crear contact rules
  console.log('[4b/5] 📋 Creando contact rules...');
  await db.collection('users').doc(uid).collection('businesses').doc(bizId)
    .collection('contact_rules').doc('rules').set({
      ...MEDILINK_CONTACT_RULES,
      updatedAt: new Date().toISOString()
    });
  console.log('   ✅ Contact rules creadas\n');

  // 5. Crear grupo "Equipo Medilink"
  console.log('[5/5] 👥 Creando grupo "Equipo Medilink"...');
  const groupRef = await db.collection('users').doc(uid).collection('contact_groups').add({
    name: 'Equipo Medilink',
    icon: '🏥',
    tone: 'Tono profesional pero cercano. Son compañeros de trabajo de Medilink. MIIA conoce a todos y los trata como equipo.',
    autoRespond: false,
    proactiveEnabled: false,
    createdAt: new Date().toISOString()
  });
  console.log(`   ✅ Grupo creado: ${groupRef.id}`);
  console.log('   ℹ️ Grupo vacío — Mariano agregará los integrantes después.\n');

  // Resumen
  console.log(`${'═'.repeat(60)}`);
  console.log('  ✅ TODO CREADO EXITOSAMENTE');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Negocio: Medilink (${bizId})`);
  console.log(`  Cerebro: ✅`);
  console.log(`  Contact Rules: ✅`);
  console.log(`  Grupo Equipo Medilink: ✅ (${groupRef.id})`);
  console.log(`  Usuario: ${uid} (${TARGET_EMAIL})`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
