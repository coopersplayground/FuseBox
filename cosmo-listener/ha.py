#!/usr/bin/env python3
"""Home Assistant control for the Cosmo voice session (Server 2 only).
Token: /home/cosmo/.config/ha-api-token (0600, never leaves this box).
Usage:
  ha.py list [domain]            controllable entities + states
  ha.py state <name-or-id>       one entity's state
  ha.py on|off|toggle <name-or-id>
  ha.py automation-add --name "Porch on" --at 19:00 --entity switch.x --action on [--days mon,tue,wed,thu,fri]
  ha.py automation-remove <name-or-id>
Names match entity_id or friendly name, case-insensitive substring;
an ambiguous match lists the candidates instead of guessing."""
import json, sys, urllib.request

BASE = 'http://127.0.0.1:8123'
TOK = open('/home/cosmo/.config/ha-api-token').read().strip()
CONTROL = ('switch', 'light', 'automation', 'media_player', 'climate', 'fan', 'cover', 'lock', 'input_boolean', 'scene', 'script')

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=12) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}

def states():
    return api('GET', '/api/states')

def find(st, q):
    q = q.lower()
    hits = [e for e in st if e['entity_id'].lower() == q]
    if not hits:
        hits = [e for e in st if q in e['entity_id'].lower() or q in (e['attributes'].get('friendly_name') or '').lower()]
    return hits

def service(domain, svc, entity_id):
    return api('POST', '/api/services/%s/%s' % (domain, svc), {'entity_id': entity_id})

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    cmd = args[0]
    st = states()
    if cmd == 'list':
        dom = args[1] if len(args) > 1 else None
        rows = [e for e in st if e['entity_id'].split('.')[0] in CONTROL and (not dom or e['entity_id'].startswith(dom + '.'))]
        for e in sorted(rows, key=lambda x: x['entity_id']):
            print('%-38s %-10s %s' % (e['entity_id'], e['state'], e['attributes'].get('friendly_name') or ''))
        print('%d controllable entities' % len(rows))
        return 0
    if cmd in ('state', 'on', 'off', 'toggle'):
        if len(args) < 2:
            print('need a name or entity_id')
            return 2
        hits = find(st, ' '.join(args[1:]))
        if not hits:
            print('NO MATCH for', ' '.join(args[1:]))
            return 3
        if len(hits) > 1:
            print('AMBIGUOUS - be more specific:')
            for e in hits:
                print(' ', e['entity_id'], '=', e['state'])
            return 4
        e = hits[0]
        eid, dom = e['entity_id'], e['entity_id'].split('.')[0]
        if cmd == 'state':
            print('%s = %s (%s)' % (eid, e['state'], e['attributes'].get('friendly_name') or ''))
            return 0
        if dom == 'media_player':
            svc = {'on': 'turn_on', 'off': 'turn_off', 'toggle': 'media_play_pause'}[cmd]
        elif dom == 'scene':
            svc = 'turn_on'
        else:
            svc = {'on': 'turn_on', 'off': 'turn_off', 'toggle': 'toggle'}[cmd]
        service(dom, svc, eid)
        after = find(states(), eid)
        print('%s -> %s' % (eid, after[0]['state'] if after else '?'))
        return 0
    if cmd == 'automation-add':
        opts = {}
        it = iter(args[1:])
        for a in it:
            if a.startswith('--'):
                opts[a[2:]] = next(it)
        name = opts.get('name', 'Cosmo schedule')
        at = opts.get('at')
        ent = opts.get('entity')
        act = opts.get('action', 'on')
        if not at or not ent:
            print('need --at HH:MM and --entity <id>')
            return 2
        hits = find(st, ent)
        if len(hits) != 1:
            print('entity match problem:', [h['entity_id'] for h in hits])
            return 3
        eid = hits[0]['entity_id']
        dom = eid.split('.')[0]
        uid = 'cosmo_' + ''.join(ch if ch.isalnum() else '_' for ch in name.lower()).strip('_')
        body = {'alias': name,
                'trigger': [{'platform': 'time', 'at': at + ':00'}],
                'action': [{'service': '%s.turn_%s' % (dom, act), 'target': {'entity_id': eid}}]}
        days = opts.get('days')
        if days:
            body['condition'] = [{'condition': 'time', 'weekday': [d.strip()[:3].lower() for d in days.split(',')]}]
        api('POST', '/api/config/automation/config/' + uid, body)
        print('automation created:', uid, '-', name, 'at', at, '->', eid, act)
        return 0
    if cmd == 'automation-remove':
        q = ' '.join(args[1:])
        hits = [e for e in st if e['entity_id'].startswith('automation.')]
        hits = find(hits, q)
        if len(hits) != 1:
            print('match problem:', [h['entity_id'] for h in hits])
            return 3
        uid = hits[0]['attributes'].get('id') or hits[0]['entity_id'].split('.', 1)[1]
        api('DELETE', '/api/config/automation/config/' + str(uid))
        print('automation removed:', hits[0]['entity_id'])
        return 0
    print('unknown command:', cmd)
    return 2

if __name__ == '__main__':
    sys.exit(main())
