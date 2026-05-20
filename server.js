const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Expone variables de entorno al cliente — ANTES de express.static para no ser sobreescrito
app.get('/config.js', (req, res) => {
  const apiUrl = (process.env.KAME_API_URL || 'https://fdl-kame-api.onrender.com').replace(/'/g, "\\'");
  const apiKey = (process.env.KAME_API_KEY || '').replace(/'/g, "\\'");
  res.type('application/javascript');
  res.send(`window.KAME_API_URL = '${apiUrl}';\nwindow.KAME_API_KEY = '${apiKey}';`);
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
