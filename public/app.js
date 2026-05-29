/* ══════════════════════════════════════════════════════════════════════════
   KAME INVENTARIO — App JS
   Offline-first PWA para toma de inventario
══════════════════════════════════════════════════════════════════════════ */

// Proxy server-side en /api — evita CORS y mantiene la API key segura en el servidor
const API_BASE    = window.KAME_API_URL  || '/api';
const API_KEY     = window.KAME_API_KEY  || '';

// Helper: headers con API key (no necesario con proxy, pero por compatibilidad)
function apiHeaders() {
  return API_KEY ? { 'X-API-Key': API_KEY } : {};
}


// Helper: escape HTML para evitar XSS
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// ─── USUARIOS AUTORIZADOS ─────────────────────────────────────────────────
// Agregar/quitar usuarios aquí. PIN hasheado con btoa para ejemplo simple.
// En producción usar bcrypt en backend.
const KAME_USUARIO   = 'alex@inmopatagonia.cl';   // usuario válido en KAME ERP
const RUT_FICHA      = '13.319.963-2';            // RUT requerido por KAME en movimientos
const UNIDAD_NEGOCIO = 'Planta Aserradero';        // Unidad de negocio configurada en KAME

// Calcula precio costo: recalcula factor desde descripción (evita factores incorrectos en KAME)
// Factor = E × A × L / divisor  (blandas=32, nativas=36.6)
// Precio = factor × costo/pulg según calidad (1ª=2300, 2ª=1000, 3ª=500)
function calcPrecioCosto(desc) {
  const d = (desc || '').toUpperCase();
  // Extraer dimensiones EspesorxAnchoxLargo del nombre (ej. "1X14X6.00")
  const m = d.match(/(\d+(?:[.,]\d+)?)[X×](\d+(?:[.,]\d+)?)[X×](\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  const e = parseFloat(m[1].replace(',', '.'));
  const a = parseFloat(m[2].replace(',', '.'));
  const l = parseFloat(m[3].replace(',', '.'));
  const NATIVAS = ['ROBLE', 'NATIVO', 'LAUREL', 'LINGUE', 'AROMO'];
  const divisor = NATIVAS.some(n => d.includes(n)) ? 36.6 : 32.0;
  const factor  = (e * a * l) / divisor;
  let costoPulg;
  if      (d.includes('1ª')) costoPulg = 2300;
  else if (d.includes('2ª')) costoPulg = 1000;
  else if (d.includes('3ª')) costoPulg = 500;
  else                       costoPulg = 1000; // default 2ª
  return Math.round(factor * costoPulg);
}
// Usuarios por defecto (se sobrescriben con los de IDB si existen)
const USERS_DEFAULT = {
  'admin':   { pin: '1234', nombre: 'Administrador',  rol: 'admin',  kameUser: KAME_USUARIO },
  'bodega1': { pin: '2580', nombre: 'Bodeguero 1',    rol: 'bodega', kameUser: KAME_USUARIO },
  'bodega2': { pin: '1470', nombre: 'Bodeguero 2',    rol: 'bodega', kameUser: KAME_USUARIO },
  'jefe':    { pin: '9999', nombre: 'Jefe de Patio',  rol: 'jefe',   kameUser: KAME_USUARIO },
};
let USERS = { ...USERS_DEFAULT };

// ─── STATE ────────────────────────────────────────────────────────────────
const State = {
  currentUser:   null,
  currentSession:null,
  articles:      [],
  kameStock:     {},
  bodegaList:    [],
  filters: { familia: null, tipo: null, calidad: null, condicion: null, proceso: null, stock: null },
  searchQuery:   '',
  reviewFilter:  'all',
  isOnline:      navigator.onLine,
};

// ─── DB (IndexedDB) ───────────────────────────────────────────────────────
let db;
const DB = {
  async open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('KameInventario', 5);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('sessions'))
          d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('articles'))
          d.createObjectStore('articles', { keyPath: 'sku' });
        if (!d.objectStoreNames.contains('pending'))
          d.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('history'))
          d.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('users'))
          d.createObjectStore('users', { keyPath: 'user' });
        if (!d.objectStoreNames.contains('cancha_tomas'))
          d.createObjectStore('cancha_tomas', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror = () => rej(req.error);
    });
  },
  async save(store, data) {
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(data);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(store, key) {
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async getAll(store) {
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async delete(store, key) {
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  // Bulk write — mucho más rápido que await secuencial para lotes grandes
  async saveAll(store, items) {
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const obj = tx.objectStore(store);
      for (const item of items) obj.put(item);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }
};

// ─── APP CONTROLLER ───────────────────────────────────────────────────────
const App = {

  // ── INIT ─────────────────────────────────────────────────────────────
  async init() {
    await DB.open();
    await App.loadArticles();

    // Recuperar sesión guardada
    const saved = await DB.get('sessions', 'current');
    if (saved) State.currentSession = saved;

    // Online/offline listeners
    window.addEventListener('online',  () => App.setOnline(true));
    window.addEventListener('offline', () => App.setOnline(false));
    App.setOnline(navigator.onLine);

    // Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Splash → login/home
    setTimeout(() => {
      document.getElementById('splashStatus').textContent = 'Listo';
      setTimeout(() => {
        const session = sessionStorage.getItem('kameUser');
        if (session) {
          State.currentUser = JSON.parse(session);
          App.showHome();
        } else {
          App.goTo('login');
        }
      }, 400);
    }, 3500);
  },

  // ── ARTICLES ──────────────────────────────────────────────────────────
  async loadArticles() {
    const statusEl = document.getElementById('splashStatus');
    statusEl.textContent = 'Cargando artículos...';

    const normalize = a => ({
      sku:     (a.sku || a.SKU || '').trim(),
      desc:    (a.desc || a.descripcion || a['Descripcion'] || a['Descripción'] || '').trim(),
      familia: (a.familia || a['Familia'] || '').trim(),
      factor:  parseFloat(a.factor || a.FactorUnidadEquivalente || a.factorUnidadEquivalente || 0),
    });

    // Con conexión: siempre descarga el catálogo fresco desde KAME y actualiza caché.
    // Así nuevos artículos (rollizos, trozos, etc.) siempre están disponibles.
    if (State.isOnline) {
      try {
        statusEl.textContent = 'Descargando catálogo KAME...';
        const resp = await fetch(`${API_BASE}/maestro/articulos/slim`, { headers: apiHeaders() });
        if (resp.ok) {
          const data = await resp.json();
          State.articles = (data.items || data || []).map(normalize);
          await DB.saveAll('articles', State.articles);
          statusEl.textContent = `${State.articles.length} artículos cargados`;
          return;
        }
      } catch(e) {}
    }

    // Sin conexión: usar caché IndexedDB (cualquier tamaño sirve para operar offline)
    const cached = await DB.getAll('articles');
    if (cached.length > 0) {
      State.articles = cached.map(normalize);
      statusEl.textContent = `${State.articles.length} artículos (modo offline)`;
    } else {
      statusEl.textContent = 'Sin artículos — necesitás conexión para la primera carga';
    }
  },

  // ── CARGAR USUARIOS DESDE IDB ─────────────────────────────────────────
  async loadUsers() {
    // Intento 1: bajar del servidor (fuente de verdad)
    try {
      const resp = await fetch(API_BASE + '/usuarios', { headers: apiHeaders() });
      if (resp.ok) {
        const data = await resp.json();
        if (data.items && data.items.length > 0) {
          USERS = {};
          data.items.forEach(u => { if (u.user) USERS[u.user] = u; });
          if (!USERS['admin']) USERS['admin'] = USERS_DEFAULT['admin'];
          // Actualizar IDB con los datos del servidor
          await Promise.all(data.items.map(u => DB.save('users', u)));
          return;
        }
      }
    } catch(e) { /* continuar con IDB */ }
    // Intento 2: IDB local
    try {
      const saved = await DB.getAll('users');
      if (saved.length > 0) {
        USERS = {};
        saved.forEach(u => { USERS[u.user] = u; });
        if (!USERS['admin']) USERS['admin'] = USERS_DEFAULT['admin'];
      }
    } catch(e) { /* usar defaults */ }
  },

  async _syncUsersToServer() {
    try {
      const items = Object.values(USERS).filter(u => u.user !== 'admin');
      await fetch(API_BASE + '/usuarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ items }),
      });
    } catch(e) { /* silencioso, no crítico */ }
  },

  // ── AUTH ──────────────────────────────────────────────────────────────
  async login() {
    const user = document.getElementById('loginUser').value.trim().toLowerCase();
    const pin  = document.getElementById('loginPin').value.trim();
    const err  = document.getElementById('loginError');
    await App.loadUsers();
    if (!USERS[user] || USERS[user].pin !== pin) {
      err.textContent = 'Usuario o PIN incorrecto';
      document.getElementById('loginPin').value = '';
      return;
    }
    // Guardar usuario sin el PIN
    const { pin: _pin, ...userInfo } = USERS[user];
    State.currentUser = { user, ...userInfo };
    sessionStorage.setItem('kameUser', JSON.stringify(State.currentUser));
    err.textContent = '';
    App.showHome();
  },

  logout() {
    if (!confirm('¿Cerrar sesión?')) return;
    sessionStorage.removeItem('kameUser');
    State.currentUser = null;
    App.goTo('login');
  },

  // ── NAVIGATION ────────────────────────────────────────────────────────
  goTo(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screen)?.classList.add('active');

    if (screen === 'home')        App.refreshHomeState();
    if (screen === 'count')       App.renderArticleList();
    if (screen === 'review')      App.renderReview();
    if (screen === 'sync')        App.renderSync();
    if (screen === 'consolidado') App.initConsolidado();

    // Botón flotante home: visible en pantallas de trabajo, oculto en home/login/splash
    const noHome = ['home', 'login', 'splash', 'newSession'];
    const fab = document.getElementById('btnFloatHome');
    if (fab) fab.style.display = noHome.includes(screen) ? 'none' : 'flex';
  },

  showHome() {
    document.getElementById('topUser').textContent =
      State.currentUser?.nombre?.split(' ')[0] || '—';
    // Card de consolidación solo visible para admin
    const isAdmin = State.currentUser?.rol === 'admin';
    const btnC = document.getElementById('btnConsolidar');
    if (btnC) btnC.style.display = isAdmin ? 'flex' : 'none';
    App.refreshHomeState();
    App.goTo('home');
  },

  refreshHomeState() {
    const sess    = State.currentSession;
    const isAdmin = State.currentUser?.rol === 'admin';
    const card    = document.getElementById('activeSessionCard');
    const btnR    = document.getElementById('btnReview');
    const btnS    = document.getElementById('btnSync');

    if (sess) {
      const count = Object.keys(sess.items || {}).length;
      card.style.display = 'flex';
      document.getElementById('activeSessionName').textContent = sess.bodega;
      document.getElementById('activeSessionStats').textContent =
        `${count} artículo${count !== 1 ? 's' : ''} contado${count !== 1 ? 's' : ''}`;
      btnR.disabled = count === 0;
      // Ocultar "Subir a KAME" completamente para no-admin
      if (btnS) {
        btnS.style.display = isAdmin ? 'flex' : 'none';
        btnS.disabled = count === 0;
      }
    } else {
      card.style.display = 'none';
      btnR.disabled = true;
      if (btnS) { btnS.style.display = isAdmin ? 'flex' : 'none'; btnS.disabled = true; }
    }

    // Pendientes offline
    DB.getAll('pending').then(p => {
      const banner = document.getElementById('pendingBanner');
      if (p.length > 0) {
        banner.style.display = 'block';
        document.getElementById('pendingCount').textContent = p.length;
      } else {
        banner.style.display = 'none';
      }
    });

    // ── Botón Cancha de Trozos (solo si la sesión es de esa bodega)
    const esCancha = sess && sess.bodega === 'CANCHA DE TROZOS';
    let btnCancha = document.getElementById('btnCanchaTrozos');
    if (esCancha) {
      if (!btnCancha) {
        btnCancha = document.createElement('button');
        btnCancha.id = 'btnCanchaTrozos';
        btnCancha.className = 'action-card';
        btnCancha.innerHTML = '<span style="font-size:24px">🪵</span><span>Cubicación Cancha de Trozos</span>';
        btnCancha.onclick = () => App.showCanchaTrozos();
        const homeActions = document.querySelector('.home-actions');
        homeActions.insertBefore(btnCancha, homeActions.firstChild);
      }
      btnCancha.style.display = 'flex';
    } else if (btnCancha) {
      btnCancha.style.display = 'none';
    }

    // ── Botón actualizar stock (siempre visible si hay sesión activa)
    let btnActStock = document.getElementById('btnActualizarStock');
    if (!btnActStock) {
      btnActStock = document.createElement('button');
      btnActStock.id = 'btnActualizarStock';
      btnActStock.className = 'action-card';
      btnActStock.innerHTML = '<span style="font-size:24px">🔄</span><span>Actualizar stock KAME</span>';
      btnActStock.onclick = () => App.actualizarStock();
      // Insertar antes de "Nueva toma"
      const homeActions = document.querySelector('.home-actions');
      homeActions.insertBefore(btnActStock, homeActions.firstChild);
    }

    // ── Botón "Enviar sesión al servidor" para no-admin (reemplaza btnGoSync oculto)
    let btnEnviarHome = document.getElementById('btnEnviarSesionHome');
    if (!isAdmin) {
      if (!btnEnviarHome) {
        btnEnviarHome = document.createElement('button');
        btnEnviarHome.id = 'btnEnviarSesionHome';
        btnEnviarHome.className = 'action-card';
        btnEnviarHome.innerHTML = '<span style="font-size:24px">📤</span><span>Enviar sesión al servidor</span>';
        btnEnviarHome.onclick = () => App.submitSesion();
        const homeActions = document.querySelector('.home-actions');
        homeActions.appendChild(btnEnviarHome);
      }
      btnEnviarHome.style.display = sess ? 'flex' : 'none';
      if (btnEnviarHome) btnEnviarHome.disabled = !sess || Object.keys(sess.items || {}).length === 0;
    } else if (btnEnviarHome) {
      btnEnviarHome.style.display = 'none';
    }

    // ── Botones solo para admin
    const adminContainer = document.getElementById('btnConsolidar').parentNode;

    let histBtn = document.getElementById('btnHistorial');
    if (isAdmin) {
      if (!histBtn) {
        histBtn = document.createElement('button');
        histBtn.id = 'btnHistorial';
        histBtn.className = 'action-card';
        histBtn.innerHTML = '<span style="font-size:24px">📋</span><span>Historial de inventarios</span>';
        histBtn.onclick = () => App.showHistory();
        adminContainer.appendChild(histBtn);
      }
      histBtn.style.display = 'flex';
    } else if (histBtn) {
      histBtn.style.display = 'none';
    }

    // ── Gestión de usuarios (solo admin)
    let btnUsers = document.getElementById('btnGestionUsuarios');
    if (isAdmin) {
      if (!btnUsers) {
        btnUsers = document.createElement('button');
        btnUsers.id = 'btnGestionUsuarios';
        btnUsers.className = 'action-card';
        btnUsers.innerHTML = '<span style="font-size:24px">👥</span><span>Gestionar usuarios</span>';
        btnUsers.onclick = () => App.showUserManager();
        adminContainer.appendChild(btnUsers);
      }
      btnUsers.style.display = 'flex';
    } else if (btnUsers) {
      btnUsers.style.display = 'none';
    }
  },

  // ── ACTUALIZAR STOCK KAME ─────────────────────────────────────────────
  async actualizarStock() {
    const sess = State.currentSession;
    if (!sess) { App.toast('Iniciá una sesión primero'); return; }
    const btn = document.getElementById('btnActualizarStock');
    if (btn) btn.innerHTML = '<span style="font-size:24px">⏳</span><span>Cargando stock...</span>';
    try {
      const bodega = encodeURIComponent(sess.bodega);
      const resp   = await fetch(`${API_BASE}/inventario/stock/bodega/${bodega}`, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      State.kameStock  = {};
      State.bodegaList = [];
      (data.items || data || []).forEach(it => {
        const sku = it.SKU || it.sku || it.Sku || it.articulo || it.Articulo;
        const qty = parseFloat(it.StockActual ?? it.stockActual ?? it.stock ?? it.cantidad ?? it.saldo ?? 0);
        if (sku && qty > 0) { State.kameStock[sku] = qty; State.bodegaList.push(sku); }
      });
      await DB.save('articles', { sku: `stock_${sess.bodega}`, stock: State.kameStock, list: State.bodegaList });
      App.toast(`✓ Stock actualizado: ${State.bodegaList.length} artículos`);
    } catch(e) {
      App.toast('Sin conexión — usando stock guardado');
    }
    if (btn) btn.innerHTML = '<span style="font-size:24px">🔄</span><span>Actualizar stock KAME</span>';
  },

  // ── GESTIÓN DE USUARIOS ───────────────────────────────────────────────
  async showUserManager() {
    await App.loadUsers();
    let modal = document.getElementById('userModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'userModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:flex-end;';
    document.body.appendChild(modal);

    const renderModal = () => {
      const rows = Object.entries(USERS).map(([u, d]) => `
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:8px 6px;font-family:monospace;font-weight:600">${u}</td>
          <td style="padding:8px 6px">${d.nombre}</td>
          <td style="padding:8px 6px"><span style="background:${d.rol==='admin'?'#1a3a5c':d.rol==='jefe'?'#e67e22':'#27ae60'};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px">${d.rol}</span></td>
          <td style="padding:8px 6px;font-family:monospace">${'●'.repeat(d.pin.length)}</td>
          <td style="padding:8px 6px;text-align:center">
            ${u !== 'admin' ? `<button onclick="App._editUser('${u}')" style="background:none;border:1px solid #2980b9;color:#2980b9;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;margin-right:4px">✏️</button>
            <button onclick="App._deleteUser('${u}')" style="background:none;border:1px solid #e74c3c;color:#e74c3c;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px">🗑</button>` : '<span style="color:#aaa;font-size:12px">protegido</span>'}
          </td>
        </tr>`).join('');

      modal.innerHTML = `
        <div style="background:#fff;width:100%;max-height:90vh;border-radius:16px 16px 0 0;overflow:auto">
          <div style="padding:16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff">
            <b style="font-size:16px">👥 Gestión de Usuarios</b>
            <button onclick="document.getElementById('userModal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer">✕</button>
          </div>
          <div style="padding:12px 16px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="color:#888;font-size:11px;border-bottom:2px solid #eee">
                <th style="text-align:left;padding:6px">Usuario</th>
                <th style="text-align:left;padding:6px">Nombre</th>
                <th style="text-align:left;padding:6px">Rol</th>
                <th style="text-align:left;padding:6px">PIN</th>
                <th style="padding:6px">Acciones</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div style="padding:16px;border-top:1px solid #eee">
            <p style="font-size:12px;color:#888;margin-bottom:10px">Nuevo usuario</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
              <input id="nuUser"   placeholder="usuario (sin espacios)" style="border:1px solid #ddd;border-radius:8px;padding:8px;font-size:13px">
              <input id="nuNombre" placeholder="Nombre completo"        style="border:1px solid #ddd;border-radius:8px;padding:8px;font-size:13px">
              <input id="nuPin"    placeholder="PIN (números)"  type="password" style="border:1px solid #ddd;border-radius:8px;padding:8px;font-size:13px">
              <select id="nuRol" style="border:1px solid #ddd;border-radius:8px;padding:8px;font-size:13px">
                <option value="bodega">bodega</option>
                <option value="jefe">jefe</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <button onclick="App._saveNewUser()" style="width:100%;background:#1a3a5c;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer;font-weight:600">+ Agregar usuario</button>
          </div>
        </div>`;
    };

    renderModal();

    App._renderUserModal = renderModal;
  },

  async _saveNewUser() {
    const user   = document.getElementById('nuUser').value.trim().toLowerCase().replace(/\s/g,'');
    const nombre = document.getElementById('nuNombre').value.trim();
    const pin    = document.getElementById('nuPin').value.trim();
    const rol    = document.getElementById('nuRol').value;
    if (!user || !nombre || !pin) { App.toast('Completá todos los campos'); return; }
    if (!/^\d{4,8}$/.test(pin))   { App.toast('PIN debe ser 4-8 dígitos'); return; }
    if (USERS[user])               { App.toast('Usuario ya existe'); return; }
    const data = { user, nombre, pin, rol, kameUser: KAME_USUARIO };
    await DB.save('users', data);
    USERS[user] = data;
    await App._syncUsersToServer();
    App.toast(`Usuario ${user} creado ✓`);
    App._renderUserModal && App._renderUserModal();
  },

  async _editUser(user) {
    const d = USERS[user];
    if (!d) return;
    const nuPin    = prompt(`Nuevo PIN para ${user} (dejar vacío para no cambiar):`);
    const nuNombre = prompt(`Nuevo nombre (actual: ${d.nombre}):`);
    if (nuPin && !/^\d{4,8}$/.test(nuPin)) { App.toast('PIN debe ser 4-8 dígitos'); return; }
    const updated = {
      ...d,
      pin:    nuPin    || d.pin,
      nombre: nuNombre || d.nombre,
    };
    await DB.save('users', updated);
    USERS[user] = updated;
    await App._syncUsersToServer();
    App.toast(`Usuario ${user} actualizado ✓`);
    App._renderUserModal && App._renderUserModal();
  },

  async _deleteUser(user) {
    if (!confirm(`¿Eliminar usuario "${user}"?`)) return;
    await DB.delete('users', user);
    delete USERS[user];
    await App._syncUsersToServer();
    App.toast(`Usuario ${user} eliminado`);
    App._renderUserModal && App._renderUserModal();
  },

  // ── SESSION ───────────────────────────────────────────────────────────
  startSession() {
    if (State.currentSession) {
      if (!confirm('Ya hay una sesión activa. ¿Descartarla e iniciar nueva?')) return;
    }
    // Setear fecha de hoy por defecto
    document.getElementById('sessionDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('sessionResp').value = State.currentUser?.nombre || '';
    App.goTo('newSession');
  },

  async createSession() {
    const bodega = document.getElementById('selectBodega').value;
    const fecha  = document.getElementById('sessionDate').value;
    const resp   = document.getElementById('sessionResp').value.trim();
    if (!bodega) { App.toast('Selecciona una bodega'); return; }
    if (!fecha)  { App.toast('Selecciona una fecha');  return; }
    if (!resp)   { App.toast('Ingresa el responsable'); return; }

    State.currentSession = {
      id: 'current',
      bodega,
      fecha,
      resp,
      calle: (document.getElementById('sessionCalle')?.value || '').trim(),
      obs: document.getElementById('sessionObs').value.trim(),
      items: {},
      // SKUs extra agregados manualmente (no estaban en stock bodega)
      extraSkus: [],
      createdAt: Date.now(),
    };
    // kameStock = artículos con stock en bodega (lista principal)
    State.kameStock     = {};
    // bodegaList = SKUs ordenados según stock bodega KAME
    State.bodegaList    = [];

    await DB.save('sessions', State.currentSession);
    App.goTo('count');

    // Cargar stock de la bodega desde KAME
    if (State.isOnline) {
      await App.loadKameStock();
    } else {
      // Offline: cargar desde IDB si hay datos previos
      const cached = await DB.get('articles', `stock_${bodega}`);
      if (cached) {
        State.kameStock  = cached.stock;
        State.bodegaList = cached.list;
        App.toast(`📦 Stock offline: ${State.bodegaList.length} artículos`);
        App.renderArticleList();
      } else {
        App.toast('Sin conexión — sin stock precargado. Busca manualmente.');
        App.renderArticleList();
      }
    }
  },

  // ── STOCK KAME ────────────────────────────────────────────────────────
  async loadKameStock() {
    if (!State.currentSession) return;
    const btn = document.getElementById('btnLoadKame');
    if (btn) btn.textContent = '⟳ Cargando...';

    try {
      const bodega = encodeURIComponent(State.currentSession.bodega);
      const resp   = await fetch(`${API_BASE}/inventario/stock/bodega/${bodega}`, { headers: apiHeaders() });
      if (resp.ok) {
        const data  = await resp.json();
        const items = data.items || data || [];

        State.kameStock  = {};
        State.bodegaList = [];

        for (const item of items) {
          const sku = item.sku || item.SKU || item.articulo || item.Articulo;
          const qty = parseFloat(item.stock ?? item.cantidad ?? item.saldo ?? 0);
          if (sku && qty > 0) {
            State.kameStock[sku]  = qty;
            State.bodegaList.push(sku);
          }
        }

        // Cachear en IDB para uso offline futuro
        await DB.save('articles', {
          sku:   `stock_${State.currentSession.bodega}`,
          stock: State.kameStock,
          list:  State.bodegaList,
          ts:    Date.now(),
        });

        App.toast(`📦 ${State.bodegaList.length} artículos con stock en ${State.currentSession.bodega}`);
      }
    } catch(e) {
      App.toast('No se pudo cargar stock de bodega');
    }

    if (btn) btn.textContent = '↻ KAME';
    App.renderArticleList();
  },

  // ── ARTICLE LIST ──────────────────────────────────────────────────────
  renderArticleList() {
    const sess = State.currentSession;
    const list = document.getElementById('articleList');

    document.getElementById('countBodega').textContent = sess?.bodega || '—';
    const counted = Object.keys(sess?.items || {}).length;
    document.getElementById('countProgress').textContent = `${counted} contado${counted !== 1 ? 's' : ''}`;
    document.getElementById('fabNumber').textContent = counted;

    const q          = (State.searchQuery || '').toUpperCase();
    const hasFilters = Object.values(State.filters).some(v => v !== null);
    const textSearch = q.length >= 2;
    const isSearching = textSearch || hasFilters;

    let arts;
    if (isSearching) {
      // Búsqueda o filtros: catálogo completo
      arts = App._applyFilters([...State.articles]);
    } else {
      // Sin búsqueda: mostrar TODOS los artículos del maestro.
      // Los que tienen stock en KAME para esta bodega van primero (son los esperados).
      // Los demás igual aparecen para poder contar lo que hay físicamente aunque KAME no lo registre.
      const bodegaSet = new Set(State.bodegaList);
      const extraSet  = new Set(sess?.extraSkus || []);
      const conStock  = State.articles.filter(a => bodegaSet.has(a.sku) || extraSet.has(a.sku));
      const sinStock  = State.articles.filter(a => !bodegaSet.has(a.sku) && !extraSet.has(a.sku));
      arts = [...conStock, ...sinStock];
    }

    if (arts.length === 0) {
      list.innerHTML = `<div class="empty-state"><span style="font-size:40px">🔍</span><p>Sin resultados${isSearching ? ' — cambiá los filtros' : ''}</p></div>`;
      return;
    }

    const pending = arts.filter(a => sess?.items?.[a.sku] === undefined);
    const done    = arts.filter(a => sess?.items?.[a.sku] !== undefined);

    let html = '';
    if (isSearching) {
      html += `<div class="search-mode-banner">${q.length >= 2 ? '🔍 Búsqueda' : '🔽 Filtros'} — ${arts.length} resultado${arts.length !== 1 ? 's' : ''}</div>`;
    }
    if (pending.length > 0) {
      const label = !isSearching && State.bodegaList.length > 0
        ? `Con stock KAME (${Math.min(pending.length, State.bodegaList.length)}) + sin stock (${Math.max(0, pending.length - State.bodegaList.length)}) — total ${pending.length}`
        : `Por contar (${pending.length})`;
      html += `<div class="list-section-label">${label}</div>`;
      html += pending.slice(0, 150).map(art => App._renderArticleItem(art, sess)).join('');
      if (pending.length > 150)
        html += `<div class="empty-state"><p>Mostrando 150 de ${pending.length} — usá búsqueda o filtros para acotar</p></div>`;
    }
    if (done.length > 0) {
      html += `<div class="list-section-label done-label">Contados (${done.length})</div>`;
      html += done.map(art => App._renderArticleItem(art, sess)).join('');
    }
    list.innerHTML = html;
  },

  _searchTimer: null,
  search(q) {
    State.searchQuery = q;
    clearTimeout(App._searchTimer);
    App._searchTimer = setTimeout(() => App.renderArticleList(), 200);
  },

  _renderArticleItem(art, sess) {
    const item    = sess?.items?.[art.sku];
    const counted = item !== undefined;
    const kame    = State.kameStock[art.sku];
    const isExtra = (sess?.extraSkus || []).includes(art.sku);
    return `
      <div class="article-item ${counted ? 'counted' : ''}" onclick="App.openModal('${esc(art.sku)}')">
        <div class="art-info">
          <div class="art-desc">${esc(art.desc)}</div>
          <div class="art-sku">
            ${esc(art.sku)}
            ${isExtra ? '<span class="extra-badge">+ agregado</span>' : ''}
          </div>
          ${kame !== undefined
            ? `<div class="art-kame-stock">KAME: ${kame}</div>`
            : '<div class="art-kame-stock no-stock">Sin stock registrado</div>'}
        </div>
        <div class="art-qty-badge ${counted && item.qty === 0 ? 'qty-zero' : ''}">${counted ? (item.qty === 0 ? '∅' : item.qty) : ''}</div>
        <div class="art-add-btn">+</div>
      </div>`;
  },

  _applyFilters(arts) {
    const f = State.filters;
    const q = (State.searchQuery || '').toUpperCase();
    if (q.length >= 2) arts = arts.filter(a => (a.desc||'').toUpperCase().includes(q) || (a.sku||'').toUpperCase().includes(q));
    // familia filtra por texto en descripción para capturar artículos sin familia asignada en KAME
    // (ej: "OREGON" trae maderas oregon Y rollizos industriales cc oregon)
    if (f.familia)   arts = arts.filter(a => (a.desc||'').toUpperCase().includes(f.familia) || (a.familia||'').toUpperCase().includes(f.familia));
    if (f.tipo)      arts = arts.filter(a => (a.desc||'').toUpperCase().startsWith(f.tipo));
    if (f.calidad)   arts = arts.filter(a => (a.desc||'').includes(f.calidad));
    if (f.condicion) arts = arts.filter(a => (a.desc||'').toUpperCase().includes(f.condicion));
    if (f.proceso)   arts = arts.filter(a => (a.desc||'').toUpperCase().includes(f.proceso));
    if (f.stock === 'con')  arts = arts.filter(a => (State.kameStock[a.sku] || 0) > 0);
    if (f.stock === 'sin')  arts = arts.filter(a => !(State.kameStock[a.sku] > 0));
    return arts;
  },

  toggleFilters() {
    const panel = document.getElementById('filterPanel');
    const btn   = document.getElementById('btnFilterToggle');
    const open  = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = open ? 'flex' : 'none';
    btn.textContent = (open ? '🔼 Filtros ' : '🔽 Filtros ') + (document.getElementById('filterActiveCount')?.textContent || '');
  },

  setFilter(type, value, btn) {
    State.filters[type] = value;
    const rowId = { familia: 'filterFamilia', tipo: 'filterTipo', calidad: 'filterCalidad', condicion: 'filterCondicion', proceso: 'filterProceso', stock: 'filterStock' }[type];
    document.querySelectorAll(`#${rowId} .chip`).forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const activeCount = Object.values(State.filters).filter(v => v !== null).length;
    const countEl = document.getElementById('filterActiveCount');
    if (countEl) countEl.textContent = activeCount > 0 ? `(${activeCount})` : '';
    document.getElementById('btnClearFilters').style.display = activeCount > 0 ? 'block' : 'none';
    App.renderArticleList();
  },

  clearFilters() {
    State.filters = { familia: null, tipo: null, calidad: null, condicion: null, proceso: null, stock: null };
    ['filterFamilia','filterTipo','filterCalidad','filterCondicion','filterProceso','filterStock'].forEach(id => {
      const chips = document.querySelectorAll(`#${id} .chip`);
      chips.forEach(c => c.classList.remove('active'));
      if (chips[0]) chips[0].classList.add('active');
    });
    const countEl = document.getElementById('filterActiveCount');
    if (countEl) countEl.textContent = '';
    document.getElementById('btnClearFilters').style.display = 'none';
    App.renderArticleList();
  },

  // Agregar artículo extra (no estaba en stock bodega)
  async addExtraArticle(sku) {
    if (!State.currentSession.extraSkus) State.currentSession.extraSkus = [];
    if (!State.currentSession.extraSkus.includes(sku)) {
      State.currentSession.extraSkus.push(sku);
      await DB.save('sessions', State.currentSession);
    }
    // Limpiar búsqueda y abrir modal
    document.getElementById('searchInput').value = '';
    State.searchQuery = '';
    App.renderArticleList();
    App.openModal(sku);
  },

  // ── MODAL CONTEO ──────────────────────────────────────────────────────
  _modalSku: null,

  openModal(sku) {
    const art = State.articles.find(a => a.sku === sku);
    if (!art) return;

    // Si viene de búsqueda y no es de bodega ni extra → preguntar si agregar
    const enBodega = State.bodegaList.includes(sku);
    const esExtra  = (State.currentSession?.extraSkus || []).includes(sku);
    if (State.bodegaList.length > 0 && !enBodega && !esExtra && State.searchQuery.length >= 2) {
      App.addExtraArticle(sku);
      return;
    }

    App._modalSku = sku;

    document.getElementById('modalSku').textContent  = sku;
    document.getElementById('modalDesc').textContent = art.desc;
    document.getElementById('modalFamilia').textContent = art.familia;

    const kame = State.kameStock[sku];
    document.getElementById('modalKameStock').textContent =
      kame !== undefined ? kame : '—';

    const existing = State.currentSession?.items?.[sku];
    const input = document.getElementById('cantidadInput');
    input.value = existing !== undefined ? existing.qty : '';
    document.getElementById('modalObs').value = existing?.obs || '';
    App.updateModalDiff();

    document.getElementById('modalOverlay').classList.add('open');
    setTimeout(() => input.focus(), 300);
  },

  closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
    App._modalSku = null;
  },

  adjustQty(delta) {
    const input = document.getElementById('cantidadInput');
    const val   = parseFloat(input.value) || 0;
    input.value = Math.max(0, val + delta);
    App.updateModalDiff();
  },

  updateModalDiff() {
    const sku   = App._modalSku;
    const input = document.getElementById('cantidadInput');
    const div   = document.getElementById('modalDiff');
    const val   = parseFloat(input.value);
    const kame  = State.kameStock[sku];

    if (isNaN(val) || kame === undefined) { div.textContent = ''; return; }
    const diff = val - kame;
    if (diff === 0) {
      div.className = 'modal-diff zero';
      div.textContent = '✓ Coincide con KAME';
    } else if (diff > 0) {
      div.className = 'modal-diff pos';
      div.textContent = `▲ Sobrante: +${diff}`;
    } else {
      div.className = 'modal-diff neg';
      div.textContent = `▼ Faltante: ${diff}`;
    }
  },

  async saveCount() {
    const sku = App._modalSku;
    const val = parseFloat(document.getElementById('cantidadInput').value);
    if (isNaN(val) || val < 0) { App.toast('Ingresa una cantidad válida'); return; }

    if (!State.currentSession.items) State.currentSession.items = {};
    State.currentSession.items[sku] = {
      qty: val,
      obs: document.getElementById('modalObs').value.trim(),
      ts:  Date.now(),
    };

    await DB.save('sessions', State.currentSession);
    App.closeModal();
    App.renderArticleList();
    App.toast('Conteo guardado ✓');
  },

  // ── REVIEW ────────────────────────────────────────────────────────────
  renderReview() {
    const sess  = State.currentSession;
    const items = Object.entries(sess?.items || {});
    const list  = document.getElementById('reviewList');

    let ok = 0, diff = 0;
    const rows = items.map(([sku, item]) => {
      const art   = State.articles.find(a => a.sku === sku);
      const kame  = State.kameStock[sku];
      const delta = kame !== undefined ? item.qty - kame : null;
      if (delta === 0) ok++; else if (delta !== null) diff++;
      return { sku, item, art, kame, delta };
    });

    document.getElementById('statContados').textContent = items.length;
    document.getElementById('statOk').textContent = ok;
    document.getElementById('statDiff').textContent = diff;

    // Ocultar "Subir a KAME" en pantalla de revisión si no es admin
    const btnGoSync = document.getElementById('btnGoSync');
    if (btnGoSync) btnGoSync.style.display = State.currentUser?.rol === 'admin' ? '' : 'none';

    const filter = State.reviewFilter;
    const visible = rows.filter(r => {
      if (filter === 'diff') return r.delta !== 0 && r.delta !== null;
      if (filter === 'ok')   return r.delta === 0;
      return true;
    });

    if (visible.length === 0) {
      list.innerHTML = `<div class="empty-state"><span style="font-size:40px">✓</span><p>Sin ítems para mostrar</p></div>`;
      return;
    }

    list.innerHTML = visible.map(({ sku, item, art, kame, delta }) => {
      let badgeClass = 'diff-badge zero', badgeText = '—';
      if (delta !== null) {
        if (delta > 0)      { badgeClass = 'diff-badge positive'; badgeText = `+${delta}`; }
        else if (delta < 0) { badgeClass = 'diff-badge';          badgeText = `${delta}`; }
        else                { badgeClass = 'diff-badge zero';     badgeText = '='; }
      }
      return `
        <div class="review-item ${delta !== 0 && delta !== null ? 'diff' : 'ok-item'}">
          <div class="review-item-header">
            <div>
              <div class="review-desc">${esc(art?.desc || sku)}</div>
              <div class="review-sku">${esc(sku)}</div>
            </div>
            <span class="${badgeClass}">${badgeText}</span>
          </div>
          <div class="review-numbers">
            <div class="rev-num"><span>Contado</span><strong>${item.qty}</strong></div>
            <div class="rev-num"><span>KAME</span><strong style="color:var(--info)">${kame !== undefined ? kame : '—'}</strong></div>
            <div class="rev-num"><span>Diferencia</span><strong style="color:${delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--warn)' : 'var(--text2)'}">${delta !== null ? delta : '—'}</strong></div>
          </div>
          ${item.obs ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">📝 ${esc(item.obs)}</div>` : ''}
        </div>`;
    }).join('');
  },

  filterReview(f, btn) {
    State.reviewFilter = f;
    document.querySelectorAll('#review .chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    App.renderReview();
  },

  // ── SYNC ──────────────────────────────────────────────────────────────
  renderSync() {
    const sess  = State.currentSession;
    const items = Object.entries(sess?.items || {});
    const diffs = items.filter(([sku, item]) => {
      const kame = State.kameStock[sku];
      return kame === undefined || item.qty !== kame;
    });

    document.getElementById('syncDiffCount').textContent = diffs.length;
    document.getElementById('syncBodega').textContent    = sess?.bodega || '—';
    document.getElementById('syncFecha').textContent     = sess?.fecha || '—';

    const warn = document.getElementById('offlineWarning');
    warn.style.display = State.isOnline ? 'none' : 'block';
  },

  async doSync() {
    if (State.currentUser?.rol !== 'admin') {
      App.toast('Solo el administrador puede enviar movimientos a KAME');
      return;
    }
    const sess = State.currentSession;
    if (!sess) return;

    const log = document.getElementById('syncLog');
    log.className = 'sync-log visible';
    log.innerHTML = '';

    const addLog = (msg, err = false) => {
      const d = document.createElement('div');
      d.className = 'log-line' + (err ? ' log-err' : '');
      d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };

    document.getElementById('syncIcon').textContent  = '⏳';
    document.getElementById('syncMsg').textContent   = 'Sincronizando...';
    document.getElementById('syncDetail').textContent = '';
    document.getElementById('btnDoSync').disabled = true;

    if (!State.isOnline) {
      App.saveLocal();
      return;
    }

    const items = Object.entries(sess.items || {});
    let ok = 0, errors = 0;
    // Acumula resultado por SKU para el historial (incluye folio)
    const histItems = [];
    addLog(`Iniciando sincronización: ${items.length} artículos`);

    for (const [sku, item] of items) {
      const kame = State.kameStock[sku];
      if (kame === undefined || item.qty === kame) {
        histItems.push({ sku, qty: item.qty, kame: kame ?? null, diff: 0, tipo: '—', folio: '' });
        ok++; continue;
      }

      const diff = item.qty - kame;
      const tipo  = diff > 0 ? 'ENTRADA' : 'SALIDA';
      const motivo = diff > 0 ? 'Entrada por producción' : 'Merma';

      try {
        const art     = State.articles.find(a => a.sku === sku);
        const precio  = calcPrecioCosto(art?.desc || '');
        const cant    = Math.abs(diff);
        const itemDet = {
          sku, cantidad: cant, unidadNegocio: UNIDAD_NEGOCIO,
          ...(tipo === 'ENTRADA' ? { precioUnitario: precio, totalLinea: Math.round(cant * precio) } : {}),
        };
        const body = {
          usuario:          State.currentUser?.kameUser || KAME_USUARIO,
          tipoDocumento:    tipo,
          fecha:            sess.fecha,
          motivoMovimiento: motivo,
          rutFicha:         RUT_FICHA,
          bodegaEntrada:    diff > 0 ? sess.bodega : '',
          bodegaSalida:     diff < 0 ? sess.bodega : '',
          comentario:       `Toma de inventario ${sess.fecha} - ${sess.resp}`,
          items:            [itemDet],
        };

        const resp = await fetch(`${API_BASE}/inventario/movimiento`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify(body)
        });

        if (resp.ok) {
          const rj    = await resp.json().catch(() => ({}));
          const folio = rj?.Folio ?? rj?.folio ?? rj?.folio_movimiento ?? '';
          addLog(`✓ ${sku}: ${tipo} ${Math.abs(diff)} unidades${folio ? ' — Folio ' + folio : ''}`);
          histItems.push({ sku, qty: item.qty, kame, diff, tipo, folio: String(folio) });
          ok++;
        } else {
          const errTxt = await resp.text().catch(() => resp.status);
          addLog(`✗ ${sku}: Error ${resp.status} — ${errTxt}`, true);
          histItems.push({ sku, qty: item.qty, kame, diff, tipo, folio: '', error: resp.status });
          errors++;
        }
      } catch(e) {
        addLog(`✗ ${sku}: Sin conexión`, true);
        histItems.push({ sku, qty: item.qty, kame: kame ?? null, diff, tipo, folio: '', error: 'timeout' });
        errors++;
      }
    }

    addLog(`Finalizado: ${ok} OK, ${errors} errores`);

    if (errors === 0) {
      document.getElementById('syncIcon').textContent  = '✅';
      document.getElementById('syncMsg').textContent   = '¡Sincronizado!';
      document.getElementById('syncDetail').textContent = `${ok} movimientos registrados en KAME`;
      App.toast('Inventario subido a KAME ✓');
      // Guardar historial con folios reales por SKU
      await DB.save('history', {
        ts:          Date.now(),
        fechaStr:    new Date().toLocaleString('es-CL'),
        tipo:        'sesion',
        user:        State.currentUser?.nombre || '',
        bodega:      sess.bodega || '',
        fechaConteo: sess.fecha  || '',
        resp:        sess.resp   || '',
        totalOk:     ok,
        totalItems:  Object.keys(sess.items || {}).length,
        items:       histItems,
      });
      // Limpiar sesión
      await DB.delete('sessions', 'current');
      State.currentSession = null;
      State.kameStock = {};
      setTimeout(() => App.showHome(), 2000);
    } else {
      document.getElementById('syncIcon').textContent  = '⚠️';
      document.getElementById('syncMsg').textContent   = `${errors} errores`;
      document.getElementById('syncDetail').textContent = 'Revisa el log y reintenta';
      document.getElementById('btnDoSync').disabled = false;
      document.getElementById('btnDoSync').textContent = 'Reintentar';
    }
  },

  async saveLocal() {
    const pending = {
      session: { ...State.currentSession },
      savedAt: Date.now(),
      user: State.currentUser?.user,
    };
    await DB.save('pending', pending);
    App.toast('Guardado localmente. Se subirá cuando haya señal.');
    await DB.delete('sessions', 'current');
    State.currentSession = null;
    App.showHome();
  },

  // ── SUBMIT SESIÓN AL SERVIDOR ────────────────────────────────────────
  async submitSesion() {
    const sess = State.currentSession;
    if (!sess) { App.toast('No hay sesión activa'); return; }
    if (!State.isOnline) { App.toast('Sin conexión'); return; }
    const nItems = Object.keys(sess.items || {}).length;
    if (nItems === 0) { App.toast('La sesión no tiene conteos'); return; }

    const sesionId = [
      State.currentUser?.user || 'usr',
      sess.bodega,
      sess.fecha,
    ].join('_').replace(/\s+/g, '_');

    const items = {};
    for (const [sku, d] of Object.entries(sess.items || {})) {
      items[sku] = { qty: d.qty, obs: d.obs || null };
    }

    const btn = document.getElementById('btnSendServer');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }

    try {
      const body = {
        sesion_id: sesionId,
        usuario:   State.currentUser?.nombre || State.currentUser?.user || 'sistema',
        bodega:    sess.bodega,
        calle:     sess.calle || null,
        fecha:     sess.fecha,
        items,
      };
      console.log('[submitSesion] body a enviar:', JSON.stringify(body));
      const resp = await fetch(`${API_BASE}/inventario/sesiones`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body:    JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
        App.toast(`✓ Sesión enviada al servidor (${data.items_recibidos} ítems)`);
        if (btn) { btn.textContent = '✓ Enviado'; }
      } else {
        const err = await resp.json().catch(() => ({}));
        const detail = typeof err.detail === 'string'
          ? err.detail
          : JSON.stringify(err.detail || err).slice(0, 200);
        console.error('submitSesion error', resp.status, err);
        App.toast(`Error ${resp.status}: ${detail}`, 5000);
        if (btn) { btn.disabled = false; btn.textContent = '📤 Enviar sesión al servidor'; }
      }
    } catch(e) {
      App.toast('Sin conexión al enviar sesión');
      if (btn) { btn.disabled = false; btn.textContent = '📤 Enviar sesión al servidor'; }
    }
  },

  // ── CONSOLIDADO (ADMIN) ───────────────────────────────────────────────
  _consoData:     [],
  _consoFilter:   'all',
  _consoKameStock:{},

  initConsolidado() {
    document.getElementById('consoStats').style.display    = 'none';
    document.getElementById('consoFilterBar').style.display= 'none';
    document.getElementById('consoActions').style.display  = 'none';
    document.getElementById('consoList').innerHTML = '';
    App._consoData      = [];
    App._consoKameStock = {};
  },

  async cargarConsolidado() {
    const bodega = document.getElementById('consoBodega').value;
    if (!bodega) { App.toast('Selecciona una bodega'); return; }
    if (!State.isOnline) { App.toast('Sin conexión'); return; }

    App.toast('Cargando sesiones...');
    try {
      // 1. Consolidado de sesiones en servidor
      const r1 = await fetch(
        `${API_BASE}/inventario/sesiones/consolidado?bodega=${encodeURIComponent(bodega)}`,
        { headers: apiHeaders() }
      );
      if (!r1.ok) {
        const err = await r1.json().catch(() => ({}));
        App.toast(err.detail || 'Sin sesiones para esta bodega');
        return;
      }
      const conso = await r1.json();

      // 2. Stock KAME de la bodega para comparar diferencias
      let kameStock = {};
      try {
        const r2 = await fetch(
          `${API_BASE}/inventario/stock/bodega/${encodeURIComponent(bodega)}`,
          { headers: apiHeaders() }
        );
        if (r2.ok) {
          const sd = await r2.json();
          for (const item of (sd.items || sd || [])) {
            const sku = item.sku || item.SKU || item.articulo || item.Articulo;
            const qty = parseFloat(item.stock ?? item.cantidad ?? item.saldo ?? 0);
            if (sku) kameStock[sku] = qty;
          }
        }
      } catch(e) {}

      App._consoData      = conso.items || [];
      App._consoKameStock = kameStock;
      App._consoFilter    = 'all';
      App._consoStockTs   = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
      const tsEl = document.getElementById('consoStockTs');
      if (tsEl) tsEl.textContent = App._consoStockTs;

      // Stats
      const diffs = App._consoData.filter(i => {
        const kame = kameStock[i.sku] ?? null;
        return kame === null || i.qty_contada !== kame;
      }).length;

      document.getElementById('consoNumSesiones').textContent = conso.sesiones_base || 0;
      document.getElementById('consoNumSkus').textContent     = App._consoData.length;
      document.getElementById('consoNumDiffs').textContent    = diffs;
      document.getElementById('consoStats').style.display     = 'grid';
      document.getElementById('consoFilterBar').style.display = 'flex';
      document.getElementById('consoActions').style.display   = 'block';

      // Reset chips
      document.querySelectorAll('#consoFilterBar .chip').forEach((c, i) => {
        c.classList.toggle('active', i === 0);
      });

      App.renderConsolidado();
    } catch(e) {
      App.toast('Error al cargar sesiones');
    }
  },

  renderConsolidado() {
    const list  = document.getElementById('consoList');
    const f     = App._consoFilter;

    let items = App._consoData.map(i => {
      const kame  = i.sku in App._consoKameStock ? App._consoKameStock[i.sku] : null;
      const delta = kame !== null ? i.qty_contada - kame : null;
      const art   = State.articles.find(a => a.sku === i.sku);
      return { ...i, kame, delta, desc: art?.desc || i.sku };
    });

    if (f === 'diff') items = items.filter(i => i.delta !== 0 && i.delta !== null);
    if (f === 'ok')   items = items.filter(i => i.delta === 0);

    if (items.length === 0) {
      list.innerHTML = `<div class="empty-state"><p>Sin ítems para mostrar</p></div>`;
      return;
    }

    list.innerHTML = items.map(i => {
      let badgeClass = 'diff-badge zero', badgeText = '—';
      if (i.delta !== null) {
        if (i.delta > 0)      { badgeClass = 'diff-badge positive'; badgeText = `+${i.delta}`; }
        else if (i.delta < 0) { badgeClass = 'diff-badge';          badgeText = String(i.delta); }
        else                  { badgeClass = 'diff-badge zero';     badgeText = '='; }
      }
      const calleTag = i.calles?.length
        ? `<span style="font-size:11px;color:var(--text2)"> · ${i.calles.join(', ')}</span>` : '';
      return `
        <div class="review-item ${i.delta !== 0 && i.delta !== null ? 'diff' : 'ok-item'}">
          <div class="review-item-header">
            <div>
              <div class="review-desc">${esc(i.desc)}</div>
              <div class="review-sku">${esc(i.sku)}${calleTag}</div>
            </div>
            <span class="${badgeClass}">${badgeText}</span>
          </div>
          <div class="review-numbers">
            <div class="rev-num"><span>Contado</span><strong>${i.qty_contada}</strong></div>
            <div class="rev-num"><span>KAME</span><strong style="color:var(--info)">${i.kame !== null ? i.kame : '—'}</strong></div>
            <div class="rev-num"><span>Diferencia</span><strong style="color:${i.delta > 0 ? 'var(--ok)' : i.delta < 0 ? 'var(--warn)' : 'var(--text2)'}">${i.delta !== null ? i.delta : '—'}</strong></div>
          </div>
          ${i.obs ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">📝 ${esc(i.obs)}</div>` : ''}
        </div>`;
    }).join('');
  },

  filterConsolidado(f, btn) {
    App._consoFilter = f;
    document.querySelectorAll('#consoFilterBar .chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    App.renderConsolidado();
  },

  async generarMovimientos() {
    if (State.currentUser?.rol !== 'admin') {
      App.toast('Solo el administrador puede generar movimientos en KAME');
      return;
    }
    const bodega = document.getElementById('consoBodega').value;
    if (!bodega) { App.toast('Selecciona una bodega'); return; }

    const diffs = App._consoData.filter(i => {
      const kame  = i.sku in App._consoKameStock ? App._consoKameStock[i.sku] : null;
      const delta = kame !== null ? i.qty_contada - kame : null;
      return delta !== null && delta !== 0;
    });

    if (diffs.length === 0) { App.toast('Sin diferencias para procesar'); return; }
    if (!confirm(`¿Generar ${diffs.length} movimiento(s) en KAME para ${bodega}?`)) return;

    const primaryBtn = document.querySelector('#consoActions .btn-primary');
    if (primaryBtn) { primaryBtn.disabled = true; primaryBtn.textContent = `⏳ 0/${diffs.length}...`; }

    const fecha = new Date().toISOString().slice(0, 10);
    let ok = 0, errors = 0;
    const folioMap = {};  // sku → folio

    for (const item of diffs) {
      const kame  = App._consoKameStock[item.sku] ?? 0;
      const delta = item.qty_contada - kame;
      const tipo  = delta > 0 ? 'ENTRADA' : 'SALIDA';
      try {
        const art     = State.articles.find(a => a.sku === item.sku);
        const precio  = calcPrecioCosto(art?.desc || '');
        const cant    = Math.abs(delta);
        const itemDet = {
          sku: item.sku, cantidad: cant, unidadNegocio: UNIDAD_NEGOCIO,
          ...(tipo === 'ENTRADA' ? { precioUnitario: precio, totalLinea: Math.round(cant * precio) } : {}),
        };
        const body = {
          usuario:          State.currentUser?.kameUser || KAME_USUARIO,
          tipoDocumento:    tipo,
          fecha,
          motivoMovimiento: tipo === 'ENTRADA' ? 'Entrada por producción' : 'Merma',
          rutFicha:         RUT_FICHA,
          bodegaEntrada:    delta > 0 ? bodega : '',
          bodegaSalida:     delta < 0 ? bodega : '',
          comentario:       `Consolidado multi-usuario ${fecha}`,
          items:            [itemDet],
        };
        const r = await fetch(`${API_BASE}/inventario/movimiento`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body:    JSON.stringify(body),
        });
        if (r.ok) {
          const rj = await r.json().catch(() => ({}));
          folioMap[item.sku] = String(rj?.Folio ?? rj?.folio ?? '');
          ok++;
        } else errors++;
      } catch(e) { errors++; }
      if (primaryBtn) primaryBtn.textContent = `⏳ ${ok + errors}/${diffs.length}...`;
    }

    // Guardar historial del consolidado
    await DB.save('history', {
      ts:          Date.now(),
      fechaStr:    new Date().toLocaleString('es-CL'),
      tipo:        'consolidado',
      user:        State.currentUser?.nombre || '',
      bodega,
      fechaConteo: fecha,
      resp:        State.currentUser?.nombre || '',
      totalOk:     ok,
      totalErrors: errors,
      totalItems:  diffs.length,
      items:       diffs.map(i => ({
        sku:   i.sku,
        qty:   i.qty_contada,
        kame:  App._consoKameStock[i.sku] ?? null,
        diff:  i.qty_contada - (App._consoKameStock[i.sku] ?? 0),
        tipo:  (i.qty_contada - (App._consoKameStock[i.sku] ?? 0)) > 0 ? 'ENTRADA' : 'SALIDA',
        folio: folioMap[i.sku] ?? '',
      })),
    });

    if (primaryBtn) {
      primaryBtn.disabled = false;
      primaryBtn.textContent = errors === 0
        ? `✓ ${ok} movimientos generados`
        : `⚠️ ${ok} OK, ${errors} errores`;
    }
    App.toast(errors === 0
      ? `✓ ${ok} movimientos registrados en KAME`
      : `${errors} errores — reintenta los fallidos`);
  },

  async clearSesiones() {
    const bodega = document.getElementById('consoBodega').value;
    if (!bodega) { App.toast('Selecciona una bodega'); return; }
    if (!confirm(`¿Eliminar todas las sesiones del servidor para ${bodega}?`)) return;
    try {
      const r = await fetch(
        `${API_BASE}/inventario/sesiones?bodega=${encodeURIComponent(bodega)}`,
        { method: 'DELETE', headers: apiHeaders() }
      );
      if (r.ok) {
        App.toast('Sesiones eliminadas del servidor ✓');
        App.initConsolidado();
      } else {
        App.toast('Error al eliminar sesiones');
      }
    } catch(e) { App.toast('Sin conexión'); }
  },

  async refrescarStockConsolidado() {
    const bodega = document.getElementById('consoBodega').value;
    if (!bodega) { App.toast('Selecciona una bodega primero'); return; }
    if (!State.isOnline) { App.toast('Sin conexión'); return; }
    App.toast('Actualizando stock KAME...');
    try {
      const r = await fetch(
        `${API_BASE}/inventario/stock/bodega/${encodeURIComponent(bodega)}`,
        { headers: apiHeaders() }
      );
      if (!r.ok) { App.toast('Error al obtener stock'); return; }
      const sd = await r.json();
      const kameStock = {};
      for (const item of (sd.items || sd || [])) {
        const sku = item.sku || item.SKU || item.articulo || item.Articulo;
        const qty = parseFloat(item.stock ?? item.cantidad ?? item.saldo ?? 0);
        if (sku) kameStock[sku] = qty;
      }
      App._consoKameStock = kameStock;
      App._consoStockTs   = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
      const tsEl = document.getElementById('consoStockTs');
      if (tsEl) tsEl.textContent = App._consoStockTs;
      const diffs = App._consoData.filter(i => {
        const kame = kameStock[i.sku] ?? null;
        return kame === null || i.qty_contada !== kame;
      }).length;
      const diffsEl = document.getElementById('consoNumDiffs');
      if (diffsEl) diffsEl.textContent = diffs;
      App.renderConsolidado();
      App.toast(`✓ Stock actualizado a las ${App._consoStockTs}`);
    } catch(e) { App.toast('Error al refrescar stock'); }
  },

  // ── ONLINE STATUS ─────────────────────────────────────────────────────
  setOnline(online) {
    State.isOnline = online;
    const dot   = document.getElementById('connDot');
    const badge = document.getElementById('offlineBadge');
    if (dot)   dot.classList.toggle('offline', !online);
    if (badge) badge.classList.toggle('visible', !online);
    if (online) App.trySyncPending();
  },

  async trySyncPending() {
    const pendingList = await DB.getAll('pending');
    if (pendingList.length === 0) return;
    App.toast(`🔄 Sincronizando ${pendingList.length} sesión(es) pendiente(s)...`);
    let totalOk = 0, totalErrors = 0;
    for (const pendingEntry of pendingList) {
      const sess = pendingEntry.session;
      if (!sess || !sess.items) continue;
      let kameStock = {};
      try {
        const bodega = encodeURIComponent(sess.bodega);
        const r = await fetch(`${API_BASE}/inventario/stock/bodega/${bodega}`, { headers: apiHeaders() });
        if (r.ok) {
          const data  = await r.json();
          for (const item of (data.items || data || [])) {
            const sku = item.sku || item.SKU || item.articulo || item.Articulo;
            const qty = parseFloat(item.stock ?? item.cantidad ?? item.saldo ?? 0);
            if (sku && qty > 0) kameStock[sku] = qty;
          }
        }
      } catch(e) { App.toast('Sin conexión para sincronizar pendientes'); return; }

      const entries = Object.entries(sess.items || {});
      let sessionOk = 0, sessionErrors = 0;
      for (const [sku, data] of entries) {
        const conteo = parseFloat(data.qty ?? data.conteo ?? 0);
        const stock  = parseFloat(kameStock[sku] ?? 0);
        const diff   = conteo - stock;
        if (diff === 0) { sessionOk++; continue; }
        const tipo = diff > 0 ? 'ENTRADA' : 'SALIDA';
        const body = {
          usuario:          pendingEntry.user || KAME_USUARIO,
          tipoDocumento:    tipo,
          fecha:            sess.fecha || new Date().toISOString().slice(0, 10),
          motivoMovimiento: tipo === 'ENTRADA' ? 'Entrada por producción' : 'Merma',
          rutFicha:         RUT_FICHA,
          bodegaEntrada:    diff > 0 ? sess.bodega : '',
          bodegaSalida:     diff < 0 ? sess.bodega : '',
          comentario:       `Sync pendiente - ${sess.fecha || ''} - ${sess.resp || ''}`,
          items:            [{ sku, cantidad: Math.abs(diff), unidadNegocio: UNIDAD_NEGOCIO }],
        };
        try {
          const r = await fetch(`${API_BASE}/inventario/movimiento`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...apiHeaders() },
            body: JSON.stringify(body),
          });
          if (r.ok) sessionOk++; else sessionErrors++;
        } catch(e) { sessionErrors++; }
      }
      totalOk += sessionOk; totalErrors += sessionErrors;
      if (sessionErrors === 0) await DB.delete('pending', pendingEntry.id);
    }
    App.toast(`Sincronización: ${totalOk} OK, ${totalErrors} errores`);
  },

  qrNotReady() {
    App.toast('Escáner QR próximamente — buscá el artículo por nombre o SKU');
  },

  // ── HISTORIAL ─────────────────────────────────────────────────────────
  async showHistory() {
    const records = await DB.getAll('history');
    records.sort((a, b) => b.ts - a.ts);
    let modal = document.getElementById('historyModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'historyModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:flex-end;';
    document.body.appendChild(modal);

    const rows = records.length === 0
      ? '<p style="padding:16px;color:#888;text-align:center">Sin historial aun</p>'
      : records.map(rec => {
          const badge = rec.tipo === 'consolidado'
            ? '<span style="background:#7c3aed;color:#fff;border-radius:4px;padding:2px 7px;font-size:11px">CONSOLIDADO</span>'
            : '<span style="background:#2563eb;color:#fff;border-radius:4px;padding:2px 7px;font-size:11px">SESION</span>';
          const conDiff = (rec.items || []).filter(i => i.folio || (i.diff && i.diff !== 0));
          const folioRows = conDiff.length > 0
            ? '<table style="width:100%;font-size:11px;margin-top:6px;border-collapse:collapse">' +
              '<tr style="color:#888;border-bottom:1px solid #eee">' +
              '<th style="text-align:left;padding:2px 4px">SKU</th>' +
              '<th style="text-align:right;padding:2px 4px">KAME</th>' +
              '<th style="text-align:right;padding:2px 4px">Contado</th>' +
              '<th style="text-align:right;padding:2px 4px">Dif.</th>' +
              '<th style="text-align:left;padding:2px 4px">Tipo</th>' +
              '<th style="text-align:left;padding:2px 4px">Folio</th></tr>' +
              conDiff.map(i =>
                '<tr style="border-bottom:1px solid #f5f5f5">' +
                '<td style="padding:2px 4px;font-family:monospace">' + i.sku + '</td>' +
                '<td style="text-align:right;padding:2px 4px">' + (i.kame != null ? i.kame : '-') + '</td>' +
                '<td style="text-align:right;padding:2px 4px">' + (i.qty != null ? i.qty : (i.qty_contada != null ? i.qty_contada : '-')) + '</td>' +
                '<td style="text-align:right;padding:2px 4px;color:' + (i.diff > 0 ? '#27ae60' : i.diff < 0 ? '#e74c3c' : '#888') + '">' + (i.diff > 0 ? '+' + i.diff : (i.diff || '-')) + '</td>' +
                '<td style="padding:2px 4px">' + (i.tipo || '-') + '</td>' +
                '<td style="padding:2px 4px;font-weight:' + (i.folio ? '600' : 'normal') + ';color:' + (i.folio ? '#2980b9' : '#aaa') + '">' + (i.folio || (i.error ? 'Error' : '=')) + '</td>' +
                '</tr>'
              ).join('') +
              '</table>'
            : '';
          const respLine = rec.resp && rec.resp !== rec.user
            ? ' | subido por: ' + rec.resp : '';
          return '<div style="padding:12px 16px;border-bottom:1px solid #eee">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            badge +
            '<span style="font-size:12px;color:#888">' + rec.fechaStr + '</span></div>' +
            '<div style="font-weight:600;margin-bottom:2px">' + (rec.bodega || '') + ' - ' + (rec.fechaConteo || '') + '</div>' +
            '<div style="font-size:13px;color:#888">' + (rec.user || '') + respLine +
            ' | ' + (rec.totalOk || 0) + ' OK' + (rec.totalErrors ? ' / ' + rec.totalErrors + ' errores' : '') +
            ' / ' + (rec.totalItems || 0) + ' items</div>' +
            folioRows + '</div>';
        }).join('');

    modal.innerHTML =
      '<div style="background:#fff;width:100%;max-height:80vh;overflow-y:auto;border-radius:16px 16px 0 0">' +
      '<div style="padding:16px;font-weight:700;font-size:18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between">' +
      '<span>Historial de tomas</span>' +
      '<button onclick="document.getElementById(\'historyModal\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666">&times;</button>' +
      '</div>' + rows + '</div>';
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  },


  // ══════════════════════════════════════════════════════════════════════
  // ── MÓDULO CANCHA DE TROZOS ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════

  _ct: {
    especie: null,
    largo: null,
    rumas: [],
    m3_kame_ref: 0,
    kame_grupos: {},
  },

  async _ctNextNumero() {
    const all = await DB.getAll('cancha_tomas');
    const n = all.length + 1;
    return 'CT-' + String(n).padStart(3, '0');
  },

  _ctCalcRuma(alturas, largo_ruma, largo_trozo) {
    if (!alturas.length || !largo_ruma || !largo_trozo) return { mr: 0, m3: 0 };
    const avg = alturas.reduce(function(a, b) { return a + b; }, 0) / alturas.length;
    const mr  = (avg * largo_ruma * largo_trozo) / 2.44;
    const m3  = mr * 1.56;
    return { mr: mr, m3: m3 };
  },

  async ctCargarStock() {
    const reR = /CC\s+(\w+)\s+([\d.]+)\s*MTS.*?(\d+)\s*CM/i;
    const reM = /METRO\s+RUMA/i;

    // Intento 1: API directo (campos reales: articulo=desc, saldo=qty, SKU=sku)
    try {
      const bodega = encodeURIComponent('CANCHA DE TROZOS');
      const resp   = await fetch(API_BASE + '/inventario/stock/bodega/' + bodega, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(resp.status);
      const data  = await resp.json();
      const items = (data.items || data || []);
      const grupos = {};
      items.forEach(function(it) {
        const sku  = it.SKU || it.sku || '';
        if (!sku.startsWith('TRO')) return;
        const qty  = parseFloat(it.saldo || it.saldoPresente || it.StockActual || it.stockActual || 0);
        if (qty <= 0) return;
        // descripción está en campo 'articulo'
        const desc = it.articulo || it.Articulo || it.Descripcion || it.descripcion || '';
        if (reM.test(desc)) {
          const mL = desc.match(/([\d.]+)\s*MTS/i);
          if (mL) { const k = 'METRO_RUMA|'+parseFloat(mL[1]); grupos[k]=(grupos[k]||0)+qty*1.5; }
          return;
        }
        const m = reR.exec(desc);
        if (!m) return;
        const diam_m = parseInt(m[3]) / 100;
        const factor = diam_m * diam_m * parseFloat(m[2]);
        const key = m[1].toUpperCase() + '|' + parseFloat(m[2]);
        grupos[key] = (grupos[key] || 0) + qty * factor;
      });
      if (Object.keys(grupos).length > 0) {
        this._ct.kame_grupos = grupos;
        await DB.save('articles', { sku: '__ct_grupos__', grupos: grupos, ts: Date.now() });
        return grupos;
      }
    } catch(e) {}

    // Intento 2: caché IDB
    try {
      const cached = await DB.get('articles', '__ct_grupos__');
      if (cached && Object.keys(cached.grupos || {}).length > 0) {
        this._ct.kame_grupos = cached.grupos;
        return cached.grupos;
      }
    } catch(_) {}

    return {};
  },

  async showCanchaTrozos() {
    App.goTo('cancha_trozos');
    const grupos = Object.keys(this._ct.kame_grupos).length
      ? this._ct.kame_grupos
      : await this.ctCargarStock();

    const especies = {}, largosMap = {};
    Object.keys(grupos).forEach(function(k) {
      const parts = k.split('|');
      especies[parts[0]] = true;
      largosMap[parts[1]] = true;
    });
    const espList = Object.keys(especies).sort();
    const lgList  = Object.keys(largosMap).map(Number).sort(function(a,b){ return a-b; });

    const el = document.getElementById('cancha_trozos');
    if (!el) return;

    el.innerHTML =
      '<div style="padding:16px;max-width:480px;margin:0 auto">' +
      '<div style="font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">&#x1FA75; Cancha de Trozos</div>' +

      '<div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
      '<p style="font-size:12px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">1. Selecciona Especie y Largo</p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<select id="ctEspecie" style="border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px">' +
      '<option value="">-- Especie --</option>' +
      espList.map(function(e) { return '<option value="' + e + '">' + e + '</option>'; }).join('') +
      '</select>' +
      '<select id="ctLargo" style="border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px">' +
      '<option value="">-- Largo (m) --</option>' +
      lgList.map(function(l) { return '<option value="' + l + '">' + l + ' m</option>'; }).join('') +
      '</select>' +
      '</div>' +
      '<div id="ctRef" style="margin-top:10px;padding:10px;background:#f0f7ff;border-radius:8px;font-size:13px;display:none"></div>' +
      '</div>' +

      '<div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
      '<p style="font-size:12px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">2. Medir Rumas</p>' +
      '<div id="ctRumasList" style="margin-bottom:10px"></div>' +
      '<button onclick="App.ctAgregarRuma()" style="width:100%;background:#1a3a5c;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer;font-weight:600">+ Agregar Ruma</button>' +
      '</div>' +

      '<div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="font-size:13px;color:#666">Total m&#xB3; s&#xF3;lido medido:</span>' +
      '<strong id="ctTotalM3">0.000</strong>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between">' +
      '<span style="font-size:13px;color:#666">M3 equiv. KAME (&times;1.2732):</span>' +
      '<strong id="ctTotalKame">0.000</strong>' +
      '</div>' +
      '</div>' +

      '<button id="btnCtTermine" onclick="App.ctTermine()" disabled ' +
      'style="width:100%;background:#27ae60;color:#fff;border:none;border-radius:12px;padding:14px;font-size:15px;cursor:pointer;font-weight:700;margin-bottom:8px">' +
      '&#x2705; Termin&#xe9; de medir</button>' +

      '<button onclick="App.ctVerHistorial()" ' +
      'style="width:100%;background:#ecf0f1;color:#555;border:none;border-radius:12px;padding:12px;font-size:14px;cursor:pointer;font-weight:600;margin-bottom:8px">' +
      '&#x1F4CB; Historial de tomas CT</button>' +

      '<button onclick="App.goTo(\'home\')" ' +
      'style="width:100%;background:none;color:#888;border:none;font-size:13px;cursor:pointer;padding:8px">' +
      '&#x2190; Volver</button>' +
      '</div>';

    var self = this;
    var onSelect = function() {
      var esp = document.getElementById('ctEspecie').value;
      var lg  = document.getElementById('ctLargo').value;
      var ref = document.getElementById('ctRef');
      if (esp && lg) {
        var key    = esp + '|' + lg;
        var m3kame = grupos[key] || 0;
        self._ct.especie      = esp;
        self._ct.largo        = parseFloat(lg);
        self._ct.m3_kame_ref  = m3kame;
        self._ct.rumas        = [];
        self._ctRenderRumas();
        ref.style.display = 'block';
        ref.innerHTML = '<b>Referencia KAME:</b> ' + m3kame.toFixed(3) + ' M3 para ' + esp + ' ' + lg + 'm';
      } else {
        ref.style.display = 'none';
      }
    };
    document.getElementById('ctEspecie').addEventListener('change', onSelect);
    document.getElementById('ctLargo').addEventListener('change', onSelect);
  },

  _ctRenderRumas() {
    var el = document.getElementById('ctRumasList');
    if (!el) return;
    var rumas = this._ct.rumas;
    if (!rumas.length) {
      el.innerHTML = '<p style="font-size:13px;color:#aaa;text-align:center">Sin rumas medidas a&#xFA;n</p>';
    } else {
      el.innerHTML = rumas.map(function(r, i) {
        var avgH = (r.alturas.reduce(function(a,b){return a+b;},0)/r.alturas.length).toFixed(2);
        return '<div style="background:#f8f9fa;border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
          '<div style="font-size:13px;font-weight:600">Ruma ' + (i+1) + ' &mdash; ' + r.alturas.length + ' alt.</div>' +
          '<div style="font-size:11px;color:#888">Largo ruma: ' + r.largo_ruma + 'm | Alt. prom: ' + avgH + 'm</div>' +
          '<div style="font-size:12px;color:#2980b9">MR: ' + r.mr.toFixed(3) + ' | m&#xB3;: ' + r.m3.toFixed(3) + '</div>' +
          '</div>' +
          '<button onclick="App._ctEliminarRuma(' + i + ')" style="background:none;border:none;color:#e74c3c;font-size:18px;cursor:pointer">&#x1F5D1;</button>' +
          '</div>';
      }).join('');
    }

    var totalM3   = rumas.reduce(function(s,r){ return s+r.m3; }, 0);
    var totalKame = totalM3 * 1.2732;
    var m3el = document.getElementById('ctTotalM3');
    var kmel = document.getElementById('ctTotalKame');
    var btnT = document.getElementById('btnCtTermine');
    if (m3el) m3el.textContent = totalM3.toFixed(3);
    if (kmel) kmel.textContent = totalKame.toFixed(3);
    if (btnT) btnT.disabled = (rumas.length === 0 || !this._ct.especie);
  },

  _ctEliminarRuma(idx) {
    this._ct.rumas.splice(idx, 1);
    this._ctRenderRumas();
  },

  ctAgregarRuma() {
    if (!this._ct.especie || !this._ct.largo) {
      App.toast('Seleccioná especie y largo primero');
      return;
    }
    var alturas = [];
    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;align-items:flex-end';
    App._ctModal        = modal;
    App._ctModalAlturas = alturas;

    var self = this;
    var render = function() {
      var avg   = alturas.length ? (alturas.reduce(function(a,b){return a+b;},0)/alturas.length).toFixed(3) : '&mdash;';
      var lgVal = document.getElementById('ctLargoRuma') ? document.getElementById('ctLargoRuma').value : '';
      var lgRuma = parseFloat(lgVal) || 0;
      var mr  = (alturas.length && lgRuma) ? ((parseFloat(avg)*lgRuma*self._ct.largo)/2.44).toFixed(3) : '&mdash;';
      var m3  = (mr !== '&mdash;') ? (parseFloat(mr)*1.56).toFixed(3) : '&mdash;';

      modal.innerHTML =
        '<div style="background:#fff;width:100%;border-radius:16px 16px 0 0;padding:20px;max-height:85vh;overflow-y:auto">' +
        '<div style="font-weight:700;font-size:16px;margin-bottom:12px">Nueva Ruma &mdash; ' + self._ct.especie + ' ' + self._ct.largo + 'm</div>' +

        '<label style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase">Largo de la Ruma (m)</label>' +
        '<input id="ctLargoRuma" type="text" inputmode="decimal" placeholder="ej: 12.5" ' +
        'style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:15px;margin:4px 0 12px;box-sizing:border-box;color:#111;background:#fff" ' +
        'oninput="App._ctRumaRender()" value="' + lgVal + '">' +

        '<label style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase">Alturas medidas (' + alturas.length + ')</label>' +
        '<div style="display:flex;gap:8px;margin:4px 0 8px">' +
        '<input id="ctAltInput" type="text" inputmode="decimal" placeholder="ej: 1.85" ' +
        'style="flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:15px;color:#111;background:#fff">' +
        '<button onclick="App._ctAddAltura()" style="background:#1a3a5c;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer">+ Agregar</button>' +
        '</div>' +

        '<div style="margin-bottom:10px;min-height:40px">' +
        (alturas.length ? alturas.map(function(h, i) {
          return '<span style="display:inline-block;background:#eaf0fb;border-radius:6px;padding:4px 10px;margin:2px;font-size:13px;color:#1a3a5c;font-weight:600">' +
            h.toFixed(2) + 'm <span onclick="App._ctDelAltura(' + i + ')" style="cursor:pointer;color:#e74c3c">&times;</span></span>';
        }).join('') : '<span style="font-size:12px;color:#aaa">Sin alturas aún</span>') +
        '</div>' +

        '<div style="background:#f0f7ff;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px">' +
        '<div>Altura promedio: <b>' + avg + ' m</b></div>' +
        '<div>MR calculado: <b>' + mr + '</b></div>' +
        '<div>m³ sólido: <b>' + m3 + '</b></div>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<button onclick="App._ctCerrarModal()" style="background:#ecf0f1;color:#555;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer">Cancelar</button>' +
        '<button onclick="App._ctGuardarRuma()" ' + (alturas.length && lgVal ? '' : 'disabled') + ' ' +
        'style="background:#27ae60;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer;font-weight:600">Guardar Ruma</button>' +
        '</div>' +
        '</div>';

      App._ctModalAlturas = alturas;
      App._ctModalRender  = render;
    };

    App._ctModalRender = render;
    document.body.appendChild(modal);
    render();
  },

  _ctRumaRender() { if (App._ctModalRender) App._ctModalRender(); },

  _ctAddAltura() {
    var inp = document.getElementById('ctAltInput');
    var val = parseFloat(inp ? inp.value : '');
    if (isNaN(val) || val <= 0) { App.toast('Altura inválida'); return; }
    if (App._ctModalAlturas.length >= 30) { App.toast('Máximo 30 alturas'); return; }
    App._ctModalAlturas.push(val);
    if (inp) inp.value = '';
    App._ctModalRender();
    setTimeout(function(){ var el = document.getElementById('ctAltInput'); if (el) el.focus(); }, 50);
  },

  _ctDelAltura(idx) {
    App._ctModalAlturas.splice(idx, 1);
    App._ctModalRender();
  },

  _ctCerrarModal() {
    if (App._ctModal) { App._ctModal.remove(); App._ctModal = null; }
  },

  _ctGuardarRuma() {
    var lgRuma  = parseFloat(document.getElementById('ctLargoRuma') ? document.getElementById('ctLargoRuma').value : '');
    var alturas = App._ctModalAlturas.slice();
    if (!alturas.length || !lgRuma) return;
    var res = App._ctCalcRuma(alturas, lgRuma, App._ct.largo);
    App._ct.rumas.push({ largo_ruma: lgRuma, alturas: alturas, mr: res.mr, m3: res.m3 });
    App._ctCerrarModal();
    App._ctRenderRumas();
  },

  async ctTermine() {
    var especie      = this._ct.especie;
    var largo        = this._ct.largo;
    var rumas        = this._ct.rumas;
    var m3_kame_ref  = this._ct.m3_kame_ref;

    if (!especie || !rumas.length) return;

    var totalM3  = rumas.reduce(function(s,r){ return s+r.m3; }, 0);
    var m3Equiv  = totalM3 * 1.2732;
    var delta    = m3_kame_ref > 0 ? Math.abs(m3_kame_ref - m3Equiv) / m3_kame_ref * 100 : null;
    var aprobada = delta !== null ? delta <= 8 : null;
    var estado   = aprobada === null ? 'SIN_REF' : (aprobada ? 'APROBADA' : 'RECHAZADA');

    var numero = await this._ctNextNumero();
    var toma = {
      numero:        numero,
      ts:            Date.now(),
      fechaStr:      new Date().toLocaleString('es-CL'),
      user:          State.currentUser ? State.currentUser.nombre : '',
      especie:       especie,
      largo:         largo,
      rumas:         rumas.map(function(r){ return { largo_ruma: r.largo_ruma, alturas: r.alturas, mr: r.mr, m3: r.m3 }; }),
      total_mr:      rumas.reduce(function(s,r){ return s+r.mr; }, 0),
      total_m3:      totalM3,
      m3_kame_equiv: m3Equiv,
      m3_kame_ref:   m3_kame_ref,
      delta_pct:     delta,
      estado:        estado,
    };
    await DB.save('cancha_tomas', toma);

    var color = estado === 'APROBADA' ? '#27ae60' : estado === 'RECHAZADA' ? '#e74c3c' : '#f39c12';
    var icon  = estado === 'APROBADA' ? '✅' : estado === 'RECHAZADA' ? '❌' : '⚠️';
    var msg   = estado === 'APROBADA'
      ? 'Toma aprobada. Delta ' + delta.toFixed(1) + '% ≤ 8%'
      : estado === 'RECHAZADA'
        ? 'Delta ' + delta.toFixed(1) + '% > 8%. Revisar mediciones y generar nueva toma.'
        : 'Sin referencia KAME para comparar.';

    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;align-items:center;justify-content:center';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:28px;max-width:340px;width:90%;text-align:center">' +
      '<div style="font-size:48px">' + icon + '</div>' +
      '<div style="font-weight:800;font-size:20px;color:' + color + ';margin:8px 0">' + estado + '</div>' +
      '<div style="font-size:13px;color:#555;margin-bottom:4px">Toma <b>' + numero + '</b></div>' +
      '<div style="font-size:13px;color:#555;margin-bottom:4px">' + especie + ' ' + largo + 'm &mdash; ' + rumas.length + ' ruma(s)</div>' +
      '<div style="background:#f8f9fa;border-radius:8px;padding:12px;margin:12px 0;font-size:13px;text-align:left">' +
      '<div>m³ sólido físico: <b>' + totalM3.toFixed(3) + '</b></div>' +
      '<div>M3 equiv. KAME: <b>' + m3Equiv.toFixed(3) + '</b></div>' +
      '<div>M3 ref. KAME: <b>' + (m3_kame_ref > 0 ? m3_kame_ref.toFixed(3) : 'N/D') + '</b></div>' +
      (delta !== null ? '<div>Delta: <b style="color:' + color + '">' + delta.toFixed(1) + '%</b></div>' : '') +
      '</div>' +
      '<p style="font-size:13px;color:#666;margin-bottom:16px">' + msg + '</p>' +
      '<button onclick="this.closest(\'div[style*=fixed]\').remove();App.showCanchaTrozos()" ' +
      'style="width:100%;background:#1a3a5c;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer;font-weight:600">Nueva medición</button>' +
      '</div>';
    document.body.appendChild(modal);

    this._ct.rumas   = [];
    this._ct.especie = null;
    this._ct.largo   = null;
  },

  async ctVerHistorial() {
    var tomas  = await DB.getAll('cancha_tomas');
    var sorted = tomas.sort(function(a,b){ return b.ts - a.ts; });

    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;align-items:flex-end';

    var rows = !sorted.length
      ? '<p style="padding:20px;color:#aaa;text-align:center">Sin tomas registradas</p>'
      : sorted.map(function(t) {
          var color = t.estado === 'APROBADA' ? '#27ae60' : t.estado === 'RECHAZADA' ? '#e74c3c' : '#f39c12';
          var icon  = t.estado === 'APROBADA' ? '✅' : t.estado === 'RECHAZADA' ? '❌' : '⚠️';
          return '<div style="border-bottom:1px solid #f0f0f0;padding:12px 16px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-weight:700;font-size:14px">' + t.numero + '</span>' +
            '<span style="color:' + color + ';font-size:13px;font-weight:600">' + icon + ' ' + t.estado + '</span>' +
            '</div>' +
            '<div style="font-size:12px;color:#888;margin:2px 0">' + t.fechaStr + ' &mdash; ' + (t.user || '') + '</div>' +
            '<div style="font-size:13px">' + t.especie + ' ' + t.largo + 'm &mdash; ' + (t.rumas ? t.rumas.length : 0) + ' ruma(s)</div>' +
            '<div style="font-size:12px;color:#555">' +
            'm³: ' + (t.total_m3 || 0).toFixed(3) +
            ' | M3 equiv: ' + (t.m3_kame_equiv || 0).toFixed(3) +
            ' | Ref KAME: ' + (t.m3_kame_ref > 0 ? t.m3_kame_ref.toFixed(3) : 'N/D') +
            (t.delta_pct !== null && t.delta_pct !== undefined
              ? ' | Δ <b style="color:' + color + '">' + t.delta_pct.toFixed(1) + '%</b>'
              : '') +
            '</div>' +
            '</div>';
        }).join('');

    modal.innerHTML =
      '<div style="background:#fff;width:100%;max-height:80vh;overflow-y:auto;border-radius:16px 16px 0 0">' +
      '<div style="padding:16px;font-weight:700;font-size:18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between">' +
      '<span>Historial Cancha de Trozos</span>' +
      '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666">&times;</button>' +
      '</div>' + rows + '</div>';
    modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  },



  // ── TOAST ─────────────────────────────────────────────────────────────
  toast(msg, dur = 3000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
  },
};

// ── BOOT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => DB.open().then(() => App.init()));
