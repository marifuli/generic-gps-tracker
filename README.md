# GPS Tracker

Self-hosted, multi-user GPS tracker for GT06-protocol devices (Concox GT06/GK309 and clones).

- **Google Maps** live view, follow mode, address lookup, route history with playback
- **Google sign-in**; each device is claimed by serial/IMEI, and an account only ever sees its own devices
- **Push notifications** (Web Push / VAPID, no Firebase needed) when the bike starts / stops, on alarms, and before the SIM expires
- **Ignition colours** everywhere: **green** = ignited, **yellow** = turned off, grey = unknown
- **History** with a date-and-time filter (presets, custom from/to up to 31 days), route coloured by ignition state, direction arrows and playback (1x/4x/16x)
- **Direction of travel** derived from movement, so it works even when the tracker sends no course
- **Trips & stops** detected automatically: parked or idling stays, long stops (default 60+ min), trips between them and "no signal" gaps
- **SIM recharge management**: amounts, dates, expiry, stacking packs, spend totals, reminder days
- Mobile-first PWA (installable), light/dark, real-time over WebSocket
- Runs as one Node process + SQLite behind nginx on your VPS

## Deploy on Ubuntu (22.04 / 24.04) with your own domain

No Cloudflare, no direct IP: the domain's DNS record points at the VPS, nginx serves the site
over free Let's Encrypt HTTPS, and the tracker connects to the same domain over plain TCP.

```
Browser  --https:443-->  nginx  --http--> 127.0.0.1:8080  (Node app)
Tracker  --tcp:8090---------------------> Node app (GPS server)
```

Below, replace `track.example.com` with your domain.

### 1. DNS
Create an **A** record `track` → your VPS public IPv4 (and an **AAAA** record for IPv6 if you use it).
Wait until `dig +short track.example.com` returns your IP. (If your DNS provider offers a proxy
option, keep it off / "DNS only".)

### 2. Server packages and firewall
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx ufw curl
# Node.js 22 or newer (>= 22.13 is required: the app uses Node's built-in SQLite)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 (Let's Encrypt + redirect) and 443
sudo ufw allow 8090/tcp          # tracker connections
sudo ufw enable
```
Port 8080 is **not** opened: the app listens on loopback only and nginx is the public entry point.

### 3. Install the app
```bash
sudo useradd --system --home /opt/gps-tracker --shell /usr/sbin/nologin gps
sudo mkdir -p /opt/gps-tracker
# copy the project here (from your machine):  rsync -a --exclude node_modules --exclude .env --exclude 'gps.db*' ./ user@server:/tmp/gps-tracker/
sudo rsync -a /tmp/gps-tracker/ /opt/gps-tracker/
cd /opt/gps-tracker && sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env
sudo chown -R gps:gps /opt/gps-tracker && sudo chmod 600 /opt/gps-tracker/.env
```
Edit `.env`: set `PUBLIC_URL=https://track.example.com`, `GOOGLE_CLIENT_ID`, `GOOGLE_MAPS_API_KEY`,
`ADMIN_EMAILS` (and `ALLOWED_EMAILS` if you want a private install). Leave `WEB_HOST=127.0.0.1`.
To keep your beta database, copy `gps.db` into `/opt/gps-tracker/` as well.

### 4. Run it as a service
```bash
sudo cp deploy/gps-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gps-tracker
journalctl -u gps-tracker -f        # should show web + GT06 server listening
```

### 5. nginx + free HTTPS
```bash
sudo cp deploy/nginx-gps-tracker.conf /etc/nginx/sites-available/gps-tracker
sudo sed -i 's/track.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/gps-tracker
sudo ln -s /etc/nginx/sites-available/gps-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d track.example.com --redirect -m you@email.com --agree-tos
```
Certbot installs the certificate, adds the HTTPS server block and redirects http → https.
Renewal is automatic (`systemctl list-timers | grep certbot`; test with `sudo certbot renew --dry-run`).
Optional hardening: add `add_header Strict-Transport-Security "max-age=31536000" always;` inside the
443 `server` block once everything works.

### 6. Google Cloud Console
- OAuth client (type *Web application*) → *Authorized JavaScript origins*: `https://track.example.com`
- Maps API key (Maps JavaScript API + Geocoding API) → restrict by HTTP referrer: `https://track.example.com/*`

### 7. Point the tracker at the domain
Send this SMS from your phone to the tracker's SIM (Concox/GT06 family; `0` = domain mode):
```
SERVER,0,track.example.com,8090,0#
```
Send `SERVER#` to check it, and `RESET#` to reboot it. Commands vary by clone; check your manual if it
doesn't reply. The tracker resolves the domain itself, so if it never connects, try the IP form
`SERVER,1,<VPS-IP>,8090,0#` to rule out firmware that can't resolve domains.
The tracker's connection is plain TCP (GT06 has no TLS); the app only keeps data for serials you registered.

### 8. Use it
Open `https://track.example.com` → sign in with Google → *Settings* → **Add a device** (serial/IMEI on the
tracker) → *Enable notifications*. On iPhone, add the app to the Home Screen first.

For ignition alerts the tracker's **ACC wire must be connected to the bike's ignition switch**.

### Updating / backups / troubleshooting
```bash
# update: rsync new code, then
cd /opt/gps-tracker && sudo npm ci --omit=dev && sudo systemctl restart gps-tracker
# backup (safe while running)
sudo -u gps sqlite3 /opt/gps-tracker/gps.db ".backup '/opt/gps-tracker/backup-$(date +%F).db'"
```
| Symptom | Check |
|---|---|
| 502 Bad Gateway | `systemctl status gps-tracker`, `journalctl -u gps-tracker -n 50` |
| Google sign-in "origin not allowed" | exact `https://domain` listed in OAuth origins (no trailing slash) |
| Signed in but immediately signed out | nginx must send `X-Forwarded-Proto` (it does in the provided config) and `TRUST_PROXY=loopback` |
| Live map doesn't update | WebSocket headers in the nginx `location /` block; check browser console |
| Tracker never appears online | `sudo ss -ltnp | grep 8090`, ufw rule, `journalctl` shows "login from unregistered device <serial>" until you register it |
| Maps grey / key error | Maps JS + Geocoding APIs enabled, referrer restriction matches your domain |

Access control: `ADMIN_EMAILS` can list all devices and release a serial claimed by mistake;
`ALLOWED_EMAILS` restricts who can sign in.

### Local development
```bash
npm install && cp .env.example .env && npm start     # http://127.0.0.1:8080
```

## Demo with the simulator
```bash
node scripts/simulate-tracker.js --serial 865784053274570 --host track.example.com --port 8090 --backfill 3
```
Register the serial in the app first. It sends the ignition signal (OFF then ON, OFF again on Ctrl+C), moves with no course data,
and `--backfill 3` first uploads 3 past days of trips, a long parked stop, an idling stop and a signal gap.
`--ignition toggle` flips ignition regularly (fires the push notifications), `--ignition off` stays parked.

Tuning: `MIN_STOP_MINUTES` (default 5) and `LONG_STOP_MINUTES` (default 60) in `.env`.
Only packets stamped within the last 10 minutes change the live state; buffered uploads from a tracker that was offline go into history only.

## Notes
- Other protocols: set `GPS_PROTOCOL` to TK103, TK510, GT02A, ST901 or H02. Position tracking works for all; ignition/battery parsing is GT06-specific (H02 ignition is parsed where the device reports it).
- Back up `gps.db` (SQLite, WAL mode). Use `RETENTION_DAYS` to prune old points.
- The beta code is kept in `legacy/` for reference.
- Tests: `npm test` (end-to-end with a simulated GT06 tracker).
