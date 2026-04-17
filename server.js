const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// DB Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
});

const JWT_SECRET = process.env.JWT_SECRET || 'videoperizie_secret_2026';

// Middleware auth
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ errore: 'Non autorizzato' });
  try {
    req.utente = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ errore: 'Token non valido' });
  }
}

// Health check
app.get('/', (req, res) => {
  res.send('Videoperizie server attivo ✓');
});

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT o.*, s.nome as studio_nome, s.piano, s.attivo as studio_attivo FROM operatori o JOIN studi s ON o.studio_id = s.id WHERE o.email = $1',
      [email]
    );
    const operatore = result.rows[0];
    if (!operatore) return res.status(401).json({ errore: 'Credenziali non valide' });
    if (!operatore.attivo || !operatore.studio_attivo) return res.status(403).json({ errore: 'Account disabilitato' });
    
    const ok = await bcrypt.compare(password, operatore.password_hash);
    if (!ok) return res.status(401).json({ errore: 'Credenziali non valide' });

    const token = jwt.sign({
      id: operatore.id,
      studio_id: operatore.studio_id,
      ruolo: operatore.ruolo,
      nome: operatore.nome,
      studio_nome: operatore.studio_nome,
      piano: operatore.piano
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({ token, nome: operatore.nome, studio_nome: operatore.studio_nome, ruolo: operatore.ruolo, piano: operatore.piano });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// REGISTRAZIONE STUDIO (solo admin piattaforma)
app.post('/auth/registra', async (req, res) => {
  const { nome_studio, nome, cognome, email, password, piano } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const studio = await pool.query(
      'INSERT INTO studi (nome, email, piano, limite_sessioni) VALUES ($1, $2, $3, $4) RETURNING id',
      [nome_studio, email, piano || 'free', piano === 'pro' ? 999999 : piano === 'studio' ? 999999 : 10]
    );
    await pool.query(
      'INSERT INTO operatori (studio_id, nome, cognome, email, password_hash, ruolo) VALUES ($1, $2, $3, $4, $5, $6)',
      [studio.rows[0].id, nome, cognome, email, hash, 'admin']
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// GET PERIZIE dello studio
app.get('/perizie', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, o.nome as op_nome, o.cognome as op_cognome 
       FROM perizie p 
       JOIN operatori o ON p.operatore_id = o.id 
       WHERE p.studio_id = $1 
       ORDER BY p.creata_il DESC`,
      [req.utente.studio_id]
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// CREA PERIZIA
app.post('/perizie', authMiddleware, async (req, res) => {
  const { nome_cliente, cognome_cliente, riferimento, telefono_cliente } = req.body;
  try {
    const token = uuidv4();
    const result = await pool.query(
      `INSERT INTO perizie (studio_id, operatore_id, nome_cliente, cognome_cliente, riferimento, telefono_cliente, token_sessione)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.utente.studio_id, req.utente.id, nome_cliente, cognome_cliente, riferimento, telefono_cliente, token]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// AGGIORNA STATO PERIZIA
app.put('/perizie/:id', authMiddleware, async (req, res) => {
  const { stato, num_foto } = req.body;
  try {
    const completata_il = stato === 'completata' ? new Date() : null;
    await pool.query(
      `UPDATE perizie SET stato = $1, num_foto = COALESCE($2, num_foto), completata_il = COALESCE($3, completata_il) WHERE id = $4 AND studio_id = $5`,
      [stato, num_foto, completata_il, req.params.id, req.utente.studio_id]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// CREA SESSIONE WebRTC (sostituisce il vecchio /sessione)
app.post('/sessione', async (req, res) => {
  const token = uuidv4();
  sessioni[token] = { operatore: null, cliente: null };
  res.json({ token });
});

// Sessioni WebRTC attive
const sessioni = {};

io.on('connection', (socket) => {
  socket.on('join-operatore', ({ token }) => {
    if (!sessioni[token]) sessioni[token] = { operatore: null, cliente: null };
    sessioni[token].operatore = socket.id;
    socket.join(token);
    socket.token = token;
    socket.ruolo = 'operatore';
    socket.emit('joined', { ruolo: 'operatore', token });
  });

  socket.on('join-cliente', ({ token }) => {
    if (!sessioni[token]) {
      socket.emit('errore', 'Sessione non valida');
      return;
    }
    sessioni[token].cliente = socket.id;
    socket.join(token);
    socket.token = token;
    socket.ruolo = 'cliente';
    socket.emit('joined', { ruolo: 'cliente', token });
    socket.to(token).emit('cliente-connesso');
  });

  socket.on('segnale', ({ token, data }) => {
    socket.to(token).emit('segnale', { data });
  });

  socket.on('scatta-foto', ({ token }) => {
    socket.to(token).emit('scatta-foto');
  });

  socket.on('foto', ({ token, blob }) => {
    socket.to(token).emit('foto', { blob });
  });

  socket.on('disconnect', () => {
    const token = socket.token;
    if (token && sessioni[token]) {
      socket.to(token).emit('peer-disconnesso', { ruolo: socket.ruolo });
      if (socket.ruolo === 'cliente') sessioni[token].cliente = null;
      if (socket.ruolo === 'operatore') sessioni[token].operatore = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
