# Cosmo HID core - builds USB HID reports (keyboard boot protocol +
# absolute mouse) and writes them to Linux gadget devices, or to a dev
# sink file when no gadget exists. Stdlib only.
#
# Command vocabulary (shared by every transport):
#   type:<text>          type a string
#   key:<combo>          e.g. key:enter, key:ctrl+l, key:alt+f4
#   move:<x>,<y>         0..1000 normalized, primary display space
#   click:<x>,<y>        left click (absolute on gadget; ESP32 parks+steps)
#   dblclick:<x>,<y>
#   rclick:<x>,<y>
#   scroll:<n>           wheel steps, + up / - down
import os
import struct
import time

MOD = {'ctrl': 0x01, 'shift': 0x02, 'alt': 0x04, 'gui': 0x08,
       'rctrl': 0x10, 'rshift': 0x20, 'ralt': 0x40, 'rgui': 0x80}

KEY = {}
for _i, _c in enumerate('abcdefghijklmnopqrstuvwxyz'):
    KEY[_c] = 0x04 + _i
for _i, _c in enumerate('1234567890'):
    KEY[_c] = 0x1E + _i
KEY.update({
    'enter': 0x28, 'esc': 0x29, 'escape': 0x29, 'backspace': 0x2A,
    'tab': 0x2B, 'space': 0x2C, '-': 0x2D, '=': 0x2E, '[': 0x2F, ']': 0x30,
    '\\': 0x31, ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37,
    '/': 0x38, 'capslock': 0x39, 'printscreen': 0x46, 'scrolllock': 0x47,
    'pause': 0x48, 'insert': 0x49, 'home': 0x4A, 'pageup': 0x4B,
    'delete': 0x4C, 'del': 0x4C, 'end': 0x4D, 'pagedown': 0x4E,
    'right': 0x4F, 'left': 0x50, 'down': 0x51, 'up': 0x52,
})
for _i in range(1, 13):
    KEY['f%d' % _i] = 0x3A + (_i - 1)

SHIFTED = {'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
           '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
           '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`',
           '<': ',', '>': '.', '?': '/'}


def char_to_key(ch):
    if ch in KEY:
        return (0, KEY[ch])
    if ch.isupper() and ch.lower() in KEY:
        return (MOD['shift'], KEY[ch.lower()])
    if ch in SHIFTED:
        return (MOD['shift'], KEY[SHIFTED[ch]])
    if ch == '\n':
        return (0, KEY['enter'])
    if ch == '\t':
        return (0, KEY['tab'])
    return None


class HidWriter:
    def __init__(self, kbd_path='/dev/hidg0', mouse_path='/dev/hidg1',
                 sink_path=None):
        self.kbd_path = kbd_path
        self.mouse_path = mouse_path
        self.dev = os.path.exists(kbd_path) and os.path.exists(mouse_path)
        self.sink_path = sink_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'sink.log')
        self._x = 0
        self._y = 0

    def _write(self, which, data):
        if self.dev:
            path = self.kbd_path if which == 'kbd' else self.mouse_path
            with open(path, 'wb') as f:
                f.write(data)
        else:
            with open(self.sink_path, 'a') as f:
                f.write('%s %s\n' % (which, data.hex()))

    # ---- keyboard ----
    def key_report(self, mods, code):
        self._write('kbd', bytes([mods, 0, code, 0, 0, 0, 0, 0]))

    def release(self):
        self._write('kbd', bytes(8))

    def press(self, combo):
        mods = 0
        code = 0
        for p in [x.strip().lower() for x in combo.split('+')]:
            if p in MOD:
                mods |= MOD[p]
            elif p in KEY:
                code = KEY[p]
            else:
                raise ValueError('unknown key: ' + p)
        self.key_report(mods, code)
        time.sleep(0.03)
        self.release()

    def type_text(self, text):
        for ch in text:
            k = char_to_key(ch)
            if k is None:
                continue
            self.key_report(k[0], k[1])
            time.sleep(0.012)
            self.release()
            time.sleep(0.008)

    # ---- mouse (absolute; report must match the gadget descriptor:
    # buttons 1B, X int16 LE 0..32767, Y int16 LE 0..32767, wheel int8) ----
    def _mouse(self, buttons, x1000, y1000, wheel=0):
        x = max(0, min(32767, int(x1000 * 32767 / 1000)))
        y = max(0, min(32767, int(y1000 * 32767 / 1000)))
        self._write('mouse', struct.pack('<Bhhb', buttons, x, y, wheel))
        self._x, self._y = x1000, y1000

    def move(self, x, y):
        self._mouse(0, x, y)

    def click(self, x, y, button=1, double=False):
        self._mouse(0, x, y)
        time.sleep(0.05)
        self._mouse(button, x, y)
        time.sleep(0.06)
        self._mouse(0, x, y)
        if double:
            time.sleep(0.08)
            self._mouse(button, x, y)
            time.sleep(0.06)
            self._mouse(0, x, y)

    def scroll(self, n):
        self._mouse(0, self._x, self._y, max(-127, min(127, n)))


def execute(writer, cmd):
    if cmd.startswith('type:'):
        writer.type_text(cmd[5:])
    elif cmd.startswith('key:'):
        writer.press(cmd[4:])
    elif cmd.startswith('move:'):
        x, y = cmd[5:].split(',')
        writer.move(int(x), int(y))
    elif cmd.startswith('click:'):
        x, y = cmd[6:].split(',')
        writer.click(int(x), int(y), 1)
    elif cmd.startswith('dblclick:'):
        x, y = cmd[9:].split(',')
        writer.click(int(x), int(y), 1, True)
    elif cmd.startswith('rclick:'):
        x, y = cmd[7:].split(',')
        writer.click(int(x), int(y), 2)
    elif cmd.startswith('scroll:'):
        writer.scroll(int(cmd[7:]))
    else:
        raise ValueError('unknown hid command: ' + cmd)


if __name__ == '__main__':
    import sys
    w = HidWriter()
    print('device mode:', w.dev)
    for c in sys.argv[1:]:
        execute(w, c)
        print('did:', c)
