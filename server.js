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

// ═══════════════════════════════════════════════════════════
// FEATURE 1: VALDISTRIKT INTELLIGENCE
// ═══════════════════════════════════════════════════════════

// GET /api/districts/search?q= - search districts by name/code/postcode
app.get(BASE + '/api/districts/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ data: [] });

    const like = '%' + q + '%';
    const rows = db.prepare(`
      SELECT vd.id, vd.code, vd.name, vd.population, vd.registered_voters,
             m.name as municipality_name, m.code as municipality_code,
             c.name as county_name, c.code as county_code
      FROM voting_districts vd
      LEFT JOIN municipalities m ON m.id = vd.municipality_id
      LEFT JOIN counties c ON c.id = m.county_id
      WHERE vd.name LIKE ? OR vd.code LIKE ? OR m.name LIKE ? OR vd.postcodes LIKE ?
      ORDER BY vd.name
      LIMIT 30
    `).all(like, like, like, like);

    res.json({ data: rows });
  } catch (err) {
    console.error('District search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/districts/:code/intelligence - unified intelligence card
app.get(BASE + '/api/districts/:code/intelligence', (req, res) => {
  try {
    const code = req.params.code;

    // Get district
    const district = db.prepare(`
      SELECT vd.*, m.name as municipality_name, m.code as municipality_code,
             c.name as county_name, c.code as county_code
      FROM voting_districts vd
      LEFT JOIN municipalities m ON m.id = vd.municipality_id
      LEFT JOIN counties c ON c.id = m.county_id
      WHERE vd.code = ? OR vd.id = ?
    `).get(code, code);

    if (!district) return res.status(404).json({ error: 'District not found' });

    // Election results 2022
    const results2022 = db.prepare(`
      SELECT er.party_code, er.votes, er.vote_percentage, er.turnout_percentage, er.total_votes,
             p.name as party_name, p.color as party_color
      FROM election_results er
      LEFT JOIN parties p ON p.code = er.party_code
      WHERE er.district_code = ? AND er.election_year = 2022
      ORDER BY er.votes DESC
    `).all(district.code);

    // Election results 2018
    const results2018 = db.prepare(`
      SELECT er.party_code, er.votes, er.vote_percentage, er.turnout_percentage, er.total_votes,
             p.name as party_name, p.color as party_color
      FROM election_results er
      LEFT JOIN parties p ON p.code = er.party_code
      WHERE er.district_code = ? AND er.election_year = 2018
      ORDER BY er.votes DESC
    `).all(district.code);

    // If no district-level results, try municipality level
    let elResults2022 = results2022;
    let elResults2018 = results2018;
    let resultsLevel = 'district';
    if (elResults2022.length === 0 && district.municipality_code) {
      elResults2022 = db.prepare(`
        SELECT er.party_code, er.votes, er.vote_percentage, er.turnout_percentage, er.total_votes,
               p.name as party_name, p.color as party_color
        FROM election_results er
        LEFT JOIN parties p ON p.code = er.party_code
        WHERE er.municipality_code = ? AND er.election_year = 2022 AND er.level = 'municipality'
        ORDER BY er.votes DESC
      `).all(district.municipality_code);
      elResults2018 = db.prepare(`
        SELECT er.party_code, er.votes, er.vote_percentage, er.turnout_percentage, er.total_votes,
               p.name as party_name, p.color as party_color
        FROM election_results er
        LEFT JOIN parties p ON p.code = er.party_code
        WHERE er.municipality_code = ? AND er.election_year = 2018 AND er.level = 'municipality'
        ORDER BY er.votes DESC
      `).all(district.municipality_code);
      resultsLevel = 'municipality';
    }

    // Demographics — try district, then municipality, then county
    let demographics = db.prepare(
      "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'district' ORDER BY data_year DESC LIMIT 1"
    ).get(district.code);
    if (!demographics && district.municipality_code) {
      demographics = db.prepare(
        "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'municipality' ORDER BY data_year DESC LIMIT 1"
      ).get(district.municipality_code);
    }
    if (!demographics && district.county_code) {
      demographics = db.prepare(
        "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'county' ORDER BY data_year DESC LIMIT 1"
      ).get(district.county_code);
    }

    // Campaign activity stats (across all campaigns)
    const campaignStats = db.prepare(`
      SELECT
        COUNT(DISTINCT v.id) as total_voters,
        COUNT(DISTINCT CASE WHEN v.is_contacted = 1 THEN v.id END) as contacted_voters,
        COUNT(DISTINCT CASE WHEN v.support_status = 'supporter' THEN v.id END) as supporters,
        COUNT(DISTINCT CASE WHEN v.support_status = 'soft_yes' THEN v.id END) as soft_yes,
        COUNT(DISTINCT CASE WHEN v.support_status = 'undecided' THEN v.id END) as undecided,
        COUNT(DISTINCT CASE WHEN v.support_status = 'opposition' THEN v.id END) as opposition,
        COUNT(c.id) as total_contacts,
        AVG(v.ai_support_score) as avg_ai_score
      FROM voters v
      LEFT JOIN contacts c ON c.voter_id = v.id
      WHERE v.district_id = ?
    `).get(district.id);

    // Compute AI district score (0-100)
    // Based on: turnout trend, demographics, campaign penetration, support signals
    let aiScore = 50;
    if (elResults2022.length > 0 && elResults2018.length > 0) {
      const turnout2022 = elResults2022[0] ? elResults2022[0].turnout_percentage || 0 : 0;
      const turnout2018 = elResults2018[0] ? elResults2018[0].turnout_percentage || 0 : 0;
      const turnoutTrend = turnout2022 - turnout2018;
      aiScore += turnoutTrend * 0.5;
    }
    if (demographics) {
      if (demographics.higher_education_pct) aiScore += (demographics.higher_education_pct - 30) * 0.1;
      if (demographics.unemployment_pct) aiScore -= demographics.unemployment_pct * 0.3;
      if (demographics.median_income) aiScore += (demographics.median_income / 350000 - 1) * 5;
    }
    if (campaignStats && campaignStats.total_voters > 0) {
      const contactRate = campaignStats.contacted_voters / campaignStats.total_voters;
      aiScore += contactRate * 10;
      const supportRate = (campaignStats.supporters + campaignStats.soft_yes) / Math.max(campaignStats.total_voters, 1);
      aiScore += supportRate * 15;
    }
    aiScore = Math.max(0, Math.min(100, Math.round(aiScore)));

    res.json({
      district,
      election_results: { '2022': elResults2022, '2018': elResults2018, results_level: resultsLevel },
      demographics,
      campaign_stats: campaignStats,
      ai_score: aiScore
    });
  } catch (err) {
    console.error('District intelligence error:', err);
    res.status(500).json({ error: 'Failed to get district intelligence' });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE 2: CALL RULES & QUEUE
// ═══════════════════════════════════════════════════════════

// GET /api/call-rules/:campaignId
app.get(BASE + '/api/call-rules/:campaignId', (req, res) => {
  try {
    const rules = db.prepare('SELECT * FROM call_rules WHERE campaign_id = ? ORDER BY created_at DESC').all(req.params.campaignId);
    res.json({ data: rules });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get call rules' });
  }
});

// POST /api/call-rules
app.post(BASE + '/api/call-rules', (req, res) => {
  try {
    const { campaign_id, rule_type, rule_value } = req.body;
    if (!campaign_id || !rule_type || rule_value === undefined) {
      return res.status(400).json({ error: 'campaign_id, rule_type, rule_value required' });
    }
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare('INSERT INTO call_rules (id, campaign_id, rule_type, rule_value) VALUES (?,?,?,?)')
      .run(id, campaign_id, rule_type, String(rule_value));
    const rule = db.prepare('SELECT * FROM call_rules WHERE id = ?').get(id);
    res.status(201).json({ data: rule });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create call rule' });
  }
});

// DELETE /api/call-rules/:id
app.delete(BASE + '/api/call-rules/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM call_rules WHERE id = ?').run(req.params.id);
    res.json({ message: 'Rule deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

// GET /api/call-queue/:campaignId - get next batch applying rules
app.get(BASE + '/api/call-queue/:campaignId', (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    const batchSize = parseInt(req.query.limit) || 20;

    // Fetch active rules
    const rules = db.prepare("SELECT * FROM call_rules WHERE campaign_id = ? AND is_active = 1").all(campaignId);
    const ruleMap = {};
    rules.forEach(r => { ruleMap[r.rule_type] = r.rule_value; });

    // Quiet hours check (default 09:00–20:00)
    const quietStart = ruleMap['quiet_hours_start'] || '09:00';
    const quietEnd = ruleMap['quiet_hours_end'] || '20:00';
    const nowH = new Date().getHours();
    const nowM = new Date().getMinutes();
    const nowMins = nowH * 60 + nowM;
    const [qsh, qsm] = quietStart.split(':').map(Number);
    const [qeh, qem] = quietEnd.split(':').map(Number);
    const inQuiet = nowMins < (qsh * 60 + qsm) || nowMins >= (qeh * 60 + qem);
    if (inQuiet) {
      return res.json({ data: [], quiet_hours: true, message: `Calling allowed ${quietStart}–${quietEnd} only` });
    }

    const maxPerWeek = ruleMap['max_per_week'] ? parseInt(ruleMap['max_per_week']) : null;
    const maxTotal = ruleMap['max_total'] ? parseInt(ruleMap['max_total']) : null;
    const autoStopOutcome = ruleMap['auto_stop_outcome'] || null;
    const requeueDays = ruleMap['requeue_days'] ? parseInt(ruleMap['requeue_days']) : null;

    // Build exclusion conditions
    let excludeSubquery = '';
    const params = [campaignId];

    if (autoStopOutcome) {
      excludeSubquery += ` AND v.support_status != ?`;
      params.push(autoStopOutcome);
    }

    if (maxTotal !== null) {
      excludeSubquery += ` AND v.contact_count < ?`;
      params.push(maxTotal);
    }

    if (maxPerWeek !== null) {
      excludeSubquery += ` AND (
        SELECT COUNT(*) FROM contacts c2
        WHERE c2.voter_id = v.id AND c2.created_at > datetime('now', '-7 days')
      ) < ?`;
      params.push(maxPerWeek);
    }

    if (requeueDays !== null) {
      // Include voters not contacted, OR contacted more than requeueDays ago
      excludeSubquery += ` AND (v.last_contacted_at IS NULL OR v.last_contacted_at < datetime('now', '-' || ? || ' days'))`;
      params.push(requeueDays);
    } else {
      // Default: skip recently contacted (within 24h)
      excludeSubquery += ` AND (v.last_contacted_at IS NULL OR v.last_contacted_at < datetime('now', '-1 day'))`;
    }

    // Exclude dequeued voters
    excludeSubquery += ` AND (SELECT COUNT(*) FROM call_queue cq WHERE cq.voter_id = v.id AND cq.campaign_id = ? AND cq.status = 'dequeued') = 0`;
    params.push(campaignId);

    params.push(batchSize);

    const voters = db.prepare(`
      SELECT v.*,
             (SELECT COUNT(*) FROM contacts c WHERE c.voter_id = v.id) as total_contacts_real
      FROM voters v
      WHERE v.campaign_id = ? ${excludeSubquery}
        AND v.phone IS NOT NULL AND v.phone != ''
      ORDER BY
        CASE WHEN v.support_status = 'undecided' THEN 0
             WHEN v.support_status = 'unknown' THEN 1
             WHEN v.support_status = 'soft_yes' THEN 2
             ELSE 3 END,
        COALESCE(v.ai_priority_rank, 999),
        v.contact_count ASC
      LIMIT ?
    `).all(...params);

    res.json({ data: voters, rules_applied: ruleMap });
  } catch (err) {
    console.error('Call queue error:', err);
    res.status(500).json({ error: 'Failed to get call queue' });
  }
});

// POST /api/call-queue/complete
app.post(BASE + '/api/call-queue/complete', (req, res) => {
  try {
    const { voter_id, campaign_id, outcome, notes, agent_id } = req.body;
    if (!voter_id || !campaign_id || !outcome) {
      return res.status(400).json({ error: 'voter_id, campaign_id, outcome required' });
    }
    const { v4: uuidv4 } = require('uuid');
    // Insert contact record
    db.prepare(`INSERT INTO contacts (id, voter_id, campaign_id, agent_id, contact_type, outcome, notes)
      VALUES (?,?,?,?,?,?,?)`)
      .run(uuidv4(), voter_id, campaign_id, agent_id || 'system', 'phone', outcome, notes || null);
    // Update voter stats
    db.prepare(`UPDATE voters SET
      is_contacted = 1,
      contact_count = contact_count + 1,
      last_contacted_at = datetime('now'),
      support_status = CASE WHEN ? NOT IN ('no_answer','invalid') THEN ? ELSE support_status END,
      updated_at = datetime('now')
      WHERE id = ?`)
      .run(outcome, outcome, voter_id);

    // Check auto_stop_outcome rules — if outcome matches, dequeue voter
    const autoStopRules = db.prepare("SELECT * FROM call_rules WHERE campaign_id = ? AND rule_type = 'auto_stop_outcome' AND is_active = 1").all(campaign_id);
    const shouldDequeue = autoStopRules.some(r => r.rule_value === outcome);

    if (shouldDequeue) {
      // Dequeue voter — set status to 'dequeued' so they won't appear in future queue fetches
      const existing = db.prepare("SELECT id FROM call_queue WHERE voter_id = ? AND campaign_id = ?").get(voter_id, campaign_id);
      if (existing) {
        db.prepare(`UPDATE call_queue SET status = 'dequeued', outcome = ?, completed_at = datetime('now')
          WHERE voter_id = ? AND campaign_id = ? AND status IN ('queued','in_progress','completed')`)
          .run(outcome, voter_id, campaign_id);
      } else {
        db.prepare("INSERT INTO call_queue (id, campaign_id, voter_id, status, outcome, completed_at) VALUES (?,?,?,'dequeued',?,datetime('now'))")
          .run(uuidv4(), campaign_id, voter_id, outcome);
      }
      // Also update voter support_status to reflect the auto-deselect outcome
      db.prepare("UPDATE voters SET support_status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(outcome, voter_id);
    } else {
      // Regular complete — mark queue entry done
      db.prepare(`UPDATE call_queue SET status = 'completed', outcome = ?, completed_at = datetime('now')
        WHERE voter_id = ? AND campaign_id = ? AND status IN ('queued','in_progress')`)
        .run(outcome, voter_id, campaign_id);
    }

    res.json({ message: 'Call completed', outcome, dequeued: shouldDequeue });
  } catch (err) {
    console.error('Complete call error:', err);
    res.status(500).json({ error: 'Failed to complete call' });
  }
});

// GET /api/call-queue/stats/:campaignId
app.get(BASE + '/api/call-queue/stats/:campaignId', (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    const total = db.prepare("SELECT COUNT(*) as c FROM voters WHERE campaign_id = ? AND phone IS NOT NULL AND phone != ''").get(campaignId);
    const contacted = db.prepare("SELECT COUNT(*) as c FROM voters WHERE campaign_id = ? AND is_contacted = 1").get(campaignId);
    const todayContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE campaign_id = ? AND created_at > datetime('now', 'start of day')").get(campaignId);
    const weekContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE campaign_id = ? AND created_at > datetime('now', '-7 days')").get(campaignId);
    const outcomes = db.prepare(`
      SELECT outcome, COUNT(*) as count
      FROM contacts WHERE campaign_id = ?
      GROUP BY outcome ORDER BY count DESC
    `).all(campaignId);
    res.json({
      total_callable: total.c,
      contacted: contacted.c,
      remaining: total.c - contacted.c,
      contact_rate: total.c > 0 ? Math.round((contacted.c / total.c) * 100) : 0,
      today_contacts: todayContacts.c,
      week_contacts: weekContacts.c,
      outcomes
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get queue stats' });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE 3: SMART SEARCHES
// ═══════════════════════════════════════════════════════════

// GET /api/smart-searches
app.get(BASE + '/api/smart-searches', (req, res) => {
  try {
    const { campaign_id } = req.query;
    let where = '';
    const params = [];
    if (campaign_id) { where = 'WHERE campaign_id = ? OR campaign_id IS NULL'; params.push(campaign_id); }
    const rows = db.prepare(`SELECT * FROM smart_searches ${where} ORDER BY updated_at DESC`).all(...params);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get smart searches' });
  }
});

// POST /api/smart-searches
app.post(BASE + '/api/smart-searches', (req, res) => {
  try {
    const { name, description, campaign_id, filters_json, is_shared } = req.body;
    if (!name || !filters_json) return res.status(400).json({ error: 'name and filters_json required' });
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const filtersStr = typeof filters_json === 'string' ? filters_json : JSON.stringify(filters_json);
    db.prepare(`INSERT INTO smart_searches (id, name, description, campaign_id, filters_json, is_shared)
      VALUES (?,?,?,?,?,?)`)
      .run(id, name, description || null, campaign_id || null, filtersStr, is_shared !== undefined ? (is_shared ? 1 : 0) : 1);
    const row = db.prepare('SELECT * FROM smart_searches WHERE id = ?').get(id);
    res.status(201).json({ data: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create smart search' });
  }
});

// PUT /api/smart-searches/:id
app.put(BASE + '/api/smart-searches/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM smart_searches WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { name, description, filters_json, is_shared } = req.body;
    const filtersStr = filters_json ? (typeof filters_json === 'string' ? filters_json : JSON.stringify(filters_json)) : existing.filters_json;
    db.prepare(`UPDATE smart_searches SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      filters_json = ?,
      is_shared = COALESCE(?, is_shared),
      updated_at = datetime('now')
      WHERE id = ?`)
      .run(name || null, description || null, filtersStr, is_shared !== undefined ? (is_shared ? 1 : 0) : null, req.params.id);
    const updated = db.prepare('SELECT * FROM smart_searches WHERE id = ?').get(req.params.id);
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update smart search' });
  }
});

// DELETE /api/smart-searches/:id
app.delete(BASE + '/api/smart-searches/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM smart_searches WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Helper: build voter query from filters
function buildSmartSearchQuery(filters) {
  const conditions = [];
  const params = [];

  function addCondition(group) {
    if (!Array.isArray(group)) return;
    const parts = [];
    group.forEach(function(f) {
      const field = f.field;
      const op = f.operator;
      const val = f.value;
      const val2 = f.value2;

      if (field === 'support_status') {
        if (op === 'eq') { parts.push('v.support_status = ?'); params.push(val); }
        else if (op === 'neq') { parts.push('v.support_status != ?'); params.push(val); }
        else if (op === 'in' && Array.isArray(val)) {
          parts.push('v.support_status IN (' + val.map(() => '?').join(',') + ')');
          val.forEach(v => params.push(v));
        }
      } else if (field === 'contact_count') {
        if (op === 'gt') { parts.push('v.contact_count > ?'); params.push(Number(val)); }
        else if (op === 'lt') { parts.push('v.contact_count < ?'); params.push(Number(val)); }
        else if (op === 'eq') { parts.push('v.contact_count = ?'); params.push(Number(val)); }
        else if (op === 'between') { parts.push('v.contact_count BETWEEN ? AND ?'); params.push(Number(val)); params.push(Number(val2)); }
      } else if (field === 'last_contacted_at') {
        if (op === 'null') { parts.push('v.last_contacted_at IS NULL'); }
        else if (op === 'not_null') { parts.push('v.last_contacted_at IS NOT NULL'); }
        else if (op === 'before') { parts.push('v.last_contacted_at < ?'); params.push(val); }
        else if (op === 'after') { parts.push('v.last_contacted_at > ?'); params.push(val); }
        else if (op === 'between') { parts.push('v.last_contacted_at BETWEEN ? AND ?'); params.push(val); params.push(val2); }
        else if (op === 'days_ago_gt') { parts.push("v.last_contacted_at < datetime('now', '-' || ? || ' days')"); params.push(Number(val)); }
        else if (op === 'days_ago_lt') { parts.push("v.last_contacted_at > datetime('now', '-' || ? || ' days')"); params.push(Number(val)); }
      } else if (field === 'district_code') {
        const dist = db.prepare('SELECT id FROM voting_districts WHERE code = ?').get(val);
        if (dist) { parts.push('v.district_id = ?'); params.push(dist.id); }
      } else if (field === 'municipality') {
        const mun = db.prepare('SELECT id FROM municipalities WHERE code = ? OR name LIKE ?').get(val, '%'+val+'%');
        if (mun) { parts.push('v.municipality_id = ?'); params.push(mun.id); }
      } else if (field === 'county') {
        const county = db.prepare('SELECT id FROM counties WHERE code = ? OR name LIKE ?').get(val, '%'+val+'%');
        if (county) {
          parts.push('v.municipality_id IN (SELECT id FROM municipalities WHERE county_id = ?)');
          params.push(county.id);
        }
      } else if (field === 'age_group') {
        if (op === 'eq') { parts.push('v.age_group = ?'); params.push(val); }
        else if (op === 'in' && Array.isArray(val)) {
          parts.push('v.age_group IN (' + val.map(() => '?').join(',') + ')');
          val.forEach(v => params.push(v));
        }
      } else if (field === 'tags') {
        if (op === 'contains') { parts.push('v.tags LIKE ?'); params.push('%' + val + '%'); }
        else if (op === 'not_contains') { parts.push('(v.tags NOT LIKE ? OR v.tags IS NULL)'); params.push('%' + val + '%'); }
      } else if (field === 'ai_priority_rank') {
        if (op === 'gt') { parts.push('v.ai_priority_rank > ?'); params.push(Number(val)); }
        else if (op === 'lt') { parts.push('v.ai_priority_rank < ?'); params.push(Number(val)); }
        else if (op === 'between') { parts.push('v.ai_priority_rank BETWEEN ? AND ?'); params.push(Number(val)); params.push(Number(val2)); }
      } else if (field === 'is_contacted') {
        parts.push('v.is_contacted = ?'); params.push(val ? 1 : 0);
      } else if (field === 'campaign_id') {
        parts.push('v.campaign_id = ?'); params.push(val);
      }
    });
    if (parts.length > 0) {
      const logic = group[0] && group[0].logic === 'OR' ? ' OR ' : ' AND ';
      conditions.push('(' + parts.join(logic) + ')');
    }
  }

  // filters can be a flat array (all AND) or array of groups
  if (Array.isArray(filters) && filters.length > 0) {
    if (Array.isArray(filters[0])) {
      filters.forEach(group => addCondition(group));
    } else {
      addCondition(filters);
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

// POST /api/smart-searches/execute
app.post(BASE + '/api/smart-searches/execute', (req, res) => {
  try {
    const { filters, limit, offset } = req.body;
    if (!filters) return res.status(400).json({ error: 'filters required' });

    const filtersArr = typeof filters === 'string' ? JSON.parse(filters) : filters;
    const { where, params } = buildSmartSearchQuery(filtersArr);
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;

    const countRow = db.prepare(`SELECT COUNT(*) as c FROM voters v ${where}`).get(...params);
    const voters = db.prepare(`
      SELECT v.id, v.full_name, v.first_name, v.last_name, v.address, v.postcode, v.city,
             v.phone, v.support_status, v.contact_count, v.last_contacted_at,
             v.ai_priority_rank, v.ai_support_score, v.age_group, v.tags, v.campaign_id
      FROM voters v ${where}
      ORDER BY COALESCE(v.ai_priority_rank, 9999), v.contact_count ASC
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    res.json({ data: voters, total: countRow.c });
  } catch (err) {
    console.error('Smart search execute error:', err);
    res.status(500).json({ error: 'Failed to execute search: ' + err.message });
  }
});

// GET /api/smart-searches/:id/results
app.get(BASE + '/api/smart-searches/:id/results', (req, res) => {
  try {
    const search = db.prepare('SELECT * FROM smart_searches WHERE id = ?').get(req.params.id);
    if (!search) return res.status(404).json({ error: 'Search not found' });

    const filters = JSON.parse(search.filters_json || '[]');
    const { where, params } = buildSmartSearchQuery(filters);
    const lim = parseInt(req.query.limit) || 100;
    const off = parseInt(req.query.offset) || 0;

    const countRow = db.prepare(`SELECT COUNT(*) as c FROM voters v ${where}`).get(...params);
    const voters = db.prepare(`
      SELECT v.id, v.full_name, v.first_name, v.last_name, v.address, v.postcode, v.city,
             v.phone, v.support_status, v.contact_count, v.last_contacted_at,
             v.ai_priority_rank, v.ai_support_score, v.age_group, v.tags, v.campaign_id
      FROM voters v ${where}
      ORDER BY COALESCE(v.ai_priority_rank, 9999), v.contact_count ASC
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    // Update result count and last_run_at
    db.prepare("UPDATE smart_searches SET result_count = ?, last_run_at = datetime('now') WHERE id = ?")
      .run(countRow.c, search.id);

    res.json({ data: voters, total: countRow.c, search });
  } catch (err) {
    console.error('Smart search results error:', err);
    res.status(500).json({ error: 'Failed to get results: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE: LANGUAGE-MATCHED CALLING
// ═══════════════════════════════════════════════════════════

// PUT /api/users/:id/languages - set user's spoken languages
app.put(BASE + '/api/users/:id/languages', (req, res) => {
  try {
    var userId = req.params.id;
    var user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    var { languages, preferred_calling_language } = req.body;
    var langStr = Array.isArray(languages) ? JSON.stringify(languages) : (languages || null);
    db.prepare("UPDATE users SET languages = ?, preferred_calling_language = ?, updated_at = datetime('now') WHERE id = ?")
      .run(langStr, preferred_calling_language || null, userId);
    var updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.json({ data: updated });
  } catch (err) {
    console.error('Update user languages error:', err);
    res.status(500).json({ error: 'Failed to update languages' });
  }
});

// GET /api/call-queue/:campaignId/language-matched - language-prioritized queue
app.get(BASE + '/api/call-queue/:campaignId/language-matched', (req, res) => {
  try {
    var campaignId = req.params.campaignId;
    var userId = req.query.user_id;
    var batchSize = parseInt(req.query.limit) || 20;

    // Get caller's languages
    var callerLanguages = [];
    if (userId) {
      var callerUser = db.prepare('SELECT languages FROM users WHERE id = ?').get(userId);
      if (callerUser && callerUser.languages) {
        try { callerLanguages = JSON.parse(callerUser.languages); } catch(e) {}
      }
    }

    // Fetch active rules
    var rules = db.prepare("SELECT * FROM call_rules WHERE campaign_id = ? AND is_active = 1").all(campaignId);
    var ruleMap = {};
    rules.forEach(function(r) { ruleMap[r.rule_type] = r.rule_value; });

    // Quiet hours check
    var quietStart = ruleMap['quiet_hours_start'] || '09:00';
    var quietEnd = ruleMap['quiet_hours_end'] || '20:00';
    var nowH = new Date().getHours();
    var nowM = new Date().getMinutes();
    var nowMins = nowH * 60 + nowM;
    var qsParts = quietStart.split(':').map(Number);
    var qeParts = quietEnd.split(':').map(Number);
    var inQuiet = nowMins < (qsParts[0] * 60 + qsParts[1]) || nowMins >= (qeParts[0] * 60 + qeParts[1]);
    if (inQuiet) {
      return res.json({ data: [], quiet_hours: true, message: 'Calling allowed ' + quietStart + '\u2013' + quietEnd + ' only' });
    }

    var autoStopOutcome = ruleMap['auto_stop_outcome'] || null;
    var maxTotal = ruleMap['max_total'] ? parseInt(ruleMap['max_total']) : null;
    var maxPerWeek = ruleMap['max_per_week'] ? parseInt(ruleMap['max_per_week']) : null;
    var requeueDays = ruleMap['requeue_days'] ? parseInt(ruleMap['requeue_days']) : null;

    var excludeSubquery = '';
    var params = [campaignId];

    // Filter out dequeued voters
    excludeSubquery += " AND (SELECT COUNT(*) FROM call_queue cq WHERE cq.voter_id = v.id AND cq.campaign_id = ? AND cq.status = 'dequeued') = 0";
    params.push(campaignId);

    if (autoStopOutcome) { excludeSubquery += ' AND v.support_status != ?'; params.push(autoStopOutcome); }
    if (maxTotal !== null) { excludeSubquery += ' AND v.contact_count < ?'; params.push(maxTotal); }
    if (maxPerWeek !== null) {
      excludeSubquery += " AND (SELECT COUNT(*) FROM contacts c2 WHERE c2.voter_id = v.id AND c2.created_at > datetime('now', '-7 days')) < ?";
      params.push(maxPerWeek);
    }
    if (requeueDays !== null) {
      excludeSubquery += " AND (v.last_contacted_at IS NULL OR v.last_contacted_at < datetime('now', '-' || ? || ' days'))";
      params.push(requeueDays);
    } else {
      excludeSubquery += " AND (v.last_contacted_at IS NULL OR v.last_contacted_at < datetime('now', '-1 day'))";
    }

    params.push(batchSize);

    var voters = db.prepare(`
      SELECT v.*,
             (SELECT COUNT(*) FROM contacts c WHERE c.voter_id = v.id) as total_contacts_real
      FROM voters v
      WHERE v.campaign_id = ? ${excludeSubquery}
        AND v.phone IS NOT NULL AND v.phone != ''
      ORDER BY
        CASE WHEN v.support_status = 'undecided' THEN 0
             WHEN v.support_status = 'unknown' THEN 1
             WHEN v.support_status = 'soft_yes' THEN 2
             ELSE 3 END,
        COALESCE(v.ai_priority_rank, 999),
        v.contact_count ASC
      LIMIT ?
    `).all(...params);

    // Sort language-matched voters to top
    if (callerLanguages.length > 0) {
      voters = voters.sort(function(a, b) {
        var aMatch = a.language && callerLanguages.indexOf(a.language) >= 0 ? 0 : 1;
        var bMatch = b.language && callerLanguages.indexOf(b.language) >= 0 ? 0 : 1;
        return aMatch - bMatch;
      });
    }

    res.json({ data: voters, rules_applied: ruleMap, caller_languages: callerLanguages });
  } catch (err) {
    console.error('Language matched queue error:', err);
    res.status(500).json({ error: 'Failed to get language matched queue' });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE: FIELD AGENT AI BRIEFINGS
// ═══════════════════════════════════════════════════════════

// POST /api/briefings/generate
app.post(BASE + '/api/briefings/generate', async (req, res) => {
  try {
    var { area_code, area_type, campaign_id } = req.body;
    if (!area_code || !area_type || !campaign_id) {
      return res.status(400).json({ error: 'area_code, area_type, campaign_id required' });
    }
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' });

    var { v4: uuidv4 } = require('uuid');

    // Gather area demographics
    var demographics = db.prepare(
      "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = ? ORDER BY data_year DESC LIMIT 1"
    ).get(area_code, area_type);

    // Gather election results
    var results2022 = db.prepare(`
      SELECT er.*, p.name as party_name FROM election_results er
      LEFT JOIN parties p ON p.code = er.party_code
      WHERE er.${area_type === 'county' ? 'county_code' : area_type === 'municipality' ? 'municipality_code' : 'district_code'} = ?
        AND er.election_year = 2022 ORDER BY er.votes DESC LIMIT 10
    `).all(area_code);

    var results2018 = db.prepare(`
      SELECT er.*, p.name as party_name FROM election_results er
      LEFT JOIN parties p ON p.code = er.party_code
      WHERE er.${area_type === 'county' ? 'county_code' : area_type === 'municipality' ? 'municipality_code' : 'district_code'} = ?
        AND er.election_year = 2018 ORDER BY er.votes DESC LIMIT 10
    `).all(area_code);

    // Gather contact history
    var contactStats = db.prepare(`
      SELECT c.outcome, COUNT(*) as count
      FROM contacts c
      JOIN voters v ON v.id = c.voter_id
      WHERE c.campaign_id = ?
        AND (v.district_id IN (SELECT id FROM voting_districts WHERE code = ?)
             OR v.municipality_id IN (SELECT id FROM municipalities WHERE code = ?))
      GROUP BY c.outcome ORDER BY count DESC
    `).all(campaign_id, area_code, area_code);

    // Common issues from notes
    var recentNotes = db.prepare(`
      SELECT c.notes FROM contacts c
      JOIN voters v ON v.id = c.voter_id
      WHERE c.campaign_id = ? AND c.notes IS NOT NULL AND c.notes != ''
        AND (v.district_id IN (SELECT id FROM voting_districts WHERE code = ?)
             OR v.municipality_id IN (SELECT id FROM municipalities WHERE code = ?))
      ORDER BY c.created_at DESC LIMIT 20
    `).all(campaign_id, area_code, area_code);

    // Call rules
    var callRules = db.prepare("SELECT * FROM call_rules WHERE campaign_id = ? AND is_active = 1").all(campaign_id);

    // Build context
    var ctx = 'OMRADESDATA:\n';
    ctx += 'Omradeskod: ' + area_code + ' (Typ: ' + area_type + ')\n\n';

    if (demographics) {
      ctx += 'DEMOGRAFI:\n';
      if (demographics.population) ctx += '  Befolkning: ' + demographics.population + '\n';
      if (demographics.median_age) ctx += '  Medianlder: ' + demographics.median_age + '\n';
      if (demographics.median_income) ctx += '  Medianinkomst: ' + demographics.median_income + ' SEK\n';
      if (demographics.foreign_born_pct) ctx += '  Utrikesfodda: ' + demographics.foreign_born_pct + '%\n';
      if (demographics.higher_education_pct) ctx += '  Hogre utbildning: ' + demographics.higher_education_pct + '%\n';
      if (demographics.unemployment_pct) ctx += '  Arbetsloshet: ' + demographics.unemployment_pct + '%\n';
      ctx += '\n';
    }

    if (results2022.length > 0) {
      ctx += 'VALRESULTAT 2022:\n';
      results2022.forEach(function(r) { ctx += '  ' + r.party_code + ': ' + (r.vote_percentage || 0).toFixed(1) + '%\n'; });
      ctx += '\n';
    }
    if (results2018.length > 0) {
      ctx += 'VALRESULTAT 2018:\n';
      results2018.forEach(function(r) { ctx += '  ' + r.party_code + ': ' + (r.vote_percentage || 0).toFixed(1) + '%\n'; });
      ctx += '\n';
    }

    if (contactStats.length > 0) {
      ctx += 'KAMPANJRESULTAT (kontakthistorik):\n';
      contactStats.forEach(function(s) { ctx += '  ' + s.outcome + ': ' + s.count + ' kontakter\n'; });
      ctx += '\n';
    }

    if (recentNotes.length > 0) {
      ctx += 'SENASTE ANTECKNINGAR FRAN VALJAROKONTAKTER:\n';
      recentNotes.slice(0, 10).forEach(function(n, i) { if (n.notes) ctx += '  ' + (i+1) + '. ' + n.notes + '\n'; });
      ctx += '\n';
    }

    if (callRules.length > 0) {
      ctx += 'AKTIVA SAMTALSREGLER:\n';
      callRules.forEach(function(r) { ctx += '  ' + r.rule_type + ': ' + r.rule_value + '\n'; });
    }

    var prompt = `Du ar en erfaren faltsamordnare for en svensk valkampanj. Generera en kortfattad briefing for faltarbetare i detta omrade baserat pa foljande data.\n\n${ctx}\n\nBriefiingen ska innehalla dessa sektioner:\n1. **OMRADESOVERBLICK** - Kort beskrivning av omradets politiska profil och demografiska profil\n2. **NYCKELDEMOGRAFI** - De viktigaste demografiska fakta och vad de innebar for kampanjen\n3. **SAMTALSBUDSKAP** - 3-5 konkreta samtalsamnens anpassade till detta omrade\n4. **PRIORITERA DESSA VALJARE** - Vilka typer av valjare ska prioriteras och varfor\n5. **LOKALA FRAGOR** - Fragor och synpunkter som har kommit upp i kontakter\n6. **REKOMMENDERAT TILLVAGAGANGSSATT** - Praktiska rad for faltarbetet\n\nSvara pa svenska. Var konkret och handlingsorienterad. Max 500 ord totalt.`;

    var https = require('https');
    var bodyData = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    var briefingContent = await new Promise(function(resolve, reject) {
      var options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(bodyData)
        }
      };
      var reqHttp = https.request(options, function(response) {
        var data = '';
        response.on('data', function(chunk) { data += chunk; });
        response.on('end', function() {
          try {
            var parsed = JSON.parse(data);
            var text = parsed.content && parsed.content[0] ? parsed.content[0].text : 'Briefing ej tillganglig.';
            resolve(text);
          } catch(e) { reject(new Error('Failed to parse AI response')); }
        });
      });
      reqHttp.on('error', reject);
      reqHttp.write(bodyData);
      reqHttp.end();
    });

    // Store briefing
    var briefingId = uuidv4();
    var title = 'Briefing: ' + area_code + ' (' + new Date().toLocaleDateString('sv-SE') + ')';
    db.prepare('INSERT INTO field_briefings (id, campaign_id, area_code, area_type, title, content) VALUES (?,?,?,?,?,?)')
      .run(briefingId, campaign_id, area_code, area_type, title, briefingContent);

    var briefing = db.prepare('SELECT * FROM field_briefings WHERE id = ?').get(briefingId);
    res.status(201).json({ data: briefing });
  } catch (err) {
    console.error('Generate briefing error:', err);
    res.status(500).json({ error: 'Failed to generate briefing: ' + err.message });
  }
});

// GET /api/briefings/latest/:areaCode - latest briefing for an area (MUST be before /:campaignId)
app.get(BASE + '/api/briefings/latest/:areaCode', (req, res) => {
  try {
    var briefing = db.prepare('SELECT * FROM field_briefings WHERE area_code = ? ORDER BY generated_at DESC LIMIT 1')
      .get(req.params.areaCode);
    if (!briefing) return res.status(404).json({ error: 'No briefing found for this area' });
    res.json({ data: briefing });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get briefing' });
  }
});

// GET /api/briefings/:campaignId - list briefings for campaign
app.get(BASE + '/api/briefings/:campaignId', (req, res) => {
  try {
    var briefings = db.prepare('SELECT id, campaign_id, area_code, area_type, title, generated_at FROM field_briefings WHERE campaign_id = ? ORDER BY generated_at DESC LIMIT 50')
      .all(req.params.campaignId);
    res.json({ data: briefings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get briefings' });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE: AUTO-DESELECT FROM CALL QUEUE
// ═══════════════════════════════════════════════════════════

// POST /api/voters/:id/action - log voter action, trigger auto-deselect
app.post(BASE + '/api/voters/:id/action', (req, res) => {
  try {
    var voterId = req.params.id;
    var { campaign_id, action_type, agent_id, notes } = req.body;
    if (!campaign_id || !action_type) return res.status(400).json({ error: 'campaign_id and action_type required' });

    var voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(voterId);
    if (!voter) return res.status(404).json({ error: 'Voter not found' });

    var { v4: uuidv4 } = require('uuid');

    // Log the action
    db.prepare('INSERT INTO voter_actions (id, voter_id, campaign_id, action_type, agent_id, notes) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), voterId, campaign_id, action_type, agent_id || 'system', notes || null);

    // Map action_type to support_status
    var ACTION_STATUS_MAP = {
      survey_completed: 'soft_yes',
      signed_up: 'supporter',
      donated: 'supporter',
      volunteered: 'supporter'
    };
    var newStatus = ACTION_STATUS_MAP[action_type] || 'soft_yes';

    // Update voter status
    db.prepare("UPDATE voters SET support_status = ?, is_contacted = 1, updated_at = datetime('now') WHERE id = ?")
      .run(newStatus, voterId);

    // Check if any auto_stop_outcome rule matches
    var rules = db.prepare("SELECT * FROM call_rules WHERE campaign_id = ? AND rule_type = 'auto_stop_outcome' AND is_active = 1").all(campaign_id);
    var shouldDequeue = rules.some(function(r) { return r.rule_value === newStatus; });

    if (shouldDequeue) {
      // Dequeue the voter
      var existingQueue = db.prepare("SELECT id FROM call_queue WHERE voter_id = ? AND campaign_id = ?").get(voterId, campaign_id);
      if (existingQueue) {
        db.prepare("UPDATE call_queue SET status = 'dequeued', completed_at = datetime('now'), outcome = ? WHERE voter_id = ? AND campaign_id = ? AND status IN ('queued','in_progress')")
          .run(action_type, voterId, campaign_id);
      } else {
        db.prepare("INSERT INTO call_queue (id, campaign_id, voter_id, status, outcome, completed_at) VALUES (?,?,?,'dequeued',?,datetime('now'))")
          .run(uuidv4(), campaign_id, voterId, action_type);
      }
    }

    res.json({ message: 'Action logged', action_type: action_type, new_status: newStatus, dequeued: shouldDequeue });
  } catch (err) {
    console.error('Voter action error:', err);
    res.status(500).json({ error: 'Failed to log voter action' });
  }
});

// Modify existing POST /api/call-queue/complete to handle auto-deselect
// (Override the existing one above this block)
app.post(BASE + '/api/call-queue/complete-v2', (req, res) => {
  // This is a no-op placeholder; the main one is above and already handles basic dequeue
  res.json({ message: 'Use /api/call-queue/complete' });
});

// ═══════════════════════════════════════════════════════════
// PHASE 3 FEATURE 1: LANGUAGE GAP ALERTS
// ═══════════════════════════════════════════════════════════

// GET /api/alerts/language-gaps/:campaignId
// Analyses each district in campaign, cross-refs demographics with available callers
app.get(BASE + '/api/alerts/language-gaps/:campaignId', function(req, res) {
  try {
    var campaignId = req.params.campaignId;

    // Get all districts that have voters in this campaign
    var districts = db.prepare(`
      SELECT DISTINCT vd.id, vd.code, vd.name, vd.municipality_id,
             m.name as municipality_name, m.code as municipality_code,
             c.name as county_name, c.code as county_code
      FROM voters v
      JOIN voting_districts vd ON vd.id = v.district_id
      LEFT JOIN municipalities m ON m.id = vd.municipality_id
      LEFT JOIN counties c ON c.id = m.county_id
      WHERE v.campaign_id = ? AND v.district_id IS NOT NULL
    `).all(campaignId);

    // Also include districts from area_assignments for the campaign
    var assignedDistricts = db.prepare(`
      SELECT DISTINCT vd.id, vd.code, vd.name, vd.municipality_id,
             m.name as municipality_name, m.code as municipality_code,
             c.name as county_name, c.code as county_code
      FROM area_assignments aa
      JOIN voting_districts vd ON vd.id = aa.district_id
      LEFT JOIN municipalities m ON m.id = vd.municipality_id
      LEFT JOIN counties c ON c.id = m.county_id
      WHERE aa.campaign_id = ? AND aa.district_id IS NOT NULL
    `).all(campaignId);

    // Merge district lists, dedupe by id
    var districtMap = {};
    districts.forEach(function(d) { districtMap[d.id] = d; });
    assignedDistricts.forEach(function(d) { districtMap[d.id] = d; });
    var allDistricts = Object.values(districtMap);

    // Get all active callers with their languages
    var callers = db.prepare(`
      SELECT id, name, languages FROM users WHERE is_active = 1 AND languages IS NOT NULL AND languages != ''
    `).all();

    // Build caller language index: language -> array of caller names
    var langCallers = {};
    callers.forEach(function(caller) {
      var langs = [];
      try { langs = JSON.parse(caller.languages); } catch(e) {}
      if (!Array.isArray(langs)) langs = [];
      langs.forEach(function(lang) {
        lang = lang.toLowerCase();
        if (!langCallers[lang]) langCallers[lang] = [];
        langCallers[lang].push(caller.name || caller.id);
      });
    });

    var alerts = [];

    allDistricts.forEach(function(district) {
      // Fetch demographics — try district, then municipality, then county
      var demo = db.prepare(
        "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'district' ORDER BY data_year DESC LIMIT 1"
      ).get(district.code);
      if (!demo && district.municipality_code) {
        demo = db.prepare(
          "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'municipality' ORDER BY data_year DESC LIMIT 1"
        ).get(district.municipality_code);
      }
      if (!demo && district.county_code) {
        demo = db.prepare(
          "SELECT * FROM area_demographics WHERE area_code = ? AND area_type = 'county' ORDER BY data_year DESC LIMIT 1"
        ).get(district.county_code);
      }

      var foreignBornPct = demo ? (demo.foreign_born_pct || 0) : 0;

      // Only flag if foreign-born % is high enough to warrant language callers
      if (foreignBornPct < 15) return;

      // Determine likely language(s) needed based on threshold
      // Sweden's immigrant populations: Arabic, Somali, Kurdish are most common
      // We flag all three for any district with high foreign-born %
      var neededLanguages = ['ar', 'so', 'ku'];

      neededLanguages.forEach(function(lang) {
        var langNames = { ar: 'Arabic', so: 'Somali', ku: 'Kurdish' };
        var available = langCallers[lang] || [];
        var count = available.length;
        var severity;
        if (foreignBornPct > 30 && count === 0) {
          severity = 'critical';
        } else if (foreignBornPct > 20 && count < 2) {
          severity = 'warning';
        } else {
          severity = 'ok';
        }

        if (severity !== 'ok') {
          alerts.push({
            district_code: district.code,
            district_name: district.name,
            municipality_name: district.municipality_name,
            county_name: district.county_name,
            foreign_born_pct: foreignBornPct,
            estimated_language: lang,
            estimated_language_name: langNames[lang],
            available_callers: count,
            caller_names: available.slice(0, 5),
            gap_severity: severity
          });
        }
      });
    });

    // Sort: critical first, then warning; dedupe by district+lang
    alerts.sort(function(a, b) {
      var order = { critical: 0, warning: 1, ok: 2 };
      return (order[a.gap_severity] || 2) - (order[b.gap_severity] || 2);
    });

    var criticalCount = alerts.filter(function(a) { return a.gap_severity === 'critical'; }).length;

    res.json({ data: alerts, total: alerts.length, critical_count: criticalCount });
  } catch (err) {
    console.error('Language gaps error:', err);
    res.status(500).json({ error: 'Failed to analyse language gaps: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 3 FEATURE 2: DEMOGRAPHIC CHANGE TRACKER
// ═══════════════════════════════════════════════════════════

// GET /api/demographics/changes - all areas sorted by shift score
app.get(BASE + '/api/demographics/changes', function(req, res) {
  try {
    var limit = parseInt(req.query.limit) || 50;
    var areaType = req.query.area_type || null;

    var where = 'WHERE demographic_shift_score IS NOT NULL';
    var params = [];
    if (areaType) {
      where += ' AND area_type = ?';
      params.push(areaType);
    }

    var rows = db.prepare(`
      SELECT ad.*,
             COALESCE(vd.name, m.name, c.name) as area_name
      FROM area_demographics ad
      LEFT JOIN voting_districts vd ON vd.code = ad.area_code AND ad.area_type = 'district'
      LEFT JOIN municipalities m ON m.code = ad.area_code AND ad.area_type = 'municipality'
      LEFT JOIN counties c ON c.code = ad.area_code AND ad.area_type = 'county'
      ${where}
      ORDER BY ad.demographic_shift_score DESC
      LIMIT ?
    `).all(...params, limit);

    // Annotate with change indicators
    var annotated = rows.map(function(row) {
      var popChange = null;
      var fbChange = null;
      var ageChange = null;
      if (row.previous_population && row.population) {
        popChange = ((row.population - row.previous_population) / row.previous_population * 100).toFixed(1);
      }
      if (row.previous_foreign_born_pct != null && row.foreign_born_pct != null) {
        fbChange = (row.foreign_born_pct - row.previous_foreign_born_pct).toFixed(1);
      }
      if (row.previous_median_age != null && row.median_age != null) {
        ageChange = (row.median_age - row.previous_median_age).toFixed(1);
      }
      return Object.assign({}, row, {
        pop_change_pct_calculated: popChange,
        foreign_born_change: fbChange,
        age_change: ageChange
      });
    });

    res.json({ data: annotated, total: annotated.length });
  } catch (err) {
    console.error('Demographic changes error:', err);
    res.status(500).json({ error: 'Failed to get demographic changes: ' + err.message });
  }
});

// GET /api/demographics/changes/:areaCode - detailed change for one area
app.get(BASE + '/api/demographics/changes/:areaCode', function(req, res) {
  try {
    var areaCode = req.params.areaCode;

    var rows = db.prepare(
      'SELECT * FROM area_demographics WHERE area_code = ? ORDER BY data_year DESC LIMIT 5'
    ).all(areaCode);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No demographic data found for this area' });
    }

    var current = rows[0];
    var changes = {};

    if (current.previous_population && current.population) {
      changes.population = {
        current: current.population,
        previous: current.previous_population,
        change_pct: ((current.population - current.previous_population) / current.previous_population * 100).toFixed(1),
        direction: current.population > current.previous_population ? 'growing' : 'declining'
      };
    }
    if (current.previous_foreign_born_pct != null && current.foreign_born_pct != null) {
      changes.foreign_born = {
        current: current.foreign_born_pct,
        previous: current.previous_foreign_born_pct,
        change: (current.foreign_born_pct - current.previous_foreign_born_pct).toFixed(1),
        direction: current.foreign_born_pct > current.previous_foreign_born_pct ? 'increasing' : 'decreasing'
      };
    }
    if (current.previous_median_age != null && current.median_age != null) {
      changes.median_age = {
        current: current.median_age,
        previous: current.previous_median_age,
        change: (current.median_age - current.previous_median_age).toFixed(1),
        direction: current.median_age > current.previous_median_age ? 'aging' : 'rejuvenating'
      };
    }

    // Historical series from all stored years
    var history = rows.map(function(r) {
      return {
        data_year: r.data_year,
        population: r.population,
        foreign_born_pct: r.foreign_born_pct,
        median_age: r.median_age,
        median_income: r.median_income,
        unemployment_pct: r.unemployment_pct,
        higher_education_pct: r.higher_education_pct
      };
    });

    res.json({
      area_code: areaCode,
      current: current,
      changes: changes,
      shift_score: current.demographic_shift_score,
      history: history
    });
  } catch (err) {
    console.error('Demographic change detail error:', err);
    res.status(500).json({ error: 'Failed to get area change data: ' + err.message });
  }
});

// GET /api/demographics/predict/:areaCode - electoral implications prediction
app.get(BASE + '/api/demographics/predict/:areaCode', function(req, res) {
  try {
    var areaCode = req.params.areaCode;
    var demo = db.prepare(
      'SELECT * FROM area_demographics WHERE area_code = ? ORDER BY data_year DESC LIMIT 1'
    ).get(areaCode);

    if (!demo) return res.status(404).json({ error: 'No demographic data found' });

    var predictions = [];
    var signals = [];

    // Younger population: tends left/green
    if (demo.median_age != null && demo.previous_median_age != null) {
      var ageDelta = demo.median_age - demo.previous_median_age;
      if (ageDelta < -1.0) {
        predictions.push({ factor: 'age', direction: 'younger', implication: 'Younger demographic shift suggests increased support for progressive and green parties (MP, V)', confidence: 'medium', party_lean: ['MP', 'V', 'S'] });
        signals.push('population_rejuvenating');
      } else if (ageDelta > 1.5) {
        predictions.push({ factor: 'age', direction: 'older', implication: 'Aging population suggests more conservative electorate; stronger SD and M support likely', confidence: 'medium', party_lean: ['M', 'SD', 'KD'] });
        signals.push('population_aging');
      }
    }

    // Higher education growth: tends left-liberal
    if (demo.higher_education_pct != null) {
      if (demo.higher_education_pct > 40) {
        predictions.push({ factor: 'education', direction: 'high', implication: 'High education area correlates strongly with liberal/progressive voting; L, MP, S competitive', confidence: 'high', party_lean: ['L', 'MP', 'S', 'C'] });
        signals.push('high_education');
      } else if (demo.higher_education_pct < 20) {
        predictions.push({ factor: 'education', direction: 'low', implication: 'Lower education correlates with populist right support (SD) and traditional left (S)', confidence: 'medium', party_lean: ['SD', 'S'] });
        signals.push('low_education');
      }
    }

    // Rising foreign-born %: complex — may mobilise both SD and left
    if (demo.foreign_born_pct != null && demo.previous_foreign_born_pct != null) {
      var fbDelta = demo.foreign_born_pct - demo.previous_foreign_born_pct;
      if (fbDelta > 2) {
        predictions.push({ factor: 'foreign_born', direction: 'increasing', implication: 'Increasing foreign-born population may boost S and V in immigrant communities, while also energising SD base elsewhere', confidence: 'medium', party_lean: ['S', 'V', 'SD'] });
        signals.push('increasing_immigration');
      }
    }

    // High unemployment: left / populist lean
    if (demo.unemployment_pct != null) {
      if (demo.unemployment_pct > 10) {
        predictions.push({ factor: 'unemployment', direction: 'high', implication: 'High unemployment favours S welfare messaging and SD anti-immigration framing; V competitive', confidence: 'high', party_lean: ['S', 'SD', 'V'] });
        signals.push('high_unemployment');
      } else if (demo.unemployment_pct < 4) {
        predictions.push({ factor: 'unemployment', direction: 'low', implication: 'Low unemployment correlates with M/C economic optimism; pro-business parties favoured', confidence: 'medium', party_lean: ['M', 'C', 'L'] });
        signals.push('low_unemployment');
      }
    }

    // High median income: right-of-centre lean
    if (demo.median_income != null) {
      if (demo.median_income > 400000) {
        predictions.push({ factor: 'income', direction: 'high', implication: 'High median income correlates with M and L support; lower tax demand', confidence: 'medium', party_lean: ['M', 'L', 'KD'] });
        signals.push('high_income');
      } else if (demo.median_income < 250000) {
        predictions.push({ factor: 'income', direction: 'low', implication: 'Lower income area favours redistribution parties (S, V) and welfare-focus (SD)', confidence: 'medium', party_lean: ['S', 'V', 'SD'] });
        signals.push('low_income');
      }
    }

    // Population growth: influx may dilute existing political base
    if (demo.population_change_pct != null) {
      var popChangePct = demo.population_change_pct;
      if (popChangePct > 5) {
        predictions.push({ factor: 'population', direction: 'growing', implication: 'Rapidly growing area brings new voters; traditionally less predictable, opportunities for direct outreach', confidence: 'low', party_lean: [] });
        signals.push('population_growth');
      } else if (popChangePct < -3) {
        predictions.push({ factor: 'population', direction: 'declining', implication: 'Population decline often accompanies economic pessimism; SD and S consolidate their existing bases', confidence: 'low', party_lean: ['SD', 'S'] });
        signals.push('population_decline');
      }
    }

    // Shift score summary
    var shiftScore = demo.demographic_shift_score;
    var overallOutlook = 'stable';
    if (shiftScore != null) {
      if (shiftScore >= 60) overallOutlook = 'high_volatility';
      else if (shiftScore >= 35) overallOutlook = 'moderate_shift';
    }

    res.json({
      area_code: areaCode,
      demographics: demo,
      predictions: predictions,
      signals: signals,
      overall_outlook: overallOutlook,
      shift_score: shiftScore,
      recommendation: predictions.length === 0
        ? 'Insufficient data for electoral prediction. Collect historical demographic records.'
        : 'Based on demographic signals, prioritise outreach to: ' + [...new Set(predictions.flatMap(function(p){ return p.party_lean; }))].join(', ') + ' leaning households.'
    });
  } catch (err) {
    console.error('Demographic predict error:', err);
    res.status(500).json({ error: 'Failed to generate prediction: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 3 FEATURE 3: AREA SIMILARITY ENGINE
// ═══════════════════════════════════════════════════════════

// GET /api/areas/similar/:areaCode?limit=10
// Finds N most similar areas using demographic + voting pattern cosine similarity
app.get(BASE + '/api/areas/similar/:areaCode', function(req, res) {
  try {
    var areaCode = req.params.areaCode;
    var limit = Math.min(parseInt(req.query.limit) || 10, 30);

    // Determine target area type
    var targetDistrict = db.prepare('SELECT * FROM voting_districts WHERE code = ?').get(areaCode);
    var targetMuni = db.prepare('SELECT * FROM municipalities WHERE code = ?').get(areaCode);
    var targetArea = targetDistrict || targetMuni;
    if (!targetArea) return res.status(404).json({ error: 'Area not found' });

    var areaType = targetDistrict ? 'district' : 'municipality';

    // Get target demographics
    var targetDemo = db.prepare(
      'SELECT * FROM area_demographics WHERE area_code = ? ORDER BY data_year DESC LIMIT 1'
    ).get(areaCode);

    // Get target election results (2022 Riksdag)
    var colName = areaType === 'district' ? 'district_code' : 'municipality_code';
    var targetResults = db.prepare(`
      SELECT party_code, vote_percentage FROM election_results
      WHERE ${colName} = ? AND election_year = 2022 AND election_type = 'riksdag'
      ORDER BY votes DESC
    `).all(areaCode);

    // Build target feature vector
    // Features: [foreign_born_pct, higher_education_pct, unemployment_pct, median_age/100, median_income/500000,
    //            avg_household_size, S_pct, M_pct, SD_pct, MP_pct, V_pct, C_pct, KD_pct, L_pct]
    function buildVector(demo, results) {
      var partyPcts = {};
      (results || []).forEach(function(r) { partyPcts[r.party_code] = (r.vote_percentage || 0) / 100; });
      return [
        (demo ? (demo.foreign_born_pct || 0) : 0) / 100,
        (demo ? (demo.higher_education_pct || 0) : 0) / 100,
        (demo ? (demo.unemployment_pct || 0) : 0) / 20,
        (demo ? (demo.median_age || 40) : 40) / 80,
        (demo ? (demo.median_income || 300000) : 300000) / 600000,
        (demo ? (demo.avg_household_size || 2) : 2) / 5,
        partyPcts['S'] || 0,
        partyPcts['M'] || 0,
        partyPcts['SD'] || 0,
        partyPcts['MP'] || 0,
        partyPcts['V'] || 0,
        partyPcts['C'] || 0,
        partyPcts['KD'] || 0,
        partyPcts['L'] || 0
      ];
    }

    function cosineSimilarity(a, b) {
      var dot = 0, magA = 0, magB = 0;
      for (var i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      magA = Math.sqrt(magA);
      magB = Math.sqrt(magB);
      if (magA === 0 || magB === 0) return 0;
      return dot / (magA * magB);
    }

    var targetVec = buildVector(targetDemo, targetResults);

    // Fetch candidate areas of the same type
    var candidates;
    if (areaType === 'district') {
      candidates = db.prepare(`
        SELECT vd.code, vd.name, vd.population,
               m.name as municipality_name, m.code as municipality_code,
               c.name as county_name, c.code as county_code
        FROM voting_districts vd
        LEFT JOIN municipalities m ON m.id = vd.municipality_id
        LEFT JOIN counties c ON c.id = m.county_id
        WHERE vd.code != ?
        LIMIT 2000
      `).all(areaCode);
    } else {
      candidates = db.prepare(`
        SELECT m.code, m.name, m.population,
               c.name as county_name, c.code as county_code
        FROM municipalities m
        LEFT JOIN counties c ON c.id = m.county_id
        WHERE m.code != ?
        LIMIT 400
      `).all(areaCode);
    }

    var scored = [];

    candidates.forEach(function(cand) {
      var candDemo = db.prepare(
        'SELECT * FROM area_demographics WHERE area_code = ? ORDER BY data_year DESC LIMIT 1'
      ).get(cand.code);

      var candResults = db.prepare(`
        SELECT party_code, vote_percentage FROM election_results
        WHERE ${colName} = ? AND election_year = 2022 AND election_type = 'riksdag'
        ORDER BY votes DESC
      `).all(cand.code);

      var candVec = buildVector(candDemo, candResults);
      var sim = cosineSimilarity(targetVec, candVec);

      // Only include areas with at least some data
      var hasData = (candDemo != null) || (candResults.length > 0);
      if (!hasData) return;

      // Top party for display
      var topParty = candResults.length > 0 ? candResults[0].party_code : null;
      var topPartyPct = candResults.length > 0 ? candResults[0].vote_percentage : null;

      // Key demographic match reason
      var matchReasons = [];
      if (targetDemo && candDemo) {
        if (Math.abs((targetDemo.foreign_born_pct || 0) - (candDemo.foreign_born_pct || 0)) < 3) matchReasons.push('foreign_born');
        if (Math.abs((targetDemo.higher_education_pct || 0) - (candDemo.higher_education_pct || 0)) < 5) matchReasons.push('education');
        if (Math.abs((targetDemo.unemployment_pct || 0) - (candDemo.unemployment_pct || 0)) < 2) matchReasons.push('employment');
        if (Math.abs((targetDemo.median_age || 0) - (candDemo.median_age || 0)) < 3) matchReasons.push('age');
      }

      scored.push({
        area_code: cand.code,
        area_name: cand.name,
        municipality_name: cand.municipality_name || null,
        county_name: cand.county_name,
        population: cand.population,
        similarity_score: Math.round(sim * 100),
        similarity_pct: (sim * 100).toFixed(1),
        top_party: topParty,
        top_party_pct: topPartyPct ? topPartyPct.toFixed(1) : null,
        key_demographic_match: matchReasons[0] || 'voting_pattern',
        demographics: candDemo ? {
          foreign_born_pct: candDemo.foreign_born_pct,
          median_age: candDemo.median_age,
          median_income: candDemo.median_income,
          unemployment_pct: candDemo.unemployment_pct,
          higher_education_pct: candDemo.higher_education_pct
        } : null
      });
    });

    // Sort by similarity descending, take top N
    scored.sort(function(a, b) { return b.similarity_score - a.similarity_score; });
    var topN = scored.slice(0, limit);

    res.json({
      area_code: areaCode,
      area_name: targetArea.name,
      area_type: areaType,
      similar_areas: topN,
      total_compared: scored.length
    });
  } catch (err) {
    console.error('Area similarity error:', err);
    res.status(500).json({ error: 'Failed to find similar areas: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 4 FEATURE 1: CAMPAIGN PLAYBACK TIMELINE
// ═══════════════════════════════════════════════════════════

// GET /api/campaigns/:id/timeline
app.get(BASE + '/api/campaigns/:id/timeline', function(req, res) {
  try {
    var campaignId = req.params.id;

    // Get contacts grouped by date with district location data
    var rows = db.prepare(`
      SELECT
        date(c.created_at) as contact_date,
        COALESCE(vd.code, 'UNKNOWN') as district_code,
        vd.name as district_name,
        c.outcome,
        COUNT(*) as contact_count,
        AVG(COALESCE(c.location_lat, pc.latitude)) as lat,
        AVG(COALESCE(c.location_lng, pc.longitude)) as lng
      FROM contacts c
      JOIN voters v ON v.id = c.voter_id
      LEFT JOIN voting_districts vd ON vd.id = v.district_id
      LEFT JOIN municipalities m ON m.id = v.municipality_id
      LEFT JOIN (
        SELECT DISTINCT postcode, latitude, longitude FROM postcodes WHERE latitude IS NOT NULL
      ) pc ON pc.postcode = v.postcode
      WHERE c.campaign_id = ?
      GROUP BY date(c.created_at), vd.code, c.outcome
      ORDER BY contact_date, district_code
    `).all(campaignId);

    // Gather all unique dates
    var dateSet = {};
    rows.forEach(function(r) { dateSet[r.contact_date] = true; });
    var dates = Object.keys(dateSet).sort();

    // Build activity array
    var activityMap = {};
    rows.forEach(function(r) {
      var key = r.contact_date + '|' + r.district_code;
      if (!activityMap[key]) {
        activityMap[key] = {
          date: r.contact_date,
          district_code: r.district_code,
          district_name: r.district_name || r.district_code,
          lat: r.lat || null,
          lng: r.lng || null,
          contact_count: 0,
          outcomes: {}
        };
      }
      activityMap[key].contact_count += r.contact_count;
      activityMap[key].outcomes[r.outcome] = (activityMap[key].outcomes[r.outcome] || 0) + r.contact_count;
    });

    var activity = Object.values(activityMap).sort(function(a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    res.json({ dates: dates, activity: activity, total_contacts: rows.reduce(function(s,r){ return s + r.contact_count; }, 0) });
  } catch (err) {
    console.error('Timeline error:', err);
    res.status(500).json({ error: 'Failed to get campaign timeline' });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 4 FEATURE 2: PARTY BLOC ANALYTICS
// ═══════════════════════════════════════════════════════════

var RED_GREEN = ['S','V','MP'];
var BLUE_BLOC = ['M','KD','L'];

function computeBlocData(results) {
  var rgPct = 0, bluePct = 0, sdPct = 0, cPct = 0, totalPct = 0;
  results.forEach(function(r) {
    var pct = r.vote_percentage || 0;
    totalPct += pct;
    if (RED_GREEN.indexOf(r.party_code) >= 0) rgPct += pct;
    else if (BLUE_BLOC.indexOf(r.party_code) >= 0) bluePct += pct;
    else if (r.party_code === 'SD') sdPct += pct;
    else if (r.party_code === 'C') cPct += pct;
  });
  var dominant = 'other';
  var maxPct = Math.max(rgPct, bluePct, sdPct);
  if (maxPct === rgPct && rgPct > 0) dominant = 'red_green';
  else if (maxPct === bluePct && bluePct > 0) dominant = 'blue';
  else if (maxPct === sdPct && sdPct > 0) dominant = 'sd';
  return { red_green_pct: rgPct, blue_pct: bluePct, sd_pct: sdPct, c_pct: cPct, dominant_bloc: dominant };
}

// GET /api/analytics/bloc-map?year=2022
app.get(BASE + '/api/analytics/bloc-map', function(req, res) {
  try {
    var year = parseInt(req.query.year) || 2022;
    var prevYear = year === 2022 ? 2018 : 2014;

    var currentResults = db.prepare(`
      SELECT county_code as area_code, party_code, vote_percentage
      FROM election_results
      WHERE election_year = ? AND election_type = 'riksdag' AND level = 'county' AND county_code IS NOT NULL
      ORDER BY county_code, votes DESC
    `).all(year);

    var prevResults = db.prepare(`
      SELECT county_code as area_code, party_code, vote_percentage
      FROM election_results
      WHERE election_year = ? AND election_type = 'riksdag' AND level = 'county' AND county_code IS NOT NULL
      ORDER BY county_code, votes DESC
    `).all(prevYear);

    var counties = db.prepare('SELECT code, name FROM counties').all();

    // Group by area
    function groupByArea(rows) {
      var map = {};
      rows.forEach(function(r) {
        if (!map[r.area_code]) map[r.area_code] = [];
        map[r.area_code].push(r);
      });
      return map;
    }

    var curMap = groupByArea(currentResults);
    var prevMap = groupByArea(prevResults);

    var areas = [];
    counties.forEach(function(c) {
      var cur = computeBlocData(curMap[c.code] || []);
      var prev = computeBlocData(prevMap[c.code] || []);
      var swingFrom = null;
      if (prev.dominant_bloc !== cur.dominant_bloc) {
        swingFrom = prev.dominant_bloc;
      }
      areas.push(Object.assign({
        area_code: c.code,
        area_name: c.name,
        swing_from_previous: swingFrom,
        rg_swing: (cur.red_green_pct - prev.red_green_pct).toFixed(1),
        blue_swing: (cur.blue_pct - prev.blue_pct).toFixed(1),
        sd_swing: (cur.sd_pct - prev.sd_pct).toFixed(1)
      }, cur));
    });

    // Summary totals (nationwide weighted avg by first available)
    var allCur = computeBlocData(currentResults);
    res.json({ year: year, prev_year: prevYear, areas: areas, summary: allCur });
  } catch (err) {
    console.error('Bloc map error:', err);
    res.status(500).json({ error: 'Failed to get bloc map data' });
  }
});

// GET /api/analytics/bloc-history
app.get(BASE + '/api/analytics/bloc-history', function(req, res) {
  try {
    var years = [2018, 2022];
    var history = {};

    years.forEach(function(year) {
      var results = db.prepare(`
        SELECT county_code as area_code, party_code, vote_percentage
        FROM election_results
        WHERE election_year = ? AND election_type = 'riksdag' AND level = 'county' AND county_code IS NOT NULL
      `).all(year);

      var byArea = {};
      results.forEach(function(r) {
        if (!byArea[r.area_code]) byArea[r.area_code] = [];
        byArea[r.area_code].push(r);
      });

      history[year] = {};
      Object.keys(byArea).forEach(function(code) {
        history[year][code] = computeBlocData(byArea[code]);
      });
    });

    res.json({ years: years, history: history });
  } catch (err) {
    console.error('Bloc history error:', err);
    res.status(500).json({ error: 'Failed to get bloc history' });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 4 FEATURE 3: VOLUNTEER SELF-SERVICE PORTAL
// ═══════════════════════════════════════════════════════════

// GET /api/portal/campaigns — public, no auth required
app.get(BASE + '/api/portal/campaigns', function(req, res) {
  try {
    var campaigns = db.prepare(`
      SELECT id, name, election_type, election_date, party, description, status
      FROM campaigns WHERE status = 'active'
      ORDER BY created_at DESC
    `).all();
    res.json({ data: campaigns });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get campaigns' });
  }
});

// POST /api/portal/signup — public volunteer registration
app.post(BASE + '/api/portal/signup', function(req, res) {
  try {
    var { v4: uuidv4 } = require('uuid');
    var { name, email, phone, languages, message, shift_id } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    var id = uuidv4();
    var langStr = Array.isArray(languages) ? JSON.stringify(languages) : (languages || null);
    db.prepare(`INSERT INTO volunteer_signups (id, shift_id, name, email, phone, languages, message)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, shift_id || null, name, email, phone || null, langStr, message || null);

    // Increment current_volunteers on shift if provided
    if (shift_id) {
      db.prepare(`UPDATE volunteer_shifts SET current_volunteers = current_volunteers + 1 WHERE id = ? AND current_volunteers < max_volunteers`)
        .run(shift_id);
    }

    res.status(201).json({ message: 'Signup recorded', id: id });
  } catch (err) {
    console.error('Portal signup error:', err);
    res.status(500).json({ error: 'Failed to record signup' });
  }
});

// GET /api/portal/shifts/:campaignId — public, list available shifts
app.get(BASE + '/api/portal/shifts/:campaignId', function(req, res) {
  try {
    var shifts = db.prepare(`
      SELECT * FROM volunteer_shifts
      WHERE campaign_id = ? AND status = 'open' AND start_time > datetime('now')
      ORDER BY start_time ASC
    `).all(req.params.campaignId);
    res.json({ data: shifts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get shifts' });
  }
});

// POST /api/portal/shifts/:shiftId/join
app.post(BASE + '/api/portal/shifts/:shiftId/join', function(req, res) {
  try {
    var shift = db.prepare('SELECT * FROM volunteer_shifts WHERE id = ?').get(req.params.shiftId);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (shift.current_volunteers >= shift.max_volunteers) return res.status(400).json({ error: 'Shift is full' });

    var { v4: uuidv4 } = require('uuid');
    var { name, email, phone, languages, message } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    var id = uuidv4();
    var langStr = Array.isArray(languages) ? JSON.stringify(languages) : (languages || null);
    db.prepare(`INSERT INTO volunteer_signups (id, shift_id, name, email, phone, languages, message)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.params.shiftId, name, email, phone || null, langStr, message || null);

    db.prepare('UPDATE volunteer_shifts SET current_volunteers = current_volunteers + 1 WHERE id = ?').run(req.params.shiftId);

    res.status(201).json({ message: 'Joined shift', id: id });
  } catch (err) {
    console.error('Shift join error:', err);
    res.status(500).json({ error: 'Failed to join shift' });
  }
});

// GET /api/admin/volunteers — list signups (admin)
app.get(BASE + '/api/admin/volunteers', function(req, res) {
  try {
    var { status, shift_id } = req.query;
    var where = '1=1';
    var params = [];
    if (status) { where += ' AND vs.status = ?'; params.push(status); }
    if (shift_id) { where += ' AND vs.shift_id = ?'; params.push(shift_id); }
    var rows = db.prepare(`
      SELECT vs.*, vsh.title as shift_title, vsh.start_time, vsh.shift_type, vsh.location
      FROM volunteer_signups vs
      LEFT JOIN volunteer_shifts vsh ON vsh.id = vs.shift_id
      WHERE ${where}
      ORDER BY vs.created_at DESC LIMIT 200
    `).all(...params);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get volunteer signups' });
  }
});

// PUT /api/admin/volunteers/:id — approve/decline
app.put(BASE + '/api/admin/volunteers/:id', function(req, res) {
  try {
    var { status } = req.body;
    if (!status || !['pending','approved','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare("UPDATE volunteer_signups SET status = ? WHERE id = ?").run(status, req.params.id);
    var updated = db.prepare('SELECT * FROM volunteer_signups WHERE id = ?').get(req.params.id);
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update volunteer' });
  }
});

// POST /api/admin/shifts — create shift
app.post(BASE + '/api/admin/shifts', function(req, res) {
  try {
    var { v4: uuidv4 } = require('uuid');
    var { campaign_id, title, description, shift_type, location, district_code, start_time, end_time, max_volunteers } = req.body;
    if (!campaign_id || !title || !start_time || !end_time) return res.status(400).json({ error: 'campaign_id, title, start_time, end_time required' });
    var id = uuidv4();
    db.prepare(`INSERT INTO volunteer_shifts (id, campaign_id, title, description, shift_type, location, district_code, start_time, end_time, max_volunteers)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, campaign_id, title, description || null, shift_type || 'door_knock', location || null, district_code || null, start_time, end_time, max_volunteers || 5);
    res.status(201).json({ data: db.prepare('SELECT * FROM volunteer_shifts WHERE id = ?').get(id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// ═══════════════════════════════════════════════════════════
// PHASE 4 FEATURE 4: VOLUNTEER JOURNEY & BADGES
// ═══════════════════════════════════════════════════════════

var BADGE_DEFS = [
  { type: 'first_contact',     name: 'Forsta steget',      name_en: 'First Step',         icon: 'fa-shoe-prints',  xp: 50,   check: function(s) { return s.total_contacts >= 1; } },
  { type: 'caller_10',         name: 'Ringare',             name_en: 'Caller',             icon: 'fa-phone',        xp: 100,  check: function(s) { return s.total_calls >= 10; } },
  { type: 'door_knocker_10',   name: 'Dorrknackare',        name_en: 'Door Knocker',       icon: 'fa-door-open',    xp: 100,  check: function(s) { return s.total_doors >= 10; } },
  { type: 'marathon',          name: 'Marathonlopare',      name_en: 'Marathon',           icon: 'fa-running',      xp: 250,  check: function(s) { return s.total_contacts >= 50; } },
  { type: 'week_streak',       name: 'Veckostreak',         name_en: 'Week Streak',        icon: 'fa-fire',         xp: 200,  check: function(s) { return s.current_streak >= 7; } },
  { type: 'marathon_100',      name: 'Samordnare',          name_en: 'Coordinator',        icon: 'fa-medal',        xp: 500,  check: function(s, badges) { return s.total_contacts >= 100 && badges.length >= 3; } },
  { type: 'legend',            name: 'Legend',              name_en: 'Legend',             icon: 'fa-crown',        xp: 1000, check: function(s, badges) { return s.total_contacts >= 500 && badges.length >= 8; } }
];

function getLevelFromXp(xp) {
  if (xp >= 2000) return 'legend';
  if (xp >= 800)  return 'coordinator';
  if (xp >= 350)  return 'veteran';
  if (xp >= 100)  return 'active';
  return 'rookie';
}

function getXpForLevel(level) {
  var map = { rookie: 0, active: 100, veteran: 350, coordinator: 800, legend: 2000 };
  return map[level] || 0;
}

function awardBadgesForUser(userId) {
  try {
    var stats = db.prepare('SELECT * FROM volunteer_stats WHERE user_id = ?').get(userId);
    if (!stats) return;

    var existingBadges = db.prepare('SELECT badge_type FROM volunteer_badges WHERE user_id = ?').all(userId);
    var earned = existingBadges.map(function(b) { return b.badge_type; });

    var { v4: uuidv4 } = require('uuid');
    var newXp = stats.xp || 0;

    BADGE_DEFS.forEach(function(def) {
      if (earned.indexOf(def.type) >= 0) return; // already earned
      if (def.check(stats, existingBadges)) {
        db.prepare('INSERT INTO volunteer_badges (id, user_id, badge_type, badge_name, badge_icon) VALUES (?,?,?,?,?)')
          .run(uuidv4(), userId, def.type, def.name, def.icon);
        newXp += def.xp;
        earned.push(def.type);
      }
    });

    var newLevel = getLevelFromXp(newXp);
    db.prepare("UPDATE volunteer_stats SET xp = ?, level = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(newXp, newLevel, userId);
  } catch(e) {
    console.error('Badge award error:', e);
  }
}

function updateVolunteerStats(userId, contactType) {
  try {
    var { v4: uuidv4 } = require('uuid');
    var existing = db.prepare('SELECT * FROM volunteer_stats WHERE user_id = ?').get(userId);

    if (!existing) {
      db.prepare(`INSERT INTO volunteer_stats (id, user_id, total_contacts, total_doors, total_calls, last_activity_at)
        VALUES (?,?,1,?,?,datetime('now'))`)
        .run(uuidv4(), userId, contactType === 'door' ? 1 : 0, contactType === 'phone' ? 1 : 0);
    } else {
      var doorInc = contactType === 'door' ? 1 : 0;
      var callInc = contactType === 'phone' ? 1 : 0;

      // Streak logic
      var now = new Date();
      var lastActivity = existing.last_activity_at ? new Date(existing.last_activity_at) : null;
      var streak = existing.current_streak || 0;
      if (lastActivity) {
        var diffDays = Math.floor((now - lastActivity) / 86400000);
        if (diffDays === 0) { /* same day, no streak change */ }
        else if (diffDays === 1) { streak += 1; }
        else { streak = 1; }
      } else {
        streak = 1;
      }
      var longest = Math.max(existing.longest_streak || 0, streak);

      db.prepare(`UPDATE volunteer_stats SET
        total_contacts = total_contacts + 1,
        total_doors = total_doors + ?,
        total_calls = total_calls + ?,
        current_streak = ?,
        longest_streak = ?,
        last_activity_at = datetime('now')
        WHERE user_id = ?`)
        .run(doorInc, callInc, streak, longest, userId);
    }

    awardBadgesForUser(userId);
  } catch(e) {
    console.error('updateVolunteerStats error:', e);
  }
}

function getVolunteerUserId(req) {
  try {
    var jwt = require('jsonwebtoken');
    var token = (req.headers.authorization || '').replace('Bearer ', '');
    var payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.userId || null;
  } catch(e) { return null; }
}

// GET /api/volunteers/me/stats
app.get(BASE + '/api/volunteers/me/stats', function(req, res) {
  try {
    var userId = getVolunteerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    var stats = db.prepare('SELECT * FROM volunteer_stats WHERE user_id = ?').get(userId);
    if (!stats) {
      stats = { user_id: userId, total_contacts: 0, total_doors: 0, total_calls: 0, total_events: 0, total_hours: 0, current_streak: 0, longest_streak: 0, level: 'rookie', xp: 0, last_activity_at: null };
    }

    var nextLevel = { rookie: 'active', active: 'veteran', veteran: 'coordinator', coordinator: 'legend', legend: null };
    var nextLevelName = nextLevel[stats.level] || null;
    var curXpNeeded = getXpForLevel(stats.level);
    var nextXpNeeded = nextLevelName ? getXpForLevel(nextLevelName) : null;
    var progress = nextXpNeeded ? Math.min(100, Math.round(((stats.xp - curXpNeeded) / (nextXpNeeded - curXpNeeded)) * 100)) : 100;

    res.json({ data: stats, next_level: nextLevelName, xp_to_next: nextXpNeeded ? (nextXpNeeded - stats.xp) : 0, level_progress_pct: progress });
  } catch(err) {
    res.status(500).json({ error: 'Failed to get volunteer stats' });
  }
});

// GET /api/volunteers/me/badges
app.get(BASE + '/api/volunteers/me/badges', function(req, res) {
  try {
    var userId = getVolunteerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    var earned = db.prepare('SELECT * FROM volunteer_badges WHERE user_id = ? ORDER BY earned_at DESC').all(userId);
    var earnedTypes = earned.map(function(b) { return b.badge_type; });

    var all = BADGE_DEFS.map(function(def) {
      var earnedBadge = earned.find(function(b) { return b.badge_type === def.type; });
      return {
        type: def.type,
        name: def.name,
        name_en: def.name_en,
        icon: def.icon,
        xp: def.xp,
        earned: !!earnedBadge,
        earned_at: earnedBadge ? earnedBadge.earned_at : null
      };
    });

    res.json({ data: all, earned_count: earnedTypes.length, total: BADGE_DEFS.length });
  } catch(err) {
    res.status(500).json({ error: 'Failed to get badges' });
  }
});

// GET /api/volunteers/leaderboard
app.get(BASE + '/api/volunteers/leaderboard', function(req, res) {
  try {
    var rows = db.prepare(`
      SELECT vs.*, u.name, u.email
      FROM volunteer_stats vs
      JOIN users u ON u.id = vs.user_id
      ORDER BY vs.xp DESC LIMIT 10
    `).all();
    res.json({ data: rows });
  } catch(err) {
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// GET /api/volunteers/me/activity - recent contacts by current user
app.get(BASE + '/api/volunteers/me/activity', function(req, res) {
  try {
    var userId = getVolunteerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    var activity = db.prepare(`
      SELECT c.*, v.full_name as voter_name, v.postcode
      FROM contacts c
      LEFT JOIN voters v ON v.id = c.voter_id
      WHERE c.agent_id = ?
      ORDER BY c.created_at DESC LIMIT 20
    `).all(userId);
    res.json({ data: activity });
  } catch(err) {
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// Hook into the existing contact logging to update volunteer stats
// Monkey-patch the /api/contacts route results by wrapping the response —
// instead, handle via a dedicated endpoint that is called alongside contact logging.
// The contacts route already creates contacts; we use a lightweight middleware hook via:
app.use(BASE + '/api/contacts', function(req, res, next) {
  var _json = res.json.bind(res);
  res.json = function(data) {
    if (req.method === 'POST' && data && data.data && data.data.agent_id) {
      var contactType = (data.data.contact_type === 'door') ? 'door' : 'phone';
      updateVolunteerStats(data.data.agent_id, contactType);
    }
    return _json(data);
  };
  next();
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
