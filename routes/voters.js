const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// GET / - list voters for a campaign
router.get('/', (req, res) => {
  try {
    const { campaign_id, support_status, district_id, postcode, search, page = 1, limit = 50 } = req.query;

    if (!campaign_id) {
      return res.status(400).json({ error: 'campaign_id query parameter is required' });
    }

    const conditions = ['campaign_id = ?'];
    const params = [campaign_id];

    if (support_status) {
      conditions.push('support_status = ?');
      params.push(support_status);
    }
    if (district_id) {
      conditions.push('district_id = ?');
      params.push(district_id);
    }
    if (postcode) {
      conditions.push('postcode = ?');
      params.push(postcode);
    }
    if (search) {
      conditions.push('(first_name LIKE ? OR last_name LIKE ? OR address LIKE ? OR phone LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const whereClause = conditions.join(' AND ');
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM voters WHERE ${whereClause}`
    ).get(...params).count;

    const voters = db.prepare(
      `SELECT * FROM voters WHERE ${whereClause} ORDER BY last_name, first_name LIMIT ? OFFSET ?`
    ).all(...params, parseInt(limit), offset);

    res.json({
      data: voters,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Error listing voters:', err);
    res.status(500).json({ error: 'Failed to retrieve voters' });
  }
});

// GET /queue/:campaignId - get next voter in priority queue
router.get('/queue/:campaignId', (req, res) => {
  try {
    const voter = db.prepare(`
      SELECT * FROM voters
      WHERE campaign_id = ? AND is_contacted = 0
      ORDER BY ai_priority_rank ASC
      LIMIT 1
    `).get(req.params.campaignId);

    if (!voter) {
      return res.json({ data: null, message: 'No more voters in queue' });
    }
    res.json({ data: voter });
  } catch (err) {
    console.error('Error getting next voter:', err);
    res.status(500).json({ error: 'Failed to retrieve next voter' });
  }
});

// GET /:id - get single voter with contact history
router.get('/:id', (req, res) => {
  try {
    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
    if (!voter) {
      return res.status(404).json({ error: 'Voter not found' });
    }

    const contacts = db.prepare(
      'SELECT * FROM contacts WHERE voter_id = ? ORDER BY created_at DESC'
    ).all(voter.id);

    res.json({ data: { ...voter, contact_history: contacts } });
  } catch (err) {
    console.error('Error getting voter:', err);
    res.status(500).json({ error: 'Failed to retrieve voter' });
  }
});

// POST /import - bulk import voters from JSON array
router.post('/import', (req, res) => {
  try {
    const { campaign_id, voters } = req.body;

    if (!campaign_id) {
      return res.status(400).json({ error: 'campaign_id is required' });
    }
    if (!Array.isArray(voters) || voters.length === 0) {
      return res.status(400).json({ error: 'voters must be a non-empty array' });
    }

    const insert = db.prepare(`
      INSERT INTO voters (id, campaign_id, first_name, last_name, phone, email, address, postcode, district_id, county_id, municipality_id, support_status, is_contacted, contact_count, ai_priority_rank, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    let imported = 0;
    let errors = [];

    const importMany = db.transaction((voterList) => {
      for (let i = 0; i < voterList.length; i++) {
        const v = voterList[i];
        try {
          const id = uuidv4();
          insert.run(
            id, campaign_id,
            v.first_name || null, v.last_name || null,
            v.phone || null, v.email || null,
            v.address || null, v.postcode || null,
            v.district_id || null, v.county_id || null, v.municipality_id || null,
            v.support_status || 'unknown',
            v.ai_priority_rank || 999,
            now, now
          );
          imported++;
        } catch (e) {
          errors.push({ index: i, error: e.message });
        }
      }
    });

    importMany(voters);

    res.status(201).json({
      message: `Imported ${imported} of ${voters.length} voters`,
      imported,
      total: voters.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('Error importing voters:', err);
    res.status(500).json({ error: 'Failed to import voters' });
  }
});

// POST / - create single voter
router.post('/', (req, res) => {
  try {
    const { campaign_id, first_name, last_name, phone, email, address, postcode, district_id, county_id, municipality_id, support_status, ai_priority_rank } = req.body;

    if (!campaign_id) {
      return res.status(400).json({ error: 'campaign_id is required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO voters (id, campaign_id, first_name, last_name, phone, email, address, postcode, district_id, county_id, municipality_id, support_status, is_contacted, contact_count, ai_priority_rank, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).run(
      id, campaign_id,
      first_name || null, last_name || null,
      phone || null, email || null,
      address || null, postcode || null,
      district_id || null, county_id || null, municipality_id || null,
      support_status || 'unknown',
      ai_priority_rank || 999,
      now, now
    );

    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(id);
    res.status(201).json({ data: voter });
  } catch (err) {
    console.error('Error creating voter:', err);
    res.status(500).json({ error: 'Failed to create voter' });
  }
});

// PUT /:id - update voter
router.put('/:id', (req, res) => {
  try {
    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
    if (!voter) {
      return res.status(404).json({ error: 'Voter not found' });
    }

    const { first_name, last_name, phone, email, address, postcode, district_id, county_id, municipality_id, support_status, ai_priority_rank } = req.body;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE voters
      SET first_name = ?, last_name = ?, phone = ?, email = ?, address = ?, postcode = ?,
          district_id = ?, county_id = ?, municipality_id = ?, support_status = ?,
          ai_priority_rank = ?, updated_at = ?
      WHERE id = ?
    `).run(
      first_name !== undefined ? first_name : voter.first_name,
      last_name !== undefined ? last_name : voter.last_name,
      phone !== undefined ? phone : voter.phone,
      email !== undefined ? email : voter.email,
      address !== undefined ? address : voter.address,
      postcode !== undefined ? postcode : voter.postcode,
      district_id !== undefined ? district_id : voter.district_id,
      county_id !== undefined ? county_id : voter.county_id,
      municipality_id !== undefined ? municipality_id : voter.municipality_id,
      support_status !== undefined ? support_status : voter.support_status,
      ai_priority_rank !== undefined ? ai_priority_rank : voter.ai_priority_rank,
      now,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
    res.json({ data: updated });
  } catch (err) {
    console.error('Error updating voter:', err);
    res.status(500).json({ error: 'Failed to update voter' });
  }
});

// DELETE /:id - delete voter
router.delete('/:id', (req, res) => {
  try {
    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
    if (!voter) {
      return res.status(404).json({ error: 'Voter not found' });
    }

    db.prepare('DELETE FROM voters WHERE id = ?').run(req.params.id);
    res.json({ message: 'Voter deleted successfully' });
  } catch (err) {
    console.error('Error deleting voter:', err);
    res.status(500).json({ error: 'Failed to delete voter' });
  }
});

module.exports = router;
