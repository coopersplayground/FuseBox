// Cosmo HID - ESP32-S3 BLE keyboard + mouse dongle (Muse Home)
// =================================================================
// The dongle pairs with the user's PC as a genuine Bluetooth HID
// keyboard+mouse. The hub (Pi / Server) feeds it one-line commands over
// WiFi TCP (port 4210) or USB-serial; the dongle turns them into real
// HID reports, so the PC cannot distinguish them from a physical user.
//
// Command lines (same vocabulary as the wired gadget transport):
//   TYPE:<text>        DBLCLICK:<x>,<y>
//   KEY:<combo>        RCLICK:<x>,<y>
//   CLICK:<x>,<y>      MOVE:<x>,<y>
//   SCROLL:<n>         PING
// Coordinates are 0..1000 normalized over the PC's primary display.
// BLE mice are RELATIVE only, so MOVE/CLICK first park the cursor into
// the top-left corner (large negative steps) and then step out to the
// target in <=127-count chunks. Close enough for button-sized targets;
// the wired USB gadget transport stays the precision path.
//
// LIBRARIES (Library Manager / PlatformIO):
//   - lemmingDev "ESP32-BLE-Controller" (NimBLE; combined Controller +
//     Keyboard + Mouse in ONE BLE connection), or blackketter
//     "ESP32-BLE-Combo". Express the HID report map through whichever
//     combo library is chosen and then FREEZE IT:
//     *** Windows caches the HID descriptor against the pairing bond.
//     *** Changing the report map later REQUIRESES users to remove the
//     *** device in Windows Settings and pair again. Freeze before ship.
//
// STATUS: ready-to-flash source, not yet compiled on hardware (first
// flash shakes out library API naming). The hub-side protocol and the
// wired path are tested; treat this file as the firmware starting point.

#include <WiFi.h>
#include <BleComboKeyboard.h>   // lemmingDev ESP32-BLE-Controller
#include <BleComboMouse.h>

BleComboKeyboard keyboard;
BleComboMouse mouse(&keyboard);

const int TCP_PORT = 4210;
WiFiServer server(TCP_PORT);

// WiFi credentials are provisioned per-user at install time (the
// production installer writes them via serial on first plug-in).
// Dev defaults: leave empty -> serial-only mode.
const char* WIFI_SSID = "";
const char* WIFI_PASS = "";

void mouseTo(int x1000, int y1000) {
  // Park at top-left, then step out. Assumes a 1000x1000 logical space;
  // chunk steps to the BLE report range.
  for (int i = 0; i < 12; i++) mouse.move(-127, -127);
  delay(20);
  // Scale: treat the display as roughly 2000x2000 counts of travel from
  // the corner; hubs calibrate per-PC on first use.
  long tx = (long)x1000 * 2, ty = (long)y1000 * 2;
  while (tx > 0 || ty > 0) {
    int sx = tx > 127 ? 127 : (int)tx;
    int sy = ty > 127 ? 127 : (int)ty;
    mouse.move(sx, sy);
    tx -= sx; ty -= sy;
  }
  delay(20);
}

void doClick(int x, int y, uint8_t btn, bool dbl) {
  mouseTo(x, y);
  mouse.click(btn);
  if (dbl) { delay(90); mouse.click(btn); }
}

void handleLine(String line) {
  line.trim();
  if (line.startsWith("PING")) { Serial.println("PONG"); return; }
  if (!keyboard.isConnected()) { Serial.println("ERR not paired"); return; }
  if (line.startsWith("TYPE:")) {
    keyboard.print(line.substring(5));
  } else if (line.startsWith("KEY:")) {
    String c = line.substring(4); c.toLowerCase();
    // Combos like ctrl+l, alt+f4, enter - the combo library exposes
    // press()/releaseAll(); single named keys go through write().
    if (c == "enter") keyboard.write(KEY_RETURN);
    else if (c == "esc") keyboard.write(KEY_ESC);
    else if (c == "tab") keyboard.write(KEY_TAB);
    else if (c.indexOf('+') > 0) {
      // modifier + key
      String mod = c.substring(0, c.indexOf('+'));
      String key = c.substring(c.indexOf('+') + 1);
      if (mod == "ctrl") keyboard.press(KEY_LEFT_CTRL);
      else if (mod == "alt") keyboard.press(KEY_LEFT_ALT);
      else if (mod == "gui") keyboard.press(KEY_LEFT_GUI);
      else if (mod == "shift") keyboard.press(KEY_LEFT_SHIFT);
      if (key.length() == 1) keyboard.press(key.charAt(0));
      keyboard.releaseAll();
    }
  } else if (line.startsWith("MOVE:")) {
    int comma = line.indexOf(',');
    mouseTo(line.substring(5, comma).toInt(), line.substring(comma + 1).toInt());
  } else if (line.startsWith("CLICK:")) {
    int comma = line.indexOf(',');
    doClick(line.substring(6, comma).toInt(), line.substring(comma + 1).toInt(), MOUSE_LEFT, false);
  } else if (line.startsWith("DBLCLICK:")) {
    int comma = line.indexOf(',');
    doClick(line.substring(9, comma).toInt(), line.substring(comma + 1).toInt(), MOUSE_LEFT, true);
  } else if (line.startsWith("RCLICK:")) {
    int comma = line.indexOf(',');
    doClick(line.substring(7, comma).toInt(), line.substring(comma + 1).toInt(), MOUSE_RIGHT, false);
  } else if (line.startsWith("SCROLL:")) {
    mouse.move(0, 0, line.substring(7).toInt());
  }
  Serial.println("OK " + line);
}

void setup() {
  Serial.begin(115200);
  keyboard.setName("Cosmo Keyboard");       // plausible device strings;
  // mouse shares the connection identity. Ship names users recognize.
  keyboard.begin();
  mouse.begin();
  if (strlen(WIFI_SSID) > 0) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
    if (WiFi.status() == WL_CONNECTED) server.begin();
  }
  Serial.println("cosmo-hid esp32 up");
}

void loop() {
  if (Serial.available()) {
    handleLine(Serial.readStringUntil('\n'));
  }
  WiFiClient client = server.available();
  if (client) {
    unsigned long t0 = millis();
    while (client.connected() && millis() - t0 < 2000) {
      if (client.available()) {
        handleLine(client.readStringUntil('\n'));
        t0 = millis();
      }
    }
    client.stop();
  }
  delay(5);
}
