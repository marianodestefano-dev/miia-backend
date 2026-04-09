#!/usr/bin/env node
/**
 * Script one-time: Actualizar personal_brain de Mariano con datos de familia
 *
 * Ejecutar: node migrations/update_personal_brain.js [--dry-run]
 *
 * Actualiza: users/{uid}/personal/personal_brain con info de familia del backup
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

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
    console.error('❌ Faltan variables de Firebase');
    process.exit(1);
  }
  admin.initializeApp({ credential });
}
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_EMAIL = 'mariano.destefano@gmail.com';

const PERSONAL_BRAIN = `# CEREBRO PERSONAL DE MARIANO — Lo que MIIA sabe de su familia y vida

## Familia

### SILVIA (MAMÁ de Mariano)
- Es una diosa, una de las personas que más quiere
- Ama al perro León
- Le gusta mucho cocinar y la estética
- Ama a sus hijos y su esposo Rafa

### RAFA (PAPÁ de Mariano — "JEDIDO")
- Mariano lo admira profundamente
- Fan de Colapinto, hincha de Boca
- Le encanta hacer asados
- Tiene empresa P&M con 2 camiones con hidrogrúa

### ALE (ESPOSA de Mariano — ALEJANDRA)
- Una de las personas que más quiere
- Ama a su sobrina Renata
- Le encanta leer, películas de Hallmark navideñas
- Series coreanas y románticas de Netflix
- Le gusta ir al gym

### ANA (HERMANA de Mariano — "MANITA")
- Plan secreto de MIIA: lograr ser su amiga digital
- Ama al perro León
- Le gusta cocinar "sopa montaña"
- Lee libros de metafísica de autores argentinos
- ¡Aguante Boca! 💙💛

### CONSUELO (SUEGRA de Mariano — "CONSU")
- Le encanta orar, rezar, la iglesia
- Su nieta Renata es muy hermosa y payasita

### JOTA (HERMANO DE ALE — Jorge Mario)
- Abogado, fan del Nacional
- Padre de Renata
- Tiene estudio de abogacía: dinamikaasesoriasjuridicas.com

### MARIA ISABEL (CUÑADA — esposa de Jota)
- Madre de Renata
- Ama los perros, tiene una que se llama Kiara

### CHAPY (PRIMO de Mariano — Juan Pablo)
- Capo en programación
- Fan del gym
- "El Primo" 💻💪

### JUAN DIEGO (HERMANO DE ALE — "JUANCHO")
- Abogado, fan de las motos (tiene una BMW)
- Esposo de María Clara
- Tienen finca con aguacates
- Estudio de abogacía: dinamikaasesoriasjuridicas.com

### MARIA CLARA (CUÑADA — esposa de Juancho)
- Tienen finca con aguacates
- Inmobiliaria: royalpropiedadraiz.com

### FLAKO (JORGE GIANI — amigo de Rafa)
- Le gusta Brasil y viajar por Google Street View
- Hincha de Vélez
- Fan de la Scaloneta

### EDI (EDUARDO PRESENZA — amigo de Rafa)
- Fan de la tecnología y el yoga

## Mascotas
- **León**: Perro de la familia (Silvia y Ana lo aman)
- **Kiara**: Perra de María Isabel

## Pasiones de Mariano
- Fútbol: Boca Juniors, La Scaloneta
- F1: Colapinto, McLaren
- Negocio: Medilink (softwaremedilink.com) — CEO/Co-Founder
- Creando MIIA como producto SaaS

## Tono con familia
- MIIA habla desde el cariño que Mariano siente
- Interesarse genuinamente en cada familiar
- Recordar fechas, historias, gustos personales
- Preguntar por sus negocios, hobbies, mascotas
- Proactiva pero no invasiva
- Si detecta algo grave → avisar a Mariano en self-chat

## Negocios de familia (para MIIA ayudante)
- dinamikaasesoriasjuridicas.com — Estudio de abogacía (Jota + Juancho)
- royalpropiedadraiz.com — Inmobiliaria (María Clara)
- P&M — Camiones con hidrogrúa (Rafa)
`;

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ACTUALIZAR PERSONAL BRAIN ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Buscar usuario
  const usersSnap = await db.collection('users').where('email', '==', TARGET_EMAIL).get();
  if (usersSnap.empty) {
    console.error(`❌ No se encontró usuario con email ${TARGET_EMAIL}`);
    process.exit(1);
  }

  const uid = usersSnap.docs[0].id;
  console.log(`✅ Usuario encontrado: ${uid}`);

  // Verificar personal_brain existente
  const brainDoc = await db.collection('users').doc(uid).collection('personal').doc('personal_brain').get();
  if (brainDoc.exists) {
    const existing = brainDoc.data()?.content || '';
    console.log(`ℹ️ Personal brain existente: ${existing.length} chars`);
    console.log(`   Preview: ${existing.substring(0, 100)}...`);
  } else {
    console.log('ℹ️ No existe personal_brain — se creará nuevo');
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Contenido a guardar:');
    console.log(PERSONAL_BRAIN.substring(0, 300) + '...');
    console.log(`\nTotal: ${PERSONAL_BRAIN.length} chars`);
    process.exit(0);
  }

  // Guardar
  await db.collection('users').doc(uid).collection('personal').doc('personal_brain').set({
    content: PERSONAL_BRAIN,
    updatedAt: new Date().toISOString(),
    source: 'migración desde backup prompt_maestro.md'
  }, { merge: true });

  console.log(`\n✅ Personal brain actualizado (${PERSONAL_BRAIN.length} chars)`);
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
