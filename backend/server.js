const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Keep the last known reading in memory for fast /api/status responses
let lastReading = null;

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function boolify(row) {
  return {
    ...row,
    autoMode: !!row.autoMode,
    manualPumpState: !!row.manualPumpState,
  };
}

// ---------- Device -> Server: push a sensor reading, get control state back ----------
app.post('/api/sensor-data', (req, res) => {
  const { deviceId, level, distanceCm, pumpOn } = req.body;

  if (typeof level !== 'number' || !deviceId) {
    return res.status(400).json({ error: 'deviceId and numeric level are required' });
  }

  const stmt = db.prepare(`
    INSERT INTO readings (deviceId, level, distanceCm, pumpOn)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(deviceId, level, distanceCm ?? null, pumpOn ? 1 : 0);

  lastReading = {
    id: info.lastInsertRowid,
    deviceId,
    level,
    distanceCm: distanceCm ?? null,
    pumpOn: !!pumpOn,
    timestamp: new Date().toISOString(),
  };

  // push live update to any connected dashboards
  io.emit('reading', lastReading);

  const settings = boolify(getSettings());

  res.json({
    autoMode: settings.autoMode,
    manualPumpState: settings.manualPumpState,
    lowThreshold: settings.lowThreshold,
    highThreshold: settings.highThreshold,
  });
});

// ---------- Dashboard: current status ----------
app.get('/api/status', (req, res) => {
  const settings = boolify(getSettings());
  const latest = lastReading || db.prepare(`
    SELECT * FROM readings ORDER BY id DESC LIMIT 1
  `).get();

  res.json({
    reading: latest || null,
    settings,
  });
});

// ---------- Dashboard: historical readings ----------
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const rows = db.prepare(`
    SELECT * FROM readings ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json(rows.reverse());
});

// ---------- Dashboard: today's stats (min/max/avg level, pump runtime, cycles) ----------
app.get('/api/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT level, pumpOn, timestamp FROM readings
    WHERE date(timestamp) = date('now')
    ORDER BY id ASC
  `).all();

  if (rows.length === 0) {
    return res.json({
      minToday: null, maxToday: null, avgToday: null,
      pumpOnMinutesToday: 0, pumpCyclesToday: 0, readingsToday: 0,
    });
  }

  let min = 100, max = 0, sum = 0;
  let pumpOnMs = 0;
  let cycles = 0;
  let prevPump = null;
  let prevTime = null;

  for (const r of rows) {
    min = Math.min(min, r.level);
    max = Math.max(max, r.level);
    sum += r.level;

    const t = new Date(r.timestamp.replace(' ', 'T') + 'Z').getTime();
    if (prevTime !== null && prevPump === 1) {
      pumpOnMs += (t - prevTime);
    }
    if (prevPump !== null && prevPump === 0 && r.pumpOn === 1) cycles++;
    prevPump = r.pumpOn;
    prevTime = t;
  }

  res.json({
    minToday: Number(min.toFixed(1)),
    maxToday: Number(max.toFixed(1)),
    avgToday: Number((sum / rows.length).toFixed(1)),
    pumpOnMinutesToday: Math.round(pumpOnMs / 60000),
    pumpCyclesToday: cycles,
    readingsToday: rows.length,
  });
});

// ---------- Dashboard: change mode / thresholds / manual pump ----------
app.post('/api/control', (req, res) => {
  const { autoMode, manualPumpState, lowThreshold, highThreshold } = req.body;
  const current = getSettings();

  const updated = {
    autoMode: autoMode !== undefined ? (autoMode ? 1 : 0) : current.autoMode,
    manualPumpState: manualPumpState !== undefined ? (manualPumpState ? 1 : 0) : current.manualPumpState,
    lowThreshold: lowThreshold !== undefined ? lowThreshold : current.lowThreshold,
    highThreshold: highThreshold !== undefined ? highThreshold : current.highThreshold,
  };

  if (updated.lowThreshold >= updated.highThreshold) {
    return res.status(400).json({ error: 'lowThreshold must be less than highThreshold' });
  }

  db.prepare(`
    UPDATE settings
    SET autoMode = ?, manualPumpState = ?, lowThreshold = ?, highThreshold = ?
    WHERE id = 1
  `).run(updated.autoMode, updated.manualPumpState, updated.lowThreshold, updated.highThreshold);

  const newSettings = boolify(getSettings());
  io.emit('settings', newSettings);

  res.json(newSettings);
});

io.on('connection', (socket) => {
  // send the latest snapshot immediately to a newly connected dashboard
  socket.emit('status', {
    reading: lastReading,
    settings: boolify(getSettings()),
  });
});

server.listen(PORT, () => {
  console.log(`Smart Water Tank backend running at http://localhost:${PORT}`);
});
