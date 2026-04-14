require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3020;
const BASE = process.env.BASE_PATH || '/election';

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(BASE + '/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(BASE, express.static(path.join(__dirname, 'public')));

// API routes
app.use(BASE + '/api/auth', require('./routes/auth'));
app.use(BASE + '/api/geo', require('./routes/geo'));
app.use(BASE + '/api/campaigns', require('./routes/campaigns'));
app.use(BASE + '/api/voters', require('./routes/voters'));
app.use(BASE + '/api/contacts', require('./routes/contacts'));
app.use(BASE + '/api/results', require('./routes/results'));
app.use(BASE + '/api/admin', require('./routes/admin'));

// API: Get election results for map visualization
app.get(BASE + '/api/map/results', (req, res) => {
  try {
    const { year, type, level } = req.query;
    const elYear = parseInt(year) || 2022;
    const elType = type || 'riksdag';
    const elLevel = level || 'county';

    let codeCol;
    if (elLevel === 'county') codeCol = 'county_code';
    else if (elLevel === 'municipality') codeCol = 'municipality_code';
    else codeCol = 'district_code';

    const results = db.prepare(`
      SELECT ${codeCol} as area_code, party_code, votes, vote_percentage, turnout_percentage
      FROM election_results
      WHERE election_year = ? AND election_type = ? AND level = ? AND ${codeCol} IS NOT NULL
      ORDER BY ${codeCol}, votes DESC
    `).all(elYear, elType, elLevel);

    // Group by area
    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.area_code]) grouped[r.area_code] = { parties: [], turnout: r.turnout_percentage };
      grouped[r.area_code].parties.push({
        party: r.party_code,
        votes: r.votes,
        pct: r.vote_percentage
      });
    });

    res.json({ year: elYear, type: elType, level: elLevel, areas: grouped });
  } catch (err) {
    console.error('Map results error:', err);
    res.status(500).json({ error: 'Failed to get map data' });
  }
});

// API: Dashboard stats
app.get(BASE + '/api/dashboard', (req, res) => {
  try {
    const counties = db.prepare('SELECT COUNT(*) as c FROM counties').get().c;
    const municipalities = db.prepare('SELECT COUNT(*) as c FROM municipalities').get().c;
    const parties = db.prepare('SELECT COUNT(*) as c FROM parties').get().c;
    const elections = db.prepare('SELECT COUNT(DISTINCT election_year || election_type) as c FROM election_results').get().c;
    const resultRows = db.prepare('SELECT COUNT(*) as c FROM election_results').get().c;
    const voters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
    const contacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
    const campaigns = db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c;

    res.json({
      counties, municipalities, parties, elections, resultRows, voters, contacts, campaigns,
      availableYears: db.prepare('SELECT DISTINCT election_year FROM election_results ORDER BY election_year DESC').all().map(r => r.election_year)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// SPA fallback
app.get(BASE + '/*', (req, res) => {
  if (req.path.startsWith(BASE + '/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Election Intelligence running on port ${PORT}`);
  console.log(`${BASE} -> http://localhost:${PORT}${BASE}`);
});
