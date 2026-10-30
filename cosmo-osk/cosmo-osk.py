#!/usr/bin/env python3
# cosmo-osk: Fuse_Box system on-screen keyboard.
# One keyboard for every screen on the box: floats over any app, never takes
# focus, types into the focused window via xdotool (XTest). Pops up on its own
# when a text field is focused in the board Chrome or Brave (watched over the
# Chromium DevTools protocol), and can always be summoned from the pill button.
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib

import websocket  # websocket-client

LOG_PATH = '/home/cosmo/cosmo-osk/osk.log'


def log(msg):
    try:
        with open(LOG_PATH, 'a') as f:
            f.write('%s %s\n' % (time.strftime('%H:%M:%S'), msg))
    except Exception:
        pass


# ---------------------------------------------------------------- key sender
class KeySender:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()

    def _ensure(self):
        if self.proc is None or self.proc.poll() is not None:
            self.proc = subprocess.Popen(['xdotool', '-'], stdin=subprocess.PIPE,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         text=True)

    def key(self, keysym):
        with self.lock:
            try:
                self._ensure()
                self.proc.stdin.write('key %s\n' % keysym)
                self.proc.stdin.flush()
            except Exception as e:
                log('key send failed: %r' % (e,))
                self.proc = None


SENDER = KeySender()

KEYSYM = {
    '!': 'exclam', '@': 'at', '#': 'numbersign', '$': 'dollar', '%': 'percent',
    '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft',
    ')': 'parenright', '-': 'minus', '_': 'underscore', '=': 'equal', '+': 'plus',
    '[': 'bracketleft', ']': 'bracketright', '{': 'braceleft', '}': 'braceright',
    ';': 'semicolon', ':': 'colon', "'": 'apostrophe', '"': 'quotedbl',
    ',': 'comma', '.': 'period', '/': 'slash', '?': 'question',
    '\\': 'backslash', '|': 'bar', '<': 'less', '>': 'greater',
    '`': 'grave', '~': 'asciitilde', ' ': 'space',
}

LETTER_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']
SYMBOL_ROWS = ['!@#$%^&*()', '-_=+[]{};:', '\'"\\|<>/?`~']

CSS = b'''
window { background: #0b1428; }
.kbframe { background: #101c3f; border: 2px solid #2c4a8a; border-radius: 18px; }
button.key { background: #16224a; color: #eaf0ff; border: 1px solid #2c4a8a;
  border-radius: 12px; font-size: 25px; font-weight: bold; min-height: 74px; }
button.key:active { background: #2c4a8a; }
button.key.wide { font-size: 17px; }
button.key.enter { background: #f6a21a; color: #14171b; }
button.key.once { background: #3a5da8; }
button.key.on { background: #f6a21a; color: #14171b; }
.pillframe { background: rgba(16,28,63,0.92); border: 2px solid #f6a21a; border-radius: 28px; }
button.pill { background: transparent; color: #f6a21a; font-size: 27px; font-weight: bold;
  border: none; box-shadow: none; min-width: 56px; min-height: 56px; padding: 0; }
'''


class Keyboard:
    def __init__(self):
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.shift = 0          # 0 off, 1 once, 2 lock
        self.shift_at = 0.0
        self.manual_until = 0.0
        self.visible = False
        self.letter_buttons = []
        self.shift_btn = None

        display = Gdk.Display.get_default()
        mon = display.get_monitor(0)
        geo = mon.get_geometry()
        self.mon_w, self.mon_h = geo.width, geo.height
        kb_w = min(1280, self.mon_w - 16)
        kb_h = 452

        # ---- keyboard window
        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.win.set_decorated(False)
        self.win.set_accept_focus(False)
        self.win.set_focus_on_map(False)
        self.win.set_skip_taskbar_hint(True)
        self.win.set_skip_pager_hint(True)
        self.win.set_keep_above(True)
        self.win.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.win.set_default_size(kb_w, kb_h)
        self.win.move((self.mon_w - kb_w) // 2, self.mon_h - kb_h - 10)

        frame = Gtk.Frame()
        frame.get_style_context().add_class('kbframe')
        self.stack = Gtk.Stack()
        self.stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self.stack.add_named(self._build_page('letters'), 'letters')
        self.stack.add_named(self._build_page('syms'), 'syms')
        frame.add(self.stack)
        self.win.add(frame)

        # ---- pill window
        self.pill = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.pill.set_decorated(False)
        self.pill.set_accept_focus(False)
        self.pill.set_focus_on_map(False)
        self.pill.set_skip_taskbar_hint(True)
        self.pill.set_skip_pager_hint(True)
        self.pill.set_keep_above(True)
        self.pill.set_type_hint(Gdk.WindowTypeHint.DOCK)
        pbtn = Gtk.Button()
        icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kb-icon.png')
        if os.path.exists(icon_path):
            pbtn.set_image(Gtk.Image.new_from_file(icon_path))
            pbtn.set_always_show_image(True)
        else:
            pbtn.set_label('KB')
        pbtn.get_style_context().add_class('pill')
        pbtn.set_focus_on_click(False)
        pbtn.set_can_focus(False)
        pbtn.set_relief(Gtk.ReliefStyle.NONE)
        pbtn.connect('clicked', self._on_pill)
        self.pill.add(pbtn)
        self.pill.move(self.mon_w - 88, self.mon_h - 88)
        self.pill.show_all()

        GLib.timeout_add(1200, self._raise_keeper)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, self._sig_show)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, self._sig_hide)

    def _sig_show(self):
        self.manual_until = time.time() + 20
        self.show()
        return True

    def _sig_hide(self):
        self.hide(manual=True)
        return True

    # ------------------------------------------------------------ building
    def _key_btn(self, label, cls='key', flex=False):
        b = Gtk.Button(label=label)
        for c in cls.split():
            b.get_style_context().add_class(c)
        b.set_focus_on_click(False)
        b.set_hexpand(flex)
        return b

    def _build_page(self, page):
        grid = Gtk.Grid()
        grid.set_row_spacing(8)
        grid.set_column_spacing(8)
        grid.set_column_homogeneous(True)
        grid.set_valign(Gtk.Align.END)
        grid.set_hexpand(True)
        grid.set_margin_top(12)
        grid.set_margin_bottom(12)
        grid.set_margin_start(12)
        grid.set_margin_end(12)
        rows = LETTER_ROWS if page == 'letters' else SYMBOL_ROWS
        r = 0
        for ri, rowstr in enumerate(rows):
            col = 0
            if page == 'letters' and ri == 3:
                self.shift_btn = self._key_btn('SHIFT', 'key wide')
                self.shift_btn.connect('clicked', self._on_shift)
                grid.attach(self.shift_btn, col, r, 2, 1)
                col += 2
            for ch in rowstr:
                b = self._key_btn(ch)
                b.connect('clicked', self._on_char, ch, page)
                if page == 'letters' and ri > 0:
                    self.letter_buttons.append(b)
                grid.attach(b, col, r, 1, 1)
                col += 1
            if page == 'letters' and ri == 3:
                bk = self._key_btn('DELETE', 'key wide')
                bk.connect('clicked', lambda *_: self._special('BackSpace'))
                grid.attach(bk, col, r, 2, 1)
                col += 2
            r += 1
        # bottom row: page toggle / space / enter / hide
        toggle = self._key_btn('!#? SYMBOLS' if page == 'letters' else 'ABC LETTERS', 'key wide')
        toggle.connect('clicked', self._on_page_toggle)
        grid.attach(toggle, 0, r, 2, 1)
        space = self._key_btn('SPACE', 'key wide', flex=True)
        space.connect('clicked', lambda *_: self._special('space'))
        grid.attach(space, 2, r, 6, 1)
        enter = self._key_btn('ENTER', 'key wide enter')
        enter.connect('clicked', lambda *_: self._special('Return'))
        grid.attach(enter, 8, r, 2, 1)
        hide = self._key_btn('HIDE', 'key wide')
        hide.connect('clicked', lambda *_: self.hide(manual=True))
        grid.attach(hide, 10, r, 2, 1)
        return grid

    # ------------------------------------------------------------ actions
    def _extend_manual(self):
        if time.time() < self.manual_until:
            self.manual_until = time.time() + 20

    def _on_char(self, _btn, ch, page):
        self._extend_manual()
        out = ch
        if page == 'letters' and ch.isalpha() and self.shift > 0:
            out = ch.upper()
        if out.isupper() and out.isalpha():
            SENDER.key('shift+' + out.lower())
        elif out in KEYSYM:
            SENDER.key(KEYSYM[out])
        else:
            SENDER.key(out)
        if page == 'letters' and self.shift == 1 and ch.isalpha():
            self.shift = 0
            self._paint_shift()

    def _special(self, keysym):
        self._extend_manual()
        SENDER.key(keysym)

    def _on_shift(self, _btn):
        now = time.time()
        if self.shift == 0:
            self.shift = 1
            self.shift_at = now
        elif self.shift == 1 and (now - self.shift_at) < 0.45:
            self.shift = 2
        else:
            self.shift = 0
        self._paint_shift()

    def _paint_shift(self):
        ctx = self.shift_btn.get_style_context()
        ctx.remove_class('once')
        ctx.remove_class('on')
        if self.shift == 1:
            ctx.add_class('once')
        elif self.shift == 2:
            ctx.add_class('on')
        for b in self.letter_buttons:
            lab = b.get_label()
            b.set_label(lab.upper() if self.shift > 0 else lab.lower())

    def _on_page_toggle(self, _btn):
        cur = self.stack.get_visible_child_name()
        self.stack.set_visible_child_name('syms' if cur == 'letters' else 'letters')

    def _on_pill(self, _btn):
        if self.visible:
            self.hide(manual=True)
        else:
            self.manual_until = time.time() + 20
            self.show()

    # ------------------------------------------------------------ show/hide
    def show(self):
        if not self.visible:
            self.visible = True
            self.win.show_all()
            gw = self.win.get_window()
            if gw:
                gw.raise_()
            log('shown')

    def hide(self, manual=False):
        if manual:
            self.manual_until = 0.0
        if self.visible:
            self.visible = False
            self.win.hide()
            log('hidden')

    def _raise_keeper(self):
        try:
            for w in (self.pill, self.win):
                if w.get_visible():
                    gw = w.get_window()
                    if gw:
                        gw.raise_()
        except Exception:
            pass
        return True


# ------------------------------------------------------------------- watcher
def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=4).stdout.strip()
    except Exception:
        return ''


def focus_browser_window(app):
    """XTest keys go to the X input focus window, and in this WM-less session
    that focus can sit on a stub window even when a browser page believes it
    has focus. While the keyboard is up for a browser, pin X focus to that
    browser's main window so OSK keystrokes actually land."""
    cls = 'Brave-browser' if app == 'brave' else 'Google-chrome'
    ids = [x for x in sh(['xdotool', 'search', '--class', cls]).split('\n') if x.strip()]
    best, best_area = None, -1
    for wid in ids:
        geo = sh(['xdotool', 'getwindowgeometry', wid])
        for line in geo.splitlines():
            if 'Geometry:' in line:
                try:
                    w, h = line.split('Geometry:')[1].strip().split('x')
                    area = int(w) * int(h)
                    if area > best_area:
                        best, best_area = wid, area
                except Exception:
                    pass
    if best:
        sh(['xdotool', 'windowfocus', best])


def front_browser():
    """Which browser is in front: compare the stacking order of the Brave and
    board-Chrome top windows in the root window's child list (last = top).
    X input focus is unreliable in this WM-less session (it can sit on a
    stub window), but each page's own hasFocus() is truthful, so we only
    need to know which browser is on top."""
    brave = sh(['xdotool', 'search', '--class', 'Brave-browser']).split('\n')
    board = sh(['xdotool', 'search', '--class', 'Google-chrome']).split('\n')
    brave = [x for x in brave if x.strip()]
    board = [x for x in board if x.strip()]
    if not brave and not board:
        return None
    if not board:
        return 'brave'
    if not brave:
        return 'board'
    order = sh(['xwininfo', '-root', '-children'])
    ids = []
    for line in order.splitlines():
        parts = line.split()
        if parts and parts[0].startswith('0x'):
            ids.append(parts[0])
    def pos(idlist):
        best = -1
        for wid in idlist:
            hx = hex(int(wid))
            if hx in ids:
                best = max(best, ids.index(hx))
        return best
    return 'brave' if pos(brave) > pos(board) else 'board'


class CdpBrowser:
    """Persistent CDP websocket to one Chromium; answers: is a text field
    focused in the visible, focused page?"""
    PORTS = {'brave': 9224, 'board': 9223}
    EVAL = ("JSON.stringify({v: document.visibilityState, f: document.hasFocus(), "
            "tag: (document.activeElement ? document.activeElement.tagName : ''), "
            "type: (document.activeElement ? (document.activeElement.type || '') : ''), "
            "ce: !!(document.activeElement && document.activeElement.isContentEditable)})")
    TEXT_TYPES = {'', 'text', 'search', 'password', 'email', 'url', 'tel', 'number'}

    def __init__(self, name):
        self.name = name
        self.port = self.PORTS[name]
        self.ws = None
        self.target_id = None
        self.msg_id = 0

    def _targets(self):
        with urllib.request.urlopen('http://127.0.0.1:%d/json/list' % self.port, timeout=2) as r:
            pages = [t for t in json.loads(r.read()) if t.get('type') == 'page'
                     and t.get('webSocketDebuggerUrl')]
        return pages

    def _connect(self):
        pages = self._targets()
        if not pages:
            raise RuntimeError('no pages')
        # prefer a real page over the new-tab page
        pages.sort(key=lambda t: 0 if t.get('url', '').startswith('http') else 1)
        t = pages[0]
        self.ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=2)
        self.target_id = t['id']

    def editable_focused(self):
        try:
            if self.ws is None:
                self._connect()
            self.msg_id += 1
            self.ws.send(json.dumps({'id': self.msg_id, 'method': 'Runtime.evaluate',
                                     'params': {'expression': self.EVAL, 'returnByValue': True}}))
            while True:
                msg = json.loads(self.ws.recv())
                if msg.get('id') == self.msg_id:
                    val = msg['result']['result'].get('value')
                    break
            d = json.loads(val)
            if d.get('v') != 'visible' or not d.get('f'):
                return False
            if d.get('ce'):
                return True
            if d.get('tag') == 'TEXTAREA':
                return True
            if d.get('tag') == 'INPUT' and d.get('type') in self.TEXT_TYPES:
                return True
            return False
        except Exception:
            try:
                if self.ws:
                    self.ws.close()
            except Exception:
                pass
            self.ws = None
            return False


def watcher(kb):
    browsers = {'brave': CdpBrowser('brave'), 'board': CdpBrowser('board')}
    false_streak = 0
    while True:
        try:
            manual = time.time() < kb.manual_until
            want = manual
            app = None
            if not want:
                app = front_browser()
                if app in browsers:
                    want = browsers[app].editable_focused()
            if want:
                false_streak = 0
                GLib.idle_add(kb.show)
                if app in browsers:
                    focus_browser_window(app)
            else:
                false_streak += 1
                if false_streak >= 2:
                    GLib.idle_add(kb.hide)
        except Exception as e:
            log('watcher error: %r' % (e,))
        time.sleep(0.7)


def main():
    GLib.set_prgname('osk-keyboard')
    GLib.set_application_name('On-Screen Keyboard')
    kb = Keyboard()
    t = threading.Thread(target=watcher, args=(kb,), daemon=True)
    t.start()
    log('cosmo-osk started (manual=%s)' % 'pill ready')
    Gtk.main()


if __name__ == '__main__':
    main()
