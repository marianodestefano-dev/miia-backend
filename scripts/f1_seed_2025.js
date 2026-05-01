'use strict';

/**
 * MiiaF1 — Seed datos temporada 2025
 * Ejecutar: node scripts/f1_seed_2025.js
 * Requiere: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL en env
 */

const admin = require('firebase-admin');
const { validateDriver, validateGP, paths } = require('../sports/f1_dashboard/f1_schema');

const SEASON = '2025';

// ═══ DRIVERS 2025 ═══
const DRIVERS_2025 = [
  { id: 'verstappen', name: 'Max Verstappen',   team: 'Red Bull Racing', team_color: '#3671C6', number: 1,  nationality: 'NLD', acronym: 'VER' },
  { id: 'lawson',     name: 'Liam Lawson',       team: 'Red Bull Racing', team_color: '#3671C6', number: 30, nationality: 'NZL', acronym: 'LAW' },
  { id: 'hamilton',   name: 'Lewis Hamilton',    team: 'Ferrari',         team_color: '#E8002D', number: 44, nationality: 'GBR', acronym: 'HAM' },
  { id: 'leclerc',    name: 'Charles Leclerc',   team: 'Ferrari',         team_color: '#E8002D', number: 16, nationality: 'MCO', acronym: 'LEC' },
  { id: 'russell',    name: 'George Russell',    team: 'Mercedes',        team_color: '#27F4D2', number: 63, nationality: 'GBR', acronym: 'RUS' },
  { id: 'antonelli',  name: 'Andrea Kimi Antonelli', team: 'Mercedes',   team_color: '#27F4D2', number: 12, nationality: 'ITA', acronym: 'ANT' },
  { id: 'norris',     name: 'Lando Norris',      team: 'McLaren',         team_color: '#FF8000', number: 4,  nationality: 'GBR', acronym: 'NOR' },
  { id: 'piastri',    name: 'Oscar Piastri',     team: 'McLaren',         team_color: '#FF8000', number: 81, nationality: 'AUS', acronym: 'PIA' },
  { id: 'alonso',     name: 'Fernando Alonso',   team: 'Aston Martin',    team_color: '#229971', number: 14, nationality: 'ESP', acronym: 'ALO' },
  { id: 'stroll',     name: 'Lance Stroll',      team: 'Aston Martin',    team_color: '#229971', number: 18, nationality: 'CAN', acronym: 'STR' },
  { id: 'sainz',      name: 'Carlos Sainz',      team: 'Williams',        team_color: '#64C4FF', number: 55, nationality: 'ESP', acronym: 'SAI' },
  { id: 'albon',      name: 'Alexander Albon',   team: 'Williams',        team_color: '#64C4FF', number: 23, nationality: 'THA', acronym: 'ALB' },
  { id: 'gasly',      name: 'Pierre Gasly',      team: 'Alpine',          team_color: '#0093CC', number: 10, nationality: 'FRA', acronym: 'GAS' },
  { id: 'doohan',     name: 'Jack Doohan',       team: 'Alpine',          team_color: '#0093CC', number: 7,  nationality: 'AUS', acronym: 'DOO' },
  { id: 'hulkenberg', name: 'Nico Hulkenberg',   team: 'Sauber',          team_color: '#52E252', number: 27, nationality: 'DEU', acronym: 'HUL' },
  { id: 'bortoleto',  name: 'Gabriel Bortoleto', team: 'Sauber',          team_color: '#52E252', number: 5,  nationality: 'BRA', acronym: 'BOR' },
  { id: 'tsunoda',    name: 'Yuki Tsunoda',      team: 'Racing Bulls',    team_color: '#6692FF', number: 22, nationality: 'JPN', acronym: 'TSU' },
  { id: 'hadjar',     name: 'Isack Hadjar',      team: 'Racing Bulls',    team_color: '#6692FF', number: 6,  nationality: 'FRA', acronym: 'HAD' },
  { id: 'bearman',    name: 'Oliver Bearman',    team: 'Haas',            team_color: '#B6BABD', number: 87, nationality: 'GBR', acronym: 'BEA' },
  { id: 'ocon',       name: 'Esteban Ocon',      team: 'Haas',            team_color: '#B6BABD', number: 31, nationality: 'FRA', acronym: 'OCO' },
];

// ═══ CALENDARIO 2025 (24 GPs) ═══
const SCHEDULE_2025 = [
  { id: 'australia',      round: 1,  name: 'Gran Premio de Australia',       circuit: 'Albert Park',          city: 'Melbourne',    country: 'AUS', date: '2025-03-16', status: 'completed' },
  { id: 'china',          round: 2,  name: 'Gran Premio de China',           circuit: 'Shanghai Int. Circuit', city: 'Shanghai',     country: 'CHN', date: '2025-03-23', status: 'completed', sprint: true },
  { id: 'japan',          round: 3,  name: 'Gran Premio de Japon',           circuit: 'Suzuka',                city: 'Suzuka',       country: 'JPN', date: '2025-04-06', status: 'completed' },
  { id: 'bahrain',        round: 4,  name: 'Gran Premio de Bahrain',         circuit: 'Bahrain Int. Circuit',  city: 'Sakhir',       country: 'BHR', date: '2025-04-13', status: 'completed' },
  { id: 'saudi_arabia',   round: 5,  name: 'Gran Premio de Arabia Saudita',  circuit: 'Jeddah Corniche',       city: 'Jeddah',       country: 'SAU', date: '2025-04-20', status: 'completed' },
  { id: 'miami',          round: 6,  name: 'Gran Premio de Miami',           circuit: 'Miami Int. Autodrome',  city: 'Miami',        country: 'USA', date: '2025-05-04', status: 'completed', sprint: true },
  { id: 'emilia_romagna', round: 7,  name: 'Gran Premio de Emilia-Romagna',  circuit: 'Imola',                 city: 'Imola',        country: 'ITA', date: '2025-05-18', status: 'completed' },
  { id: 'monaco',         round: 8,  name: 'Gran Premio de Monaco',          circuit: 'Circuit de Monaco',     city: 'Monte Carlo',  country: 'MCO', date: '2025-05-25', status: 'completed' },
  { id: 'spain',          round: 9,  name: 'Gran Premio de Espana',          circuit: 'Circuit de Barcelona',  city: 'Barcelona',    country: 'ESP', date: '2025-06-01', status: 'completed' },
  { id: 'canada',         round: 10, name: 'Gran Premio de Canada',          circuit: 'Circuit Gilles Villeneuve', city: 'Montreal', country: 'CAN', date: '2025-06-15', status: 'completed' },
  { id: 'austria',        round: 11, name: 'Gran Premio de Austria',         circuit: 'Red Bull Ring',         city: 'Spielberg',    country: 'AUT', date: '2025-06-29', status: 'completed' },
  { id: 'great_britain',  round: 12, name: 'Gran Premio de Gran Bretana',    circuit: 'Silverstone',           city: 'Silverstone',  country: 'GBR', date: '2025-07-06', status: 'completed' },
  { id: 'belgium',        round: 13, name: 'Gran Premio de Belgica',         circuit: 'Spa-Francorchamps',     city: 'Spa',          country: 'BEL', date: '2025-07-27', status: 'completed', sprint: true },
  { id: 'hungary',        round: 14, name: 'Gran Premio de Hungria',         circuit: 'Hungaroring',           city: 'Budapest',     country: 'HUN', date: '2025-08-03', status: 'completed' },
  { id: 'netherlands',    round: 15, name: 'Gran Premio de Paises Bajos',    circuit: 'Zandvoort',             city: 'Zandvoort',    country: 'NLD', date: '2025-08-31', status: 'scheduled' },
  { id: 'italy',          round: 16, name: 'Gran Premio de Italia',          circuit: 'Monza',                 city: 'Monza',        country: 'ITA', date: '2025-09-07', status: 'scheduled' },
  { id: 'azerbaijan',     round: 17, name: 'Gran Premio de Azerbaiyan',      circuit: 'Baku City Circuit',     city: 'Baku',         country: 'AZE', date: '2025-09-21', status: 'scheduled' },
  { id: 'singapore',      round: 18, name: 'Gran Premio de Singapur',        circuit: 'Marina Bay',            city: 'Singapur',     country: 'SGP', date: '2025-10-05', status: 'scheduled' },
  { id: 'usa',            round: 19, name: 'Gran Premio de USA',             circuit: 'Circuit of the Americas', city: 'Austin',     country: 'USA', date: '2025-10-19', status: 'scheduled', sprint: true },
  { id: 'mexico',         round: 20, name: 'Gran Premio de Mexico',          circuit: 'Autodromo Hermanos Rodriguez', city: 'CDMX', country: 'MEX', date: '2025-10-26', status: 'scheduled' },
  { id: 'brazil',         round: 21, name: 'Gran Premio de Brasil',          circuit: 'Autodromo Jose Carlos Pace', city: 'Sao Paulo', country: 'BRA', date: '2025-11-09', status: 'scheduled', sprint: true },
  { id: 'las_vegas',      round: 22, name: 'Gran Premio de Las Vegas',       circuit: 'Las Vegas Strip',       city: 'Las Vegas',    country: 'USA', date: '2025-11-22', status: 'scheduled' },
  { id: 'qatar',          round: 23, name: 'Gran Premio de Qatar',           circuit: 'Lusail Int. Circuit',   city: 'Lusail',       country: 'QAT', date: '2025-11-30', status: 'scheduled', sprint: true },
  { id: 'abu_dhabi',      round: 24, name: 'Gran Premio de Abu Dhabi',       circuit: 'Yas Marina',            city: 'Abu Dhabi',    country: 'UAE', date: '2025-12-07', status: 'scheduled' },
];

async function seed() {
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.error('[F1-SEED] ERROR: FIREBASE_PROJECT_ID no configurado');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });

  const db = admin.firestore();
  const batch = db.batch();
  let writes = 0;

  console.log(`[F1-SEED] Iniciando seed temporada ${SEASON}...`);

  // Drivers
  for (const driver of DRIVERS_2025) {
    const data = { ...driver, season: SEASON, active: true };
    const validation = validateDriver(data);
    if (!validation.valid) {
      console.error(`[F1-SEED] Driver invalido ${driver.id}: ${validation.error}`);
      process.exit(1);
    }
    const ref = db.doc(paths.driver(SEASON, driver.id));
    batch.set(ref, data, { merge: true });
    writes++;
  }
  console.log(`[F1-SEED] ${DRIVERS_2025.length} drivers preparados`);

  // Schedule
  for (const gp of SCHEDULE_2025) {
    const data = { ...gp, season: SEASON };
    const validation = validateGP(data);
    if (!validation.valid) {
      console.error(`[F1-SEED] GP invalido ${gp.id}: ${validation.error}`);
      process.exit(1);
    }
    const ref = db.doc(paths.gp(SEASON, gp.id));
    batch.set(ref, data, { merge: true });
    writes++;
  }
  console.log(`[F1-SEED] ${SCHEDULE_2025.length} GPs preparados`);

  await batch.commit();
  console.log(`[F1-SEED] OK: ${writes} documentos escritos en Firestore`);
  process.exit(0);
}

seed().catch(err => {
  console.error('[F1-SEED] FATAL:', err);
  process.exit(1);
});
