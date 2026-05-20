/* ══════════════════════════════════════════════════════════════════════════
   KAME INVENTARIO — App JS
   Offline-first PWA para toma de inventario
══════════════════════════════════════════════════════════════════════════ */

const API_BASE    = window.KAME_API_URL  || 'https://fdl-kame-api.onrender.com';
const API_KEY     = window.KAME_API_KEY  || '';   // Setear en index.html: <script>window.KAME_API_KEY='...'</script>

// Helper: headers con API key para todos los fetch a la API
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
const USERS = {
  'admin':   { pin: '1234', nombre: 'Administrador',  rol: 'admin' },
  'bodega1': { pin: '2580', nombre: 'Bodeguero 1',    rol: 'bodega' },
  'bodega2': { pin: '1470', nombre: 'Bodeguero 2',    rol: 'bodega' },
  'jefe':    { pin: '9999', nombre: 'Jefe de Patio',  rol: 'jefe' },
};

// ─── STATE ────────────────────────────────────────────────────────────────
const State = {
  currentUser:   null,
  currentSession:null,
  articles:      [],
  kameStock:     {},
  bodegaList:    [],
  filters: { familia: null, tipo: null, calidad: null, condicion: null, proceso: null },
  searchQuery:   '',
  reviewFilter:  'all',
  isOnline:      navigator.onLine,
};

// ─── DB (IndexedDB) ───────────────────────────────────────────────────────
let db;
const DB = {
  async open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('KameInventario', 2);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('sessions'))
          d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('articles'))
          d.createObjectStore('articles', { keyPath: 'sku' });
        if (!d.objectStoreNames.contains('pending'))
          d.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
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
    });

    // Con conexión: siempre descarga el catálogo fresco desde KAME y actualiza caché.
    // Así nuevos artículos (rollizos, trozos, etc.) siempre están disponibles.
    if (State.isOnline) {
      try {
        statusEl.textContent = 'Descargando catálogo KAME...';
        const resp = await fetch(`${API_BASE}/maestro/articulos/todos`, { headers: apiHeaders() });
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

  // ── AUTH ──────────────────────────────────────────────────────────────
  login() {
    const user = document.getElementById('loginUser').value.trim().toLowerCase();
    const pin  = document.getElementById('loginPin').value.trim();
    const err  = document.getElementById('loginError');
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

    if (screen === 'count')  App.renderArticleList();
    if (screen === 'review') App.renderReview();
    if (screen === 'sync')   App.renderSync();
  },

  showHome() {
    document.getElementById('topUser').textContent =
      State.currentUser?.nombre?.split(' ')[0] || '—';
    App.refreshHomeState();
    App.goTo('home');
  },

  refreshHomeState() {
    const sess = State.currentSession;
    const card  = document.getElementById('activeSessionCard');
    const btnR  = document.getElementById('btnReview');
    const btnS  = document.getElementById('btnSync');

    if (sess) {
      const count = Object.keys(sess.items || {}).length;
      card.style.display = 'flex';
      document.getElementById('activeSessionName').textContent = sess.bodega;
      document.getElementById('activeSessionStats').textContent =
        `${count} artículo${count !== 1 ? 's' : ''} contado${count !== 1 ? 's' : ''}`;
      btnR.disabled = count === 0;
      btnS.disabled = count === 0;
    } else {
      card.style.display = 'none';
      btnR.disabled = true;
      btnS.disabled = true;
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
    if (State.bodegaList.length > 0 && !textSearch) {
      // Vista bodega: artículos con stock + extras. Los filtros de chip aplican dentro de la bodega.
      const bodegaSet = new Set(State.bodegaList);
      const extraSet  = new Set(sess?.extraSkus || []);
      const base = State.articles.filter(a => bodegaSet.has(a.sku) || extraSet.has(a.sku));
      arts = hasFilters ? App._applyFilters(base) : base;
    } else {
      // Búsqueda de texto: catálogo completo (permite encontrar y agregar artículos extra)
      arts = App._applyFilters([...State.articles]);
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
      html += `<div class="list-section-label">Por contar (${pending.length})</div>`;
      html += pending.slice(0, 150).map(art => App._renderArticleItem(art, sess)).join('');
      if (pending.length > 150)
        html += `<div class="empty-state"><p>Mostrando 150 de ${pending.length} — usá filtros para acotar</p></div>`;
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
        <div class="art-qty-badge">${counted ? item.qty : ''}</div>
        <div class="art-add-btn">+</div>
      </div>`;
  },

  _applyFilters(arts) {
    const f = State.filters;
    const q = (State.searchQuery || '').toUpperCase();
    if (q.length >= 2) arts = arts.filter(a => (a.desc||'').toUpperCase().includes(q) || (a.sku||'').toUpperCase().includes(q));
    if (f.familia)   arts = arts.filter(a => (a.familia||'') === f.familia);
    if (f.tipo)      arts = arts.filter(a => (a.desc||'').toUpperCase().startsWith(f.tipo));
    if (f.calidad)   arts = arts.filter(a => (a.desc||'').includes(f.calidad));
    if (f.condicion) arts = arts.filter(a => (a.desc||'').toUpperCase().includes(f.condicion));
    if (f.proceso)   arts = arts.filter(a => (a.desc||'').toUpperCase().includes(f.proceso));
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
    const rowId = { familia: 'filterFamilia', tipo: 'filterTipo', calidad: 'filterCalidad', condicion: 'filterCondicion', proceso: 'filterProceso' }[type];
    document.querySelectorAll(`#${rowId} .chip`).forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const activeCount = Object.values(State.filters).filter(v => v !== null).length;
    const countEl = document.getElementById('filterActiveCount');
    if (countEl) countEl.textContent = activeCount > 0 ? `(${activeCount})` : '';
    document.getElementById('btnClearFilters').style.display = activeCount > 0 ? 'block' : 'none';
    App.renderArticleList();
  },

  clearFilters() {
    State.filters = { familia: null, tipo: null, calidad: null, condicion: null, proceso: null };
    ['filterFamilia','filterTipo','filterCalidad','filterCondicion','filterProceso'].forEach(id => {
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
    addLog(`Iniciando sincronización: ${items.length} artículos`);

    for (const [sku, item] of items) {
      const kame = State.kameStock[sku];
      if (kame === undefined || item.qty === kame) { ok++; continue; }

      const diff = item.qty - kame;
      const tipo  = diff > 0 ? 'ENTRADA' : 'SALIDA';
      const motivo = diff > 0 ? 'Ajuste por inventario físico (E)' : 'Ajuste por inventario físico (S)';

      try {
        const body = {
          usuario: State.currentUser?.user || 'sistema',
          tipoDocumento: tipo,
          fecha: sess.fecha,
          motivoMovimiento: motivo,
          bodegaEntrada: diff > 0 ? sess.bodega : '',
          bodegaSalida:  diff < 0 ? sess.bodega : '',
          comentario: `Toma de inventario ${sess.fecha} - ${sess.resp}`,
          items: [{ sku, cantidad: Math.abs(diff) }]
        };

        const resp = await fetch(`${API_BASE}/inventario/movimiento`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify(body)
        });

        if (resp.ok) {
          addLog(`✓ ${sku}: ${tipo} ${Math.abs(diff)} unidades`);
          ok++;
        } else {
          addLog(`✗ ${sku}: Error ${resp.status}`, true);
          errors++;
        }
      } catch(e) {
        addLog(`✗ ${sku}: Sin conexión`, true);
        errors++;
      }
    }

    addLog(`Finalizado: ${ok} OK, ${errors} errores`);

    if (errors === 0) {
      document.getElementById('syncIcon').textContent  = '✅';
      document.getElementById('syncMsg').textContent   = '¡Sincronizado!';
      document.getElementById('syncDetail').textContent = `${ok} movimientos registrados en KAME`;
      App.toast('Inventario subido a KAME ✓');
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

      // Intentar obtener stock de bodega para calcular diferencias
      let kameStock = {};
      try {
        const bodega = encodeURIComponent(sess.bodega);
        const r = await fetch(`${API_BASE}/inventario/stock/bodega/${bodega}`, { headers: apiHeaders() });
        if (r.ok) {
          const data  = await r.json();
          const items = data.items || data || [];
          for (const item of items) {
            const sku = item.sku || item.SKU || item.articulo || item.Articulo;
            const qty = parseFloat(item.stock ?? item.cantidad ?? item.saldo ?? 0);
            if (sku && qty > 0) kameStock[sku] = qty;
          }
        }
      } catch(e) {
        App.toast('Sin conexión para sincronizar pendientes');
        return;
      }

      // Enviar movimientos — contador por sesión para decidir si eliminar
      const entries = Object.entries(sess.items || {});
      let sessionOk = 0, sessionErrors = 0;

      for (const [sku, data] of entries) {
        const conteo = parseFloat(data.qty ?? data.conteo ?? data.count ?? 0);
        const stock  = parseFloat(kameStock[sku] ?? data.stockKame ?? 0);
        const diff   = conteo - stock;
        if (diff === 0) { sessionOk++; continue; }

        const tipo = diff > 0 ? 'ENTRADA' : 'SALIDA';
        const body = {
          usuario:          pendingEntry.user || 'sistema',
          tipoDocumento:    tipo,
          fecha:            sess.fecha || new Date().toISOString().slice(0, 10),
          motivoMovimiento: `Toma de inventario ${sess.fecha || ''} - ${sess.resp || ''}`,
          bodegaEntrada:    diff > 0 ? sess.bodega : '',
          bodegaSalida:     diff < 0 ? sess.bodega : '',
          comentario:       `Sync pendiente`,
          items:            [{ sku, cantidad: Math.abs(diff) }],
        };

        try {
          const r = await fetch(`${API_BASE}/inventario/movimiento`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', ...apiHeaders() },
            body:    JSON.stringify(body),
          });
          if (r.ok) sessionOk++;
          else sessionErrors++;
        } catch(e) {
          sessionErrors++;
        }
      }

      totalOk     += sessionOk;
      totalErrors += sessionErrors;

      // Solo eliminar la sesión pendiente si todos sus movimientos se enviaron OK
      if (sessionErrors === 0) {
        await DB.delete('pending', pendingEntry.id);
      }
    }

    App.toast(`Sincronización: ${totalOk} OK, ${totalErrors} errores`);
  },


  qrNotReady() {
    App.toast('Escáner QR próximamente — buscá el artículo por nombre o SKU');
  },

  toast(msg, duration = 2500) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;z-index:9999;font-size:14px;opacity:0;transition:opacity .3s;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, duration);
  },

};

// ── BOOT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
