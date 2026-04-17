const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sessioni attive: { token: { operatore: socketId, cliente: socketId } }
const sessioni = {};

// Crea nuova sessione (chiamata dall'operatore)
app.post('/sessione', (req, res) => {
  const token = uuidv4();
  sessioni[token] = { operatore: null, cliente: null };
  console.log(`Nuova sessione creata: ${token}`);
  res.json({ token });
});

// Health check
app.get('/', (req, res) => {
  res.send('Videoperizie signaling server attivo ✓');
});

io.on('connection', (socket) => {
  console.log(`Connesso: ${socket.id}`);

  // Operatore si unisce alla sessione
  socket.on('join-operatore', ({ token }) => {
    if (!sessioni[token]) {
      socket.emit('errore', 'Sessione non trovata');
      return;
    }
    sessioni[token].operatore = socket.id;
    socket.join(token);
    socket.token = token;
    socket.ruolo = 'operatore';
    console.log(`Operatore entrato in sessione ${token}`);
    socket.emit('joined', { ruolo: 'operatore', token });
  });

  // Cliente si unisce alla sessione tramite link
  socket.on('join-cliente', ({ token }) => {
    if (!sessioni[token]) {
      socket.emit('errore', 'Sessione non valida o scaduta');
      return;
    }
    sessioni[token].cliente = socket.id;
    socket.join(token);
    socket.token = token;
    socket.ruolo = 'cliente';
    console.log(`Cliente entrato in sessione ${token}`);
    socket.emit('joined', { ruolo: 'cliente', token });
    // Avvisa operatore che il cliente è connesso
    socket.to(token).emit('cliente-connesso');
  });

  // Scambio segnali WebRTC (offer, answer, ICE candidates)
  socket.on('segnale', ({ token, data }) => {
    socket.to(token).emit('segnale', { data });
  });

  // Operatore chiede di scattare una foto
  socket.on('scatta-foto', ({ token }) => {
    socket.to(token).emit('scatta-foto');
    console.log(`Comando scatta-foto inviato in sessione ${token}`);
  });

  // Cliente invia la foto all'operatore
  socket.on('foto', ({ token, blob }) => {
    socket.to(token).emit('foto', { blob });
    console.log(`Foto ricevuta in sessione ${token}`);
  });

  // Disconnessione
  socket.on('disconnect', () => {
    const token = socket.token;
    if (token && sessioni[token]) {
      socket.to(token).emit('peer-disconnesso', { ruolo: socket.ruolo });
      if (socket.ruolo === 'cliente') sessioni[token].cliente = null;
      if (socket.ruolo === 'operatore') sessioni[token].operatore = null;
    }
    console.log(`Disconnesso: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
