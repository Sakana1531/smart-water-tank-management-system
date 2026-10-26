const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tank.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT NOT NULL,
    level REAL NOT NULL,
    distanceCm REAL,
    pumpOn INTEGER NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    autoMode INTEGER NOT NULL DEFAULT 1,
    manualPumpState INTEGER NOT NULL DEFAULT 0,
    lowThreshold REAL NOT NULL DEFAULT 25,
    highThreshold REAL NOT NULL DEFAULT 90,
    tankHeightCm REAL NOT NULL DEFAULT 100
  );
`);

// Ensure a single settings row always exists
const existing = db.prepare('SELECT * FROM settings WHERE id = 1').get();
if (!existing) {
  db.prepare(`
    INSERT INTO settings (id, autoMode, manualPumpState, lowThreshold, highThreshold, tankHeightCm)
    VALUES (1, 1, 0, 25, 90, 100)
  `).run();
}

module.exports = db;
