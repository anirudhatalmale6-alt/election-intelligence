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

  const county = db.prepare('SELECT * FROM counties WHERE code = ?').get(countyCode);
  const municipality = munCode ? db.prepare('SELECT * FROM municipalities WHERE code = ?').get(munCode) : null;

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

  const demographics = db.prepare(
    "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'county' ORDER BY data_year DESC LIMIT 1"
  ).get(countyCode);

  const nearbyPostcodes = db.prepare(
    'SELECT DISTINCT city FROM postcodes WHERE county_code = ? ORDER BY city LIMIT 10'
  ).all(countyCode);

  // Auto-save to postcode_searches database
  try {
    const top2022 = results2022[0] || {};
    const top2018 = results2018[0] || {};
    const existing = db.prepare('SELECT id, search_count FROM postcode_searches WHERE postcode = ?').get(mapping.postcode);
    if (existing) {
      db.prepare('UPDATE postcode_searches SET search_count = search_count + 1, last_searched_at = datetime(\'now\') WHERE id = ?').run(existing.id);
    } else {
      const { v4: uuidv4 } = require('uuid');
      db.prepare(`INSERT INTO postcode_searches (id, postcode, city, county_code, county_name, municipality_code, municipality_name,
        population_county, population_municipality, top_party_2022, top_party_pct_2022, top_party_2018, top_party_pct_2018,
        turnout_2022, demographics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuidv4(), mapping.postcode, mapping.city, countyCode, county ? county.name : null,
        munCode, municipality ? municipality.name : null,
        county ? county.population : null, municipality ? municipality.population : null,
        top2022.party_code || null, top2022.vote_percentage || null,
        top2018.party_code || null, top2018.vote_percentage || null,
        top2022.turnout_percentage || null,
        demographics ? JSON.stringify(demographics) : null);
    }
  } catch (e) { /* ignore save errors */ }

  // Count voters in this area
  const voterCount = db.prepare('SELECT COUNT(*) as c FROM voters WHERE postcode = ?').get(mapping.postcode).c;

  res.json({
    postcode: mapping.postcode,
    city: mapping.city,
    latitude: mapping.latitude,
    longitude: mapping.longitude,
    county: county ? { code: county.code, name: county.name, name_en: county.name_en, population: county.population } : null,
    municipality: municipality ? { code: municipality.code, name: municipality.name, population: municipality.population } : null,
    election_results: { '2022': results2022, '2018': results2018 },
    demographics: demographics || null,
    nearby_cities: nearbyPostcodes.map(p => p.city),
    voters_in_area: voterCount
  });
}

// API: List saved postcode searches
app.get(BASE + '/api/postcode-searches', (req, res) => {
  try {
    const { county, sort } = req.query;
    let where = '';
    const params = [];
    if (county) { where = 'WHERE county_code = ?'; params.push(county); }
    const orderBy = sort === 'count' ? 'search_count DESC' : 'last_searched_at DESC';
    const rows = db.prepare(`SELECT * FROM postcode_searches ${where} ORDER BY ${orderBy} LIMIT 200`).all(...params);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get saved searches' });
  }
});

// API: Add voter manually (with postcode lookup)
app.post(BASE + '/api/voters/add-manual', express.json(), (req, res) => {
  try {
    const { first_name, last_name, address, postcode, city, phone, email, age_group, gender, campaign_id, notes } = req.body;
    if (!first_name && !last_name) return res.status(400).json({ error: 'Name is required' });

    const { v4: uuidv4 } = require('uuid');

    // Lookup postcode to get municipality/county
    let municipalityId = null;
    let districtId = null;
    if (postcode) {
      const pcMapping = db.prepare('SELECT * FROM postcodes WHERE postcode = ?').get(postcode.replace(/\s/g, ''));
      if (pcMapping && pcMapping.municipality_code) {
        const mun = db.prepare('SELECT id FROM municipalities WHERE code = ?').get(pcMapping.municipality_code);
        if (mun) municipalityId = mun.id;
      }
    }

    // Use first available campaign or null
    let campId = campaign_id || null;
    if (!campId) {
      const firstCamp = db.prepare('SELECT id FROM campaigns LIMIT 1').get();
      campId = firstCamp ? firstCamp.id : null;
    }

    // If no campaign exists, create a default one
    if (!campId) {
      campId = uuidv4();
      db.prepare('INSERT INTO campaigns (id, name, election_type, status) VALUES (?, ?, ?, ?)').run(campId, 'Standard', 'riksdag', 'active');
    }

    const voterId = uuidv4();
    const fullName = [first_name, last_name].filter(Boolean).join(' ');
    db.prepare(`INSERT INTO voters (id, campaign_id, first_name, last_name, full_name, address, postcode, city, municipality_id, phone, email, age_group, gender, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(voterId, campId, first_name || null, last_name || null, fullName,
      address || null, postcode || null, city || null, municipalityId,
      phone || null, email || null, age_group || null, gender || null, notes || null);

    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(voterId);
    res.status(201).json({ data: voter });
  } catch (err) {
    console.error('Error adding voter:', err);
    res.status(500).json({ error: 'Failed to add voter' });
  }
});

// API: Bulk add voters from CSV/JSON (with postcode matching)
app.post(BASE + '/api/voters/bulk-import', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { voters: voterList, campaign_id } = req.body;
    if (!Array.isArray(voterList) || voterList.length === 0) return res.status(400).json({ error: 'voters array required' });

    const { v4: uuidv4 } = require('uuid');

    // Ensure campaign exists
    let campId = campaign_id;
    if (!campId) {
      const firstCamp = db.prepare('SELECT id FROM campaigns LIMIT 1').get();
      campId = firstCamp ? firstCamp.id : uuidv4();
      if (!firstCamp) {
        db.prepare('INSERT INTO campaigns (id, name, election_type, status) VALUES (?, ?, ?, ?)').run(campId, 'Import', 'riksdag', 'active');
      }
    }

    const insert = db.prepare(`INSERT INTO voters (id, campaign_id, first_name, last_name, full_name, address, postcode, city, municipality_id, phone, email, age_group, gender, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    let imported = 0;
    const importMany = db.transaction((list) => {
      for (const v of list) {
        try {
          let munId = null;
          if (v.postcode) {
            const pc = db.prepare('SELECT municipality_code FROM postcodes WHERE postcode = ?').get(String(v.postcode).replace(/\s/g, ''));
            if (pc && pc.municipality_code) {
              const mun = db.prepare('SELECT id FROM municipalities WHERE code = ?').get(pc.municipality_code);
              if (mun) munId = mun.id;
            }
          }
          const fn = v.first_name || v.fornamn || '';
          const ln = v.last_name || v.efternamn || '';
          const full = v.full_name || v.namn || [fn, ln].filter(Boolean).join(' ');
          insert.run(uuidv4(), campId, fn || null, ln || null, full,
            v.address || v.adress || null, v.postcode || v.postnummer || null,
            v.city || v.ort || null, munId,
            v.phone || v.telefon || null, v.email || v.epost || null,
            v.age_group || v.alder || null, v.gender || v.kon || null,
            v.notes || v.anteckningar || null);
          imported++;
        } catch (e) { /* skip duplicates */ }
      }
    });
    importMany(voterList);

    res.status(201).json({ message: `Imported ${imported} of ${voterList.length} voters`, imported });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Failed to import voters' });
  }
});

// ═══ AI POLICIES CRUD ═══
app.get(BASE + '/api/ai/policies', (req, res) => {
  try {
    const policies = db.prepare('SELECT * FROM ai_policies WHERE is_active = 1 ORDER BY sort_order, name').all();
    res.json({ data: policies });
  } catch (err) { res.status(500).json({ error: 'Failed to get policies' }); }
});

app.get(BASE + '/api/ai/policies/all', (req, res) => {
  try {
    const policies = db.prepare('SELECT * FROM ai_policies ORDER BY sort_order, name').all();
    res.json({ data: policies });
  } catch (err) { res.status(500).json({ error: 'Failed to get policies' }); }
});

app.post(BASE + '/api/ai/policies', express.json(), (req, res) => {
  try {
    const { name, name_en, description, icon, color, prompt_template, sort_order } = req.body;
    if (!name || !prompt_template) return res.status(400).json({ error: 'name and prompt_template required' });
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare('INSERT INTO ai_policies (id, name, name_en, description, icon, color, prompt_template, sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, name_en || null, description || null, icon || 'fa-robot', color || '#c9a227', prompt_template, sort_order || 0);
    const policy = db.prepare('SELECT * FROM ai_policies WHERE id = ?').get(id);
    res.status(201).json({ data: policy });
  } catch (err) { res.status(500).json({ error: 'Failed to create policy' }); }
});

app.put(BASE + '/api/ai/policies/:id', express.json(), (req, res) => {
  try {
    const policy = db.prepare('SELECT * FROM ai_policies WHERE id = ?').get(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const { name, name_en, description, icon, color, prompt_template, is_active, sort_order } = req.body;
    db.prepare(`UPDATE ai_policies SET name=COALESCE(?,name), name_en=COALESCE(?,name_en), description=COALESCE(?,description),
      icon=COALESCE(?,icon), color=COALESCE(?,color), prompt_template=COALESCE(?,prompt_template),
      is_active=COALESCE(?,is_active), sort_order=COALESCE(?,sort_order), updated_at=datetime('now') WHERE id=?`)
      .run(name||null, name_en||null, description||null, icon||null, color||null, prompt_template||null,
        is_active!==undefined?is_active:null, sort_order!==undefined?sort_order:null, req.params.id);
    const updated = db.prepare('SELECT * FROM ai_policies WHERE id = ?').get(req.params.id);
    res.json({ data: updated });
  } catch (err) { res.status(500).json({ error: 'Failed to update policy' }); }
});

app.delete(BASE + '/api/ai/policies/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM ai_policies WHERE id = ?').run(req.params.id);
    res.json({ message: 'Policy deleted' });
  } catch (err) { res.status(500).json({ error: 'Failed to delete policy' }); }
});

// API: AI Analysis of area (with policy support)
app.post(BASE + '/api/ai/analyze-area', express.json(), async (req, res) => {
  try {
    const { county_code, postcode, results_2022, results_2018, demographics, policy_id } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

    // Build area data string
    let areaData = '';
    if (postcode) areaData += `Postnummer: ${postcode}\n`;
    if (req.body.county_name) areaData += `Lan: ${req.body.county_name}\n`;
    if (req.body.municipality_name) areaData += `Kommun: ${req.body.municipality_name}\n`;
    areaData += '\n';

    if (results_2022 && results_2022.length > 0) {
      areaData += `Riksdagsval 2022:\n`;
      results_2022.forEach(r => { areaData += `  ${r.party_code}: ${r.vote_percentage}%\n`; });
    }
    if (results_2018 && results_2018.length > 0) {
      areaData += `\nRiksdagsval 2018:\n`;
      results_2018.forEach(r => { areaData += `  ${r.party_code}: ${r.vote_percentage}%\n`; });
    }
    if (demographics) {
      areaData += `\nDemografi:\n`;
      areaData += `  Befolkning: ${demographics.population}\n`;
      areaData += `  Medianinkomst: ${demographics.median_income} SEK\n`;
      areaData += `  Mediainalder: ${demographics.median_age}\n`;
      areaData += `  Utrikesfoddda: ${demographics.foreign_born_pct}%\n`;
      areaData += `  Hogre utbildning: ${demographics.higher_education_pct}%\n`;
      areaData += `  Arbetsloshet: ${demographics.unemployment_pct}%\n`;
    }

    // Get policy prompt template or use default
    let prompt;
    if (policy_id) {
      const policy = db.prepare('SELECT * FROM ai_policies WHERE id = ?').get(policy_id);
      if (policy) {
        prompt = policy.prompt_template.replace('{area_data}', areaData);
      }
    }
    if (!prompt) {
      prompt = `Du ar en svensk valanalytiker. Analysera foljande valdata for detta omrade.\n\n${areaData}\nGe en kort analys (max 300 ord) pa svenska med:\n1. Politisk profil\n2. Trender mellan 2018 och 2022\n3. Nyckelfaktorer\n4. Kampanjstrategi\n\nSvara med ren text, ingen markdown-formattering.`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
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
