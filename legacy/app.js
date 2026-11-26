const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { createServer, adapters } = require('gps-tracking');

const GPS_PORT = 8090;
const WEB_PORT = 8091;

const db = new Database(path.join(__dirname, 'gps.db'));
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imei TEXT NOT NULL,
        time TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        speed REAL,
        course REAL,
        satellites INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_positions_time
    ON positions(time);
`);

const insertPosition = db.prepare(`
    INSERT INTO positions
    (imei, time, latitude, longitude, speed, course, satellites)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getLatest = db.prepare(`
    SELECT *
    FROM positions
    ORDER BY id DESC
    LIMIT 1
`);

const getHistory = db.prepare(`
    SELECT *
    FROM positions
    WHERE time >= ?
      AND time < ?
    ORDER BY time ASC
`);

const webServer = http.createServer((req, res) => {
    if (req.url === '/') {
        const html = fs.readFileSync(
            path.join(__dirname, 'public.html'),
            'utf8'
        );

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8'
        });

        res.end(html);
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

const wss = new WebSocket.Server({
    server: webServer
});

function sendLatest(ws) {
    const latest = getLatest.get();

    if (latest && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'position',
            data: latest
        }));
    }
}

function broadcastPosition(data) {
    const message = JSON.stringify({
        type: 'position',
        data
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function getDhakaDayRange(date) {
    /*
     * Bangladesh is UTC+6 all year.
     *
     * Example:
     * 2026-09-16 in Dhaka
     *
     * starts at:
     * 2026-09-15 18:00 UTC
     *
     * ends at:
     * 2026-09-16 18:00 UTC
     */

    const start = new Date(`${date}T00:00:00+06:00`);
    const end = new Date(`${date}T00:00:00+06:00`);

    end.setUTCDate(end.getUTCDate() + 1);

    return {
        start: start.toISOString(),
        end: end.toISOString()
    };
}

wss.on('connection', (ws) => {
    console.log('Dashboard connected');

    // Immediately send latest known position
    sendLatest(ws);

    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());

            if (
                message.type === 'history' &&
                /^\d{4}-\d{2}-\d{2}$/.test(message.date)
            ) {
                const range = getDhakaDayRange(message.date);

                const rows = getHistory.all(
                    range.start,
                    range.end
                );

                ws.send(JSON.stringify({
                    type: 'history',
                    date: message.date,
                    data: rows
                }));
            }
        } catch (err) {
            console.error('WebSocket message error:', err);
        }
    });

    ws.on('close', () => {
        console.log('Dashboard disconnected');
    });
});

webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`Dashboard listening on port ${WEB_PORT}`);
});

const gpsServer = createServer({
    host: '0.0.0.0',
    port: GPS_PORT,
    adapter: adapters.GT06,
    logger: console,
});

gpsServer.on('connection', (device) => {
    console.log('Device connected');

    device.on('loginRequest', () => {
        console.log('Login request:', device.id);
        device.acceptLogin();
    });

    device.on('identified', () => {
        console.log('Identified:', device.id);
    });

    device.on('ping', (position) => {
 
        const data = {
            imei: device.id,

            time: position.time
                ? new Date(position.time).toISOString()
                : new Date().toISOString(),

            latitude: position.latitude,
            longitude: position.longitude,
            speed: position.speed,
            course: position.orientation,
            satellites: position.satellites
        };

//        console.log('GPS:', data);

        insertPosition.run(
            data.imei,
            data.time,
            data.latitude,
            data.longitude,
            data.speed,
            data.course,
            data.satellites
        );

        // Immediately send to connected dashboard(s)
        broadcastPosition(data);
    });

    device.on('disconnect', () => {
        console.log('Disconnected:', device.id);
    });

    device.on('parseError', (err) => {
        console.error('Parse error:', err);
    });
});

gpsServer.listen().then(() => {
    console.log(`GT06 server listening on 0.0.0.0:${GPS_PORT}`);
});