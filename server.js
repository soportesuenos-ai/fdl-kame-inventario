const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const KAME_API_URL = process.env.KAME_API_URL || 'https://fdl-kame-api.onrender.com';
const KAME_API_KEY = process.env.KAME_API_KEY || '';

// Proxy: /api/* → fdl-kame-api (agrega API key server-side, elimina CORS)
app.use('/api', async (req, res) => {
  try {
    const qs  = new URLSearchParams(req.query).toString();
    const url = `${KAME_API_URL}${req.path}${qs ? '?' + qs : ''}`;
    const upstream = await fetch(url, {
      method:  req.method,
      headers: { 'X-API-Key': KAME_API_KEY, 'Content-Type': 'application/json' },
    });
    const text = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (e) {
    res.status(502).json({ error: 'Proxy error', detail: e.message });
  }
});

// Config dinámica (mantener por compatibilidad)
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.KAME_API_URL = '/api';\nwindow.KAME_API_KEY = '';`);
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Todas las rutas → index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ KAME Inventario PWA corriendo en puerto ${PORT}`);
});
