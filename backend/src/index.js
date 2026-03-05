const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3099;

app.use(cors());
app.use(express.json());

// DB setup
const dbDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'incidents.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    severity TEXT DEFAULT 'minor',
    status TEXT DEFAULT 'investigating',
    affectedServices TEXT DEFAULT '[]',
    rootCause TEXT DEFAULT '',
    fix TEXT DEFAULT '',
    detectedAt TEXT DEFAULT (datetime('now','localtime')),
    resolvedAt TEXT DEFAULT '',
    duration INTEGER DEFAULT 0,
    detectedBy TEXT DEFAULT '',
    resolvedBy TEXT DEFAULT '',
    postmortem TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_inc_severity ON incidents(severity);
  CREATE INDEX IF NOT EXISTS idx_inc_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_inc_detected ON incidents(detectedAt);

  CREATE TABLE IF NOT EXISTS timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incidentId INTEGER REFERENCES incidents(id),
    event TEXT NOT NULL,
    author TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Stats
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM incidents').get().cnt;
    const active = db.prepare("SELECT COUNT(*) as cnt FROM incidents WHERE status IN ('investigating','identified','monitoring')").get().cnt;
    const resolved = db.prepare("SELECT COUNT(*) as cnt FROM incidents WHERE status='resolved'").get().cnt;
    const bySeverity = db.prepare("SELECT severity, COUNT(*) as cnt FROM incidents GROUP BY severity").all();
    const avgResolution = db.prepare("SELECT AVG(duration) as avg FROM incidents WHERE status='resolved' AND duration > 0").get().avg || 0;

    // resolved this week
    const resolvedThisWeek = db.prepare(`
      SELECT COUNT(*) as cnt FROM incidents 
      WHERE status='resolved' AND resolvedAt >= datetime('now','-7 days')
    `).get().cnt;

    // most affected services (flatten from JSON arrays)
    const allServices = db.prepare('SELECT affectedServices FROM incidents').all();
    const serviceCount = {};
    allServices.forEach(row => {
      try {
        const svcs = JSON.parse(row.affectedServices || '[]');
        svcs.forEach(s => { serviceCount[s] = (serviceCount[s] || 0) + 1; });
      } catch {}
    });
    const mostAffected = Object.entries(serviceCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([service, count]) => ({ service, count }));

    res.json({
      total, active, resolved, resolvedThisWeek,
      bySeverity,
      mttr: Math.round(avgResolution),
      mostAffectedServices: mostAffected
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List incidents
app.get('/api/incidents', (req, res) => {
  try {
    const { severity, status, from, to, limit = 50 } = req.query;
    let sql = 'SELECT * FROM incidents WHERE 1=1';
    const params = [];
    if (severity) { sql += ' AND severity=?'; params.push(severity); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (from) { sql += ' AND detectedAt >= ?'; params.push(from); }
    if (to) { sql += ' AND detectedAt <= ?'; params.push(to); }
    sql += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = db.prepare(sql).all(...params);
    const incidents = rows.map(r => ({
      ...r,
      affectedServices: JSON.parse(r.affectedServices || '[]'),
      tags: JSON.parse(r.tags || '[]')
    }));
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single incident with timeline
app.get('/api/incidents/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM incidents WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const timeline = db.prepare('SELECT * FROM timeline_events WHERE incidentId=? ORDER BY createdAt ASC').all(req.params.id);
    res.json({
      ...row,
      affectedServices: JSON.parse(row.affectedServices || '[]'),
      tags: JSON.parse(row.tags || '[]'),
      timeline
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create incident
app.post('/api/incidents', (req, res) => {
  try {
    const {
      title, description = '', severity = 'minor', status = 'investigating',
      affectedServices = [], rootCause = '', fix = '', detectedAt,
      resolvedAt = '', duration = 0, detectedBy = '', resolvedBy = '',
      postmortem = '', tags = []
    } = req.body;

    const stmt = db.prepare(`
      INSERT INTO incidents (title, description, severity, status, affectedServices, rootCause, fix,
        detectedAt, resolvedAt, duration, detectedBy, resolvedBy, postmortem, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      title, description, severity, status,
      JSON.stringify(affectedServices), rootCause, fix,
      detectedAt || new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace('T', ' '),
      resolvedAt, duration, detectedBy, resolvedBy, postmortem,
      JSON.stringify(tags)
    );

    // Auto-add timeline event
    if (status !== 'investigating') {
      db.prepare('INSERT INTO timeline_events (incidentId, event, author) VALUES (?,?,?)').run(
        result.lastInsertRowid, `Incident created with status: ${status}`, detectedBy || 'system'
      );
    } else {
      db.prepare('INSERT INTO timeline_events (incidentId, event, author) VALUES (?,?,?)').run(
        result.lastInsertRowid, 'Incident detected and investigation started', detectedBy || 'system'
      );
    }

    const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(result.lastInsertRowid);
    res.status(201).json({
      ...incident,
      affectedServices: JSON.parse(incident.affectedServices || '[]'),
      tags: JSON.parse(incident.tags || '[]')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update incident
app.patch('/api/incidents/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM incidents WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const allowed = ['title','description','severity','status','affectedServices','rootCause','fix',
      'detectedAt','resolvedAt','duration','detectedBy','resolvedBy','postmortem','tags'];
    const updates = [];
    const params = [];

    for (const [key, val] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      if (key === 'affectedServices' || key === 'tags') {
        updates.push(`${key}=?`);
        params.push(JSON.stringify(val));
      } else {
        updates.push(`${key}=?`);
        params.push(val);
      }
    }

    if (updates.length === 0) return res.json({ ...row });

    // Auto set resolvedAt if status=resolved
    if (req.body.status === 'resolved' && !req.body.resolvedAt && !row.resolvedAt) {
      updates.push('resolvedAt=?');
      params.push(new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace('T', ' '));
    }

    params.push(req.params.id);
    db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id=?`).run(...params);

    // Auto timeline event for status change
    if (req.body.status && req.body.status !== row.status) {
      db.prepare('INSERT INTO timeline_events (incidentId, event, author) VALUES (?,?,?)').run(
        req.params.id, `Status changed to: ${req.body.status}`, req.body.resolvedBy || req.body.updatedBy || 'system'
      );
    }

    const updated = db.prepare('SELECT * FROM incidents WHERE id=?').get(req.params.id);
    res.json({
      ...updated,
      affectedServices: JSON.parse(updated.affectedServices || '[]'),
      tags: JSON.parse(updated.tags || '[]')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add timeline event
app.post('/api/incidents/:id/timeline', (req, res) => {
  try {
    const { event, author = '' } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });
    const result = db.prepare('INSERT INTO timeline_events (incidentId, event, author) VALUES (?,?,?)').run(
      req.params.id, event, author
    );
    const te = db.prepare('SELECT * FROM timeline_events WHERE id=?').get(result.lastInsertRowid);
    res.status(201).json(te);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`IncidentLog backend running on port ${PORT}`);
});
