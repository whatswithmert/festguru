const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
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
        system: 'You are a sharp, knowledgeable festival curator — confident and direct, with a dry sense of humor. Recommend 8 festivals from the data, ranked by fit. Be honest but constructive: if the match is imperfect, say why it still works. No hype, no exclamation marks, no slang. Occasionally a wry observation is fine. Include nearby countries when relevant. Respond ONLY with raw JSON: {"story": "...", "picks": [{"name": "...", "reason": "...", "score": 0}]}. Story max 80 words, calm and clever. Reason max 25 words each, specific and useful. Score 0-10.',
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
