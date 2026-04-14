const db = require('./database');

console.log('Seeding Swedish postcodes...');

// ── Create postcodes table ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS postcodes (
    postcode TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    municipality_code TEXT,
    county_code TEXT NOT NULL,
    latitude REAL,
    longitude REAL
  );

  CREATE INDEX IF NOT EXISTS idx_postcodes_county ON postcodes(county_code);
  CREATE INDEX IF NOT EXISTS idx_postcodes_municipality ON postcodes(municipality_code);
`);

// ── Postcode range definitions ────────────────────────────────────
// Each entry: [startCode, endCode, city, municipalityCode, countyCode, lat, lng]
const postcodeRanges = [
  // ═══ Stockholm County (01) ═══
  [10000, 11999, 'Stockholm',    '0180', '01', 59.3293, 18.0686],
  [12000, 12999, 'Stockholm',    '0180', '01', 59.2985, 18.0510],
  [13000, 13999, 'Nacka',        '0182', '01', 59.3108, 18.1639],
  [14000, 14999, 'Huddinge',     '0126', '01', 59.2373, 17.9818],
  [15000, 15599, 'Sodertalje',   '0181', '01', 59.1955, 17.6253],
  [16000, 16999, 'Stockholm',    '0180', '01', 59.3600, 17.9400],
  [17000, 17499, 'Solna',        '0184', '01', 59.3600, 18.0000],
  [17500, 17999, 'Sundbyberg',   '0183', '01', 59.3614, 17.9721],
  [18000, 18299, 'Lidingo',      '0186', '01', 59.3667, 18.1500],
  [18300, 18599, 'Danderyd',     '0162', '01', 59.3993, 18.0294],
  [18600, 18799, 'Vallentuna',   '0115', '01', 59.5340, 18.0780],
  [18800, 18999, 'Taby',         '0160', '01', 59.4437, 18.0688],
  [19000, 19999, 'Sigtuna',      '0191', '01', 59.6162, 17.7246],

  // ═══ Skane County (12) ═══
  [20000, 21999, 'Malmo',        '1280', '12', 55.6050, 13.0038],
  [22000, 22999, 'Lund',         '1281', '12', 55.7047, 13.1910],
  [23000, 23999, 'Trelleborg',   '1287', '12', 55.3764, 13.1574],
  [24000, 24999, 'Eslov',        '1285', '12', 55.8393, 13.3539],
  [25000, 25999, 'Helsingborg',  '1283', '12', 56.0465, 12.6945],
  [26000, 26999, 'Landskrona',   '1282', '12', 55.8708, 12.8302],
  [27000, 27499, 'Ystad',        '1286', '12', 55.4295, 13.8200],
  [27500, 27999, 'Simrishamn',   '1291', '12', 55.5565, 14.3499],
  [28000, 28999, 'Kristianstad', '1290', '12', 56.0294, 14.1567],
  [29000, 29999, 'Hassleholm',   '1293', '12', 56.1591, 13.7665],

  // ═══ Halland County (13) ═══
  [30000, 30999, 'Halmstad',     '1380', '13', 56.6745, 12.8578],
  [31000, 31499, 'Falkenberg',   '1382', '13', 56.9055, 12.4914],
  [31500, 31999, 'Varberg',      '1383', '13', 57.1057, 12.2508],

  // ═══ Kronoberg County (07) ═══
  [35000, 35999, 'Vaxjo',        '0780', '07', 56.8777, 14.8091],

  // ═══ Blekinge County (10) ═══
  [37000, 37999, 'Karlskrona',   '1080', '10', 56.1612, 15.5869],

  // ═══ Kalmar County (08) ═══
  [39000, 39999, 'Kalmar',       '0880', '08', 56.6634, 16.3566],

  // ═══ Vastra Gotaland County (14) ═══
  [40000, 41999, 'Goteborg',     '1480', '14', 57.7089, 11.9746],
  [42000, 42999, 'Goteborg',     '1480', '14', 57.7350, 11.9500],
  [43000, 43499, 'Molndal',      '1481', '14', 57.6557, 12.0154],
  [43500, 43999, 'Kungalv',      '1482', '14', 57.8710, 11.9807],
  [44000, 44999, 'Stenungsund',  '1415', '14', 58.0733, 11.8197],
  [45000, 45499, 'Uddevalla',    '1485', '14', 58.3499, 11.9381],
  [45500, 45999, 'Trollhattan',  '1488', '14', 58.2838, 12.2867],
  [46000, 46999, 'Vanersborg',   '1487', '14', 58.3807, 12.3234],
  [50000, 50999, 'Boras',        '1490', '14', 57.7210, 12.9401],
  [51000, 51499, 'Skovde',       '1492', '14', 58.3925, 13.8460],
  [51500, 51999, 'Falkoping',    '1499', '14', 58.1732, 13.5513],
  [52000, 52499, 'Lidkoping',    '1494', '14', 58.5052, 13.1581],
  [52500, 52999, 'Skara',        '1495', '14', 58.3867, 13.4387],
  [54000, 54999, 'Mariestad',    '1493', '14', 58.7098, 13.8237],

  // ═══ Jonkoping County (06) ═══
  [55000, 55999, 'Jonkoping',    '0680', '06', 57.7826, 14.1618],

  // ═══ Ostergotland County (05) ═══
  [58000, 58999, 'Linkoping',    '0580', '05', 58.4108, 15.6214],
  [60000, 60999, 'Norrkoping',   '0581', '05', 58.5942, 16.1826],

  // ═══ Sodermanland County (04) ═══
  [61000, 61999, 'Nykoping',     '0480', '04', 58.7530, 17.0086],
  [63000, 63999, 'Eskilstuna',   '0484', '04', 59.3712, 16.5099],

  // ═══ Gotland County (09) ═══
  [62000, 62999, 'Visby',        '0980', '09', 57.6389, 18.2948],

  // ═══ Varmland County (17) ═══
  [65000, 65999, 'Karlstad',     '1780', '17', 59.3793, 13.5036],

  // ═══ Orebro County (18) ═══
  [70000, 70999, 'Orebro',       '1880', '18', 59.2753, 15.2134],

  // ═══ Vastmanland County (19) ═══
  [72000, 72999, 'Vasteras',     '1980', '19', 59.6099, 16.5448],

  // ═══ Uppsala County (03) ═══
  [74000, 74999, 'Enkoping',     '0381', '03', 59.6357, 17.0775],
  [75000, 75999, 'Uppsala',      '0380', '03', 59.8586, 17.6389],

  // ═══ Dalarna County (20) ═══
  [78000, 78999, 'Borlange',     '2081', '20', 60.4856, 15.4372],
  [79000, 79999, 'Falun',        '2080', '20', 60.6065, 15.6355],

  // ═══ Gavleborg County (21) ═══
  [80000, 80999, 'Gavle',        '2180', '21', 60.6749, 17.1413],

  // ═══ Jamtland County (23) ═══
  [83000, 83999, 'Ostersund',    '2380', '23', 63.1792, 14.6357],

  // ═══ Vasternorrland County (22) ═══
  [85000, 85999, 'Sundsvall',    '2280', '22', 62.3908, 17.3069],
  [87000, 87999, 'Harnosand',    '2281', '22', 62.6323, 17.9379],

  // ═══ Vasterbotten County (24) ═══
  [90000, 90999, 'Umea',         '2480', '24', 63.8258, 20.2630],
  [93000, 93999, 'Skelleftea',   '2481', '24', 64.7507, 20.9528],

  // ═══ Norrbotten County (25) ═══
  [94000, 94999, 'Pitea',        '2581', '25', 65.3173, 21.4798],
  [96000, 96999, 'Boden',        '2582', '25', 66.0050, 21.6886],
  [97000, 97999, 'Lulea',        '2580', '25', 65.5848, 22.1547],
  [98000, 98999, 'Kiruna',       '2584', '25', 67.8558, 20.2253],
];

// ── Prepare insert statement ──────────────────────────────────────
const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO postcodes (postcode, city, municipality_code, county_code, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)'
);

// ── Insert postcodes in a transaction ─────────────────────────────
let insertedCount = 0;

const insertAll = db.transaction(() => {
  for (const [start, end, city, munCode, countyCode, lat, lng] of postcodeRanges) {
    for (let code = start; code <= end; code += 10) {
      const postcode = String(code).padStart(5, '0');
      const result = insertStmt.run(postcode, city, munCode, countyCode, lat, lng);
      if (result.changes > 0) {
        insertedCount++;
      }
    }
  }
});

insertAll();

console.log(`  ${insertedCount} postcodes inserted into postcodes table`);
console.log('Postcode seeding complete.');
