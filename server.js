const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const pdf = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sessions = new Map();

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── Upload any file ──
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filePath = req.file.path;
    let result;

    if (['.csv', '.tsv'].includes(ext)) {
      result = await parseCSV(filePath, ext === '.tsv' ? '\t' : ',');
    } else if (['.xlsx', '.xls'].includes(ext)) {
      result = parseExcel(filePath);
    } else if (ext === '.pdf') {
      result = await parsePDF(filePath);
    } else if (ext === '.json') {
      result = parseJSON(filePath);
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
      result = await parseImage(filePath, ext);
    } else if (['.txt', '.log', '.md'].includes(ext)) {
      result = await parseText(filePath);
    } else {
      cleanup(filePath);
      return res.status(400).json({ error: 'Unsupported file. We accept: CSV, Excel, PDF, JSON, images, and text files.' });
    }

    cleanup(filePath);
    const sessionId = genId();
    sessions.set(sessionId, { ...result, filename: req.file.originalname });

    res.json({
      sessionId,
      filename: req.file.originalname,
      type: result.type,
      rowCount: result.rows ? result.rows.length : 0,
      columns: result.columns || [],
      columnTypes: result.columnTypes || {},
      preview: result.rows ? result.rows.slice(0, 15) : [],
      stats: result.rows ? computeStats(result) : {},
      charts: result.rows ? autoCharts(result) : [],
      rawText: result.rawText || null,
      summary: result.summary || null,
    });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file) cleanup(req.file.path);
    res.status(500).json({ error: 'Could not process file. Please try a different format.' });
  }
});

// ── Paste raw data ──
app.post('/api/paste', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Nothing to analyze' });

    // Try to parse as tabular data
    let result = tryParseTable(text);
    if (!result) {
      // Treat as raw text for AI analysis
      result = { type: 'text', rawText: text.slice(0, 50000), rows: null, columns: null, columnTypes: null };
    }

    const sessionId = genId();
    sessions.set(sessionId, { ...result, filename: 'Pasted data' });

    res.json({
      sessionId,
      filename: 'Pasted data',
      type: result.type,
      rowCount: result.rows ? result.rows.length : 0,
      columns: result.columns || [],
      columnTypes: result.columnTypes || {},
      preview: result.rows ? result.rows.slice(0, 15) : [],
      stats: result.rows ? computeStats(result) : {},
      charts: result.rows ? autoCharts(result) : [],
      rawText: result.rawText || null,
    });
  } catch (err) {
    console.error('Paste error:', err);
    res.status(500).json({ error: 'Could not process pasted data.' });
  }
});

// ── Import from URL (Google Sheets, Drive, Dropbox, any link) ──
app.post('/api/url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim()) return res.status(400).json({ error: 'No URL provided' });

    let fetchUrl = url.trim();
    let filename = 'Imported data';

    // Google Sheets → CSV export
    const sheetsMatch = fetchUrl.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch) {
      const gid = fetchUrl.match(/gid=(\d+)/);
      fetchUrl = `https://docs.google.com/spreadsheets/d/${sheetsMatch[1]}/export?format=csv${gid ? '&gid=' + gid[1] : ''}`;
      filename = 'Google Sheet';
    }

    // Google Drive file → direct download
    const driveMatch = fetchUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) {
      fetchUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      filename = 'Google Drive file';
    }

    // Google Drive open → direct download
    const driveOpen = fetchUrl.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
    if (driveOpen) {
      fetchUrl = `https://drive.google.com/uc?export=download&id=${driveOpen[1]}`;
      filename = 'Google Drive file';
    }

    // Dropbox → direct download
    if (fetchUrl.includes('dropbox.com')) {
      fetchUrl = fetchUrl.replace('dl=0', 'dl=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
      filename = 'Dropbox file';
    }

    // OneDrive → direct download
    if (fetchUrl.includes('1drv.ms') || fetchUrl.includes('onedrive.live.com')) {
      fetchUrl = fetchUrl.replace('redir', 'download');
      filename = 'OneDrive file';
    }

    // Fetch the URL
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RyvioAI/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`Could not fetch URL (status ${response.status}). Make sure the link is public/shared.`);

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    let result;

    // Try to parse as CSV/TSV first
    result = tryParseTable(body);
    if (result && result.rows && result.rows.length > 1) {
      result.summary = `Imported ${result.rows.length} rows from ${filename}`;
    } else if (contentType.includes('json')) {
      // Try JSON
      try {
        const raw = JSON.parse(body);
        const arr = Array.isArray(raw) ? raw : raw.data || raw.results || raw.items || raw.records || [raw];
        if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') {
          result = buildTabular(arr.map(r => flattenObj(r)));
          result.summary = `Imported ${result.rows.length} records from JSON`;
        }
      } catch {}
    }

    if (!result || !result.rows || result.rows.length === 0) {
      // Treat as raw text/HTML
      const cleanText = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      result = { type: 'document', rawText: cleanText.slice(0, 50000), rows: null, columns: null, columnTypes: null, summary: `Imported content from URL (${cleanText.length} characters)` };
    }

    const sessionId = genId();
    sessions.set(sessionId, { ...result, filename });

    res.json({
      sessionId,
      filename,
      type: result.type,
      rowCount: result.rows ? result.rows.length : 0,
      columns: result.columns || [],
      columnTypes: result.columnTypes || {},
      preview: result.rows ? result.rows.slice(0, 15) : [],
      stats: result.rows ? computeStats(result) : {},
      charts: result.rows ? autoCharts(result) : [],
      rawText: result.rawText || null,
      summary: result.summary || null,
    });
  } catch (err) {
    console.error('URL import error:', err);
    const msg = err.name === 'AbortError' ? 'Request timed out. Try a different URL.' : (err.message || 'Could not fetch URL.');
    res.status(500).json({ error: msg });
  }
});


app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'Missing data' });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session expired. Please re-upload your data.' });

    const ctx = session.rows ? buildTableContext(session) : `Raw text/document content:\n${(session.rawText || '').slice(0, 8000)}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are Ryvio AI, a friendly business analytics assistant. You help business owners understand their data using simple, plain language. Never use jargon. Be concise.

Rules:
1. Give a clear, simple answer first with specific numbers
2. Use bold for key numbers and findings
3. When a chart would help, include one using this exact format:
\`\`\`chart
{"type":"bar","title":"Title","labels":["A","B"],"datasets":[{"label":"Name","data":[1,2]}]}
\`\`\`
Valid types: bar, line, doughnut, scatter, polarArea

Data context:
${ctx}`,
      messages: [{ role: 'user', content: message }],
    });

    const text = response.content[0].text;
    let chart = null;
    const m = text.match(/```chart\n([\s\S]*?)\n```/);
    if (m) try { chart = JSON.parse(m[1]); } catch {}

    res.json({ answer: text.replace(/```chart\n[\s\S]*?\n```/g, '').trim(), chart });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI temporarily unavailable. Try again in a moment.' });
  }
});

// ── Parsers ──

async function parseCSV(filePath, sep) {
  const rows = await new Promise((resolve, reject) => {
    const r = [];
    fs.createReadStream(filePath).pipe(csv({ separator: sep }))
      .on('data', d => r.push(d)).on('end', () => resolve(r)).on('error', reject);
  });
  return buildTabular(rows);
}

function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  return buildTabular(rows);
}

async function parsePDF(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdf(buf);
  const text = data.text;

  // Try to find tables in the PDF text
  const result = tryParseTable(text);
  if (result && result.rows.length > 2) {
    result.rawText = text.slice(0, 20000);
    result.summary = `PDF document with ${data.numpages} pages. Found ${result.rows.length} rows of tabular data.`;
    return result;
  }

  return {
    type: 'document',
    rawText: text.slice(0, 50000),
    summary: `PDF document with ${data.numpages} pages, ${text.length} characters.`,
    rows: null, columns: null, columnTypes: null,
  };
}

function parseJSON(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.data || raw.results || raw.items || raw.records || [raw];
  if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') {
    return buildTabular(arr.map(r => flattenObj(r)));
  }
  return { type: 'document', rawText: JSON.stringify(raw, null, 2).slice(0, 50000), rows: null, columns: null, columnTypes: null };
}

async function parseImage(filePath, ext) {
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
  const base64 = fs.readFileSync(filePath).toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeMap[ext] || 'image/png', data: base64 } },
        { type: 'text', text: 'Extract ALL data from this image. If it contains a table, chart, receipt, invoice, or any structured data, output it as a CSV with headers on the first line. If it\'s a receipt or invoice, extract every line item with columns: Item, Quantity, Price, Total. If it\'s a chart, extract the underlying data points. Always output CSV format if possible. If no structured data, describe what you see in detail.' },
      ],
    }],
  });

  const text = response.content[0].text;
  const result = tryParseTable(text);
  if (result && result.rows.length > 0) {
    result.summary = 'Data extracted from image using AI vision.';
    return result;
  }

  return { type: 'document', rawText: text, summary: 'Image analyzed by AI.', rows: null, columns: null, columnTypes: null };
}

async function parseText(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const result = tryParseTable(text);
  if (result && result.rows.length > 2) return result;
  return { type: 'document', rawText: text.slice(0, 50000), rows: null, columns: null, columnTypes: null };
}

// ── Helpers ──

function buildTabular(rows) {
  if (!rows.length) return { type: 'table', rows: [], columns: [], columnTypes: {} };
  const columns = Object.keys(rows[0]);
  const columnTypes = {};
  columns.forEach(col => {
    const sample = rows.slice(0, 30).map(r => r[col]).filter(v => v != null && v !== '');
    columnTypes[col] = sample.every(v => !isNaN(parseFloat(v))) && sample.length > 0 ? 'number' : 'text';
  });
  rows = rows.map(row => {
    const c = {};
    columns.forEach(col => { c[col] = columnTypes[col] === 'number' ? (parseFloat(row[col]) || 0) : String(row[col] || ''); });
    return c;
  });
  return { type: 'table', rows, columns, columnTypes };
}

function tryParseTable(text) {
  // Try CSV-like parsing
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return null;

  // Detect delimiter
  const delimiters = [',', '\t', '|', ';'];
  let bestDel = ',', bestScore = 0;
  for (const d of delimiters) {
    const counts = lines.slice(0, 5).map(l => l.split(d).length);
    const consistent = counts.every(c => c === counts[0]) && counts[0] > 1;
    if (consistent && counts[0] > bestScore) { bestScore = counts[0]; bestDel = d; }
  }

  if (bestScore < 2) return null;

  const headers = lines[0].split(bestDel).map(h => h.replace(/^["']|["']$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(bestDel).map(v => v.replace(/^["']|["']$/g, '').trim());
    if (vals.length >= headers.length - 1) {
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] || ''; });
      rows.push(row);
    }
  }

  if (rows.length === 0) return null;
  return buildTabular(rows);
}

function flattenObj(obj, prefix = '') {
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(flat, flattenObj(v, key));
    } else {
      flat[key] = Array.isArray(v) ? v.join(', ') : v;
    }
  }
  return flat;
}

function computeStats(session) {
  const { columns, columnTypes, rows } = session;
  if (!columns || !rows) return {};
  const stats = {};
  columns.forEach(col => {
    if (columnTypes[col] === 'number') {
      const vals = rows.map(r => r[col]).filter(v => !isNaN(v));
      if (!vals.length) return;
      stats[col] = {
        min: Math.min(...vals), max: Math.max(...vals),
        avg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
        sum: +vals.reduce((a, b) => a + b, 0).toFixed(2),
      };
    } else {
      const counts = {};
      rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      stats[col] = { unique: sorted.length, top3: sorted.slice(0, 3).map(([val, count]) => ({ val, count })) };
    }
  });
  return stats;
}

function autoCharts(session) {
  const { columns, columnTypes, rows } = session;
  if (!columns || !rows || rows.length === 0) return [];
  const charts = [];
  const numCols = columns.filter(c => columnTypes[c] === 'number');
  const textCols = columns.filter(c => columnTypes[c] === 'text');

  if (textCols.length > 0) {
    const col = textCols[0];
    const counts = {};
    rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    charts.push({ type: 'bar', title: `${col} Breakdown`, labels: sorted.map(s => s[0]), datasets: [{ label: 'Count', data: sorted.map(s => s[1]) }] });
  }

  if (textCols.length > 0 && numCols.length > 0) {
    const cat = textCols[0], val = numCols[0];
    const grouped = {};
    rows.forEach(r => { if (!grouped[r[cat]]) grouped[r[cat]] = []; grouped[r[cat]].push(r[val]); });
    const entries = Object.entries(grouped).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0)).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    charts.push({ type: 'bar', title: `Total ${val} by ${cat}`, labels: entries.map(e => e[0]), datasets: [{ label: val, data: entries.map(e => e[1]) }] });
  }

  if (textCols.length > 0) {
    const col = textCols.length > 1 ? textCols[1] : textCols[0];
    const counts = {};
    rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (sorted.length > 1) charts.push({ type: 'doughnut', title: `${col} Mix`, labels: sorted.map(s => s[0]), datasets: [{ label: col, data: sorted.map(s => s[1]) }] });
  }

  if (numCols.length >= 2) {
    const sample = rows.slice(0, 40);
    charts.push({ type: 'line', title: `${numCols[1]} Trend`, labels: sample.map((_, i) => i + 1), datasets: [{ label: numCols[1], data: sample.map(r => r[numCols[1]]) }] });
  }

  return charts;
}

function buildTableContext(session) {
  const { columns, columnTypes, rows } = session;
  const lines = [`Data: ${rows.length} rows, ${columns.length} columns`];
  columns.forEach(col => {
    if (columnTypes[col] === 'number') {
      const vals = rows.map(r => r[col]).filter(v => !isNaN(v));
      const sum = vals.reduce((a, b) => a + b, 0);
      lines.push(`- ${col} (number): sum=${sum.toFixed(2)}, avg=${(sum / vals.length).toFixed(2)}, min=${Math.min(...vals)}, max=${Math.max(...vals)}`);
    } else {
      const u = new Set(rows.map(r => r[col]));
      lines.push(`- ${col} (text): ${u.size} unique. Examples: ${[...u].slice(0, 5).join(', ')}`);
    }
  });
  lines.push('\nFirst 5 rows:');
  rows.slice(0, 5).forEach((r, i) => lines.push(`${i + 1}: ${JSON.stringify(r)}`));
  return lines.join('\n');
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cleanup(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }

app.listen(PORT, () => console.log(`Ryvio AI running on port ${PORT}`));
