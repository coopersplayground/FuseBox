#!/usr/bin/env python3
"""Zero-token weather feeder: Open-Meteo (no key) -> cosmo-ui /api/weather.
Location comes from cosmo-ui/config.json (weatherLat/weatherLon/weatherPlace).
Runs from cron every 30 min; safe to run by hand any time."""
import json, urllib.request, urllib.parse
from datetime import datetime

BASE = '/home/cosmo/cosmo-ui'
cfg = json.load(open(BASE + '/config.json'))
LAT = cfg.get('weatherLat', 41.1062)
LON = cfg.get('weatherLon', -75.8427)
PLACE = cfg.get('weatherPlace', 'New York, NY')
UI = 'http://127.0.0.1:3180'

def hour_label(iso):
    h = int(iso[11:13])
    return ('%d %s' % ((h % 12) or 12, 'AM' if h < 12 else 'PM'))

def main():
    q = urllib.parse.urlencode({
        'latitude': LAT, 'longitude': LON,
        'current': 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
        'hourly': 'temperature_2m,weather_code,precipitation_probability',
        'daily': 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        'temperature_unit': 'fahrenheit', 'wind_speed_unit': 'mph',
        'timezone': 'America/New_York', 'forecast_days': 8,
    })
    with urllib.request.urlopen('https://api.open-meteo.com/v1/forecast?' + q, timeout=20) as r:
        w = json.loads(r.read())
    cur = w['current']
    state = {'place': PLACE, 'updatedAt': datetime.now().astimezone().isoformat(),
             'current': {'temp': round(cur['temperature_2m']), 'feels': round(cur['apparent_temperature']),
                         'code': cur['weather_code'], 'wind': round(cur['wind_speed_10m']),
                         'humidity': round(cur['relative_humidity_2m'])}}
    times = w['hourly']['time']
    now_h = cur['time'][:13]
    start = next((i for i, t in enumerate(times) if t[:13] >= now_h), 0)
    hourly = []
    for i in range(start, min(start + 12, len(times))):
        hourly.append({'label': 'Now' if i == start else hour_label(times[i]),
                       'temp': round(w['hourly']['temperature_2m'][i]),
                       'code': w['hourly']['weather_code'][i],
                       'precip': w['hourly']['precipitation_probability'][i]})
    state['hourly'] = hourly
    d = w['daily']
    daily = []
    for i in range(min(7, len(d['time']))):
        dt = datetime.strptime(d['time'][i], '%Y-%m-%d')
        daily.append({'label': 'Today' if i == 0 else dt.strftime('%a'), 'date': d['time'][i],
                      'code': d['weather_code'][i], 'hi': round(d['temperature_2m_max'][i]),
                      'lo': round(d['temperature_2m_min'][i]),
                      'precip': d['precipitation_probability_max'][i]})
    state['daily'] = daily
    req = urllib.request.Request(UI + '/api/weather', data=json.dumps({'state': state}).encode(),
                                 method='POST', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        r.read()
    print('weather posted:', state['current']['temp'], 'F code', state['current']['code'],
          '| hourly', len(hourly), '| daily', len(daily))

if __name__ == '__main__':
    main()
