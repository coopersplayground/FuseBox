#!/usr/bin/env python3
"""Network Administrator feeder (Server 2, zero-token). Gathers live LAN
state - host, links (router / internet / WireGuard hub), known devices and
unknown neighbors - and posts it to cosmo-ui /api/network/data.
Runs from cron every 2 minutes; --once is the same single pass."""
import json, os, re, shutil, socket, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

UI = 'http://127.0.0.1:3180'

def run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout or ''
    except Exception:
        return ''

def ping(ip):
    if not ip:
        return (False, None)
    out = run(['ping', '-c1', '-W1', ip], timeout=4)
    m = re.search(r'time[=<]([0-9.]+) ms', out)
    if '1 received' in out or m:
        return (True, round(float(m.group(1))) if m else 0)
    return (False, None)

KNOWN = [
    ('Router', '192.168.1.1', '00:11:22:33:44:01', 'Home router / gateway'),
    ('Demo Cam', '192.168.1.64', '00:11:22:33:44:02', 'Example camera'),
    ('Smart TV', None, '00:11:22:33:44:03', 'Example television'),
]

def neigh():
    out = run(['ip', 'neigh', 'show', 'dev', 'eno1'])
    by_ip, by_mac = {}, {}
    for line in out.splitlines():
        m = re.match(r'(\d+\.\d+\.\d+\.\d+)\s+(?:lladdr\s+([0-9a-f:]+)\s+)?(\w+)', line.strip())
        if not m:
            continue
        e = {'ip': m.group(1), 'mac': m.group(2) or '', 'state': m.group(3)}
        by_ip[e['ip']] = e
        if e['mac']:
            by_mac[e['mac']] = e
    return by_ip, by_mac

def iface_ip(name):
    out = run(['ip', '-4', '-brief', 'addr', 'show', name])
    parts = out.split()
    return parts[2].split('/')[0] if len(parts) >= 3 else ''

def host_info():
    up = float(open('/proc/uptime').read().split()[0])
    d, rem = divmod(int(up), 86400)
    hh, mm = divmod(rem // 60, 60 * 24 % 24) if False else divmod(rem, 3600)
    uptime = ('%dd %dh %dm' % (d, hh, mm // 60)) if d else ('%dh %dm' % (hh, mm // 60))
    temps = []
    tdir = '/sys/class/thermal'
    for z in os.listdir(tdir) if os.path.isdir(tdir) else []:
        try:
            temps.append(int(open(os.path.join(tdir, z, 'temp')).read().strip()) / 1000.0)
        except Exception:
            pass
    mem = {}
    for line in open('/proc/meminfo'):
        k = line.split(':')[0]
        if k in ('MemTotal', 'MemAvailable'):
            mem[k] = int(line.split()[1]) / 1048576.0
    du = shutil.disk_usage('/')
    return {
        'hostname': socket.gethostname(), 'iface': 'eno1', 'ip': iface_ip('eno1'),
        'uptime': uptime, 'load': '%.2f on %d cores' % (os.getloadavg()[0], os.cpu_count() or 0),
        'temp': ('%.0f\u00b0C' % max(temps)) if temps else '-',
        'mem': '%.0f GB free of %.0f GB' % (mem.get('MemAvailable', 0), mem.get('MemTotal', 0)),
        'disk': '%.0f GB free of %.0f GB' % (du.free / 1e9, du.total / 1e9),
    }

def wg_info():
    out = run(['sudo', '-n', 'wg', 'show', 'wg0'])
    hs = re.search(r'latest handshake:\s*(.+)', out)
    ep = re.search(r'endpoint:\s*(\S+)', out)
    tr = re.search(r'transfer:\s*(.+)', out)
    return {'handshake': hs.group(1).strip() if hs else '', 'endpoint': ep.group(1) if ep else '', 'transfer': tr.group(1).strip() if tr else ''}

def main():
    targets = ['192.168.1.1', '1.1.1.1'] + [k[1] for k in KNOWN if k[1]]
    with ThreadPoolExecutor(max_workers=10) as ex:
        pings = dict(zip(targets, ex.map(ping, targets)))
    by_ip, by_mac = neigh()
    known_macs = {k[2] for k in KNOWN if k[2]}
    known_ips = set()
    devices = [{'name': 'Fuse_Box', 'ip': iface_ip('eno1') or '192.168.1.10', 'status': 'up', 'detail': 'This box - the board lives here'}]
    for name, fb_ip, mac, detail in KNOWN:
        e = by_mac.get(mac) if mac else None
        ip = e['ip'] if e else fb_ip
        if ip:
            known_ips.add(ip)
        ok, ms = pings.get(ip, (False, None)) if ip else (False, None)
        state = e['state'] if e else (by_ip.get(ip, {}) if ip else {}).get('state', '')
        if ok:
            status = 'up'
            detail = detail + (' - %d ms' % ms if ms is not None else '')
        elif state in ('REACHABLE', 'DELAY', 'PROBE', 'STALE'):
            status = 'seen'
        else:
            status = 'down'
        devices.append({'name': name, 'ip': ip or '', 'status': status, 'detail': detail})
    unknown = []
    for ip, e in by_ip.items():
        if ip in known_ips or (e['mac'] and e['mac'] in known_macs) or not e['mac']:
            continue
        unknown.append({'ip': ip, 'mac': e['mac'], 'status': 'seen'})
    unknown.sort(key=lambda x: tuple(int(p) for p in x['ip'].split('.')))
    wg = wg_info()
    links = [
        {'name': 'Router / gateway', 'target': '192.168.1.1', 'ok': pings['192.168.1.1'][0], 'ms': pings['192.168.1.1'][1], 'detail': 'Home router'},
        {'name': 'Internet', 'target': '1.1.1.1', 'ok': pings['1.1.1.1'][0], 'ms': pings['1.1.1.1'][1], 'detail': 'ISP uplink'},
    ]
    summary = {
        'internet': bool(pings['1.1.1.1'][0]), 'tunnel': False,
        'devicesUp': sum(1 for d in devices if d['status'] == 'up'),
        'devicesSeen': sum(1 for d in devices if d['status'] in ('up', 'seen')),
        'devicesTotal': len(devices), 'unknownCount': len(unknown),
    }
    payload = {'host': host_info(), 'links': links, 'devices': devices, 'unknown': unknown[:16], 'summary': summary}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(UI + '/api/network/data', data=data, method='POST', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()
    print('network-feeder: internet %s, tunnel %s, devices %d up / %d seen of %d, unknown %d' % (
        'UP' if summary['internet'] else 'DOWN', 'UP' if summary['tunnel'] else 'DOWN',
        summary['devicesUp'], summary['devicesSeen'], summary['devicesTotal'], summary['unknownCount']))

if __name__ == '__main__':
    main()
