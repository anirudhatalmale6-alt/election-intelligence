const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET / - list all counties with municipality count
router.get('/', (req, res) => {
  try {
    const counties = db.prepare(`
      SELECT c.*, COUNT(m.id) AS municipality_count
      FROM counties c
      LEFT JOIN municipalities m ON m.county_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json({ data: counties });
  } catch (err) {
    console.error('Error listing counties with municipality count:', err);
    res.status(500).json({ error: 'Failed to retrieve geographic data' });
  }
});

// GET /counties - list counties
router.get('/counties', (req, res) => {
  try {
    const counties = db.prepare('SELECT * FROM counties ORDER BY name').all();
    res.json({ data: counties });
  } catch (err) {
    console.error('Error listing counties:', err);
    res.status(500).json({ error: 'Failed to retrieve counties' });
  }
});

// GET /counties/:code - get county with its municipalities
router.get('/counties/:code', (req, res) => {
  try {
    const county = db.prepare('SELECT * FROM counties WHERE code = ?').get(req.params.code);
    if (!county) {
      return res.status(404).json({ error: 'County not found' });
    }
    const municipalities = db.prepare(
      'SELECT * FROM municipalities WHERE county_id = ? ORDER BY name'
    ).all(county.id);
    res.json({ data: { ...county, municipalities } });
  } catch (err) {
    console.error('Error getting county:', err);
    res.status(500).json({ error: 'Failed to retrieve county' });
  }
});

// GET /municipalities - list all municipalities (filterable by county_id)
router.get('/municipalities', (req, res) => {
  try {
    const { county_id } = req.query;
    let sql = 'SELECT * FROM municipalities';
    const params = [];
    if (county_id) {
      sql += ' WHERE county_id = ?';
      params.push(county_id);
    }
    sql += ' ORDER BY name';
    const municipalities = db.prepare(sql).all(...params);
    res.json({ data: municipalities });
  } catch (err) {
    console.error('Error listing municipalities:', err);
    res.status(500).json({ error: 'Failed to retrieve municipalities' });
  }
});

// GET /municipalities/:code - get municipality details
router.get('/municipalities/:code', (req, res) => {
  try {
    const municipality = db.prepare('SELECT * FROM municipalities WHERE code = ?').get(req.params.code);
    if (!municipality) {
      return res.status(404).json({ error: 'Municipality not found' });
    }
    res.json({ data: municipality });
  } catch (err) {
    console.error('Error getting municipality:', err);
    res.status(500).json({ error: 'Failed to retrieve municipality' });
  }
});

// GET /districts - list voting districts (filterable by municipality_id)
router.get('/districts', (req, res) => {
  try {
    const { municipality_id } = req.query;
    let sql = 'SELECT * FROM districts';
    const params = [];
    if (municipality_id) {
      sql += ' WHERE municipality_id = ?';
      params.push(municipality_id);
    }
    sql += ' ORDER BY name';
    const districts = db.prepare(sql).all(...params);
    res.json({ data: districts });
  } catch (err) {
    console.error('Error listing districts:', err);
    res.status(500).json({ error: 'Failed to retrieve districts' });
  }
});

// GET /search?q=postcode_or_name - search across all geo levels
router.get('/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query "q" is required' });
    }
    const searchTerm = `%${q.trim()}%`;

    const counties = db.prepare(
      'SELECT *, \'county\' AS level FROM counties WHERE name LIKE ? OR code LIKE ?'
    ).all(searchTerm, searchTerm);

    const municipalities = db.prepare(
      'SELECT *, \'municipality\' AS level FROM municipalities WHERE name LIKE ? OR code LIKE ? OR postcode LIKE ?'
    ).all(searchTerm, searchTerm, searchTerm);

    const districts = db.prepare(
      'SELECT *, \'district\' AS level FROM districts WHERE name LIKE ? OR code LIKE ?'
    ).all(searchTerm, searchTerm);

    res.json({
      data: {
        counties,
        municipalities,
        districts,
        total: counties.length + municipalities.length + districts.length
      }
    });
  } catch (err) {
    console.error('Error searching geo data:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
