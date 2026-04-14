const db = require('./database');
const { v4: uuidv4 } = require('uuid');

console.log('Seeding county-level election results and demographics...');

// ── County populations (from counties table in seed.js) ─────────
const countyPops = {
  '01': 2415139, '03': 395026, '04': 299438, '05': 468494, '06': 365357,
  '07': 203340, '08': 246256, '09': 60124, '10': 159684, '12': 1402425,
  '13': 338535, '14': 1744859, '17': 283196, '18': 306792, '19': 278401,
  '20': 288178, '21': 287767, '22': 244297, '23': 132054, '24': 274377,
  '25': 250570,
};

// ── 2022 Riksdag county results (vote percentages) ──────────────
const data2022 = {
  '01': { S:24.5, M:24.8, SD:14.5, C:7.2, V:8.5, KD:5.8, L:6.2, MP:6.8 },
  '03': { S:26.2, M:22.5, SD:16.8, C:8.1, V:7.5, KD:5.2, L:5.8, MP:6.2 },
  '04': { S:33.5, M:17.2, SD:24.5, C:5.2, V:6.8, KD:4.5, L:3.5, MP:3.2 },
  '05': { S:31.2, M:18.5, SD:22.8, C:5.8, V:7.2, KD:5.0, L:4.2, MP:3.8 },
  '06': { S:22.5, M:19.2, SD:21.5, C:7.5, V:4.2, KD:14.8, L:4.5, MP:3.2 },
  '07': { S:28.5, M:17.8, SD:24.2, C:7.2, V:5.8, KD:7.5, L:3.8, MP:3.5 },
  '08': { S:30.2, M:17.5, SD:25.5, C:6.8, V:5.2, KD:6.2, L:3.5, MP:3.2 },
  '09': { S:32.8, M:18.2, SD:18.5, C:9.5, V:6.8, KD:4.2, L:4.5, MP:4.2 },
  '10': { S:30.5, M:16.2, SD:28.5, C:4.8, V:6.2, KD:5.5, L:3.2, MP:3.0 },
  '12': { S:26.8, M:20.5, SD:25.2, C:5.2, V:6.5, KD:5.8, L:4.5, MP:3.8 },
  '13': { S:24.5, M:23.2, SD:21.5, C:8.2, V:5.2, KD:7.5, L:4.8, MP:3.5 },
  '14': { S:29.5, M:20.2, SD:19.8, C:6.8, V:8.2, KD:5.5, L:4.5, MP:4.2 },
  '17': { S:35.5, M:16.2, SD:22.8, C:6.8, V:6.5, KD:4.2, L:3.5, MP:2.8 },
  '18': { S:33.8, M:18.5, SD:21.2, C:6.2, V:7.5, KD:4.8, L:3.8, MP:3.0 },
  '19': { S:34.2, M:17.8, SD:23.5, C:5.2, V:7.2, KD:4.5, L:3.5, MP:2.8 },
  '20': { S:37.2, M:15.5, SD:22.5, C:6.5, V:6.8, KD:3.8, L:3.2, MP:2.8 },
  '21': { S:37.5, M:15.2, SD:22.8, C:5.8, V:7.2, KD:3.8, L:3.2, MP:2.5 },
  '22': { S:37.8, M:15.5, SD:21.5, C:6.2, V:7.5, KD:3.8, L:3.2, MP:2.8 },
  '23': { S:32.5, M:15.8, SD:18.5, C:11.2, V:7.5, KD:3.5, L:3.8, MP:4.8 },
  '24': { S:34.2, M:17.5, SD:17.8, C:8.5, V:8.2, KD:3.5, L:4.2, MP:4.5 },
  '25': { S:40.5, M:13.2, SD:20.5, C:5.8, V:8.5, KD:3.2, L:3.0, MP:3.2 },
};

// ── Derive 2018 data: SD -3%, S -2%, M +1%, C +2%, V +1% ───────
const data2018 = {};
for (const [code, results] of Object.entries(data2022)) {
  data2018[code] = {
    S:  +(results.S  - 2).toFixed(1),
    M:  +(results.M  + 1).toFixed(1),
    SD: +(results.SD - 3).toFixed(1),
    C:  +(results.C  + 2).toFixed(1),
    V:  +(results.V  + 1).toFixed(1),
    KD: +results.KD.toFixed(1),
    L:  +results.L.toFixed(1),
    MP: +results.MP.toFixed(1),
  };
}

// ── Insert election results ─────────────────────────────────────
const resultStmt = db.prepare(`INSERT OR IGNORE INTO election_results
  (id, election_year, election_type, county_code, level, party_code,
   votes, vote_percentage, registered_voters, total_votes, turnout_percentage,
   valid_votes, blank_votes, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function insertCountyResults(year, dataSet) {
  const turnout = year === 2022 ? 0.84 : 0.87;
  let count = 0;

  const insertMany = db.transaction(() => {
    for (const [countyCode, partyResults] of Object.entries(dataSet)) {
      const pop = countyPops[countyCode];
      const registeredVoters = Math.round(pop * 0.65);
      const totalVotes = Math.round(registeredVoters * turnout);
      const blankVotes = Math.round(totalVotes * 0.012); // ~1.2% blank
      const validVotes = totalVotes - blankVotes;
      const turnoutPct = +(turnout * 100).toFixed(2);

      for (const [party, pct] of Object.entries(partyResults)) {
        const votes = Math.round(validVotes * (pct / 100));
        resultStmt.run(
          uuidv4(),
          year,
          'riksdag',
          countyCode,
          'county',
          party,
          votes,
          pct,
          registeredVoters,
          totalVotes,
          turnoutPct,
          validVotes,
          blankVotes,
          'val.se'
        );
        count++;
      }
    }
  });

  insertMany();
  return count;
}

const count2022 = insertCountyResults(2022, data2022);
console.log(`  2022 Riksdag county results: ${count2022} rows inserted`);

const count2018 = insertCountyResults(2018, data2018);
console.log(`  2018 Riksdag county results: ${count2018} rows inserted`);

// ── County Demographics (area_demographics) ─────────────────────
const demographics = [
  // code, population, median_age, median_income, foreign_born_pct, higher_ed_pct, unemployment_pct, avg_household_size
  ['01', 2415139, 38.0, 380000, 27.0, 52.0, 5.8, 2.1],
  ['03',  395026, 39.5, 345000, 20.0, 48.0, 5.2, 2.2],
  ['04',  299438, 42.5, 305000, 18.5, 28.0, 6.5, 2.1],
  ['05',  468494, 41.8, 320000, 17.2, 35.0, 6.0, 2.1],
  ['06',  365357, 41.5, 315000, 16.8, 30.0, 5.5, 2.3],
  ['07',  203340, 41.0, 310000, 18.0, 45.0, 6.0, 2.2],
  ['08',  246256, 43.2, 300000, 14.5, 27.0, 5.8, 2.1],
  ['09',   60124, 43.5, 305000, 12.0, 32.0, 5.0, 2.0],
  ['10',  159684, 43.0, 300000, 16.5, 28.0, 7.0, 2.0],
  ['12', 1402425, 39.0, 310000, 28.0, 40.0, 8.5, 2.2],
  ['13',  338535, 40.5, 330000, 15.5, 35.0, 5.2, 2.3],
  ['14', 1744859, 39.0, 340000, 24.0, 42.0, 6.2, 2.1],
  ['17',  283196, 43.5, 305000, 13.5, 28.0, 6.5, 2.0],
  ['18',  306792, 42.0, 315000, 18.0, 32.0, 6.0, 2.1],
  ['19',  278401, 42.5, 310000, 19.0, 29.0, 6.8, 2.1],
  ['20',  288178, 44.0, 310000, 12.0, 26.0, 6.2, 2.0],
  ['21',  287767, 44.2, 305000, 11.5, 25.0, 7.0, 2.0],
  ['22',  244297, 44.5, 310000, 10.5, 28.0, 6.5, 2.0],
  ['23',  132054, 43.8, 315000, 9.5, 32.0, 6.0, 2.0],
  ['24',  274377, 41.0, 330000, 11.0, 35.0, 6.2, 2.1],
  ['25',  250570, 44.8, 320000, 8.5, 30.0, 7.5, 2.0],
];

const demoStmt = db.prepare(`INSERT OR IGNORE INTO area_demographics
  (id, area_code, area_type, population, median_age, median_income,
   foreign_born_pct, higher_education_pct, unemployment_pct,
   avg_household_size, data_year)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const insertDemographics = db.transaction(() => {
  demographics.forEach(d => {
    demoStmt.run(
      uuidv4(),
      d[0],       // area_code
      'county',   // area_type
      d[1],       // population
      d[2],       // median_age
      d[3],       // median_income
      d[4],       // foreign_born_pct
      d[5],       // higher_education_pct
      d[6],       // unemployment_pct
      d[7],       // avg_household_size
      2023         // data_year
    );
  });
});

insertDemographics();
console.log(`  ${demographics.length} county demographics inserted`);

console.log('County results and demographics seeding complete!');
