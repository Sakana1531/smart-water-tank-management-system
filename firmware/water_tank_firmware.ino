/*
  Smart Water Tank Level Monitoring & Automated Pump Control
  Firmware for ESP32

  Hardware:
    - HC-SR04 ultrasonic sensor  -> mounted at the TOP of the tank, facing down
    - 5V single-channel relay module -> switches the water pump
    - (Optional) Buzzer on BUZZER_PIN for low/high level alerts
    - (Optional) Status LED on LED_PIN

  Wiring (typical):
    HC-SR04  TRIG -> GPIO 5
    HC-SR04  ECHO -> GPIO 18 (use a voltage divider, ECHO is 5V logic!)
    Relay    IN   -> GPIO 26
    Buzzer   +    -> GPIO 27
    LED      +    -> GPIO 2 (onboard LED on most dev boards)

  Behaviour:
    - Reads distance every SAMPLE_INTERVAL_MS, converts to a level percentage
      using TANK_HEIGHT_CM and SENSOR_OFFSET_CM.
    - Every POST_INTERVAL_MS it POSTs a JSON reading to the backend and the
      backend responds with the current desired pump/mode state (single
      round trip = simple, no need for the device to also poll separately).
    - In AUTO mode the firmware decides pump ON/OFF locally using the
      thresholds last received from the server, so the pump keeps working
      correctly even if WiFi drops temporarily.
    - In MANUAL mode the firmware just obeys the manualPumpState flag sent
      by the server.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------- USER CONFIG ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Point this at your backend server, e.g. http://192.168.1.50:3000
const char* SERVER_BASE_URL = "http://192.168.1.50:3000";
const char* DEVICE_ID = "tank-01";

const float TANK_HEIGHT_CM   = 100.0;  // full internal height of the tank
const float SENSOR_OFFSET_CM = 2.0;    // gap between sensor face and the "full" water line

const unsigned long SAMPLE_INTERVAL_MS = 2000;   // how often to read the sensor
const unsigned long POST_INTERVAL_MS   = 5000;   // how often to talk to the server

// ---------- PINS ----------
#define TRIG_PIN    5
#define ECHO_PIN    18
#define RELAY_PIN   26
#define BUZZER_PIN  27
#define LED_PIN     2

#define RELAY_ACTIVE_LOW true   // most cheap relay boards trigger on LOW

// ---------- STATE ----------
float currentLevelPct   = 0;
float currentDistanceCm = 0;
bool  pumpOn            = false;

// Config received from / synced with the server
bool  autoMode        = true;
bool  manualPumpState = false;
float lowThreshold     = 25.0;  // % - auto mode turns pump ON below this
float highThreshold    = 90.0;  // % - auto mode turns pump OFF at/above this

unsigned long lastSampleMs = 0;
unsigned long lastPostMs   = 0;

// ---------- BUZZER STATE ----------
const float CRITICAL_LOW_PCT = 5.0;   // below this: continuous alarm
const unsigned long LOW_BEEP_ON_MS   = 150;   // slow beep: short pip
const unsigned long LOW_BEEP_OFF_MS  = 1700;  // ...then a long silence
const unsigned long FULL_BEEP_MS     = 600;   // one-shot confirmation beep length

unsigned long buzzerToggleMs = 0;
bool buzzerOn = false;
bool wasFull  = false;   // edge-detect crossing INTO "full" so we beep once, not continuously
unsigned long fullBeepEndMs = 0;
bool fullBeepActive = false;

// ---------- HELPERS ----------
void setPump(bool on) {
  pumpOn = on;
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000UL); // 30ms timeout ~5m range
  if (duration == 0) return -1; // no echo / out of range

  float distanceCm = duration * 0.0343 / 2.0;
  return distanceCm;
}

float distanceToLevelPct(float distanceCm) {
  float waterHeight = TANK_HEIGHT_CM - (distanceCm - SENSOR_OFFSET_CM);
  float pct = (waterHeight / TANK_HEIGHT_CM) * 100.0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi connect failed, will retry in loop()");
  }
}

// Posts a reading and applies whatever control state the server returns.
void postReadingAndSync() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return;
  }

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/sensor-data";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["deviceId"]    = DEVICE_ID;
  doc["level"]       = currentLevelPct;
  doc["distanceCm"]  = currentDistanceCm;
  doc["pumpOn"]      = pumpOn;

  String body;
  serializeJson(doc, body);

  int httpCode = http.POST(body);

  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> respDoc;
    DeserializationError err = deserializeJson(respDoc, response);
    if (!err) {
      autoMode        = respDoc["autoMode"]        | autoMode;
      manualPumpState = respDoc["manualPumpState"]  | manualPumpState;
      lowThreshold    = respDoc["lowThreshold"]     | lowThreshold;
      highThreshold   = respDoc["highThreshold"]    | highThreshold;
    }
  } else {
    Serial.print("POST failed, code: ");
    Serial.println(httpCode);
  }

  http.end();
}

void applyPumpLogic() {
  if (autoMode) {
    if (currentLevelPct <= lowThreshold && !pumpOn) {
      setPump(true);
    } else if (currentLevelPct >= highThreshold && pumpOn) {
      setPump(false);
    }
  } else {
    if (manualPumpState != pumpOn) {
      setPump(manualPumpState);
    }
  }

}

// Non-blocking buzzer patterns, called every loop() so it never freezes readings/WiFi:
//   - level >= highThreshold : one short confirmation beep (only on the moment it becomes full)
//   - level <= CRITICAL_LOW_PCT : continuous beep (solid tone) until it rises back up
//   - level <= lowThreshold (but not critical) : slow intermittent beep (pip ... pip ... pip)
//   - otherwise : silent
void updateBuzzer() {
  unsigned long now = millis();
  bool isFull     = currentLevelPct >= highThreshold;
  bool isCritical = currentLevelPct <= CRITICAL_LOW_PCT;
  bool isLow      = currentLevelPct <= lowThreshold && !isCritical;

  // --- "just became full" -> single short beep ---
  if (isFull && !wasFull) {
    fullBeepActive = true;
    fullBeepEndMs = now + FULL_BEEP_MS;
  }
  wasFull = isFull;

  if (fullBeepActive) {
    digitalWrite(BUZZER_PIN, HIGH);
    if (now >= fullBeepEndMs) fullBeepActive = false;
    return;
  }

  // --- critically low -> continuous beep ---
  if (isCritical) {
    digitalWrite(BUZZER_PIN, HIGH);
    return;
  }

  // --- low (not critical) -> slow intermittent beep ---
  if (isLow) {
    if (buzzerOn && now - buzzerToggleMs >= LOW_BEEP_ON_MS) {
      buzzerOn = false;
      buzzerToggleMs = now;
      digitalWrite(BUZZER_PIN, LOW);
    } else if (!buzzerOn && now - buzzerToggleMs >= LOW_BEEP_OFF_MS) {
      buzzerOn = true;
      buzzerToggleMs = now;
      digitalWrite(BUZZER_PIN, HIGH);
    }
    return;
  }

  // --- normal range -> silent ---
  buzzerOn = false;
  digitalWrite(BUZZER_PIN, LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  setPump(false);

  connectWiFi();
}

void loop() {
  unsigned long now = millis();

  // Runs every loop() iteration (not just every sample) so the beep timing
  // (150ms on / 1700ms off for "low", continuous for "critical") is accurate.
  updateBuzzer();

  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    float d = readDistanceCm();
    if (d > 0) {
      currentDistanceCm = d;
      currentLevelPct = distanceToLevelPct(d);
      applyPumpLogic();
      Serial.printf("Distance: %.1f cm | Level: %.1f%% | Pump: %s | Mode: %s\n",
                    currentDistanceCm, currentLevelPct,
                    pumpOn ? "ON" : "OFF", autoMode ? "AUTO" : "MANUAL");
    } else {
      Serial.println("Sensor read failed (no echo)");
    }
  }

  if (now - lastPostMs >= POST_INTERVAL_MS) {
    lastPostMs = now;
    postReadingAndSync();
  }
}
