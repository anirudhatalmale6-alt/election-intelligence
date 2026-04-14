const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// GET /users - list all users (admin only)
router.get('/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(
      'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC'
    ).all();
    res.json({ data: users });
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// PUT /users/:id - update user role (admin only)
router.put('/users/:id', requireAdmin, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, role, is_active FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role } = req.body;
    const validRoles = ['admin', 'manager', 'agent', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);

    const updated = db.prepare(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?'
    ).get(req.params.id);
    res.json({ data: updated });
  } catch (err) {
    console.error('Error updating user role:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// DELETE /users/:id - deactivate user (admin only)
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ message: 'User deactivated successfully' });
  } catch (err) {
    console.error('Error deactivating user:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// GET /stats - overall system stats
router.get('/stats', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_active = 1').get().count;
    const campaignCount = db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count;
    const voterCount = db.prepare('SELECT COUNT(*) AS count FROM voters').get().count;
    const contactCount = db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count;
    const resultCount = db.prepare('SELECT COUNT(*) AS count FROM election_results').get().count;

    const contactsToday = db.prepare(
      "SELECT COUNT(*) AS count FROM contacts WHERE DATE(created_at) = DATE('now')"
    ).get().count;

    const votersByStatus = db.prepare(`
      SELECT support_status, COUNT(*) AS count
      FROM voters
      GROUP BY support_status
    `).all();

    const recentCampaigns = db.prepare(
      'SELECT id, name, status, created_at FROM campaigns ORDER BY created_at DESC LIMIT 5'
    ).all();

    res.json({
      data: {
        users: userCount,
        campaigns: campaignCount,
        voters: voterCount,
        contacts: contactCount,
        election_results: resultCount,
        contacts_today: contactsToday,
        voters_by_status: votersByStatus,
        recent_campaigns: recentCampaigns
      }
    });
  } catch (err) {
    console.error('Error getting system stats:', err);
    res.status(500).json({ error: 'Failed to retrieve system stats' });
  }
});

// POST /settings - update settings (admin only)
router.post('/settings', requireAdmin, (req, res) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object is required' });
    }

    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();

    const upsertMany = db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(key, typeof value === 'string' ? value : JSON.stringify(value), now);
      }
    });

    upsertMany(Object.entries(settings));

    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// GET /settings - get all settings
router.get('/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    res.json({ data: settings });
  } catch (err) {
    console.error('Error getting settings:', err);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

module.exports = router;
