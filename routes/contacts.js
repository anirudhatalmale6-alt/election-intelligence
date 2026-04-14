const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

const VALID_CONTACT_TYPES = ['phone', 'door'];
const VALID_OUTCOMES = ['supporter', 'soft_yes', 'undecided', 'opposition', 'no_answer', 'invalid'];

// POST / - log a contact
router.post('/', (req, res) => {
  try {
    const { voter_id, campaign_id, contact_type, outcome, notes, follow_up_date } = req.body;

    if (!voter_id || !campaign_id) {
      return res.status(400).json({ error: 'voter_id and campaign_id are required' });
    }
    if (!contact_type || !VALID_CONTACT_TYPES.includes(contact_type)) {
      return res.status(400).json({ error: `contact_type must be one of: ${VALID_CONTACT_TYPES.join(', ')}` });
    }
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}` });
    }

    const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(voter_id);
    if (!voter) {
      return res.status(404).json({ error: 'Voter not found' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const agentId = req.user.id;

    const logContact = db.transaction(() => {
      // Insert the contact record
      db.prepare(`
        INSERT INTO contacts (id, voter_id, campaign_id, agent_id, contact_type, outcome, notes, follow_up_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, voter_id, campaign_id, agentId, contact_type, outcome, notes || null, follow_up_date || null, now);

      // Update voter record
      const supportStatus = ['no_answer', 'invalid'].includes(outcome) ? voter.support_status : outcome;
      db.prepare(`
        UPDATE voters
        SET support_status = ?,
            is_contacted = 1,
            contact_count = contact_count + 1,
            last_contacted_at = ?,
            last_contacted_by = ?,
            updated_at = ?
        WHERE id = ?
      `).run(supportStatus, now, agentId, now, voter_id);
    });

    logContact();

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    res.status(201).json({ data: contact });
  } catch (err) {
    console.error('Error logging contact:', err);
    res.status(500).json({ error: 'Failed to log contact' });
  }
});

// GET / - list contacts (filterable)
router.get('/', (req, res) => {
  try {
    const { campaign_id, agent_id, outcome, contact_type, date_from, date_to, page = 1, limit = 50 } = req.query;

    const conditions = [];
    const params = [];

    if (campaign_id) {
      conditions.push('campaign_id = ?');
      params.push(campaign_id);
    }
    if (agent_id) {
      conditions.push('agent_id = ?');
      params.push(agent_id);
    }
    if (outcome) {
      conditions.push('outcome = ?');
      params.push(outcome);
    }
    if (contact_type) {
      conditions.push('contact_type = ?');
      params.push(contact_type);
    }
    if (date_from) {
      conditions.push('created_at >= ?');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('created_at <= ?');
      params.push(date_to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM contacts ${whereClause}`
    ).get(...params).count;

    const contacts = db.prepare(
      `SELECT * FROM contacts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, parseInt(limit), offset);

    res.json({
      data: contacts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Error listing contacts:', err);
    res.status(500).json({ error: 'Failed to retrieve contacts' });
  }
});

// GET /stats/:campaignId - contact stats
router.get('/stats/:campaignId', (req, res) => {
  try {
    const campaignId = req.params.campaignId;

    const totalContacts = db.prepare(
      'SELECT COUNT(*) AS count FROM contacts WHERE campaign_id = ?'
    ).get(campaignId).count;

    const byOutcome = db.prepare(`
      SELECT outcome, COUNT(*) AS count
      FROM contacts WHERE campaign_id = ?
      GROUP BY outcome
    `).all(campaignId);

    const byAgent = db.prepare(`
      SELECT agent_id, COUNT(*) AS count
      FROM contacts WHERE campaign_id = ?
      GROUP BY agent_id
    `).all(campaignId);

    const byDay = db.prepare(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM contacts WHERE campaign_id = ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(campaignId);

    res.json({
      data: {
        total_contacts: totalContacts,
        by_outcome: byOutcome,
        by_agent: byAgent,
        by_day: byDay
      }
    });
  } catch (err) {
    console.error('Error getting contact stats:', err);
    res.status(500).json({ error: 'Failed to retrieve contact stats' });
  }
});

// GET /agent/:agentId/stats - agent performance stats
router.get('/agent/:agentId/stats', (req, res) => {
  try {
    const agentId = req.params.agentId;

    const totalContacts = db.prepare(
      'SELECT COUNT(*) AS count FROM contacts WHERE agent_id = ?'
    ).get(agentId).count;

    const byOutcome = db.prepare(`
      SELECT outcome, COUNT(*) AS count
      FROM contacts WHERE agent_id = ?
      GROUP BY outcome
    `).all(agentId);

    const byCampaign = db.prepare(`
      SELECT campaign_id, COUNT(*) AS count
      FROM contacts WHERE agent_id = ?
      GROUP BY campaign_id
    `).all(agentId);

    const byDay = db.prepare(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM contacts WHERE agent_id = ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `).all(agentId);

    const byType = db.prepare(`
      SELECT contact_type, COUNT(*) AS count
      FROM contacts WHERE agent_id = ?
      GROUP BY contact_type
    `).all(agentId);

    res.json({
      data: {
        agent_id: agentId,
        total_contacts: totalContacts,
        by_outcome: byOutcome,
        by_campaign: byCampaign,
        by_day: byDay,
        by_contact_type: byType
      }
    });
  } catch (err) {
    console.error('Error getting agent stats:', err);
    res.status(500).json({ error: 'Failed to retrieve agent stats' });
  }
});

module.exports = router;
