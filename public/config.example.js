// Plantilla de configuración del cliente. NO poner secretos aquí ni versionar config.js.
//
// En producción NO se usa este archivo: el servidor (server.js) sirve un /config.js
// dinámico que apunta al proxy interno (/api) y deja la API key vacía en el navegador.
// La API key real vive SOLO como variable de entorno KAME_API_KEY en el servidor,
// que la inyecta server-side al hacer proxy hacia fdl-kame-api.
//
// Para un override local opcional, copia este archivo a config.js (gitignored):
//   cp public/config.example.js public/config.js
window.KAME_API_URL = '/api';
window.KAME_API_KEY = '';
