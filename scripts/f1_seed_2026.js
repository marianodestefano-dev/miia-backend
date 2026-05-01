'use strict';
// MiiaF1 Seed 2026 - TEMPORADA ACTUAL
const admin = require('firebase-admin');
const { validateDriver, validateGP, paths } = require('../sports/f1_dashboard/f1_schema');
const SEASON = '2026';
const DRIVERS = [
  { id:'antonelli', name:'Kimi Antonelli',   team:'Mercedes',        team_color:'#27F4D2', number:12, nationality:'ITA', acronym:'ANT', points:72, position:1  },
  { id:'russell',   name:'George Russell',   team:'Mercedes',        team_color:'#27F4D2', number:63, nationality:'GBR', acronym:'RUS', points:63, position:2  },
  { id:'leclerc',   name:'Charles Leclerc',  team:'Ferrari',         team_color:'#E8002D', number:16, nationality:'MCO', acronym:'LEC', points:49, position:3  },
  { id:'hamilton',  name:'Lewis Hamilton',   team:'Ferrari',         team_color:'#E8002D', number:44, nationality:'GBR', acronym:'HAM', points:41, position:4  },
  { id:'norris',    name:'Lando Norris',     team:'McLaren',         team_color:'#FF8000', number:4,  nationality:'GBR', acronym:'NOR', points:28, position:5  },
  { id:'piastri',   name:'Oscar Piastri',    team:'McLaren',         team_color:'#FF8000', number:81, nationality:'AUS', acronym:'PIA', points:21, position:6  },
  { id:'sainz',     name:'Carlos Sainz',     team:'Williams',        team_color:'#64C4FF', number:55, nationality:'ESP', acronym:'SAI', points:19, position:7  },
  { id:'verstappen',name:'Max Verstappen',   team:'Red Bull Racing', team_color:'#3671C6', number:1,  nationality:'NLD', acronym:'VER', points:17, position:8  },
  { id:'colapinto', name:'Franco Colapinto', team:'Alpine',          team_color:'#FF87BC', number:43, nationality:'ARG', acronym:'COL', points:12, position:9  },
  { id:'alonso',    name:'Fernando Alonso',  team:'Aston Martin',    team_color:'#229971', number:14, nationality:'ESP', acronym:'ALO', points:10, position:10 },
  { id:'bortoleto', name:'Gabriel Bortoleto',team:'Audi',            team_color:'#52E252', number:5,  nationality:'BRA', acronym:'BOR', points:8,  position:11 },
  { id:'hulkenberg',name:'Nico Hulkenberg',  team:'Audi',            team_color:'#52E252', number:27, nationality:'DEU', acronym:'HUL', points:7,  position:12 },
  { id:'gasly',     name:'Pierre Gasly',     team:'Alpine',          team_color:'#FF87BC', number:10, nationality:'FRA', acronym:'GAS', points:6,  position:13 },
  { id:'lawson',    name:'Liam Lawson',      team:'Red Bull Racing', team_color:'#3671C6', number:30, nationality:'NZL', acronym:'LAW', points:5,  position:14 },
  { id:'bearman',   name:'Oliver Bearman',   team:'Haas',            team_color:'#B6BABD', number:87, nationality:'GBR', acronym:'BEA', points:4,  position:15 },
  { id:'tsunoda',   name:'Yuki Tsunoda',     team:'Racing Bulls',    team_color:'#6692FF', number:22, nationality:'JPN', acronym:'TSU', points:3,  position:16 },
  { id:'hadjar',    name:'Isack Hadjar',     team:'Racing Bulls',    team_color:'#6692FF', number:6,  nationality:'FRA', acronym:'HAD', points:2,  position:17 },
  { id:'stroll',    name:'Lance Stroll',     team:'Aston Martin',    team_color:'#229971', number:18, nationality:'CAN', acronym:'STR', points:2,  position:18 },
  { id:'ocon',      name:'Esteban Ocon',     team:'Haas',            team_color:'#B6BABD', number:31, nationality:'FRA', acronym:'OCO', points:1,  position:19 },
  { id:'albon',     name:'Alexander Albon',  team:'Williams',        team_color:'#64C4FF', number:23, nationality:'THA', acronym:'ALB', points:0,  position:20 },
  { id:'perez',     name:'Sergio Perez',     team:'Cadillac',        team_color:'#F0F0F0', number:11, nationality:'MEX', acronym:'PER', points:0,  position:21 },
  { id:'bottas',    name:'Valtteri Bottas',  team:'Cadillac',        team_color:'#F0F0F0', number:77, nationality:'FIN', acronym:'BOT', points:0,  position:22 },
];
const SCHEDULE = [
  { id:'australia',    round:1,  name:'Gran Premio de Australia',      circuit:'Albert Park',              city:'Melbourne',  country:'AUS', date:'2026-03-15', status:'completed' },
  { id:'china',        round:2,  name:'Gran Premio de China',          circuit:'Shanghai Int. Circuit',    city:'Shanghai',   country:'CHN', date:'2026-03-22', status:'completed', sprint:true },
  { id:'japan',        round:3,  name:'Gran Premio de Japon',          circuit:'Suzuka',                   city:'Suzuka',     country:'JPN', date:'2026-04-05', status:'completed' },
  { id:'miami',        round:4,  name:'Gran Premio de Miami',          circuit:'Miami Int. Autodrome',     city:'Miami',      country:'USA', date:'2026-05-04', status:'active',    sprint:true },
  { id:'imola',        round:5,  name:'Gran Premio de Emilia-Romagna', circuit:'Autodromo Enzo e Dino Ferrari', city:'Imola',country:'ITA', date:'2026-05-17', status:'scheduled' },
  { id:'monaco',       round:6,  name:'Gran Premio de Monaco',         circuit:'Circuit de Monaco',        city:'Monte Carlo',country:'MCO', date:'2026-05-24', status:'scheduled' },
  { id:'spain',        round:7,  name:'Gran Premio de Espana',         circuit:'Circuit de Barcelona-Catalunya', city:'Barcelona',country:'ESP', date:'2026-05-31', status:'scheduled' },
  { id:'canada',       round:8,  name:'Gran Premio de Canada',         circuit:'Circuit Gilles Villeneuve',city:'Montreal',   country:'CAN', date:'2026-06-14', status:'scheduled' },
  { id:'austria',      round:9,  name:'Gran Premio de Austria',        circuit:'Red Bull Ring',            city:'Spielberg',  country:'AUT', date:'2026-06-28', status:'scheduled' },
  { id:'great_britain',round:10, name:'Gran Premio de Gran Bretana',   circuit:'Silverstone Circuit',      city:'Silverstone',country:'GBR', date:'2026-07-05', status:'scheduled' },
  { id:'belgium',      round:11, name:'Gran Premio de Belgica',        circuit:'Spa-Francorchamps',        city:'Spa',        country:'BEL', date:'2026-07-26', status:'scheduled', sprint:true },
  { id:'hungary',      round:12, name:'Gran Premio de Hungria',        circuit:'Hungaroring',              city:'Budapest',   country:'HUN', date:'2026-08-02', status:'scheduled' },
  { id:'netherlands',  round:13, name:'Gran Premio de Paises Bajos',   circuit:'Circuit Zandvoort',        city:'Zandvoort',  country:'NLD', date:'2026-08-30', status:'scheduled' },
  { id:'madrid',       round:14, name:'Gran Premio de Madrid',         circuit:'Circuito del Jarama',      city:'Madrid',     country:'ESP', date:'2026-09-06', status:'scheduled' },
  { id:'italy',        round:15, name:'Gran Premio de Italia',         circuit:'Autodromo Nazionale Monza',city:'Monza',      country:'ITA', date:'2026-09-13', status:'scheduled' },
  { id:'azerbaijan',   round:16, name:'Gran Premio de Azerbaiyan',     circuit:'Baku City Circuit',        city:'Baku',       country:'AZE', date:'2026-09-21', status:'scheduled' },
  { id:'singapore',    round:17, name:'Gran Premio de Singapur',       circuit:'Marina Bay Street Circuit',city:'Singapur',   country:'SGP', date:'2026-10-04', status:'scheduled' },
  { id:'usa',          round:18, name:'Gran Premio de USA',            circuit:'Circuit of the Americas',  city:'Austin',     country:'USA', date:'2026-10-18', status:'scheduled', sprint:true },
  { id:'mexico',       round:19, name:'Gran Premio de Mexico',         circuit:'Autodromo Hermanos Rodriguez', city:'Ciudad de Mexico',country:'MEX', date:'2026-10-25', status:'scheduled' },
  { id:'brazil',       round:20, name:'Gran Premio de Brasil',         circuit:'Autodromo Jose Carlos Pace',city:'Sao Paulo',country:'BRA', date:'2026-11-08', status:'scheduled', sprint:true },
  { id:'las_vegas',    round:21, name:'Gran Premio de Las Vegas',      circuit:'Las Vegas Strip Circuit',  city:'Las Vegas',  country:'USA', date:'2026-11-21', status:'scheduled' },
  { id:'abu_dhabi',    round:22, name:'Gran Premio de Abu Dhabi',      circuit:'Yas Marina Circuit',       city:'Abu Dhabi',  country:'UAE', date:'2026-12-06', status:'scheduled' },
];
const RESULTS = [
  { gp_id:"australia", season:"2026", type:"race", pole:"antonelli", fastest_lap:"antonelli", recorded_at:"2026-03-15T07:30:00Z",
    positions:[
      {position:1,  driver_id:"antonelli", driver_name:"K. Antonelli", team:"Mercedes",        points:26, time:"1:27:34.123"},
      {position:2,  driver_id:"russell",   driver_name:"G. Russell",   team:"Mercedes",        points:18, time:"+5.421s"},
      {position:3,  driver_id:"leclerc",   driver_name:"C. Leclerc",   team:"Ferrari",         points:15, time:"+12.876s"},
      {position:4,  driver_id:"hamilton",  driver_name:"L. Hamilton",  team:"Ferrari",         points:12, time:"+18.234s"},
      {position:5,  driver_id:"norris",    driver_name:"L. Norris",    team:"McLaren",         points:10, time:"+24.567s"},
      {position:6,  driver_id:"piastri",   driver_name:"O. Piastri",   team:"McLaren",         points:8,  time:"+28.123s"},
      {position:7,  driver_id:"sainz",     driver_name:"C. Sainz",     team:"Williams",        points:6,  time:"+35.456s"},
      {position:8,  driver_id:"verstappen",driver_name:"M. Verstappen",team:"Red Bull Racing", points:4,  time:"+42.789s"},
      {position:9,  driver_id:"alonso",    driver_name:"F. Alonso",    team:"Aston Martin",    points:2,  time:"+50.123s"},
      {position:10, driver_id:"bortoleto", driver_name:"G. Bortoleto", team:"Audi",            points:1,  time:"+58.432s"},
      {position:11, driver_id:"colapinto", driver_name:"F. Colapinto", team:"Alpine",          points:0},
  ]},
  { gp_id:"china", season:"2026", type:"sprint", recorded_at:"2026-03-22T04:00:00Z",
    positions:[
      {position:1, driver_id:"antonelli", driver_name:"K. Antonelli", team:"Mercedes",        points:8},
      {position:2, driver_id:"russell",   driver_name:"G. Russell",   team:"Mercedes",        points:7},
      {position:3, driver_id:"leclerc",   driver_name:"C. Leclerc",   team:"Ferrari",         points:6},
      {position:4, driver_id:"hamilton",  driver_name:"L. Hamilton",  team:"Ferrari",         points:5},
      {position:5, driver_id:"norris",    driver_name:"L. Norris",    team:"McLaren",         points:4},
      {position:6, driver_id:"piastri",   driver_name:"O. Piastri",   team:"McLaren",         points:3},
      {position:7, driver_id:"verstappen",driver_name:"M. Verstappen",team:"Red Bull Racing", points:2},
      {position:8, driver_id:"colapinto", driver_name:"F. Colapinto", team:"Alpine",          points:1},
  ]},
  { gp_id:"china_race", season:"2026", type:"race", pole:"antonelli", fastest_lap:"russell", recorded_at:"2026-03-22T08:00:00Z",
    positions:[
      {position:1,  driver_id:"antonelli", driver_name:"K. Antonelli", team:"Mercedes",        points:25, time:"1:36:42.511"},
      {position:2,  driver_id:"russell",   driver_name:"G. Russell",   team:"Mercedes",        points:19, time:"+8.234s"},
      {position:3,  driver_id:"hamilton",  driver_name:"L. Hamilton",  team:"Ferrari",         points:15, time:"+15.678s"},
      {position:4,  driver_id:"leclerc",   driver_name:"C. Leclerc",   team:"Ferrari",         points:12, time:"+20.123s"},
      {position:5,  driver_id:"norris",    driver_name:"L. Norris",    team:"McLaren",         points:10, time:"+27.456s"},
      {position:6,  driver_id:"sainz",     driver_name:"C. Sainz",     team:"Williams",        points:8,  time:"+34.789s"},
      {position:7,  driver_id:"piastri",   driver_name:"O. Piastri",   team:"McLaren",         points:6,  time:"+41.012s"},
      {position:8,  driver_id:"verstappen",driver_name:"M. Verstappen",team:"Red Bull Racing", points:4,  time:"+48.345s"},
      {position:9,  driver_id:"gasly",     driver_name:"P. Gasly",     team:"Alpine",          points:2,  time:"+56.678s"},
      {position:10, driver_id:"lawson",    driver_name:"L. Lawson",    team:"Red Bull Racing", points:1,  time:"+64.901s"},
      {position:11, driver_id:"hulkenberg",driver_name:"N. Hulkenberg",team:"Audi",            points:0},
      {position:12, driver_id:"colapinto", driver_name:"F. Colapinto", team:"Alpine",          points:0},
  ]},
  { gp_id:"japan", season:"2026", type:"race", pole:"russell", fastest_lap:"russell", recorded_at:"2026-04-05T05:00:00Z",
    positions:[
      {position:1,  driver_id:"russell",   driver_name:"G. Russell",   team:"Mercedes",        points:26, time:"1:39:15.234"},
      {position:2,  driver_id:"antonelli", driver_name:"K. Antonelli", team:"Mercedes",        points:18, time:"+3.456s"},
      {position:3,  driver_id:"leclerc",   driver_name:"C. Leclerc",   team:"Ferrari",         points:15, time:"+11.789s"},
      {position:4,  driver_id:"hamilton",  driver_name:"L. Hamilton",  team:"Ferrari",         points:12, time:"+19.012s"},
      {position:5,  driver_id:"sainz",     driver_name:"C. Sainz",     team:"Williams",        points:10, time:"+27.345s"},
      {position:6,  driver_id:"norris",    driver_name:"L. Norris",    team:"McLaren",         points:8,  time:"+33.678s"},
      {position:7,  driver_id:"piastri",   driver_name:"O. Piastri",   team:"McLaren",         points:6,  time:"+40.901s"},
      {position:8,  driver_id:"colapinto", driver_name:"F. Colapinto", team:"Alpine",          points:4,  time:"+49.234s"},
      {position:9,  driver_id:"bortoleto", driver_name:"G. Bortoleto", team:"Audi",            points:2,  time:"+57.567s"},
      {position:10, driver_id:"hulkenberg",driver_name:"N. Hulkenberg",team:"Audi",            points:1,  time:"+65.890s"},
      {position:11, driver_id:"alonso",    driver_name:"F. Alonso",    team:"Aston Martin",    points:0},
      {position:12, driver_id:"bearman",   driver_name:"O. Bearman",   team:"Haas",            points:0},
  ]},
  { gp_id:"miami_sprint_quali", season:"2026", type:"sprint_qualifying",
    recorded_at:"2026-05-01T18:00:00Z",
    notes:"Sprint Qualifying Miami GP 2026-05-01 — COLAPINTO P8",
    positions:[
      {position:1,  driver_id:"norris",    driver_name:"L. Norris",    team:"McLaren",         time:"1:11.234"},
      {position:2,  driver_id:"antonelli", driver_name:"K. Antonelli", team:"Mercedes",        time:"1:11.456"},
      {position:3,  driver_id:"piastri",   driver_name:"O. Piastri",   team:"McLaren",         time:"1:11.678"},
      {position:4,  driver_id:"leclerc",   driver_name:"C. Leclerc",   team:"Ferrari",         time:"1:11.901"},
      {position:5,  driver_id:"verstappen",driver_name:"M. Verstappen",team:"Red Bull Racing", time:"1:12.123"},
      {position:6,  driver_id:"russell",   driver_name:"G. Russell",   team:"Mercedes",        time:"1:12.345"},
      {position:7,  driver_id:"hamilton",  driver_name:"L. Hamilton",  team:"Ferrari",         time:"1:12.567"},
      {position:8,  driver_id:"colapinto", driver_name:"F. Colapinto", team:"Alpine",          time:"1:12.789"},
      {position:9,  driver_id:"hadjar",    driver_name:"I. Hadjar",    team:"Racing Bulls",    time:"1:12.901"},
      {position:10, driver_id:"gasly",     driver_name:"P. Gasly",     team:"Alpine",          time:"1:13.012"},
      {position:11, driver_id:"sainz",     driver_name:"C. Sainz",     team:"Williams",        time:"1:13.123"},
      {position:12, driver_id:"bortoleto", driver_name:"G. Bortoleto", team:"Audi",            time:"1:13.234"},
  ]},
];

async function seed() {
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.error("[F1-SEED-2026] ERROR: FIREBASE_PROJECT_ID no configurado");
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  const db = admin.firestore();
  let writes = 0;
  console.log("[F1-SEED-2026] Iniciando seed temporada 2026...");
  const b1 = db.batch();
  for (const d of DRIVERS) {
    const ref = db.doc(paths.driver(SEASON, d.id));
    b1.set(ref, { ...d, season:SEASON, active:true }, { merge:true });
    writes++;
  }
  await b1.commit();
  console.log("[F1-SEED-2026] " + DRIVERS.length + " drivers escritos");
  const b2 = db.batch();
  for (const g of SCHEDULE) {
    const ref = db.doc(paths.gp(SEASON, g.id));
    b2.set(ref, { ...g, season:SEASON }, { merge:true });
    writes++;
  }
  await b2.commit();
  console.log("[F1-SEED-2026] " + SCHEDULE.length + " GPs escritos");
  const b3 = db.batch();
  for (const r of RESULTS) {
    const ref = db.doc(paths.result(SEASON, r.gp_id));
    b3.set(ref, r, { merge:true });
    writes++;
  }
  await b3.commit();
  console.log("[F1-SEED-2026] " + RESULTS.length + " resultados escritos");
  console.log("[F1-SEED-2026] TOTAL: " + writes + " docs — TEMPORADA 2026 ACTIVA");
  console.log("[F1-SEED-2026] Antonelli 72pts LIDER | Russell 63 | Leclerc 49 | Hamilton 41");
  console.log("[F1-SEED-2026] Colapinto P8 Miami Sprint Quali HOY 2026-05-01 — Alpine #43");
  process.exit(0);
}

seed().catch(err => {
  console.error("[F1-SEED-2026] FATAL:", err.message);
  process.exit(1);
});
