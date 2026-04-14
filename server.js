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

// API: Postcode search - lookup area, results, demographics
app.get(BASE + '/api/postcode/:code', (req, res) => {
  try {
    const pc = req.params.code.replace(/\s/g, '');
    if (!/^\d{5}$/.test(pc)) return res.status(400).json({ error: 'Invalid postcode format. Use 5 digits.' });

    // Find postcode mapping
    const mapping = db.prepare('SELECT * FROM postcodes WHERE postcode = ?').get(pc);
    if (!mapping) {
      // Try nearest match by prefix
      const prefix = pc.substring(0, 3);
      const nearest = db.prepare("SELECT * FROM postcodes WHERE postcode LIKE ? ORDER BY postcode LIMIT 1").get(prefix + '%');
      if (!nearest) return res.status(404).json({ error: 'Postcode not found. Try a different postcode.' });
      // Use nearest match
      Object.assign(mapping || {}, nearest);
      return handlePostcodeResult(nearest, res);
    }
    handlePostcodeResult(mapping, res);
  } catch (err) {
    console.error('Postcode search error:', err);
    res.status(500).json({ error: 'Failed to search postcode' });
  }
});

function handlePostcodeResult(mapping, res) {
  const countyCode = mapping.county_code;
  const munCode = mapping.municipality_code;

  // Get county info
  const county = db.prepare('SELECT * FROM counties WHERE code = ?').get(countyCode);

  // Get municipality info
  const municipality = munCode ? db.prepare('SELECT * FROM municipalities WHERE code = ?').get(munCode) : null;

  // Get election results for this county (2022 + 2018)
  const results2022 = db.prepare(`
    SELECT er.*, p.name as party_name, p.color as party_color
    FROM election_results er
    LEFT JOIN parties p ON p.code = er.party_code
    WHERE er.county_code = ? AND er.election_year = 2022 AND er.election_type = 'riksdag' AND er.level = 'county'
    ORDER BY er.votes DESC
  `).all(countyCode);

  const results2018 = db.prepare(`
    SELECT er.*, p.name as party_name, p.color as party_color
    FROM election_results er
    LEFT JOIN parties p ON p.code = er.party_code
    WHERE er.county_code = ? AND er.election_year = 2018 AND er.election_type = 'riksdag' AND er.level = 'county'
    ORDER BY er.votes DESC
  `).all(countyCode);

  // Get demographics
  const demographics = db.prepare(
    "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'county' ORDER BY data_year DESC LIMIT 1"
  ).get(countyCode);

  // Get neighboring postcodes in same county for context
  const nearbyPostcodes = db.prepare(
    'SELECT DISTINCT city FROM postcodes WHERE county_code = ? ORDER BY city LIMIT 10'
  ).all(countyCode);

  res.json({
    postcode: mapping.postcode,
    city: mapping.city,
    latitude: mapping.latitude,
    longitude: mapping.longitude,
    county: county ? { code: county.code, name: county.name, name_en: county.name_en, population: county.population } : null,
    municipality: municipality ? { code: municipality.code, name: municipality.name, population: municipality.population } : null,
    election_results: {
      '2022': results2022,
      '2018': results2018
    },
    demographics: demographics || null,
    nearby_cities: nearbyPostcodes.map(p => p.city)
  });
}

// API: AI Analysis of area
app.post(BASE + '/api/ai/analyze-area', express.json(), async (req, res) => {
  try {
    const { county_code, postcode, results_2022, results_2018, demographics } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

    // Build context for AI
    let prompt = `Du ar en svensk valanalytiker. Analysera foljande valdata for detta omrade.\n\n`;
    if (postcode) prompt += `Postnummer: ${postcode}\n`;
    if (req.body.county_name) prompt += `Lan: ${req.body.county_name}\n`;
    if (req.body.municipality_name) prompt += `Kommun: ${req.body.municipality_name}\n\n`;

    if (results_2022 && results_2022.length > 0) {
      prompt += `Riksdagsval 2022:\n`;
      results_2022.forEach(r => { prompt += `  ${r.party_code}: ${r.vote_percentage}%\n`; });
    }
    if (results_2018 && results_2018.length > 0) {
      prompt += `\nRiksdagsval 2018:\n`;
      results_2018.forEach(r => { prompt += `  ${r.party_code}: ${r.vote_percentage}%\n`; });
    }
    if (demographics) {
      prompt += `\nDemografi:\n`;
      prompt += `  Befolkning: ${demographics.population}\n`;
      prompt += `  Medianinkomst: ${demographics.median_income} SEK\n`;
      prompt += `  Medianålder: ${demographics.median_age}\n`;
      prompt += `  Utrikesfödda: ${demographics.foreign_born_pct}%\n`;
      prompt += `  Högre utbildning: ${demographics.higher_education_pct}%\n`;
      prompt += `  Arbetslöshet: ${demographics.unemployment_pct}%\n`;
    }

    prompt += `\nGe en kort analys (max 300 ord) pa svenska med:\n1. Politisk profil - vilken typ av omrade ar detta?\n2. Trender - hur har rostvariationen andrats mellan 2018 och 2022?\n3. Nyckelfaktorer - vilka demografiska faktorer paverkar rosten?\n4. Kampanjstrategi - vad bor en kampanj fokusera pa i detta omrade?\n\nSvara med ren text, ingen markdown-formattering.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await response.json();
    const analysis = aiData.content && aiData.content[0] ? aiData.content[0].text : 'AI analysis unavailable.';

    res.json({ analysis });
  } catch (err) {
    console.error('AI analysis error:', err);
    res.status(500).json({ error: 'AI analysis failed' });
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
