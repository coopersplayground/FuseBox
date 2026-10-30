#!/usr/bin/env python3
# Cosmo HID emitter - drains the cosmo-ui HID command queue and drives the
# best available transport, in priority order:
#   1. Pi USB gadget devices (/dev/hidg0 keyboard, /dev/hidg1 mouse)
#   2. ESP32-S3 BLE dongle over TCP (config.json: esp32_host, esp32_port)
#   3. Dev sink (report bytes logged to sink.log) - no hardware needed
# Stdlib only. Runs as a systemd user service (hid-emitter).
import json
import os
import socket
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
import sys
sys.path.insert(0, HERE)
import hid as hidcore

BOARD = 'http://127.0.0.1:3180'
VERSION = 'cosmo-hid 0.1'


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def board(path, obj=None):
    if obj is None:
        with _opener.open(BOARD + path, timeout=5) as r:
            return json.load(r)
    req = urllib.request.Request(BOARD + path, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'})
    with _opener.open(req, timeout=5) as r:
        return json.load(r)


def load_cfg():
    try:
        with open(os.path.join(HERE, 'config.json')) as f:
            return json.load(f)
    except Exception:
        return {}


class Esp32Transport:
    """Sends vocabulary lines to the ESP32-S3 firmware over TCP. The
    firmware maps click/move onto its relative BLE mouse by parking the
    cursor at the top-left corner and stepping to the target."""

    def __init__(self, host, port):
        self.host = host
        self.port = port

    def send(self, cmd):
        line = cmd
        for pre, rep in (('type:', 'TYPE:'), ('key:', 'KEY:'),
                         ('click:', 'CLICK:'), ('dblclick:', 'DBLCLICK:'),
                         ('rclick:', 'RCLICK:'), ('move:', 'MOVE:'),
                         ('scroll:', 'SCROLL:')):
            if cmd.startswith(pre):
                line = rep + cmd[len(pre):]
                break
        with socket.create_connection((self.host, self.port), timeout=4) as s:
            s.sendall((line + '\n').encode())


def pick_transport(cfg):
    w = hidcore.HidWriter()
    if w.dev:
        return ('gadget', w)
    host = cfg.get('esp32_host')
    if host:
        return ('esp32', Esp32Transport(host, int(cfg.get('esp32_port', 4210))))
    return ('sink', w)


def main():
    cfg = load_cfg()
    transport, driver = pick_transport(cfg)
    board('/api/hid/status', {'emitter': VERSION, 'transport': transport,
                              'detail': 'started'})
    print('hid-emitter up, transport =', transport, flush=True)
    last_status = time.time()
    while True:
        try:
            r = board('/api/hid/command')
            cmd = (r or {}).get('command') or ''
            if cmd:
                if transport == 'esp32':
                    driver.send(cmd)
                else:
                    hidcore.execute(driver, cmd)
                board('/api/hid/status', {'emitter': VERSION,
                                          'transport': transport,
                                          'detail': 'did ' + cmd[:40]})
                last_status = time.time()
        except Exception as e:
            print('cycle error:', e, flush=True)
        if time.time() - last_status > 30:
            try:
                board('/api/hid/status', {'emitter': VERSION,
                                          'transport': transport,
                                          'detail': 'idle'})
            except Exception:
                pass
            last_status = time.time()
        time.sleep(0.4)


if __name__ == '__main__':
    main()
