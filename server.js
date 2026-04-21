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
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Invia email con Resend
async function inviaEmail(to, nome, link) {
  try {
    console.log(`[EMAIL] Invio a: ${to}, chiave: ${RESEND_API_KEY ? RESEND_API_KEY.slice(0,8) + '...' : 'MANCANTE'}`);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Ispecto <noreply@studiolotti.org>',
        to: [to],
        subject: 'La tua videoperizia è pronta',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
          <h2>Gentile ${nome},</h2>
          <p>È stata richiesta una videoperizia. Clicchi sul link per avviare la sessione:</p>
          <a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">📹 Avvia Videoperizia</a>
          <p style="color:#9ca3af;font-size:0.82rem;margin-top:24px;">Il link è valido per 60 minuti.</p>
        </div>`
      })
    });
    const result = await response.json();
    console.log('[EMAIL] Risposta Resend:', JSON.stringify(result));
  } catch(e) {
    console.log('[EMAIL] Errore:', e.message);
    await logErrore('errore_email', 'Invio email fallito: ' + e.message);
  }
}

// Helper chiamate Supabase REST
async function sb(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (res.status === 204) return [];
  return res.json();
}

// Middleware auth
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ errore: 'Non autorizzato' });
  try {
    req.utente = jwt.verify(token, JWT_SECRET);
    // Controlla studio attivo ad ogni richiesta
    sb(`studi?id=eq.${req.utente.studio_id}&select=attivo`)
      .then(data => {
        if (!data[0]?.attivo) return res.status(403).json({ errore: 'Account sospeso' });
        next();
      })
      .catch(() => next());
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
  const { nome_cliente, cognome_cliente, riferimento, telefono_cliente, email_cliente } = req.body;
  try {
    // Controlla limite sessioni
    const studio = await sb(`studi?id=eq.${req.utente.studio_id}&select=sessioni_mese,limite_sessioni,attivo`);
    const s = studio[0];
    if (!s.attivo) return res.status(403).json({ errore: 'Account sospeso. Contatta il supporto.' });
    if (s.sessioni_mese >= s.limite_sessioni) return res.status(403).json({ errore: 'Limite sessioni mensile raggiunto. Aggiorna il piano.' });

    const token = uuidv4();
    sessioni[token] = { operatore: null, cliente: null };
    const data = await sb('perizie', 'POST', {
      studio_id: req.utente.studio_id,
      operatore_id: req.utente.id,
      nome_cliente, cognome_cliente, riferimento, telefono_cliente,
      email_cliente: email_cliente || null,
      token_sessione: token
    });
    // Incrementa sessioni_mese studio
    await fetch(`${SUPABASE_URL}/rest/v1/studi?id=eq.${req.utente.studio_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ sessioni_mese: s.sessioni_mese + 1 })
    });
    // Invia email se disponibile
    if (email_cliente) {
      const link = `${process.env.BASE_URL || 'https://studiolotti.org'}/videoperizie/cliente.html?token=${token}`;
      await inviaEmail(email_cliente, nome_cliente, link);
    }
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

// CAMBIO PASSWORD
app.post('/auth/cambio-password', authMiddleware, async (req, res) => {
  const { password_attuale, password_nuova } = req.body;
  try {
    const data = await sb(`operatori?id=eq.${req.utente.id}&select=password_hash`);
    const op = data[0];
    if (!op) return res.status(404).json({ errore: 'Utente non trovato' });
    const ok = await bcrypt.compare(password_attuale, op.password_hash);
    if (!ok) return res.status(401).json({ errore: 'Password attuale non corretta' });
    const hash = await bcrypt.hash(password_nuova, 10);
    await fetch(`${SUPABASE_URL}/rest/v1/operatori?id=eq.${req.utente.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ password_hash: hash })
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// REINVIA EMAIL link perizia
app.post('/perizie/:id/invia-email', authMiddleware, async (req, res) => {
  try {
    const data = await sb(`perizie?id=eq.${req.params.id}&studio_id=eq.${req.utente.studio_id}&select=nome_cliente,email_cliente,token_sessione`);
    const p = data[0];
    if (!p) return res.status(404).json({ errore: 'Perizia non trovata' });
    if (!p.email_cliente) return res.status(400).json({ errore: 'Nessuna email cliente' });
    const link = `${process.env.BASE_URL || 'https://studiolotti.org'}/videoperizie/cliente.html?token=${p.token_sessione}`;
    await inviaEmail(p.email_cliente, p.nome_cliente, link);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// GET operatori del proprio studio
app.get('/studio/operatori', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.utente.ruolo)) 
      return res.status(403).json({ errore: 'Non autorizzato' });
    const data = await sb(`operatori?studio_id=eq.${req.utente.studio_id}&select=id,nome,cognome,email,ruolo,attivo,creato_il&order=creato_il.asc`);
    res.json(data);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// CREA operatore nel proprio studio
app.post('/studio/operatori', authMiddleware, async (req, res) => {
  const { nome, cognome, email, password } = req.body;
  try {
    if (!['admin', 'superadmin'].includes(req.utente.ruolo))
      return res.status(403).json({ errore: 'Non autorizzato' });
    const hash = await bcrypt.hash(password, 10);
    await sb('operatori', 'POST', {
      studio_id: req.utente.studio_id,
      nome, cognome, email,
      password_hash: hash,
      ruolo: 'operatore'
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// AGGIORNA operatore del proprio studio (attivo/disattivo)
app.put('/studio/operatori/:id', authMiddleware, async (req, res) => {
  const { attivo } = req.body;
  try {
    if (!['admin', 'superadmin'].includes(req.utente.ruolo))
      return res.status(403).json({ errore: 'Non autorizzato' });
    await fetch(`${SUPABASE_URL}/rest/v1/operatori?id=eq.${req.params.id}&studio_id=eq.${req.utente.studio_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ attivo })
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// Middleware solo admin piattaforma
function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ errore: 'Non autorizzato' });
  try {
    const utente = jwt.verify(token, JWT_SECRET);
    if (utente.ruolo !== 'superadmin') return res.status(403).json({ errore: 'Non autorizzato' });
    req.utente = utente;
    next();
  } catch(e) {
    res.status(401).json({ errore: 'Token non valido' });
  }
}

// GET tutti gli studi
app.get('/admin/studi', adminMiddleware, async (req, res) => {
  try {
    const studi = await sb('studi?select=*&order=creato_il.desc');
    // Conta operatori per ogni studio
    const studiConOperatori = await Promise.all(studi.map(async s => {
      const ops = await sb(`operatori?studio_id=eq.${s.id}&select=id,attivo`);
      return {
        ...s,
        num_operatori: ops.length,
        num_operatori_attivi: ops.filter(o => o.attivo).length
      };
    }));
    res.json(studiConOperatori);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// CREA nuovo studio + operatore admin
app.post('/admin/studi', adminMiddleware, async (req, res) => {
  const { nome_studio, email_studio, nome, cognome, email, password, piano } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const limite = piano === 'pro' ? 999999 : piano === 'studio' ? 100 : piano === 'base' ? 30 : 10;
    const studio = await sb('studi', 'POST', {
	  nome: nome_studio, email: email_studio, piano, limite_sessioni: limite
	});
	if (!studio || !studio[0] || !studio[0].id) {
	  return res.status(500).json({ errore: 'Errore creazione studio: ' + JSON.stringify(studio) });
	}
	await sb('operatori', 'POST', {
	  studio_id: studio[0].id,
      nome, cognome, email,
      password_hash: hash,
      ruolo: 'admin'
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// AGGIORNA studio (piano, attivo)
app.put('/admin/studi/:id', adminMiddleware, async (req, res) => {
  const { piano, attivo } = req.body;
  try {
    const body = {};
    if (piano !== undefined) {
      body.piano = piano;
      body.limite_sessioni = piano === 'pro' ? 999999 : piano === 'studio' ? 100 : 30;
    }
    if (attivo !== undefined) body.attivo = attivo;
    await fetch(`${SUPABASE_URL}/rest/v1/studi?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(body)
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// GET log errori
app.get('/admin/logs', adminMiddleware, async (req, res) => {
  try {
    const data = await sb('logs?select=*&order=creato_il.desc&limit=100');
    res.json(data);
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
});

// Reset sessioni mese tutti gli studi
app.post('/admin/reset-sessioni', adminMiddleware, async (req, res) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/studi?attivo=in.(true,false)`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json', 
        'apikey': SUPABASE_KEY, 
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ sessioni_mese: 0 })
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

// Verifica stato perizia dal token
app.get('/perizie/check/:token', async (req, res) => {
  try {
    const data = await sb(`perizie?token_sessione=eq.${req.params.token}&select=stato,creata_il`);
    if (!data[0]) return res.json({ valido: false, motivo: 'non_trovata' });
    const p = data[0];
    const minutiPassati = (Date.now() - new Date(p.creata_il)) / 60000;
    if (p.stato === 'completata') return res.json({ valido: false, motivo: 'completata' });
    if (minutiPassati > 60) return res.json({ valido: false, motivo: 'scaduta' });
    res.json({ valido: true, stato: p.stato });
  } catch(e) {
    res.status(500).json({ errore: e.message });
  }
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

  socket.on('termina-sessione', ({ token }) => {
    socket.to(token).emit('sessione-terminata');
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
