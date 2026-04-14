const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// GET / - list campaigns
router.get('/', (req, res) => {
  try {
    const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    res.json({ data: campaigns });
  } catch (err) {
    console.error('Error listing campaigns:', err);
    res.status(500).json({ error: 'Failed to retrieve campaigns' });
  }
});

// GET /:id - get campaign with stats
router.get('/:id', (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const voterStats = db.prepare(`
      SELECT
        COUNT(*) AS total_voters,
        SUM(CASE WHEN is_contacted = 1 THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN support_status = 'supporter' THEN 1 ELSE 0 END) AS supporters,
        SUM(CASE WHEN support_status = 'opposition' THEN 1 ELSE 0 END) AS opposition,
        SUM(CASE WHEN support_status = 'undecided' THEN 1 ELSE 0 END) AS undecided
      FROM voters WHERE campaign_id = ?
    `).get(campaign.id);

    const contactStats = db.prepare(`
      SELECT COUNT(*) AS total_contacts
      FROM contacts WHERE campaign_id = ?
    `).get(campaign.id);

    const candidateCount = db.prepare(
      'SELECT COUNT(*) AS count FROM candidates WHERE campaign_id = ?'
    ).get(campaign.id);

    res.json({
      data: {
        ...campaign,
        stats: {
          ...voterStats,
          total_contacts: contactStats.total_contacts,
          candidate_count: candidateCount.count
        }
      }
    });
  } catch (err) {
    console.error('Error getting campaign:', err);
    res.status(500).json({ error: 'Failed to retrieve campaign' });
  }
});

// POST / - create campaign
router.post('/', (req, res) => {
  try {
    const { name, description, election_date, election_type, status, area_code, area_level } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO campaigns (id, name, description, election_date, election_type, status, area_code, area_level, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description || null, election_date || null, election_type || null, status || 'draft', area_code || null, area_level || null, req.user.id, now, now);

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    res.status(201).json({ data: campaign });
  } catch (err) {
    console.error('Error creating campaign:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// PUT /:id - update campaign
router.put('/:id', (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { name, description, election_date, election_type, status, area_code, area_level } = req.body;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE campaigns
      SET name = ?, description = ?, election_date = ?, election_type = ?, status = ?, area_code = ?, area_level = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name || campaign.name,
      description !== undefined ? description : campaign.description,
      election_date !== undefined ? election_date : campaign.election_date,
      election_type !== undefined ? election_type : campaign.election_type,
      status || campaign.status,
      area_code !== undefined ? area_code : campaign.area_code,
      area_level !== undefined ? area_level : campaign.area_level,
      now,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    res.json({ data: updated });
  } catch (err) {
    console.error('Error updating campaign:', err);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// DELETE /:id - delete campaign
router.delete('/:id', (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
    res.json({ message: 'Campaign deleted successfully' });
  } catch (err) {
    console.error('Error deleting campaign:', err);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

// POST /:id/candidates - add candidate
router.post('/:id/candidates', (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { name, party, position, is_incumbent, bio, photo_url } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Candidate name is required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO candidates (id, campaign_id, name, party, position, is_incumbent, bio, photo_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, name, party || null, position || null, is_incumbent ? 1 : 0, bio || null, photo_url || null, now);

    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
    res.status(201).json({ data: candidate });
  } catch (err) {
    console.error('Error adding candidate:', err);
    res.status(500).json({ error: 'Failed to add candidate' });
  }
});

// GET /:id/candidates - list candidates
router.get('/:id/candidates', (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const candidates = db.prepare(
      'SELECT * FROM candidates WHERE campaign_id = ? ORDER BY name'
    ).all(req.params.id);
    res.json({ data: candidates });
  } catch (err) {
    console.error('Error listing candidates:', err);
    res.status(500).json({ error: 'Failed to retrieve candidates' });
  }
});

// PUT /:id/candidates/:cid - update candidate
router.put('/:id/candidates/:cid', (req, res) => {
  try {
    const candidate = db.prepare(
      'SELECT * FROM candidates WHERE id = ? AND campaign_id = ?'
    ).get(req.params.cid, req.params.id);
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    const { name, party, position, is_incumbent, bio, photo_url } = req.body;

    db.prepare(`
      UPDATE candidates
      SET name = ?, party = ?, position = ?, is_incumbent = ?, bio = ?, photo_url = ?
      WHERE id = ? AND campaign_id = ?
    `).run(
      name || candidate.name,
      party !== undefined ? party : candidate.party,
      position !== undefined ? position : candidate.position,
      is_incumbent !== undefined ? (is_incumbent ? 1 : 0) : candidate.is_incumbent,
      bio !== undefined ? bio : candidate.bio,
      photo_url !== undefined ? photo_url : candidate.photo_url,
      req.params.cid,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.cid);
    res.json({ data: updated });
  } catch (err) {
    console.error('Error updating candidate:', err);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

// DELETE /:id/candidates/:cid - delete candidate
router.delete('/:id/candidates/:cid', (req, res) => {
  try {
    const candidate = db.prepare(
      'SELECT * FROM candidates WHERE id = ? AND campaign_id = ?'
    ).get(req.params.cid, req.params.id);
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    db.prepare('DELETE FROM candidates WHERE id = ? AND campaign_id = ?').run(req.params.cid, req.params.id);
    res.json({ message: 'Candidate deleted successfully' });
  } catch (err) {
    console.error('Error deleting candidate:', err);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

module.exports = router;
