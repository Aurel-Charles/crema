import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'display.html'));
});

app.post('/send', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'Message vide' });
  }
  io.emit('message', { text });
  res.json({ ok: true });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Crema V0 — http://localhost:${PORT}`);
});
