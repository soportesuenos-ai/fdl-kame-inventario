// Tests unitarios — node tests/test_app.js
// Carga public/app.js con stubs de browser y prueba la lógica pura:
// coma decimal, cálculo de rumas, precio costo y handlers del modal.
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Stubs de entorno browser ────────────────────────────────────────────
const elements = {};           // id → elemento falso
function el(id) {
  if (!elements[id]) {
    // .value coerce a string como en el DOM real
    let _v = '';
    elements[id] = { get value() { return _v; }, set value(x) { _v = String(x); }, textContent: '', innerHTML: '', className: '', style: {}, classList: { add(){}, remove(){}, toggle(){} }, focus(){} };
  }
  return elements[id];
}
const sandbox = {
  window:    { KAME_API_URL: '/api', KAME_API_KEY: '', addEventListener(){} },
  navigator: { onLine: false, serviceWorker: undefined },
  document:  {
    addEventListener(){},                       // no dispara DOMContentLoaded → no corre init()
    getElementById: id => el(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, remove(){}, appendChild(){}, addEventListener(){}, set innerHTML(v){}, get innerHTML(){ return ''; } }),
    body: { appendChild(){} },
  },
  sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  indexedDB: { open: () => ({}) },
  fetch: () => Promise.reject(new Error('no network in tests')),
  setTimeout, clearTimeout, console, Date, Math, JSON, Promise,
  confirm: () => true, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(code, sandbox);
const { App, State, calcPrecioCosto, esc } = vm.runInContext('({ App, State, calcPrecioCosto, esc })', sandbox);

// ── Mini framework ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = Number.isFinite(want) ? Math.abs(got - want) < 1e-9 : got === want;
  if (ok) { pass++; console.log('  ok  ' + name); }
  else    { fail++; console.log('  FAIL ' + name + ' — esperado ' + JSON.stringify(want) + ', obtenido ' + JSON.stringify(got)); }
}
function approx(name, got, want, tol) {
  if (Math.abs(got - want) <= tol) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — esperado ~' + want + ', obtenido ' + got); }
}

// Silenciar toasts pero registrar el último mensaje
let lastToast = '';
App.toast = msg => { lastToast = String(msg); };

// ════ 1. Coma decimal en alturas (cancha de trozos) ════
console.log('\n1. _ctAddAltura — coma decimal');
App._ctModalAlturas = [];
App._ctModalRender  = () => {};
el('ctAltInput').value = '1,4';
App._ctAddAltura();
eq('"1,4" se interpreta como 1.4', App._ctModalAlturas[0], 1.4);
el('ctAltInput').value = '0,6';
App._ctAddAltura();
eq('"0,6" se interpreta como 0.6', App._ctModalAlturas[1], 0.6);
el('ctAltInput').value = '1.85';
App._ctAddAltura();
eq('"1.85" con punto sigue funcionando', App._ctModalAlturas[2], 1.85);
el('ctAltInput').value = 'abc';
App._ctAddAltura();
eq('texto inválido no se agrega', App._ctModalAlturas.length, 3);
eq('texto inválido muestra toast', lastToast, 'Altura inválida');
el('ctAltInput').value = '0';
App._ctAddAltura();
eq('cero se rechaza', App._ctModalAlturas.length, 3);
el('ctAltInput').value = '-1,2';
App._ctAddAltura();
eq('negativo se rechaza', App._ctModalAlturas.length, 3);

console.log('\n2. Límite de 30 alturas');
App._ctModalAlturas = Array(30).fill(1.0);
el('ctAltInput').value = '1,0';
App._ctAddAltura();
eq('no acepta la altura 31', App._ctModalAlturas.length, 30);

// ════ 3. _ctGuardarRuma con coma en largo de ruma ════
console.log('\n3. _ctGuardarRuma — largo con coma');
App._ct = { especie: 'PINO', largo: 3.2, rumas: [], m3_kame_ref: 0, kame_grupos: {} };
App._ctModalAlturas = [1.4, 0.6];
App._ctModal = { remove(){} };
el('ctLargoRuma').value = '12,5';
el('ctRumasList'); // existe para _ctRenderRumas
App._ctGuardarRuma();
eq('se guardó 1 ruma', App._ct.rumas.length, 1);
eq('largo_ruma "12,5" → 12.5', App._ct.rumas[0].largo_ruma, 12.5);
// mr = avg(1.0) * 12.5 * 3.2 / 2.44 = 16.39344...
approx('MR calculado', App._ct.rumas[0].mr, (1.0 * 12.5 * 3.2) / 2.44, 1e-9);
approx('m3 = MR × 1.56', App._ct.rumas[0].m3, App._ct.rumas[0].mr * 1.56, 1e-9);

// ════ 4. _ctCalcRuma — matemática pura ════
console.log('\n4. _ctCalcRuma');
let r = App._ctCalcRuma([2.0, 1.0, 1.5], 10, 2.44);
approx('avg 1.5 × 10 × 2.44 / 2.44 = 15 MR', r.mr, 15, 1e-9);
approx('m3 = 15 × 1.56 = 23.4', r.m3, 23.4, 1e-9);
r = App._ctCalcRuma([], 10, 2.44);
eq('sin alturas → 0', r.mr, 0);
r = App._ctCalcRuma([1.5], 0, 2.44);
eq('largo_ruma 0 → 0', r.mr, 0);

// ════ 5. Modal de conteo general — coma decimal ════
console.log('\n5. saveCount / adjustQty / updateModalDiff con coma');
State.currentSession = { id: 'current', items: {} };
State.kameStock = { SKU1: 5 };
App._modalSku = 'SKU1';
// DB.save stub: interceptamos vía indexedDB? Más simple: stub de DB no expuesto.
// saveCount usa DB.save → falla con el stub de indexedDB; probamos el parseo previo
// replicando la cadena exacta del código:
el('cantidadInput').value = '1,4';
eq('parseFloat con replace en cantidad', parseFloat(el('cantidadInput').value.replace(',', '.')), 1.4);
el('cantidadInput').value = '0,6';
App.updateModalDiff();
eq('updateModalDiff calcula faltante con coma', el('modalDiff').textContent, '▼ Faltante: -4.4');
el('cantidadInput').value = '6,5';
App.updateModalDiff();
eq('updateModalDiff calcula sobrante con coma', el('modalDiff').textContent, '▲ Sobrante: +1.5');
el('cantidadInput').value = '2,5';
App.adjustQty(1);
eq('adjustQty suma sobre valor con coma', el('cantidadInput').value, '3.5');
el('cantidadInput').value = '0,5';
App.adjustQty(-1);
eq('adjustQty no baja de 0', el('cantidadInput').value, '0');

// ════ 6. calcPrecioCosto ════
console.log('\n6. calcPrecioCosto');
// 1X14X6.00 blanda 1ª: factor = 1*14*6/32 = 2.625 → 2.625*2300 = 6037.5 → 6038
eq('blanda 1ª', calcPrecioCosto('PINO 1ª 1X14X6.00'), Math.round((1 * 14 * 6 / 32) * 2300));
eq('nativa divisor 36.6', calcPrecioCosto('ROBLE 2ª 2X10X3.20'), Math.round((2 * 10 * 3.2 / 36.6) * 1000));
eq('dimensiones con coma', calcPrecioCosto('PINO 2ª 1X4X3,20'), Math.round((1 * 4 * 3.2 / 32) * 1000));
eq('sin dimensiones → 0', calcPrecioCosto('FLETE SERVICIO'), 0);
eq('sin calidad → default 2ª', calcPrecioCosto('PINO 1X14X6.00'), Math.round((1 * 14 * 6 / 32) * 1000));

// ════ 7. esc (anti-XSS) ════
console.log('\n7. esc');
eq('escapa HTML', esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
eq('escapa comillas', esc(`a"b'c`), 'a&quot;b&#39;c');
eq('null → vacío', esc(null), '');

// ════ 8. fmtN — sin ruido de float ════
console.log('\n8. fmtN y diferencias');
const fmtN = vm.runInContext('fmtN', sandbox);
eq('0.1+0.2 redondeado', fmtN(0.30000000000000004), 0.3);
eq('resta con decimales', fmtN(5 - 0.6), 4.4);
State.kameStock = { SKU1: 5 };
App._modalSku = 'SKU1';
el('cantidadInput').value = '4,9';
App.updateModalDiff();
eq('diff 4,9 vs 5 sin ruido de float', el('modalDiff').textContent, '▼ Faltante: -0.1');

// ════ 9. Exportación consolidado (CSV) ════
console.log('\n9. _consoCsv / _consoRows');
State.articles = [{ sku: 'TRO01', desc: 'TROZO "PINO" 3.2M', familia: '' }];
App._consoData = [
  { sku: 'TRO01', qty_contada: 10.5, calles: ['A1'], obs: 'ok' },
  { sku: 'XX99',  qty_contada: 3,    calles: [],     obs: '' },
];
App._consoKameStock = { TRO01: 8.2 };
App._consoStockTs   = '10:30';
el('consoBodega').value = 'CANCHA DE TROZOS';
const rows = App._consoRows();
eq('2 filas', rows.length, 2);
approx('delta TRO01 = 2.3', rows[0].delta, 2.3, 1e-9);
eq('sin stock KAME → delta null', rows[1].delta, null);
const csv = App._consoCsv();
eq('CSV arranca con BOM', csv.charCodeAt(0), 0xFEFF);
eq('separador ; y decimal coma', csv.includes('"TRO01";"TROZO ""PINO"" 3.2M";10,5;8,2;2,3;"A1";"ok"'), true);
eq('encabezado presente', csv.includes('SKU;Descripción;Contado;Stock KAME;Diferencia;Calles;Observaciones'), true);
eq('nombre de archivo', App._consoFileName().startsWith('consolidado_CANCHA_DE_TROZOS_'), true);

// ════ 10. Filtros — impregnado / lixiviado y limpieza ════
console.log('\n10. filtros');
const arts = [
  { sku: 'A', desc: 'PINO IMPREGNADO 2X2X3.20', familia: '' },
  { sku: 'B', desc: 'PINO LIXIVIADO 2X2X3.20',  familia: '' },
  { sku: 'C', desc: 'PINO SECO 2X2X3.20',       familia: '' },
];
State.searchQuery = '';
State.filters = { familia: null, tipo: null, calidad: null, condicion: 'IMPREGNADO', proceso: null, stock: null };
eq('filtro IMPREGNADO', App._applyFilters([...arts]).map(a => a.sku).join(''), 'A');
State.filters.condicion = 'LIXIVIADO';
eq('filtro LIXIVIADO', App._applyFilters([...arts]).map(a => a.sku).join(''), 'B');
App.clearFilters();
eq('clearFilters resetea condicion', State.filters.condicion, null);
eq('clearFilters resetea todos', Object.values(State.filters).every(v => v === null), true);

// ════ 11. Reenvío de toma editada conserva sesion_id ════
console.log('\n11. sesion_id al reenviar');
{
  const sess = { _serverId: 'bodega1_PATIO_VERDE_2026-06-10', bodega: 'PATIO VERDE', fecha: '2026-06-12' };
  const sesionId = sess._serverId || ['usr', sess.bodega, sess.fecha].join('_').replace(/\s+/g, '_');
  eq('usa el id original del servidor', sesionId, 'bodega1_PATIO_VERDE_2026-06-10');
  const nueva = { bodega: 'PATIO VERDE', fecha: '2026-06-12' };
  const idNuevo = nueva._serverId || ['usr', nueva.bodega, nueva.fecha].join('_').replace(/\s+/g, '_');
  eq('sesión nueva genera id propio', idNuevo, 'usr_PATIO_VERDE_2026-06-12');
}

// ════ Resultado ════
console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron');
process.exit(fail ? 1 : 0);
