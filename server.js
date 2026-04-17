const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'videoperizie_secret_2026';

// Helper chiamate Supabase REST
async function sb(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : ''
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  return res.json();
}

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

app.get('/', (req, res) => res.send('Videoperizie server attivo ✓'));

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await sb(`operatori?email=eq.${encodeURIComponent(email)}&select=*,studi(nome,piano,attivo,limite_sessioni)`);
    const op = data[0];
    if (!op) return res.status(401).json({ errore: 'Credenziali non valide' });
    if (!op.attivo || !op.studi?.attivo) return res.status(403).json({ errore: 'Account disabilitato' });

    const ok = await bcrypt.compare(password, op.password_hash);
    if (!ok) return res.status(401).json({ errore: 'Credenziali non valide' });

    const token = jwt.sign({
      id: op.id,
      studio_id: op.studio_id,
      ruolo: op.ruolo,
      nome: op.nome,
      studio_nome: op.studi.nome,
      piano: op.studi.piano
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({ token, nome: op.nome, studio_nome: op.studi.nome, ruolo: op.ruolo, piano: op.studi.piano });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// GET PERIZIE studio
app.get('/perizie', authMiddleware, async (req, res) => {
  try {
    const data = await sb(`perizie?studio_id=eq.${req.utente.studio_id}&select=*,operatori(nome,cognome)&order=creata_il.desc`);
    const mapped = data.map(p => ({
      ...p,
      op_nome: p.operatori?.nome,
      op_cognome: p.operatori?.cognome
    }));
    res.json(mapped);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// CREA PERIZIA
app.post('/perizie', authMiddleware, async (req, res) => {
  const { nome_cliente, cognome_cliente, riferimento, telefono_cliente } = req.body;
  try {
    const token = uuidv4();
    sessioni[token] = { operatore: null, cliente: null };
    const data = await sb('perizie', 'POST', {
      studio_id: req.utente.studio_id,
      operatore_id: req.utente.id,
      nome_cliente, cognome_cliente, riferimento, telefono_cliente,
      token_sessione: token
    });
    // Incrementa sessioni_mese studio
    await fetch(`${SUPABASE_URL}/rest/v1/studi?id=eq.${req.utente.studio_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ sessioni_mese: await getSessioniMese(req.utente.studio_id) + 1 })
    });
    res.json(data[0]);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

async function getSessioniMese(studio_id) {
  const data = await sb(`studi?id=eq.${studio_id}&select=sessioni_mese`);
  return data[0]?.sessioni_mese || 0;
}

// AGGIORNA STATO PERIZIA
app.put('/perizie/:id', authMiddleware, async (req, res) => {
  const { stato } = req.body;
  try {
    const body = { stato };
    if (stato === 'completata') body.completata_il = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/perizie?id=eq.${req.params.id}&studio_id=eq.${req.utente.studio_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(body)
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// SESSIONI WebRTC
const sessioni = {};

app.post('/sessione', (req, res) => {
  const token = uuidv4();
  sessioni[token] = { operatore: null, cliente: null };
  res.json({ token });
});

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
    if (!sessioni[token]) { socket.emit('errore', 'Sessione non valida'); return; }
    sessioni[token].cliente = socket.id;
    socket.join(token);
    socket.token = token;
    socket.ruolo = 'cliente';
    socket.emit('joined', { ruolo: 'cliente', token });
    socket.to(token).emit('cliente-connesso');
  });

  socket.on('segnale', ({ token, data }) => socket.to(token).emit('segnale', { data }));
  socket.on('scatta-foto', ({ token }) => socket.to(token).emit('scatta-foto'));
  socket.on('foto', ({ token, blob }) => socket.to(token).emit('foto', { blob }));

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
