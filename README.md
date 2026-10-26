# Smart Water Tank Level Monitoring & Automated Pump Control (IoT + Full-Stack)

A complete, working system:

- **firmware/** — ESP32 code that measures water level with an HC-SR04 ultrasonic
  sensor and drives a relay-controlled pump.
- **backend/** — Node.js + Express + Socket.IO + SQLite server. Stores every
  reading, exposes a REST API, and pushes live updates to the dashboard.
- **backend/public/** — Browser dashboard: live tank gauge, level history chart,
  auto/manual mode switch, and threshold controls.

## How it fits together

```
[HC-SR04] --distance--> [ESP32] --WiFi/HTTP--> [Node/Express backend] --WebSocket--> [Browser dashboard]
                            |                          |
                       [Relay->Pump]            [SQLite: readings, settings]
```

The ESP32 POSTs a reading every 5 seconds to `/api/sensor-data`. The server
saves it, broadcasts it live to any open dashboards over Socket.IO, and
replies with the current mode/thresholds — so the same request that reports
a reading also tells the device what to do. In **Auto** mode the device turns
the pump on below the low threshold and off at/above the high threshold, and
keeps doing this locally even if WiFi briefly drops. In **Manual** mode it
just obeys the on/off switch from the dashboard.

## 1. Run the backend

```bash
cd backend
npm install
npm start
```

This starts the server at `http://localhost:3000` and serves the dashboard
at the same address. A `tank.db` SQLite file is created automatically on
first run.

### Try it without hardware first

In a second terminal:

```bash
cd backend
node simulate-device.js
```

This fakes an ESP32 sending readings so you can see the dashboard update
live, test auto/manual mode, and try the thresholds — before wiring up any
electronics.

## 2. Flash the firmware

Hardware needed:

- ESP32 dev board
- HC-SR04 ultrasonic sensor
- 1-channel 5V relay module
- Submersible/AC pump (switched via the relay, **not** powered directly from the ESP32)
- Optional: buzzer + LED for alerts

Wiring:

| HC-SR04 | ESP32     |
|---------|-----------|
| VCC     | 5V        |
| TRIG    | GPIO 5    |
| ECHO    | GPIO 18 (via voltage divider — ECHO is 5V, ESP32 GPIOs are 3.3V) |
| GND     | GND       |

| Relay | ESP32 |
|-------|-------|
| IN    | GPIO 26 |
| VCC   | 5V |
| GND   | GND |

Steps:

1. Open `firmware/water_tank_firmware.ino` in the Arduino IDE (install the
   ESP32 board package + the `ArduinoJson` library first).
2. Edit the top of the file:
   - `WIFI_SSID` / `WIFI_PASSWORD`
   - `SERVER_BASE_URL` — point this at the machine running the backend, e.g.
     `http://192.168.1.50:3000`
   - `TANK_HEIGHT_CM` / `SENSOR_OFFSET_CM` — measure your actual tank
3. Flash to the ESP32 and open the Serial Monitor at 115200 baud to confirm
   readings and WiFi connection.

## 3. Use the dashboard

Open `http://localhost:3000` (or your server's LAN IP) in a browser:

- **Tank gauge** — live fill level, updates instantly over WebSocket.
- **History chart** — last 60 readings.
- **Mode** — switch between Auto (threshold-based) and Manual.
- **Manual pump** — only active in Manual mode.
- **Thresholds** — set the low % (pump turns on) and high % (pump turns off)
  used in Auto mode.

## API reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/sensor-data` | Device reports a reading, receives control state back |
| GET  | `/api/status` | Latest reading + current settings |
| GET  | `/api/history?limit=100` | Recent readings for charting |
| POST | `/api/control` | Update mode / thresholds / manual pump state |

## Deploying for real use

- Run the backend on a Raspberry Pi, home server, or small cloud VM on the
  same network as (or reachable by) the ESP32.
- Use a static/reserved IP or a local DNS name for `SERVER_BASE_URL` so it
  doesn't change after router reboots.
- For internet-wide access, put the backend behind HTTPS (e.g. a reverse
  proxy like Caddy or Nginx) rather than exposing port 3000 directly.
- Add authentication to `/api/control` before exposing the dashboard beyond
  your local network — as shipped it has none.

## Extending it

- Multiple tanks: the schema already carries `deviceId`, so add another
  ESP32 with a different `DEVICE_ID` and filter by it in the API/dashboard.
- Alerts: hook the buzzer logic in firmware, or add email/SMS from the
  backend when a reading crosses a critical threshold.
- Flow sensor: add a second sensor reading field to log water usage, not
  just level.
