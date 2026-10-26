/*
  Simulates an ESP32 device posting readings to the backend, so you can see
  the dashboard working before you have real hardware wired up.

  Usage:  node simulate-device.js
*/

const SERVER = 'http://localhost:3000';
let level = 60;       // start at 60%
let direction = -1;   // draining
let pumpOn = false;

async function tick() {
  // simulate slow draining / filling
  level += direction * (Math.random() * 1.2);
  if (level < 0) level = 0;
  if (level > 100) level = 100;

  const distanceCm = (100 - level); // fake mapping, tank height = 100cm

  try {
    const res = await fetch(`${SERVER}/api/sensor-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'tank-01',
        level: Number(level.toFixed(1)),
        distanceCm: Number(distanceCm.toFixed(1)),
        pumpOn,
      }),
    });
    const control = await res.json();

    if (control.autoMode) {
      if (level <= control.lowThreshold) { pumpOn = true; direction = 1; }
      else if (level >= control.highThreshold) { pumpOn = false; direction = -1; }
    } else {
      pumpOn = control.manualPumpState;
      direction = pumpOn ? 1 : -1;
    }

    console.log(`level=${level.toFixed(1)}% pump=${pumpOn ? 'ON' : 'OFF'} mode=${control.autoMode ? 'AUTO' : 'MANUAL'}`);
  } catch (err) {
    console.error('Could not reach server:', err.message);
  }
}

setInterval(tick, 2000);
tick();
