const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (keyed by a simple session id)
const sessions = new Map();

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Upload CSV or Excel file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];
    let columns = [];

    if (ext === '.csv' || ext === '.tsv') {
      rows = await new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(req.file.path)
          .pipe(csv({ separator: ext === '.tsv' ? '\t' : ',' }))
          .on('data', (row) => results.push(row))
          .on('end', () => resolve(results))
          .on('error', reject);
      });
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(req.file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet);
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Please upload CSV or Excel.' });
    }

    if (rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File is empty or could not be parsed.' });
    }

    columns = Object.keys(rows[0]);

    // Detect column types
    const columnTypes = {};
    columns.forEach(col => {
      const sample = rows.slice(0, 20).map(r => r[col]).filter(v => v != null && v !== '');
      const allNumbers = sample.every(v => !isNaN(parseFloat(v)));
      const hasDate = sample.some(v => !isNaN(Date.parse(v)) && isNaN(v));
      columnTypes[col] = allNumbers ? 'number' : hasDate ? 'date' : 'text';
    });

    // Convert number columns
    rows = rows.map(row => {
      const clean = {};
      columns.forEach(col => {
        if (columnTypes[col] === 'number') {
          clean[col] = parseFloat(row[col]) || 0;
        } else {
          clean[col] = row[col] || '';
        }
      });
      return clean;
    });

    // Generate session id
    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Store data in session
    sessions.set(sessionId, {
      filename: req.file.originalname,
      columns,
      columnTypes,
      rows,
      rowCount: rows.length,
    });

    // Auto-generate summary stats
    const stats = {};
    columns.forEach(col => {
      if (columnTypes[col] === 'number') {
        const vals = rows.map(r => r[col]).filter(v => !isNaN(v));
        stats[col] = {
          min: Math.min(...vals),
          max: Math.max(...vals),
          avg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
          sum: +vals.reduce((a, b) => a + b, 0).toFixed(2),
        };
      } else if (columnTypes[col] === 'text') {
        const counts = {};
        rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        stats[col] = {
          unique: sorted.length,
          top3: sorted.slice(0, 3).map(([val, count]) => ({ val, count })),
        };
      }
    });

    // Auto-generate chart suggestions
    const charts = autoGenerateCharts(columns, columnTypes, rows);

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    res.json({
      sessionId,
      filename: req.file.originalname,
      rowCount: rows.length,
      columns,
      columnTypes,
      preview: rows.slice(0, 10),
      stats,
      charts,
    });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process file. Please try again.' });
  }
});

// AI Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'Missing sessionId or message' });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found. Please re-upload your data.' });

    // Build context about the data
    const dataContext = buildDataContext(session);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are Ryvio AI, a friendly business analytics assistant. You help business owners understand their data in simple, plain language. Never use technical jargon. Be concise and actionable.

When answering questions about data, always:
1. Give a clear, simple answer first
2. Include specific numbers
3. If relevant, suggest a chart by returning a JSON block in this format:
\`\`\`chart
{"type":"bar|line|doughnut|scatter","title":"Chart Title","labels":["A","B","C"],"datasets":[{"label":"Series","data":[1,2,3]}]}
\`\`\`

The user's data has ${session.rowCount} rows with these columns: ${session.columns.join(', ')}.
Column types: ${JSON.stringify(session.columnTypes)}

Here is a summary of the data:
${dataContext}`,
      messages: [{ role: 'user', content: message }],
    });

    const aiText = response.content[0].text;

    // Extract chart JSON if present
    let chart = null;
    const chartMatch = aiText.match(/```chart\n([\s\S]*?)\n```/);
    if (chartMatch) {
      try { chart = JSON.parse(chartMatch[1]); } catch (e) { /* ignore parse errors */ }
    }

    const cleanText = aiText.replace(/```chart\n[\s\S]*?\n```/g, '').trim();

    res.json({ answer: cleanText, chart });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI is temporarily unavailable. Please try again.' });
  }
});

// Get session data for charts
app.get('/api/data/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    columns: session.columns,
    columnTypes: session.columnTypes,
    rowCount: session.rowCount,
    preview: session.rows.slice(0, 100),
  });
});

function buildDataContext(session) {
  const { columns, columnTypes, rows } = session;
  const lines = [];

  columns.forEach(col => {
    if (columnTypes[col] === 'number') {
      const vals = rows.map(r => r[col]).filter(v => !isNaN(v));
      const sum = vals.reduce((a, b) => a + b, 0);
      const avg = sum / vals.length;
      lines.push(`- ${col} (number): min=${Math.min(...vals)}, max=${Math.max(...vals)}, avg=${avg.toFixed(2)}, sum=${sum.toFixed(2)}`);
    } else {
      const unique = new Set(rows.map(r => r[col]));
      const sample = [...unique].slice(0, 5).join(', ');
      lines.push(`- ${col} (${columnTypes[col]}): ${unique.size} unique values. Examples: ${sample}`);
    }
  });

  // Include first 5 rows as sample
  lines.push('\nSample rows (first 5):');
  rows.slice(0, 5).forEach((row, i) => {
    lines.push(`Row ${i + 1}: ${JSON.stringify(row)}`);
  });

  return lines.join('\n');
}

function autoGenerateCharts(columns, columnTypes, rows) {
  const charts = [];
  const numCols = columns.filter(c => columnTypes[c] === 'number');
  const textCols = columns.filter(c => columnTypes[c] === 'text');
  const dateCols = columns.filter(c => columnTypes[c] === 'date');

  // Bar chart: top text column by count
  if (textCols.length > 0) {
    const col = textCols[0];
    const counts = {};
    rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    charts.push({
      type: 'bar',
      title: `Top ${col}`,
      labels: sorted.map(s => s[0]),
      datasets: [{ label: 'Count', data: sorted.map(s => s[1]) }],
    });
  }

  // If there's a text column and a number column, do a grouped bar
  if (textCols.length > 0 && numCols.length > 0) {
    const cat = textCols[0];
    const val = numCols[0];
    const grouped = {};
    rows.forEach(r => {
      const key = r[cat];
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r[val]);
    });
    const entries = Object.entries(grouped)
      .map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    charts.push({
      type: 'bar',
      title: `Average ${val} by ${cat}`,
      labels: entries.map(e => e[0]),
      datasets: [{ label: `Avg ${val}`, data: entries.map(e => e[1]) }],
    });
  }

  // Doughnut for categorical distribution
  if (textCols.length > 0) {
    const col = textCols.length > 1 ? textCols[1] : textCols[0];
    const counts = {};
    rows.forEach(r => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    charts.push({
      type: 'doughnut',
      title: `${col} Distribution`,
      labels: sorted.map(s => s[0]),
      datasets: [{ label: col, data: sorted.map(s => s[1]) }],
    });
  }

  // Line chart if there's a date or sequential number column
  if (numCols.length >= 2) {
    const xCol = dateCols.length > 0 ? dateCols[0] : numCols[0];
    const yCol = numCols[dateCols.length > 0 ? 0 : 1];
    const sample = rows.slice(0, 50);
    charts.push({
      type: 'line',
      title: `${yCol} over ${xCol}`,
      labels: sample.map(r => String(r[xCol])),
      datasets: [{ label: yCol, data: sample.map(r => r[yCol]) }],
    });
  }

  return charts;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.listen(PORT, () => {
  console.log(`Ryvio AI running on port ${PORT}`);
});
