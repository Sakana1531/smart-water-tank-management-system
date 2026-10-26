const socket = io();

const el = {
  dot: document.getElementById('connectionDot'),
  label: document.getElementById('connectionLabel'),
  fill: document.getElementById('tankFill'),
  readout: document.getElementById('levelReadout'),
  distance: document.getElementById('distanceValue'),
  lastUpdate: document.getElementById('lastUpdate'),
  pumpBadge: document.getElementById('pumpBadge'),
  autoBtn: document.getElementById('autoBtn'),
  manualBtn: document.getElementById('manualBtn'),
  pumpOnBtn: document.getElementById('pumpOnBtn'),
  pumpOffBtn: document.getElementById('pumpOffBtn'),
  lowThreshold: document.getElementById('lowThreshold'),
  highThreshold: document.getElementById('highThreshold'),
  saveBtn: document.getElementById('saveSettingsBtn'),
  settingsStatus: document.getElementById('settingsStatus'),
  chartCanvas: document.getElementById('historyChart'),
  banner: document.getElementById('alertBanner'),
  eta: document.getElementById('etaValue'),
  statMin: document.getElementById('statMin'),
  statMax: document.getElementById('statMax'),
  statAvg: document.getElementById('statAvg'),
  statPumpMinutes: document.getElementById('statPumpMinutes'),
  statCycles: document.getElementById('statCycles'),
  exportBtn: document.getElementById('exportCsvBtn'),
  themeToggle: document.getElementById('themeToggle'),
  soundToggle: document.getElementById('soundToggle'),
};

let currentSettings = null;
let chart = null;
let recentPoints = []; // {t, level} for ETA calc
let soundEnabled = localStorage.getItem('buzzerSound') !== 'off';
let lastAlertState = null; // 'low' | 'critical' | 'full' | null
const CRITICAL_PCT = 5;

function initChart() {
  chart = new Chart(el.chartCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Level (%)',
        data: [],
        borderColor: '#2fb6c9',
        backgroundColor: 'rgba(47,182,201,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      scales: {
        y: { min: 0, max: 100, ticks: { color: '#7f9aab' }, grid: { color: '#1c3244' } },
        x: { ticks: { color: '#7f9aab', maxTicksLimit: 8 }, grid: { color: '#1c3244' } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderReading(reading) {
  if (!reading) return;
  const level = Math.max(0, Math.min(100, reading.level));
  el.fill.style.height = level + '%';
  el.readout.textContent = level.toFixed(1) + '%';
  el.distance.textContent = reading.distanceCm != null ? reading.distanceCm.toFixed(1) : '--';
  el.lastUpdate.textContent = fmtTime(reading.timestamp);
  el.pumpBadge.textContent = reading.pumpOn ? 'ON' : 'OFF';
  el.pumpBadge.className = 'badge ' + (reading.pumpOn ? 'on' : 'off');

  if (chart) {
    chart.data.labels.push(fmtTime(reading.timestamp));
    chart.data.datasets[0].data.push(level);
    if (chart.data.labels.length > 60) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.update('none');
  }

  recentPoints.push({ t: Date.now(), level });
  if (recentPoints.length > 12) recentPoints.shift();

  updateAlertBanner(level);
  updateEta(level);
}

// ---------- Alert banner + virtual buzzer + notifications ----------
function updateAlertBanner(level) {
  if (!currentSettings) return;
  const low = currentSettings.lowThreshold;
  const high = currentSettings.highThreshold;

  let state = null;
  if (level <= CRITICAL_PCT) state = 'critical';
  else if (level <= low) state = 'low';
  else if (level >= high) state = 'full';

  if (state) {
    el.banner.classList.remove('hidden', 'low', 'critical', 'full');
    el.banner.classList.add(state);
    if (state === 'critical') el.banner.textContent = `🚨 CRITICALLY LOW — ${level.toFixed(1)}% remaining! Pump attention needed.`;
    else if (state === 'low') el.banner.textContent = `⚠ Water level low — ${level.toFixed(1)}% (below ${low}% threshold)`;
    else el.banner.textContent = `✅ Tank full — ${level.toFixed(1)}% (at/above ${high}% threshold)`;
  } else {
    el.banner.classList.add('hidden');
  }

  if (state !== lastAlertState) {
    if (state === 'critical' || state === 'full') notifyBrowser(state, level);
    lastAlertState = state;
  }
  driveVirtualBuzzer(state);
}

function notifyBrowser(state, level) {
  if (!('Notification' in window)) return;
  const fire = () => {
    if (Notification.permission === 'granted') {
      const title = state === 'critical' ? '🚨 Tank critically low' : '✅ Tank full';
      new Notification(title, { body: `Level is ${level.toFixed(1)}%` });
    }
  };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => { if (p === 'granted') fire(); });
  }
}

// Web Audio "virtual buzzer" mirroring the ESP32 firmware pattern:
// critical = continuous tone, low = slow intermittent beep, full = single short beep.
let audioCtx = null;
let buzzerTimer = null;
let buzzerOsc = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beepOnce(durationMs = 150, freq = 880) {
  if (!soundEnabled) return;
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

function stopContinuousBuzzer() {
  if (buzzerTimer) { clearInterval(buzzerTimer); buzzerTimer = null; }
  if (buzzerOsc) { try { buzzerOsc.stop(); } catch (e) {} buzzerOsc = null; }
}

function driveVirtualBuzzer(state) {
  stopContinuousBuzzer();
  if (!soundEnabled) return;

  if (state === 'critical') {
    const ctx = getAudioCtx();
    buzzerOsc = ctx.createOscillator();
    const gain = ctx.createGain();
    buzzerOsc.frequency.value = 880;
    buzzerOsc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    buzzerOsc.start();
  } else if (state === 'low') {
    beepOnce(150, 700);
    buzzerTimer = setInterval(() => beepOnce(150, 700), 1850);
  } else if (state === 'full') {
    beepOnce(600, 1000);
  }
}

// ---------- Estimated time to next threshold ----------
function updateEta(level) {
  if (!currentSettings || recentPoints.length < 3) { el.eta.textContent = '--'; return; }
  const first = recentPoints[0];
  const last = recentPoints[recentPoints.length - 1];
  const dtMin = (last.t - first.t) / 60000;
  if (dtMin < 0.05) { el.eta.textContent = 'calculating…'; return; }

  const ratePerMin = (last.level - first.level) / dtMin; // %/min, negative = draining

  if (Math.abs(ratePerMin) < 0.01) { el.eta.textContent = 'stable'; return; }

  let target, label;
  if (ratePerMin < 0) {
    target = currentSettings.lowThreshold;
    label = 'to low';
  } else {
    target = currentSettings.highThreshold;
    label = 'to full';
  }

  const minutesLeft = (target - level) / ratePerMin;
  if (minutesLeft < 0 || !isFinite(minutesLeft)) { el.eta.textContent = '--'; return; }

  if (minutesLeft < 1) el.eta.textContent = `<1 min ${label}`;
  else if (minutesLeft < 60) el.eta.textContent = `~${Math.round(minutesLeft)} min ${label}`;
  else el.eta.textContent = `~${(minutesLeft / 60).toFixed(1)} hr ${label}`;
}

function renderSettings(settings) {
  currentSettings = settings;
  el.autoBtn.classList.toggle('active', settings.autoMode);
  el.manualBtn.classList.toggle('active', !settings.autoMode);
  el.pumpOnBtn.classList.toggle('active', settings.manualPumpState);
  el.pumpOffBtn.classList.toggle('active', !settings.manualPumpState);
  el.lowThreshold.value = settings.lowThreshold;
  el.highThreshold.value = settings.highThreshold;

  const manualControlsDisabled = settings.autoMode;
  el.pumpOnBtn.disabled = manualControlsDisabled;
  el.pumpOffBtn.disabled = manualControlsDisabled;
  el.pumpOnBtn.style.opacity = manualControlsDisabled ? 0.4 : 1;
  el.pumpOffBtn.style.opacity = manualControlsDisabled ? 0.4 : 1;
}

async function sendControl(payload) {
  const res = await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    const settings = await res.json();
    renderSettings(settings);
    return settings;
  } else {
    const err = await res.json();
    el.settingsStatus.textContent = 'Error: ' + err.error;
    el.settingsStatus.style.color = '#d9634f';
  }
}

el.autoBtn.addEventListener('click', () => sendControl({ autoMode: true }));
el.manualBtn.addEventListener('click', () => sendControl({ autoMode: false }));
el.pumpOnBtn.addEventListener('click', () => sendControl({ manualPumpState: true }));
el.pumpOffBtn.addEventListener('click', () => sendControl({ manualPumpState: false }));

el.saveBtn.addEventListener('click', async () => {
  const low = parseFloat(el.lowThreshold.value);
  const high = parseFloat(el.highThreshold.value);
  const settings = await sendControl({ lowThreshold: low, highThreshold: high });
  if (settings) {
    el.settingsStatus.textContent = 'Saved ✓';
    el.settingsStatus.style.color = '#4bd08b';
    setTimeout(() => (el.settingsStatus.textContent = ''), 2000);
  }
});

socket.on('connect', () => {
  el.dot.classList.add('online');
  el.dot.classList.remove('offline');
  el.label.textContent = 'Live';
});

socket.on('disconnect', () => {
  el.dot.classList.remove('online');
  el.dot.classList.add('offline');
  el.label.textContent = 'Disconnected';
});

socket.on('status', (data) => {
  if (data.settings) renderSettings(data.settings);
  if (data.reading) renderReading(data.reading);
});

socket.on('reading', (reading) => {
  renderReading(reading);
  scheduleStatsRefresh();
});
socket.on('settings', (settings) => renderSettings(settings));

async function loadHistory() {
  const res = await fetch('/api/history?limit=60');
  const rows = await res.json();
  rows.forEach((r) => {
    chart.data.labels.push(fmtTime(r.timestamp));
    chart.data.datasets[0].data.push(r.level);
  });
  chart.update('none');
}

async function bootstrap() {
  initChart();
  const res = await fetch('/api/status');
  const data = await res.json();
  if (data.settings) renderSettings(data.settings);
  if (data.reading) renderReading(data.reading);
  await loadHistory();
  await loadStats();
  setInterval(loadStats, 15000);
}

// ---------- Today's stats ----------
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    el.statMin.textContent = s.minToday != null ? s.minToday + '%' : '--';
    el.statMax.textContent = s.maxToday != null ? s.maxToday + '%' : '--';
    el.statAvg.textContent = s.avgToday != null ? s.avgToday + '%' : '--';
    el.statPumpMinutes.textContent = s.pumpOnMinutesToday != null ? s.pumpOnMinutesToday + ' min' : '--';
    el.statCycles.textContent = s.pumpCyclesToday != null ? s.pumpCyclesToday : '--';
  } catch (e) {
    // stats are non-critical; fail silently
  }
}

// Refresh stats as soon as a new reading comes in, instead of waiting for
// the next 15s poll. Throttled so a burst of readings doesn't spam /api/stats.
let statsRefreshTimer = null;
function scheduleStatsRefresh() {
  if (statsRefreshTimer) return;
  statsRefreshTimer = setTimeout(() => {
    statsRefreshTimer = null;
    loadStats();
  }, 1000);
}

// ---------- CSV export ----------
el.exportBtn.addEventListener('click', async () => {
  const res = await fetch('/api/history?limit=1000');
  const rows = await res.json();
  if (!rows.length) return;

  const header = Object.keys(rows[0]).join(',');
  const body = rows.map((r) => Object.values(r).join(',')).join('\n');
  const csv = header + '\n' + body;

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tank-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Theme toggle ----------
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  el.themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}
el.themeToggle.addEventListener('click', () => {
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
});
applyTheme(localStorage.getItem('theme') || 'dark');

// ---------- Sound toggle ----------
function applySoundIcon() {
  el.soundToggle.textContent = soundEnabled ? '🔊' : '🔇';
}
el.soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem('buzzerSound', soundEnabled ? 'on' : 'off');
  applySoundIcon();
  if (!soundEnabled) stopContinuousBuzzer();
});
applySoundIcon();

bootstrap();
