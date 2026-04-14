const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.use(authenticateToken);

// GET / - list election results
router.get('/', (req, res) => {
  try {
    const { year, type, level, page = 1, limit = 50 } = req.query;

    const conditions = [];
    const params = [];

    if (year) {
      conditions.push('election_year = ?');
      params.push(parseInt(year));
    }
    if (type) {
      conditions.push('election_type = ?');
      params.push(type);
    }
    if (level) {
      conditions.push('level = ?');
      params.push(level);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM election_results ${whereClause}`
    ).get(...params).count;

    const results = db.prepare(
      `SELECT er.*, p.name as party_name, p.name_en as party_name_en, p.color as party_color
       FROM election_results er
       LEFT JOIN parties p ON p.code = er.party_code
       ${whereClause}
       ORDER BY er.election_year DESC, er.votes DESC
       LIMIT ? OFFSET ?`
    ).all(...params, parseInt(limit), offset);

    res.json({
      data: results,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Error listing results:', err);
    res.status(500).json({ error: 'Failed to retrieve election results' });
  }
});

// GET /summary/:year/:type - summary for an election
router.get('/summary/:year/:type', (req, res) => {
  try {
    const { year, type } = req.params;

    const results = db.prepare(`
      SELECT er.*, p.name as party_name, p.name_en as party_name_en, p.color as party_color
      FROM election_results er
      LEFT JOIN parties p ON p.code = er.party_code
      WHERE er.election_year = ? AND er.election_type = ?
      ORDER BY er.votes DESC
    `).all(parseInt(year), type);

    if (results.length === 0) {
      return res.status(404).json({ error: 'No results found for this election' });
    }

    res.json({ data: results });
  } catch (err) {
    console.error('Error getting election summary:', err);
    res.status(500).json({ error: 'Failed to retrieve election summary' });
  }
});

// POST /import - import results (admin only)
router.post('/import', requireAdmin, (req, res) => {
  try {
    const { results } = req.body;
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results must be a non-empty array' });
    }

    const insert = db.prepare(`
      INSERT INTO election_results (id, election_year, election_type, level, party_code, votes, vote_percentage, seats, registered_voters, total_votes, turnout_percentage, county_code, municipality_code, district_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    const importMany = db.transaction((list) => {
      for (const r of list) {
        try {
          insert.run(uuidv4(), r.election_year, r.election_type, r.level || 'national',
            r.party_code, r.votes || 0, r.vote_percentage || 0, r.seats || 0,
            r.registered_voters || 0, r.total_votes || 0, r.turnout_percentage || 0,
            r.county_code || null, r.municipality_code || null, r.district_code || null);
          imported++;
        } catch (e) { /* skip duplicates */ }
      }
    });
    importMany(results);

    res.status(201).json({ message: `Imported ${imported} of ${results.length} results`, imported });
  } catch (err) {
    console.error('Error importing results:', err);
    res.status(500).json({ error: 'Failed to import results' });
  }
});

module.exports = router;
