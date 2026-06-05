const http = require('http');
const express = require('express');
const app = express();
app.get('/api/status', (req, res) => res.json({ ok: true }));
const server = http.createServer(app);
server.listen(3333, '0.0.0.0', () => console.log('test server on 3333'));
// Keep alive
setInterval(() => {}, 60000);
