const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS festivals (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    country TEXT,
    city TEXT,
    start_date TEXT,
    end_date TEXT,
    genres TEXT[],
    vibe TEXT[],
    lineup TEXT[],
    price INT,
    url TEXT,
    notes TEXT,
    photo_url TEXT
  )`);
}
initDB();

const upload = multer({ storage: multer.memoryStorage() });

function authMiddleware(req, res, next) {
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/festivals', async (req, res) => {
  const { country, genre } = req.query;
  let q = 'SELECT * FROM festivals ORDER BY start_date';
  const result = await pool.query(q);
  let rows = result.rows;
  if (country) rows = rows.filter(f => f.country === country);
  if (genre) rows = rows.filter(f => f.genres && f.genres.includes(genre));
  res.json(rows);
});

app.post('/plan', async (req, res) => {
  try {
    const { input } = req.body;
    const result = await pool.query('SELECT * FROM festivals ORDER BY start_date');
    const festivals = result.rows;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: "You are FestGuru — you have been to every festival on this list, multiple times. You know which toilet queue is shortest at Dekmantel, which stage has the best sound at Awakenings, and why Fusion's application-only system actually works. You share this knowledge humbly, like a wise friend who has seen it all but never brags. Dry wit, no hype, real talk. For the top 2-3 picks, drop a genuine insider detail — something only a repeat attendee would know. For the rest, keep reasons tight. If input is nonsense or not festival-related, gently deflect with a one-liner and return empty picks. Story max 55 words. Reason max 15 words each. Respond ONLY with raw JSON: {\"story\": \"...\", \"picks\": [{\"name\": \"...\", \"reason\": \"...\", \"score\": 0}]}. Score 0-10.",
        messages: [{ role: 'user', content: 'User wants: ' + input + '. Festivals: ' + JSON.stringify(festivals) }]
      })
    });

    const data = await response.json();
    console.log('API response:', JSON.stringify(data));
    if (!data.content || !data.content[0]) throw new Error('Bad API response: ' + JSON.stringify(data));
    const text = data.content[0].text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    res.json(JSON.parse(text));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/festivals', authMiddleware, async (req, res) => {
  const { name, country, city, start_date, end_date, genres, vibe, lineup, price, url, notes, photo_url } = req.body;
  const result = await pool.query(
    'INSERT INTO festivals (name, country, city, start_date, end_date, genres, vibe, lineup, price, url, notes, photo_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (name) DO UPDATE SET country=$2, city=$3, start_date=$4, end_date=$5, genres=$6, vibe=$7, lineup=$8, price=$9, url=$10, notes=$11, photo_url=$12 RETURNING *',
    [name, country, city, start_date, end_date, genres||[], vibe||[], lineup||[], price||0, url||'', notes||'', photo_url||'']
  );
  res.json(result.rows[0]);
});

app.delete('/admin/festivals/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM festivals WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/admin/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);
  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const name = row['Festival Name'] || row['name'];
    if (!name) continue;
    const genres = row['Genres'] ? String(row['Genres']).split(',').map(s => s.trim()) : [];
    const vibe = row['Vibe'] ? String(row['Vibe']).split(',').map(s => s.trim()) : [];
    const lineup = row['Lineup'] ? String(row['Lineup']).split(',').map(s => s.trim()) : [];
    const result = await pool.query(
      'INSERT INTO festivals (name, country, city, start_date, end_date, genres, vibe, lineup, price, url, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (name) DO UPDATE SET country=$2, city=$3, start_date=$4, end_date=$5, genres=$6, vibe=$7, lineup=$8, price=$9, url=$10, notes=$11 RETURNING *',
      [name, row['Country']||'', row['City']||'', row['Start Date']||'', row['End Date']||'', genres, vibe, lineup, row['Price (€)']||0, row['URL']||'', row['Notes']||'']
    );
    if (result.rows[0]) added++;
  }
  res.json({ added, updated });
});

app.listen(process.env.PORT || 3000, () => console.log('FestGuru running'));


app.patch('/admin/festivals/:id', authMiddleware, async (req, res) => {
  try {
    const { lineup } = req.body;
    await pool.query('UPDATE festivals SET lineup=$1 WHERE id=$2', [lineup, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Users & Favorites
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'festguru_secret_2026';

// Create tables
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    age_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    festival_id INTEGER REFERENCES festivals(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, festival_id)
  );
`).catch(e => console.log('Table creation note:', e.message));

// Auth middleware
const authUser = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, age_verified } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, age_verified) VALUES ($1, $2, $3) RETURNING id, email',
      [email.toLowerCase(), hashed, age_verified || false]
    );
    const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email }, JWT_SECRET);
    res.json({ token, user: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!result.rows[0]) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, result.rows[0].password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email }, JWT_SECRET);
    res.json({ token, user: { id: result.rows[0].id, email: result.rows[0].email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get favorites
app.get('/favorites', authUser, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT f.* FROM festivals f JOIN favorites fav ON f.id = fav.festival_id WHERE fav.user_id = $1 ORDER BY fav.created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add favorite
app.post('/favorites/:id', authUser, async (req, res) => {
  try {
    await pool.query('INSERT INTO favorites (user_id, festival_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove favorite
app.delete('/favorites/:id', authUser, async (req, res) => {
  try {
    await pool.query('DELETE FROM favorites WHERE user_id=$1 AND festival_id=$2', [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/change-password', authUser, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password too short' });
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
