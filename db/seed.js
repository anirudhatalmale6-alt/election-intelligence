const db = require('./database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

console.log('Seeding Election Intelligence database...');

// ── Swedish Political Parties ──────────────────────────────────
const parties = [
  { code: 'S', name: 'Socialdemokraterna', name_en: 'Social Democrats', color: '#E8112D', sort: 1 },
  { code: 'M', name: 'Moderaterna', name_en: 'Moderate Party', color: '#1B49DD', sort: 2 },
  { code: 'SD', name: 'Sverigedemokraterna', name_en: 'Sweden Democrats', color: '#DDDD00', sort: 3 },
  { code: 'C', name: 'Centerpartiet', name_en: 'Centre Party', color: '#009933', sort: 4 },
  { code: 'V', name: 'Vansterpartiet', name_en: 'Left Party', color: '#DA291C', sort: 5 },
  { code: 'KD', name: 'Kristdemokraterna', name_en: 'Christian Democrats', color: '#005EA1', sort: 6 },
  { code: 'L', name: 'Liberalerna', name_en: 'Liberals', color: '#006AB3', sort: 7 },
  { code: 'MP', name: 'Miljopartiet', name_en: 'Green Party', color: '#83CF39', sort: 8 },
  { code: 'OVR', name: 'Ovriga partier', name_en: 'Other parties', color: '#888888', sort: 9 },
];

const partyStmt = db.prepare('INSERT OR IGNORE INTO parties (id, code, name, name_en, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
parties.forEach(p => {
  partyStmt.run(uuidv4(), p.code, p.name, p.name_en, p.color, p.sort);
});
console.log(`  ${parties.length} parties seeded`);

// ── Swedish Counties (Län) ─────────────────────────────────────
const counties = [
  { code: '01', name: 'Stockholms lan', name_en: 'Stockholm County', pop: 2415139 },
  { code: '03', name: 'Uppsala lan', name_en: 'Uppsala County', pop: 395026 },
  { code: '04', name: 'Sodermanlands lan', name_en: 'Sodermanland County', pop: 299438 },
  { code: '05', name: 'Ostergotlands lan', name_en: 'Ostergotland County', pop: 468494 },
  { code: '06', name: 'Jonkopings lan', name_en: 'Jonkoping County', pop: 365357 },
  { code: '07', name: 'Kronobergs lan', name_en: 'Kronoberg County', pop: 203340 },
  { code: '08', name: 'Kalmar lan', name_en: 'Kalmar County', pop: 246256 },
  { code: '09', name: 'Gotlands lan', name_en: 'Gotland County', pop: 60124 },
  { code: '10', name: 'Blekinge lan', name_en: 'Blekinge County', pop: 159684 },
  { code: '12', name: 'Skane lan', name_en: 'Skane County', pop: 1402425 },
  { code: '13', name: 'Hallands lan', name_en: 'Halland County', pop: 338535 },
  { code: '14', name: 'Vastra Gotalands lan', name_en: 'Vastra Gotaland County', pop: 1744859 },
  { code: '17', name: 'Varmlands lan', name_en: 'Varmland County', pop: 283196 },
  { code: '18', name: 'Orebro lan', name_en: 'Orebro County', pop: 306792 },
  { code: '19', name: 'Vastmanlands lan', name_en: 'Vastmanland County', pop: 278401 },
  { code: '20', name: 'Dalarnas lan', name_en: 'Dalarna County', pop: 288178 },
  { code: '21', name: 'Gavleborgs lan', name_en: 'Gavleborg County', pop: 287767 },
  { code: '22', name: 'Vasternorrlands lan', name_en: 'Vasternorrland County', pop: 244297 },
  { code: '23', name: 'Jamtlands lan', name_en: 'Jamtland County', pop: 132054 },
  { code: '24', name: 'Vasterbottens lan', name_en: 'Vasterbotten County', pop: 274377 },
  { code: '25', name: 'Norrbottens lan', name_en: 'Norrbotten County', pop: 250570 },
];

const countyStmt = db.prepare('INSERT OR IGNORE INTO counties (id, code, name, name_en, population) VALUES (?, ?, ?, ?, ?)');
const countyIds = {};
counties.forEach(c => {
  const id = uuidv4();
  countyIds[c.code] = id;
  countyStmt.run(id, c.code, c.name, c.name_en, c.pop);
});
console.log(`  ${counties.length} counties seeded`);

// ── Top municipalities per county (sample - major cities) ──────
const municipalities = [
  // Stockholm
  { code: '0180', county: '01', name: 'Stockholm', pop: 978770 },
  { code: '0127', county: '01', name: 'Botkyrka', pop: 94734 },
  { code: '0162', county: '01', name: 'Danderyd', pop: 33367 },
  { code: '0126', county: '01', name: 'Huddinge', pop: 114010 },
  { code: '0123', county: '01', name: 'Jarfalla', pop: 80981 },
  { code: '0186', county: '01', name: 'Lidingo', pop: 48861 },
  { code: '0182', county: '01', name: 'Nacka', pop: 106538 },
  { code: '0188', county: '01', name: 'Norrkoping', pop: 143171 },
  { code: '0184', county: '01', name: 'Solna', pop: 83811 },
  { code: '0183', county: '01', name: 'Sundbyberg', pop: 55328 },
  { code: '0128', county: '01', name: 'Salem', pop: 17541 },
  // Uppsala
  { code: '0380', county: '03', name: 'Uppsala', pop: 233839 },
  { code: '0381', county: '03', name: 'Enkoping', pop: 45506 },
  // Sodermanland
  { code: '0480', county: '04', name: 'Nykoping', pop: 57218 },
  { code: '0484', county: '04', name: 'Eskilstuna', pop: 107161 },
  // Ostergotland
  { code: '0580', county: '05', name: 'Linkoping', pop: 163051 },
  { code: '0581', county: '05', name: 'Norrkoping', pop: 143171 },
  // Jonkoping
  { code: '0680', county: '06', name: 'Jonkoping', pop: 142427 },
  // Kronoberg
  { code: '0780', county: '07', name: 'Vaxjo', pop: 96069 },
  // Kalmar
  { code: '0880', county: '08', name: 'Kalmar', pop: 71942 },
  // Gotland
  { code: '0980', county: '09', name: 'Gotland', pop: 60124 },
  // Blekinge
  { code: '1080', county: '10', name: 'Karlskrona', pop: 66675 },
  // Skane
  { code: '1280', county: '12', name: 'Malmo', pop: 350647 },
  { code: '1281', county: '12', name: 'Lund', pop: 127035 },
  { code: '1283', county: '12', name: 'Helsingborg', pop: 149280 },
  { code: '1287', county: '12', name: 'Trelleborg', pop: 46103 },
  { code: '1284', county: '12', name: 'Hoganas', pop: 27957 },
  { code: '1285', county: '12', name: 'Eslов', pop: 34701 },
  { code: '1286', county: '12', name: 'Ystad', pop: 30802 },
  { code: '1290', county: '12', name: 'Kristianstad', pop: 86478 },
  { code: '1291', county: '12', name: 'Simrishamn', pop: 19560 },
  // Halland
  { code: '1380', county: '13', name: 'Halmstad', pop: 104869 },
  // Vastra Gotaland
  { code: '1480', county: '14', name: 'Goteborg', pop: 587549 },
  { code: '1481', county: '14', name: 'Molndal', pop: 70014 },
  { code: '1482', county: '14', name: 'Kungalv', pop: 47393 },
  { code: '1401', county: '14', name: 'Harryda', pop: 40199 },
  { code: '1484', county: '14', name: 'Lysekil', pop: 14690 },
  { code: '1485', county: '14', name: 'Uddevalla', pop: 57281 },
  { code: '1486', county: '14', name: 'Stromstad', pop: 13250 },
  { code: '1487', county: '14', name: 'Vanersborg', pop: 40167 },
  { code: '1488', county: '14', name: 'Trollhattan', pop: 59738 },
  { code: '1489', county: '14', name: 'Alingsas', pop: 42029 },
  { code: '1490', county: '14', name: 'Boras', pop: 114022 },
  { code: '1492', county: '14', name: 'Skovde', pop: 57029 },
  // Varmland
  { code: '1780', county: '17', name: 'Karlstad', pop: 96466 },
  // Orebro
  { code: '1880', county: '18', name: 'Orebro', pop: 157669 },
  // Vastmanland
  { code: '1980', county: '19', name: 'Vasteras', pop: 155159 },
  // Dalarna
  { code: '2080', county: '20', name: 'Falun', pop: 59355 },
  { code: '2081', county: '20', name: 'Borlange', pop: 53339 },
  // Gavleborg
  { code: '2180', county: '21', name: 'Gavle', pop: 103766 },
  // Vasternorrland
  { code: '2280', county: '22', name: 'Sundsvall', pop: 99772 },
  { code: '2281', county: '22', name: 'Harnosand', pop: 25576 },
  // Jamtland
  { code: '2380', county: '23', name: 'Ostersund', pop: 64324 },
  // Vasterbotten
  { code: '2480', county: '24', name: 'Umea', pop: 130224 },
  { code: '2481', county: '24', name: 'Skelleftea', pop: 73765 },
  // Norrbotten
  { code: '2580', county: '25', name: 'Lulea', pop: 80490 },
  { code: '2581', county: '25', name: 'Pitea', pop: 42697 },
  { code: '2582', county: '25', name: 'Boden', pop: 28589 },
  { code: '2584', county: '25', name: 'Kiruna', pop: 23167 },
];

const munStmt = db.prepare('INSERT OR IGNORE INTO municipalities (id, code, county_id, name, population) VALUES (?, ?, ?, ?, ?)');
municipalities.forEach(m => {
  const countyId = countyIds[m.county];
  if (countyId) munStmt.run(uuidv4(), m.code, countyId, m.name, m.pop);
});
console.log(`  ${municipalities.length} municipalities seeded`);

// ── Sample 2022 Riksdag results (national level) ──────────────
const results2022 = [
  { party: 'S', votes: 1964474, pct: 30.33, seats: 107 },
  { party: 'M', votes: 1237428, pct: 19.10, seats: 68 },
  { party: 'SD', votes: 1330325, pct: 20.54, seats: 73 },
  { party: 'C', votes: 427404, pct: 6.60, seats: 24 },
  { party: 'V', votes: 437589, pct: 6.75, seats: 24 },
  { party: 'KD', votes: 355546, pct: 5.49, seats: 19 },
  { party: 'L', votes: 304626, pct: 4.70, seats: 16 },
  { party: 'MP', votes: 328578, pct: 5.08, seats: 18 },
];

const resultStmt = db.prepare(`INSERT OR IGNORE INTO election_results
  (id, election_year, election_type, level, party_code, votes, vote_percentage, seats, registered_voters, total_votes, turnout_percentage)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const totalVotes2022 = 6477734;
const registered2022 = 7764354;
const turnout2022 = 84.21;

results2022.forEach(r => {
  resultStmt.run(uuidv4(), 2022, 'riksdag', 'national', r.party, r.votes, r.pct, r.seats, registered2022, totalVotes2022, turnout2022);
});
console.log(`  2022 Riksdag national results seeded`);

// ── Sample 2018 Riksdag results (national level) ──────────────
const results2018 = [
  { party: 'S', votes: 1830386, pct: 28.26, seats: 100 },
  { party: 'M', votes: 1284698, pct: 19.84, seats: 70 },
  { party: 'SD', votes: 1135627, pct: 17.53, seats: 62 },
  { party: 'C', votes: 557500, pct: 8.61, seats: 31 },
  { party: 'V', votes: 518454, pct: 8.00, seats: 28 },
  { party: 'KD', votes: 409478, pct: 6.32, seats: 22 },
  { party: 'L', votes: 355546, pct: 5.49, seats: 20 },
  { party: 'MP', votes: 282644, pct: 4.41, seats: 16 },
];

const totalVotes2018 = 6471361;
const registered2018 = 7495936;
const turnout2018 = 87.18;

results2018.forEach(r => {
  resultStmt.run(uuidv4(), 2018, 'riksdag', 'national', r.party, r.votes, r.pct, r.seats, registered2018, totalVotes2018, turnout2018);
});
console.log(`  2018 Riksdag national results seeded`);

// ── Admin user ─────────────────────────────────────────────────
const adminHash = bcrypt.hashSync('Admin2026!', 10);
const adminId = uuidv4();
db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)').run(
  adminId, 'admin@festivalai.se', adminHash, 'Admin', 'admin'
);
db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)').run(
  uuidv4(), 'talat@rafilm.se', adminHash, 'Talat Bhat', 'admin'
);
console.log('  Admin users created');

// ── Default settings ──────────────────────────────────────────
const settingsStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
settingsStmt.run('default_language', 'sv');
settingsStmt.run('supported_languages', JSON.stringify(['sv', 'en', 'ar', 'fa', 'so', 'ti']));
settingsStmt.run('site_name', 'Election Intelligence');
settingsStmt.run('site_name_sv', 'Valintelligens');
console.log('  Settings configured');

console.log('Seeding complete!');
