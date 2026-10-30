#!/usr/bin/env python3
"""Fuse_Box: the Android window's close button.

A small round X that floats at the top-right of the kiosk screen, visible
ONLY while the Android (Weston) window is on screen. Tapping it tucks the
Android window away (unmap) and brings the board back. Polls the X tree the
same way cosmo-osk does; never takes focus.
"""
import subprocess
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

BTN = 64
MARGIN_X = 10
MARGIN_Y = 8


def weston_mapped():
    try:
        out = subprocess.run(["xdotool", "search", "--class", "Weston"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        for wid in out:
            info = subprocess.run(["xwininfo", "-id", wid],
                                  capture_output=True, text=True, timeout=5).stdout
            if "IsViewable" in info:
                return wid
    except Exception:
        pass
    return None


class CloseButton:
    def __init__(self):
        self.wid = None
        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.win.set_decorated(False)
        self.win.set_accept_focus(False)
        self.win.set_focus_on_map(False)
        self.win.set_skip_taskbar_hint(True)
        self.win.set_skip_pager_hint(True)
        self.win.set_keep_above(True)
        self.win.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.win.set_app_paintable(True)
        scr = self.win.get_screen()
        vis = scr.get_rgba_visual()
        if vis:
            self.win.set_visual(vis)
        css = Gtk.CssProvider()
        css.load_from_data(b"""
        window { background: transparent; }
        button { background: rgba(127, 29, 45, 0.92); color: #ffffff; border: 2px solid rgba(255,255,255,0.55);
                 border-radius: 32px; font-size: 30px; font-weight: bold; min-width: 60px; min-height: 60px; }
        button:active { background: rgba(160, 40, 58, 0.95); }
        """)
        Gtk.StyleContext.add_provider_for_screen(scr, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        btn = Gtk.Button(label="\u2715")
        btn.set_focus_on_click(False)
        btn.connect("clicked", self.on_click)
        self.win.add(btn)
        mon = scr.get_monitor_geometry(scr.get_primary_monitor())
        self.win.move(mon.width - BTN - MARGIN_X, MARGIN_Y)
        self.win.set_size_request(BTN, BTN)
        GLib.timeout_add(700, self.tick)
        self.tick()

    def tick(self):
        wid = weston_mapped()
        if wid:
            self.wid = wid
            if not self.win.get_visible():
                self.win.show_all()
            try:
                self.win.get_window().raise_()
            except Exception:
                pass
        else:
            self.wid = None
            if self.win.get_visible():
                self.win.hide()
        return True

    def on_click(self, _btn):
        if self.wid:
            try:
                subprocess.run(["xdotool", "windowunmap", self.wid], timeout=5)
            except Exception:
                pass
        self.win.hide()


if __name__ == "__main__":
    CloseButton()
    Gtk.main()
