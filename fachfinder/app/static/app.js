import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openLayoutEditor } from './editor.js?v=1.2.1';

/* =====================================================================
   Helfer
   ===================================================================== */
const APP_VERSION = '1.2.1'; // muss zu APP_VERSION in main.py passen
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const byName = (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
const store = {
  get(k, d) { try { const v = localStorage.getItem('ff.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ff.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};
const ICON = {
  caret: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  area: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  box: '<svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h13M6 3v10M10.5 3v10" stroke="currentColor" stroke-width="1.1"/></svg>',
};

function rowLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const codeMap = new Map();            // Fachnamen bei exakt angepassten Kästen (fortlaufend je Reihe)
const cellCode = c => codeMap.get(c.id) ?? rowLetter(c.row) + (c.col + 1);
const slotCount = c => (c.sub_rows || 1) * (c.sub_cols || 1);
const slotCode = (c, s) => slotCount(c) > 1 ? `${cellCode(c)}.${(s || 0) + 1}` : cellCode(c);
const LT = {
  datenblatt: { ico: '📄', label: 'Datenblatt' },
  shop: { ico: '🛒', label: 'Shop' },
  konfig: { ico: '⚙️', label: 'Konfiguration' },
  doku: { ico: '📘', label: 'Doku' },
  link: { ico: '🔗', label: 'Link' },
};
function guessLinkType(url, label = '') {
  const u = (url + ' ' + label).toLowerCase();
  if (/\.pdf($|[?#])|datasheet|datenblatt|\/ds\//.test(u)) return 'datenblatt';
  if (/reichelt|mouser|digikey|lcsc|amazon\.|amzn|aliexpress|ebay\.|berrybase|conrad|botland|az-delivery|tme\.eu|farnell|rs-online|kaufen|shop|store/.test(u)) return 'shop';
  if (/github|gitlab|esphome|home-assistant|wiki|config|konfig|setup|firmware|getting.?started/.test(u)) return 'konfig';
  if (/docs|doku|manual|anleitung|readthedocs|tutorial/.test(u)) return 'doku';
  return 'link';
}
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '#';
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : 'Eingabe ungültig'; } catch { /* */ }
    if (msg === 'Not Found') msg = 'Diese Funktion kennt der Server nicht – läuft noch eine alte Version? Bitte Server/App neu starten.';
    toast(msg, true); throw new Error(msg);
  }
  return res.json();
}

/* =====================================================================
   Daten
   ===================================================================== */
let D = { areas: [], boxes: [], cells: [], items: [], tags: [] };
const M = { area: new Map(), box: new Map(), cell: new Map(), item: new Map(), tag: new Map(), back: new Map() };
const tagTerms = new Map();            // Label-ID -> Namen + Synonyme inkl. übergeordneter Labels
let searchHits = new Set();           // 'cellId:slot' der Treffer in der Suchansicht
let panelMode = null;                 // 'tags' = Label-Verwaltung
const cnt = { cell: new Map(), box: new Map(), area: new Map() };

let sel = { type: null, id: null };   // 'area' | 'box'
let selCell = null;                   // aktives Fach
let selSlot = 0;                      // aktiver Trenner-Bereich im Fach
const openItems = new Set();          // aufgeklappte Teile im Panel
let multi = new Set();                // Mehrfachauswahl im Fach-Editor
const expanded = new Set(store.get('expanded', []));

const childAreas = pid => D.areas.filter(a => (a.parent_id ?? null) === pid).sort(byName);
const areaBoxes = aid => D.boxes.filter(b => b.area_id === aid && !b.pair_id).sort(byName);  // nur Vorderseiten
const boxCells = bid => D.cells.filter(c => c.box_id === bid).sort((a, b) => a.row - b.row || a.col - b.col);
const cellItems = cid => D.items.filter(i => i.cell_id === cid).sort(byName);
const slotItems = (cid, s) => cellItems(cid).filter(i => (i.slot || 0) === s);
// Spaltenbreiten/Zeilenhöhen als Anteile (Summe 1); leer = gleichmäßig
const fracs = (v, n) => Array.isArray(v) && v.length === n && v.every(x => x > 0)
  ? (sum => v.map(x => x / sum))(v.reduce((a, x) => a + x, 0)) : Array(n).fill(1 / n);
const edgesOf = f => f.reduce((a, x) => (a.push(a[a.length - 1] + x), a), [0]);
const boxEdges = b => ({ X: edgesOf(fracs(b.col_w, b.cols)).map(e => e * b.width), Z: edgesOf(fracs(b.row_h, b.rows)).map(e => e * b.depth) });
const isUniform = b => !(b.col_w || []).length && !(b.row_h || []).length;
const realCells = bid => boxCells(bid).filter(c => !c.gap);
// Doppelseitige Kästen: Rückseite (Seite B) = eigener Kasten mit pair_id -> Vorderseite (Seite A)
const frontOf = b => (b.pair_id && M.box.get(b.pair_id)) || b;
const sidesOf = b => { const f = frontOf(b), k = M.back.get(f.id); return k ? [f, k] : [f]; };
const sideOf = b => b.pair_id ? 'B' : M.back.has(b.id) ? 'A' : '';
const boxLabel = b => b.name + (sideOf(b) ? ` · Seite ${sideOf(b)}` : '');
const boxSum = b => sidesOf(b).reduce((n, x) => n + (cnt.box.get(x.id) || 0), 0);
const layoutOf = c => ({ id: c.id, row: c.row, col: c.col, rowspan: c.rowspan, colspan: c.colspan, label: c.label, gap: !!c.gap });
let labelOpen = null;                 // Fach, bei dem das Namensfeld aufgeklappt ist

/* ---------- Labels ---------- */
const tagKids = pid => D.tags.filter(t => (t.parent_id ?? null) === pid).sort(byName);
function tagChain(id) {
  const out = [], seen = new Set(); let t = M.tag.get(id);
  while (t && !seen.has(t.id)) { seen.add(t.id); out.unshift(t); t = M.tag.get(t.parent_id); }
  return out;
}
const tagPath = id => tagChain(id).map(t => t.name).join(' › ');
function tagDesc(id) {
  const out = new Set([id]);
  const walk = i => tagKids(i).forEach(k => { if (!out.has(k.id)) { out.add(k.id); walk(k.id); } });
  walk(id); return out;
}
function tagTreeOrder() {
  const out = [];
  const walk = (pid, depth) => tagKids(pid).forEach(t => { out.push({ t, depth }); walk(t.id, depth + 1); });
  walk(null, 0); return out;
}
const tagChip = (id, del = false) => {
  const t = M.tag.get(id); if (!t) return '';
  return `<span class="tg" data-tag="${t.id}" style="--tc:${esc(t.color)}" title="${esc(tagPath(t.id))}">${esc(t.name)}${del ? `<button data-tagdel="${t.id}" title="Label entfernen">✕</button>` : ''}</span>`;
};

/* ---------- Suche (gleiche Logik wie im Backend) ---------- */
const squash = x => String(x || '').toLowerCase().replace(/[^0-9a-zäöüß]+/g, '');
function matchWords(words, hay) {
  const h = hay.toLowerCase(), hs = squash(hay);
  return words.every(w => h.includes(w) || (squash(w) && hs.includes(squash(w))));
}
function itemHay(i) {
  const c = M.cell.get(i.cell_id);
  return [i.name, i.qty, i.notes, c?.label,
    ...(i.props || []).map(p => `${p.k} ${p.v}`), ...(i.links || []).map(l => l.label),
    ...(i.tags || []).map(t => tagTerms.get(t) || '')].join(' ');
}
function findItems({ q, tag }) {
  if (tag != null) { const ds = tagDesc(tag); return D.items.filter(i => (i.tags || []).some(t => ds.has(t))); }
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? D.items.filter(i => matchWords(words, itemHay(i))) : [];
}
// Fächer, die nur über ihre Beschriftung passen – Fächer mit Teil-Treffer zählen nicht doppelt
function findLabelCells({ q, tag }, hits) {
  if (tag != null) return [];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const have = new Set(hits.map(i => i.cell_id));
  return D.cells.filter(c => !c.gap && c.label && !have.has(c.id) && matchWords(words, c.label));
}

function areaPath(aid) {
  const parts = []; let a = M.area.get(aid);
  while (a) { parts.unshift(a.name); a = M.area.get(a.parent_id); }
  return parts.join(' › ');
}
function cellPath(c, slot) {
  const b = M.box.get(c.box_id);
  return `${areaPath(b.area_id)} › ${boxLabel(b)} › ${slot == null ? cellCode(c) : slotCode(c, slot)}`;
}
function descendants(aid) {
  const out = new Set([aid]);
  const walk = id => childAreas(id).forEach(k => { out.add(k.id); walk(k.id); });
  walk(aid); return out;
}

function indexData() {
  for (const k in M) M[k].clear();
  D.areas.forEach(a => M.area.set(a.id, a));
  D.boxes.forEach(b => M.box.set(b.id, b));
  D.boxes.forEach(b => { if (b.pair_id && M.box.has(b.pair_id)) M.back.set(b.pair_id, b); });
  D.cells.forEach(c => M.cell.set(c.id, c));
  D.items.forEach(i => M.item.set(i.id, i));
  D.tags = D.tags || [];
  D.tags.forEach(t => M.tag.set(t.id, t));
  codeMap.clear();
  for (const b of D.boxes) if ((b.col_w || []).length || (b.row_h || []).length) {
    const bc = D.cells.filter(c => c.box_id === b.id && !c.gap);
    [...new Set(bc.map(c => c.row))].sort((x, y) => x - y).forEach((r, ri) =>
      bc.filter(c => c.row === r).sort((x, y) => x.col - y.col).forEach((c, k) => codeMap.set(c.id, rowLetter(ri) + (k + 1))));
  }
  tagTerms.clear();
  D.tags.forEach(t => tagTerms.set(t.id, tagChain(t.id).map(x => `${x.name} ${x.synonyms}`).join(' ')));
  cnt.cell.clear(); cnt.box.clear(); cnt.area.clear();
  for (const it of D.items) cnt.cell.set(it.cell_id, (cnt.cell.get(it.cell_id) || 0) + 1);
  for (const c of D.cells) cnt.box.set(c.box_id, (cnt.box.get(c.box_id) || 0) + (cnt.cell.get(c.id) || 0));
  const total = id => {
    if (cnt.area.has(id)) return cnt.area.get(id);
    let n = areaBoxes(id).reduce((s, b) => s + boxSum(b), 0);
    for (const k of childAreas(id)) n += total(k.id);
    cnt.area.set(id, n); return n;
  };
  D.areas.forEach(a => total(a.id));
}

async function reload() {
  D = await api('GET', 'api/data');
  indexData();
  if (sel.type === 'area' && !M.area.has(sel.id)) sel = { type: null, id: null };
  if (sel.type === 'box' && !M.box.has(sel.id)) sel = { type: null, id: null };
  if (sel.type === 'search' && sel.tag != null && !M.tag.has(sel.tag)) sel = { type: null, id: null };
  if (selCell && (!M.cell.has(selCell) || M.cell.get(selCell).box_id !== sel.id)) selCell = null;
  multi = new Set([...multi].filter(id => M.cell.has(id)));
  if (!selCell || selSlot >= slotCount(M.cell.get(selCell))) selSlot = 0;
  renderAll();
}

function renderAll() { renderTree(); renderPanel(); render3D(); }

/* =====================================================================
   Auswahl
   ===================================================================== */
function showSearch({ q = null, tag = null }) {
  sel = { type: 'search', id: null, q, tag };
  selCell = null; selSlot = 0; multi = new Set(); panelMode = null;
  if (q != null) sIn.value = q;
  writeHash(); renderAll();
}

function select(type, id, cellId = null, { pulse = false, slot = 0 } = {}) {
  sel = { type, id }; panelMode = null;
  selCell = cellId; selSlot = slot || 0; multi = new Set(cellId ? [cellId] : []);
  let aid = type === 'area' ? M.area.get(id)?.parent_id : M.box.get(id)?.area_id;
  while (aid != null) { expanded.add(aid); aid = M.area.get(aid)?.parent_id ?? null; }
  store.set('expanded', [...expanded]);
  writeHash();
  document.body.classList.remove('tree-open');
  renderAll();
  if (pulse && cellId) pulseCell(cellId, selSlot);
}

function setCell(cellId, additive = false, slot = null) {
  if (slot != null) selSlot = slot; else if (cellId !== selCell) selSlot = 0;
  if (additive) {
    if (multi.has(cellId) && multi.size > 1) { multi.delete(cellId); if (selCell === cellId) selCell = [...multi][0]; }
    else { multi.add(cellId); selCell = cellId; }
  } else { multi = new Set([cellId]); selCell = cellId; }
  writeHash(); renderPanel(); updateHighlights();
}

function writeHash() {
  let h = '';
  if (sel.type === 'box') h = `box=${sel.id}` + (selCell ? `&cell=${selCell}` + (selSlot ? `&slot=${selSlot}` : '') : '');
  else if (sel.type === 'area') h = `area=${sel.id}`;
  else if (sel.type === 'search') h = sel.tag != null ? `tag=${sel.tag}` : `q=${encodeURIComponent(sel.q || '')}`;
  history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  if (sel.type !== 'search') store.set('sel', { ...sel, cell: selCell, slot: selSlot });
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('q')) return { q: p.get('q') };
  if (p.get('tag')) return { tag: +p.get('tag') };
  if (p.get('box')) return { type: 'box', id: +p.get('box'), cell: p.get('cell') ? +p.get('cell') : null, slot: +(p.get('slot') || 0) };
  if (p.get('area')) return { type: 'area', id: +p.get('area') };
  return null;
}

/* =====================================================================
   Baum
   ===================================================================== */
function renderTree() {
  const el = $('#tree'); el.innerHTML = '';
  const roots = childAreas(null);
  if (!roots.length) {
    el.innerHTML = '<div class="empty">Noch nichts angelegt.<br>Leg mit <b>„+ Bereich“</b> deinen ersten Raum an.</div>';
    return;
  }
  roots.forEach(a => el.appendChild(areaNode(a, 0)));
}

function treeRow({ cls, icon, name, depth, caret, active, count, swatch, sides }) {
  const row = document.createElement('div');
  row.className = `node ${cls}${active ? ' active' : ''}`;
  row.style.paddingLeft = (6 + depth * 16) + 'px';
  row.innerHTML =
    (caret ? `<span class="caret ${caret}">${ICON.caret}</span>` : '<span class="caret"></span>') +
    `<span class="ico">${ICON[icon]}</span>` +
    (swatch ? `<span class="swatch" style="background:${esc(swatch)}"></span>` : '') +
    `<span class="nm">${esc(name)}</span>` +
    (sides ? '<span class="sides" title="Doppelseitig (Seite A und B)">A|B</span>' : '') +
    (count ? `<span class="cnt">${count}</span>` : '');
  return row;
}

function areaNode(a, depth) {
  const wrap = document.createElement('div');
  const kids = childAreas(a.id), boxes = areaBoxes(a.id);
  const open = expanded.has(a.id);
  const row = treeRow({
    cls: 'area', icon: 'area', name: a.name, depth,
    caret: kids.length + boxes.length ? (open ? 'open' : 'closed') : null,
    active: sel.type === 'area' && sel.id === a.id, count: cnt.area.get(a.id),
  });
  row.onclick = e => {
    if (e.target.closest('.caret.open, .caret.closed')) { toggleExpand(a.id); return; }
    expanded.add(a.id); store.set('expanded', [...expanded]);
    select('area', a.id);
  };
  row.ondblclick = e => { if (!e.target.closest('.caret')) renameArea(a.id); };
  wrap.appendChild(row);
  if (open) {
    kids.forEach(k => wrap.appendChild(areaNode(k, depth + 1)));
    boxes.forEach(b => wrap.appendChild(boxNode(b, depth + 1)));
  }
  return wrap;
}

function boxNode(b, depth) {
  const row = treeRow({
    cls: 'box', icon: 'box', name: b.name, depth, swatch: b.color, sides: M.back.has(b.id),
    active: sel.type === 'box' && sidesOf(b).some(x => x.id === sel.id), count: boxSum(b),
  });
  row.onclick = () => select('box', b.id);
  row.ondblclick = () => renameBox(b.id);
  return row;
}

function toggleExpand(id) {
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  store.set('expanded', [...expanded]); renderTree();
}

/* =====================================================================
   Dialoge
   ===================================================================== */
function dialog({ title, text = '', fields = [], ok = 'OK', danger = false }) {
  return new Promise(resolve => {
    const m = $('#modal');
    const f = fields.map(fl => {
      let input;
      if (fl.type === 'select') {
        input = `<select name="${fl.name}">${fl.options.map(o =>
          `<option value="${esc(o.value)}"${String(o.value) === String(fl.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      } else {
        input = `<input name="${fl.name}" type="${fl.type || 'text'}" value="${esc(fl.value ?? '')}" placeholder="${esc(fl.placeholder ?? '')}"` +
          `${fl.required ? ' required' : ''}${fl.min != null ? ` min="${fl.min}"` : ''}${fl.max != null ? ` max="${fl.max}"` : ''}${fl.type === 'number' ? ' step="any"' : ''}>`;
      }
      return `<label class="field ${fl.w || ''}"><span>${esc(fl.label)}</span>${input}</label>`;
    }).join('');
    m.innerHTML = `<div class="modal-card"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <form>${f}<div class="modal-actions"><button type="button" class="btn ghost" data-x>Abbrechen</button>
      <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></form></div>`;
    m.classList.remove('hidden');
    const form = m.querySelector('form');
    const first = form.querySelector('input,select');
    if (first) { first.focus(); first.select?.(); } else form.querySelector('[type=submit]').focus();
    const close = v => { m.classList.add('hidden'); m.innerHTML = ''; resolve(v); };
    form.onsubmit = e => { e.preventDefault(); close(Object.fromEntries(new FormData(form))); };
    m.querySelector('[data-x]').onclick = () => close(null);
    m.onmousedown = e => { if (e.target === m) close(null); };
    m.onkeydown = e => { if (e.key === 'Escape') close(null); };
  });
}

const areaOptions = (exclude = new Set()) => D.areas
  .filter(a => !exclude.has(a.id))
  .map(a => ({ value: a.id, label: areaPath(a.id) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true }));

async function addArea(parentId = null) {
  const r = await dialog({
    title: parentId ? `Unterbereich in „${M.area.get(parentId).name}“` : 'Neuer Bereich',
    text: 'Ein Bereich ist z. B. ein Raum, eine Wand oder ein Schrank.',
    fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'z. B. Werkstatt' }], ok: 'Anlegen',
  });
  if (!r) return;
  const { id } = await api('POST', 'api/areas', { name: r.name, parent_id: parentId });
  if (parentId) expanded.add(parentId);
  await reload(); select('area', id);
}

async function addBox(areaId) {
  if (!D.areas.length) { toast('Leg zuerst einen Bereich an.'); return addArea(); }
  const r = await dialog({
    title: 'Neuer Kasten',
    fields: [
      { name: 'name', label: 'Name (fest)', required: true, placeholder: 'z. B. Schrauben M3–M6' },
      { name: 'area_id', label: 'Bereich', type: 'select', value: areaId ?? D.areas[0].id, options: areaOptions() },
      { name: 'orientation', label: 'Bauform', type: 'select', value: 'liegend', options: [
        { value: 'liegend', label: 'Sortierkasten (liegend, Blick von oben)' },
        { value: 'stehend', label: 'Regal / Magazin (stehend, Blick von vorne)' }] },
      { name: 'sides', label: 'Seiten', type: 'select', value: '1', options: [
        { value: '1', label: 'Einseitig' },
        { value: '2', label: 'Doppelseitig (Rückseite mit gleichem Raster)' }] },
      { name: 'rows', label: 'Zeilen', type: 'number', value: 4, min: 1, max: 40, w: 'half' },
      { name: 'cols', label: 'Spalten', type: 'number', value: 6, min: 1, max: 40, w: 'half' },
      { name: 'width', label: 'Breite mm', type: 'number', value: 400, min: 1, w: 'third' },
      { name: 'depth', label: 'Tiefe/Höhe mm', type: 'number', value: 300, min: 1, w: 'third' },
      { name: 'height', label: 'Fachtiefe mm', type: 'number', value: 60, min: 1, w: 'third' },
    ], ok: 'Anlegen',
  });
  if (!r) return;
  const { sides, ...rest } = r;
  const { id } = await api('POST', 'api/boxes', {
    ...rest, area_id: +r.area_id, rows: clamp(+r.rows || 1, 1, 40), cols: clamp(+r.cols || 1, 1, 40),
    width: +r.width || 400, depth: +r.depth || 300, height: +r.height || 60,
    color: ['#3d6fa8', '#c2553b', '#5b8c4a', '#8a5bb5', '#c9a227', '#2e8b8b'][D.boxes.length % 6],
  });
  if (sides === '2') await api('POST', `api/boxes/${id}/back`, { copy_layout: true });
  await reload(); select('box', id);
}

async function addBack(b) {
  const r = await dialog({
    title: `„${b.name}“ doppelseitig machen`,
    text: 'Die Rückseite (Seite B) bekommt eigene Fächer und eigenen Inhalt. Name, Bereich, Maße und Farbe gelten für beide Seiten.',
    fields: [
      { name: 'copy', label: 'Fachaufteilung der Rückseite', type: 'select', value: '1', options: [
        { value: '1', label: 'Wie Seite A übernehmen' }, { value: '0', label: 'Eigenes Raster' }] },
      { name: 'rows', label: 'Zeilen (eigenes Raster)', type: 'number', value: b.rows, min: 1, max: 40, w: 'half' },
      { name: 'cols', label: 'Spalten (eigenes Raster)', type: 'number', value: b.cols, min: 1, max: 40, w: 'half' },
    ], ok: 'Rückseite anlegen',
  });
  if (!r) return;
  const { id } = await api('POST', `api/boxes/${b.id}/back`, {
    copy_layout: r.copy === '1', rows: clamp(+r.rows || 1, 1, 40), cols: clamp(+r.cols || 1, 1, 40),
  });
  await reload(); select('box', id);
}

async function renameArea(id) {
  const r = await dialog({ title: 'Bereich umbenennen', fields: [{ name: 'name', label: 'Name', value: M.area.get(id).name, required: true }], ok: 'Speichern' });
  if (r) { await api('PATCH', `api/areas/${id}`, { name: r.name }); await reload(); }
}
async function renameBox(id) {
  const r = await dialog({ title: 'Kasten umbenennen', fields: [{ name: 'name', label: 'Name', value: M.box.get(id).name, required: true }], ok: 'Speichern' });
  if (r) { await api('PATCH', `api/boxes/${id}`, { name: r.name }); await reload(); }
}

/* =====================================================================
   Rechtes Panel
   ===================================================================== */
const panel = $('#panel');

function renderPanel() {
  const act = document.activeElement;
  const focusId = act && panel.contains(act) ? act.id : null;
  const caret = focusId && 'selectionStart' in act ? act.selectionStart : null;

  if (panelMode === 'tags') renderTagManager();
  else if (sel.type === 'search') renderSearchPanel();
  else if (sel.type === 'area' && M.area.has(sel.id)) renderAreaPanel(M.area.get(sel.id));
  else if (sel.type === 'box' && M.box.has(sel.id)) renderBoxPanel(M.box.get(sel.id));
  else renderWelcome();

  if (focusId) {
    const e = document.getElementById(focusId);
    if (e) { e.focus(); try { if (caret != null) e.setSelectionRange(caret, caret); } catch { /* */ } }
  }
}

function renderWelcome() {
  panel.innerHTML = `<div class="welcome"><h2>Willkommen 👋</h2>
    <ol>
      <li>Links mit <b>+ Bereich</b> einen Raum anlegen (z. B. „Werkstatt“). Darunter kannst du weitere Bereiche wie „Wand links“ oder „Schrank“ anlegen.</li>
      <li>Mit <b>+ Kasten</b> einen Sortierkasten mit festem Namen, Zeilen, Spalten und Maßen anlegen.</li>
      <li>Ein Fach in der 3D-Ansicht oder im Raster anklicken und eintragen, was drin ist.</li>
      <li>Fächer mit <b>Shift-Klick</b> mehrfach auswählen und <b>verbinden</b>, wenn sie größer sind.</li>
      <li>Oben suchen: Das Fach leuchtet dann auf.</li>
    </ol>
    ${D.areas.length ? '' : '<button class="btn" id="demo">Beispieldaten laden</button>'}
  </div>`;
  $('#demo')?.addEventListener('click', async () => { await api('POST', 'api/demo'); await reload(); select('area', D.areas.find(a => a.parent_id == null).id); });
}

function renderAreaPanel(a) {
  const boxes = areaBoxes(a.id), kids = childAreas(a.id);
  const excl = descendants(a.id);
  panel.innerHTML = `
    <div class="p-head"><div class="kicker">Bereich</div><h2>${esc(a.name)}</h2><div class="path">${esc(areaPath(a.id))}</div></div>
    <div class="sec">
      <label class="field"><span>Name</span><input id="a-name" value="${esc(a.name)}"></label>
      <label class="field"><span>Liegt in</span><select id="a-parent"><option value="">— oberste Ebene —</option>
        ${areaOptions(excl).map(o => `<option value="${o.value}"${o.value === a.parent_id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></label>
      <div class="btn-row"><button class="btn sm" id="a-sub">+ Unterbereich</button><button class="btn sm primary" id="a-box">+ Kasten</button></div>
    </div>
    ${kids.length ? `<div class="sec"><div class="sec-title">Unterbereiche</div><div class="chips">
      ${kids.map(k => `<div class="chip" data-area="${k.id}"><span class="ico">${ICON.area}</span>${esc(k.name)}<span class="cnt">${cnt.area.get(k.id) || 0} Teile</span></div>`).join('')}
    </div></div>` : ''}
    <div class="sec"><div class="sec-title">Kästen hier</div>
      ${boxes.length ? `<div class="chips">${boxes.map(b => `<div class="chip" data-box="${b.id}">
        <span class="swatch" style="width:10px;height:10px;border-radius:3px;background:${esc(b.color)}"></span>${esc(b.name)}
        <span class="cnt">${M.back.has(b.id) ? '2 Seiten' : `${b.rows}×${b.cols}`} · ${boxSum(b)} Teile</span></div>`).join('')}</div>`
        : '<div class="no-items">Noch keine Kästen in diesem Bereich.</div>'}
    </div>
    <div class="sec"><button class="btn danger sm" id="a-del">Bereich löschen</button>
      <div class="hint">Löscht auch alle Unterbereiche, Kästen und Inhalte darin.</div></div>`;

  $('#a-name').onchange = async e => { if (!e.target.value.trim()) return; await api('PATCH', `api/areas/${a.id}`, { name: e.target.value }); await reload(); };
  $('#a-parent').onchange = async e => { await api('PATCH', `api/areas/${a.id}`, { parent_id: e.target.value ? +e.target.value : null }); await reload(); select('area', a.id); };
  $('#a-sub').onclick = () => addArea(a.id);
  $('#a-box').onclick = () => addBox(a.id);
  panel.querySelectorAll('[data-box]').forEach(el => el.onclick = () => select('box', +el.dataset.box));
  panel.querySelectorAll('[data-area]').forEach(el => el.onclick = () => select('area', +el.dataset.area));
  $('#a-del').onclick = async () => {
    const n = cnt.area.get(a.id) || 0;
    const ok = await dialog({ title: `„${a.name}“ löschen?`, text: `Damit werden ${n} eingetragene Teile und alle Kästen in diesem Bereich gelöscht.`, ok: 'Löschen', danger: true });
    if (!ok) return;
    await api('DELETE', `api/areas/${a.id}`);
    sel = a.parent_id ? { type: 'area', id: a.parent_id } : { type: null, id: null };
    await reload(); writeHash();
  };
}

function renderBoxPanel(b) {
  const st = b.orientation === 'stehend';
  const cells = boxCells(b.id);
  const ar = clamp(b.width / b.depth, 0.55, 2.6);
  const cur = selCell ? M.cell.get(selCell) : null;
  const multiArr = [...multi];
  const canSplit = multiArr.some(id => { const c = M.cell.get(id); return c && (c.rowspan > 1 || c.colspan > 1); });
  const gapN = cells.filter(c => c.gap).length;
  const allGap = multiArr.length > 0 && multiArr.every(id => M.cell.get(id)?.gap);
  const tidyN = cells.filter(c => needsTidy(c)).length;
  const sides = sidesOf(b), isBack = !!b.pair_id;

  panel.innerHTML = `
    <div class="p-head"><div class="kicker">Kasten${sides.length > 1 ? ` · Seite ${sideOf(b)}` : ''}</div><h2>${esc(b.name)}</h2><div class="path">${esc(areaPath(b.area_id))}</div>
      ${sides.length > 1 ? `<div class="side-sw">${sides.map(x => `<button class="${x.id === b.id ? 'on' : ''}" data-side="${x.id}">
        Seite ${x.pair_id ? 'B' : 'A'}<span>${x.pair_id ? 'Rückseite' : 'Vorderseite'} · ${cnt.box.get(x.id) || 0}</span></button>`).join('')}</div>` : ''}
    </div>

    <div class="sec" id="cell-sec">${cur ? cellSection(cur) : `<div class="sec-title">Fach</div><div class="no-items">Klick auf ein Fach in der 3D-Ansicht oder im Raster unten.</div>`}</div>

    <div class="sec">
      <div class="sec-title">Fächer <span style="text-transform:none;letter-spacing:0">${cells.filter(c => !c.gap).length} Fächer${gapN ? ` · ${gapN} ${gapN === 1 ? 'Aussparung' : 'Aussparungen'}` : ''}</span></div>
      <div class="row2" style="margin-bottom:10px">
        <label class="field" style="margin:0"><span>Zeilen</span><div class="stepper"><button data-step="rows:-1">−</button><input id="b-rows" type="number" value="${b.rows}" min="1" max="60"><button data-step="rows:1">+</button></div></label>
        <label class="field" style="margin:0"><span>Spalten</span><div class="stepper"><button data-step="cols:-1">−</button><input id="b-cols" type="number" value="${b.cols}" min="1" max="60"><button data-step="cols:1">+</button></div></label>
      </div>
      <div class="grid-ed" id="grid-ed" style="--boxc:${esc(b.color)};aspect-ratio:${ar};grid-template-columns:${fracs(b.col_w, b.cols).map(f => `minmax(0,${(f * 100).toFixed(3)}fr)`).join(' ')};grid-template-rows:${fracs(b.row_h, b.rows).map(f => `minmax(0,${(f * 100).toFixed(3)}fr)`).join(' ')}">
        ${cells.map(c => {
          if (c.gap) return `<div class="gc gap ${c.id === selCell ? 'sel' : multi.has(c.id) ? 'multi' : ''}" data-cell="${c.id}" title="${esc(cellCode(c))} – Aussparung (kein Fach)" style="grid-row:${c.row + 1} / span ${c.rowspan};grid-column:${c.col + 1} / span ${c.colspan}"></div>`;
          const n = cnt.cell.get(c.id) || 0;
          const label = c.label || (n ? cellItems(c.id)[0].name + (n > 1 ? ` +${n - 1}` : '') : '');
          const cls = ['gc', (n || c.label) ? 'filled' : '', c.id === selCell ? 'sel' : multi.has(c.id) ? 'multi' : ''].join(' ');
          return `<div class="${cls}" data-cell="${c.id}" title="${esc(cellCode(c) + (label ? ' – ' + label : ''))}" style="grid-row:${c.row + 1} / span ${c.rowspan};grid-column:${c.col + 1} / span ${c.colspan}">
            <span>${cellCode(c)}${slotCount(c) > 1 ? ` <i class="subind">÷${slotCount(c)}</i>` : ''}</span>${label ? `<span class="gl">${esc(label)}</span>` : ''}</div>`;
        }).join('')}
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn sm" id="merge" ${multi.size < 2 ? 'disabled' : ''}>⊞ Verbinden${multi.size > 1 ? ` (${multi.size})` : ''}</button>
        <button class="btn sm" id="split" ${canSplit ? '' : 'disabled'}>⊟ Teilen</button>
        <button class="btn sm primary" id="exact" title="Wände frei in mm verschieben, z. B. für unterschiedlich große Fächer">📐 Exakt anpassen</button>
        <button class="btn sm" id="gap" ${multi.size ? '' : 'disabled'} title="Aussparung = kein Fach, z. B. für Griff oder Ecke">${allGap ? '▣ Wieder Fach' : '▢ Aussparung'}</button>
      </div>
      <div class="hint">Alle Fächer gleich groß? Dann reichen Zeilen und Spalten. <b>Shift</b>-Klick wählt mehrere Fächer zum <b>Verbinden</b>.<br>
        Fächer unterschiedlich groß oder Griffmulde? Mit <b>📐 Exakt anpassen</b> ziehst du die Wände einfach dorthin, wo sie im echten Kasten sitzen.${isUniform(b) ? '' : ' <i>(Dieser Kasten ist exakt angepasst.)</i>'}</div>
      ${tidyN ? `<div class="tidy"><span>${tidyN} ${tidyN === 1 ? 'Fach hat' : 'Fächer haben'} eine Beschriftung, die eigentlich der Inhalt ist.</span><button class="btn sm" id="tidy-box">Aufräumen</button></div>` : ''}
    </div>

    <div class="sec">
      <div class="sec-title">Eigenschaften</div>
      <label class="field"><span>Name (fest)</span><input id="b-name" value="${esc(b.name)}"></label>
      <label class="field"><span>Bereich</span><select id="b-area">${areaOptions().map(o => `<option value="${o.value}"${o.value === b.area_id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>Bauform</span><select id="b-ori">
          <option value="liegend"${!st ? ' selected' : ''}>Liegend (Kasten)</option>
          <option value="stehend"${st ? ' selected' : ''}>Stehend (Regal)</option></select></label>
        <label class="field"><span>Farbe</span><input id="b-color" type="color" value="${esc(b.color)}"></label>
      </div>
      <label class="field"><span>Beschriftungsschild am Fach</span><select id="b-lpos">
        <option value="unten"${b.label_pos !== 'oben' ? ' selected' : ''}>Unten (${st ? 'Unterkante' : 'vorne'})</option>
        <option value="oben"${b.label_pos === 'oben' ? ' selected' : ''}>Oben (${st ? 'Oberkante' : 'hinten'})</option></select></label>
      <div class="row3">
        <label class="field"><span>Breite mm</span><input id="b-w" type="number" min="1" value="${b.width}"></label>
        <label class="field"><span>${st ? 'Höhe' : 'Tiefe'} mm</span><input id="b-d" type="number" min="1" value="${b.depth}"></label>
        <label class="field"><span>${st ? 'Fachtiefe' : 'Wandhöhe'} mm</span><input id="b-h" type="number" min="1" value="${b.height}"></label>
      </div>
      <label class="field"><span>Notiz${sides.length > 1 ? ` (Seite ${sideOf(b)})` : ''}</span><textarea id="b-notes" rows="2">${esc(b.notes)}</textarea></label>
      ${sides.length > 1 ? `<div class="hint">Doppelseitig: Name, Bereich, Bauform, Farbe und Maße gelten für beide Seiten. Raster, Fächer, ${st ? 'Fachtiefe' : 'Wandhöhe'} und Inhalt hat jede Seite für sich.</div>`
        : `<button class="btn sm" id="b-back">⇅ Rückseite anlegen (doppelseitig)</button>`}
    </div>

    <div class="sec">${isBack ? '<button class="btn danger sm" id="b-del">Rückseite entfernen</button>'
      : `<button class="btn danger sm" id="b-del">Kasten löschen</button>${sides.length > 1 ? '<div class="hint">Löscht beide Seiten.</div>' : ''}`}</div>`;

  // Fach-Bereich
  if (cur) bindCellSection(cur);
  panel.querySelectorAll('[data-side]').forEach(el => el.onclick = () => { if (+el.dataset.side !== b.id) select('box', +el.dataset.side); });
  $('#b-back')?.addEventListener('click', () => addBack(b));

  // Raster
  panel.querySelectorAll('[data-cell]').forEach(el => el.onclick = e => setCell(+el.dataset.cell, e.shiftKey || e.ctrlKey || e.metaKey));
  panel.querySelectorAll('[data-step]').forEach(el => el.onclick = () => {
    const [k, d] = el.dataset.step.split(':');
    const rows = k === 'rows' ? b.rows + +d : b.rows, cols = k === 'cols' ? b.cols + +d : b.cols;
    resizeGrid(b, rows, cols);
  });
  $('#b-rows').onchange = e => resizeGrid(b, +e.target.value, b.cols);
  $('#b-cols').onchange = e => resizeGrid(b, b.rows, +e.target.value);
  $('#merge').onclick = () => mergeCells(b);
  $('#split').onclick = () => splitCells(b);
  $('#gap').onclick = () => toggleGap(b, !allGap);
  $('#exact').onclick = () => openLayoutEditor({
    box: b, cells: boxCells(b.id), edges: boxEdges(b), rowLetter, toast,
    itemCount: id => cnt.cell.get(id) || 0,
    cellName: c => { const its = cellItems(c.id); return its.length ? its[0].name + (its.length > 1 ? ` +${its.length - 1}` : '') : ''; },
    onSave: async layout => { await saveLayout(b, layout); toast('Fachaufteilung gespeichert.'); },
  });
  $('#tidy-box')?.addEventListener('click', async () => {
    const r = await api('POST', `api/boxes/${b.id}/tidy`);
    await reload();
    toast(`${r.converted} Beschriftungen als Inhalt eingetragen, ${r.cleared} doppelte entfernt.`);
  });

  // Eigenschaften
  const patch = async data => { await api('PATCH', `api/boxes/${b.id}`, data); await reload(); };
  $('#b-name').onchange = e => e.target.value.trim() && patch({ name: e.target.value });
  $('#b-area').onchange = e => patch({ area_id: +e.target.value });
  $('#b-ori').onchange = e => patch({ orientation: e.target.value });
  $('#b-color').onchange = e => patch({ color: e.target.value });
  $('#b-lpos').onchange = e => patch({ label_pos: e.target.value });
  $('#b-w').onchange = e => +e.target.value > 0 && patch({ width: +e.target.value });
  $('#b-d').onchange = e => +e.target.value > 0 && patch({ depth: +e.target.value });
  $('#b-h').onchange = e => +e.target.value > 0 && patch({ height: +e.target.value });
  $('#b-notes').onchange = e => patch({ notes: e.target.value });
  $('#b-del').onclick = async () => {
    const ok = isBack
      ? await dialog({ title: `Rückseite von „${b.name}“ entfernen?`, text: `Seite B und ${cnt.box.get(b.id) || 0} eingetragene Teile darauf werden gelöscht. Seite A bleibt.`, ok: 'Entfernen', danger: true })
      : await dialog({ title: `„${b.name}“ löschen?`, text: `Der Kasten${sides.length > 1 ? ' (beide Seiten)' : ''} und ${boxSum(b)} eingetragene Teile werden gelöscht.`, ok: 'Löschen', danger: true });
    if (!ok) return;
    await api('DELETE', `api/boxes/${b.id}`);
    if (isBack) { await reload(); select('box', b.pair_id); return; }
    sel = { type: 'area', id: b.area_id }; selCell = null; await reload(); writeHash();
  };
}

function needsTidy(c) {
  if (c.gap || !c.label) return false;
  const its = cellItems(c.id);
  return !its.length || (its.length === 1 && its[0].name.trim().toLowerCase() === c.label.trim().toLowerCase());
}

function gapSection(c) {
  return `<div class="sec-title">Aussparung <span class="code">${cellCode(c)}</span></div>
    <div class="no-items">Hier ist kein Fach, z. B. Griffmulde oder abgeschrägte Ecke. Wird in 3D und in der Suche ausgelassen.</div>
    <button class="btn sm" id="ungap">▣ Wieder als Fach nutzen</button>`;
}

function cellSection(c) {
  if (c.gap) return gapSection(c);
  const n = slotCount(c), st = M.box.get(c.box_id).orientation === 'stehend';
  const items = slotItems(c.id, selSlot);
  const b = M.box.get(c.box_id);
  const { X, Z } = boxEdges(b);
  const mm = v => Math.round(v * 10) / 10;
  const sz = !isUniform(b) ? ` · ${mm(X[c.col + c.colspan] - X[c.col])}×${mm(Z[c.row + c.rowspan] - Z[c.row])} mm`
    : c.rowspan > 1 || c.colspan > 1 ? ` · ${c.rowspan}×${c.colspan}` : '';
  const ar = clamp((X[c.col + c.colspan] - X[c.col]) / (Z[c.row + c.rowspan] - Z[c.row]), 0.4, 3);
  return `
    <div class="sec-title">Fach <span class="code">${slotCode(c, selSlot)}${sz}</span></div>
    ${c.label || labelOpen === c.id ? `
    <label class="field"><span>Fachname – nur für Sammelfächer mit mehreren Teilen</span><input id="c-label" value="${esc(c.label)}" placeholder="z. B. DC/DC-Wandler"></label>
    ${needsTidy(c) ? `<div class="tidy"><span>${cellItems(c.id).length ? 'Der Name ist derselbe wie der Inhalt.' : 'Liegt hier nur „' + esc(c.label) + '“ drin?'}</span>
      <button class="btn sm" id="c-tidy">${cellItems(c.id).length ? 'Doppelten Namen entfernen' : 'Als Inhalt eintragen'}</button></div>` : ''}` : ''}

    <div class="sub-box">
      <div class="sub-head"><span>Trenner</span>
        <div class="sub-steps">
          <span class="sub-lbl">${st ? 'Böden' : 'quer'}</span>
          <div class="stepper sm"><button data-sub="r:-1">−</button><input value="${c.sub_rows}" readonly><button data-sub="r:1">+</button></div>
          <span class="sub-lbl">${st ? 'Wände' : 'längs'}</span>
          <div class="stepper sm"><button data-sub="c:-1">−</button><input value="${c.sub_cols}" readonly><button data-sub="c:1">+</button></div>
        </div>
      </div>
      ${n > 1 ? `<div class="slot-grid" style="aspect-ratio:${ar};grid-template-columns:repeat(${c.sub_cols},1fr);grid-template-rows:repeat(${c.sub_rows},1fr)">
        ${Array.from({ length: n }, (_, s) => {
          const si = slotItems(c.id, s);
          return `<div class="sl${s === selSlot ? ' sel' : ''}${si.length ? ' filled' : ''}" data-slot="${s}" title="${esc(slotCode(c, s))}">
            <b>${slotCode(c, s)}</b>${si.length ? `<span>${esc(si[0].name)}${si.length > 1 ? ` +${si.length - 1}` : ''}</span>` : ''}</div>`;
        }).join('')}
      </div>` : '<div class="hint" style="margin:6px 0 0">Keine Trenner. Mit „+“ teilst du das Fach in Bereiche.</div>'}
    </div>

    <div class="sec-title" style="margin-top:14px">Inhalt ${n > 1 ? `<span class="code">${slotCode(c, selSlot)}</span>` : ''}</div>
    <div class="items">
      ${items.length ? items.map(itemCard).join('') : '<div class="no-items">Hier liegt noch nichts.</div>'}
    </div>
    <form class="add-item" id="add-item">
      <input id="new-name" placeholder="Was liegt drin? z. B. DC/DC-Wandler" autocomplete="off">
      <input id="new-qty" placeholder="Menge" autocomplete="off">
      <button class="btn primary" type="submit">+</button>
    </form>
    ${!c.label && labelOpen !== c.id ? `<button class="linkbtn" id="c-label-open">+ Fachname vergeben (für Sammelfächer)</button>` : ''}`;
}

function itemCard(i) {
  const open = openItems.has(i.id);
  const links = i.links || [], props = i.props || [];
  const quick = links.map((l, idx) => `<a class="lk t-${l.type}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" title="${esc(l.url)}">
      <span>${LT[l.type]?.ico || '🔗'}</span>${esc(l.label || LT[l.type]?.label || hostOf(l.url))}</a>`).join('');
  const tagsHtml = (i.tags || []).length ? `<div class="tags">${i.tags.map(t => tagChip(t, open)).join('')}</div>` : '';
  const summary = props.length ? `<div class="props-sum">${props.map(p => `<span><b>${esc(p.k)}</b> ${esc(p.v)}</span>`).join('')}</div>` : '';
  return `
  <div class="item${open ? ' open' : ''}" data-item="${i.id}">
    <button class="exp" data-exp title="${open ? 'Zuklappen' : 'Details, Links & Daten'}">${ICON.caret}</button>
    <input id="it-n-${i.id}" class="in-name" data-f="name" value="${esc(i.name)}">
    <input id="it-q-${i.id}" class="in-qty" data-f="qty" value="${esc(i.qty)}" placeholder="Menge">
    <div class="acts"><button data-move title="Verschieben">⇄</button><button class="del" data-del title="Löschen">✕</button></div>
    ${quick || summary || tagsHtml || (!open && i.notes) ? `<div class="item-sum">${tagsHtml}${quick ? `<div class="qlinks">${quick}</div>` : ''}${open ? '' : summary}${!open && i.notes ? `<div class="note-sum">${esc(i.notes)}</div>` : ''}</div>` : ''}
    ${open ? `<div class="details">
      <label class="field"><span>Notiz</span><input id="it-o-${i.id}" data-f="notes" value="${esc(i.notes)}" placeholder="z. B. Poti auf 5 V eingestellt"></label>

      <div class="d-title">Labels</div>
      <form class="add-tag" data-addtag>
        <input name="tag" id="nt-${i.id}" list="tag-list" placeholder="z. B. Step-Down, Sensor … (Enter)" autocomplete="off">
        <button class="btn sm" type="submit">+ Label</button>
      </form>

      <div class="d-title">Links</div>
      ${links.length ? `<div class="link-list">${links.map((l, idx) => `
        <div class="link-row">
          <span class="lt">${LT[l.type]?.ico || '🔗'}</span>
          <a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label || LT[l.type]?.label)}</a>
          <span class="host">${esc(hostOf(l.url))}</span>
          <button data-ldel="${idx}" title="Link entfernen">✕</button>
        </div>`).join('')}</div>` : ''}
      <form class="add-link" data-addlink>
        <select name="type">${Object.entries(LT).map(([k, v]) => `<option value="${k}">${v.ico} ${v.label}</option>`).join('')}</select>
        <input name="url" id="nl-u-${i.id}" placeholder="https://… (Datenblatt, Shop, Wiki)" autocomplete="off">
        <input name="label" id="nl-l-${i.id}" placeholder="Bezeichnung (optional)" autocomplete="off">
        <button class="btn sm" type="submit">+ Link</button>
      </form>

      <div class="d-title">Technische Daten</div>
      ${props.map((p, idx) => `<div class="prop-row" data-prop="${idx}">
        <input id="pk-${i.id}-${idx}" data-pk value="${esc(p.k)}"><input id="pv-${i.id}-${idx}" data-pv value="${esc(p.v)}">
        <button data-pdel="${idx}" title="Entfernen">✕</button></div>`).join('')}
      <form class="prop-row add" data-addprop>
        <input name="k" id="np-k-${i.id}" placeholder="z. B. Eingang" autocomplete="off" list="prop-keys">
        <input name="v" id="np-v-${i.id}" placeholder="z. B. 4,5–28 V" autocomplete="off">
        <button class="btn sm" type="submit">+</button>
      </form>
    </div>` : ''}
  </div>`;
}

function bindCellSection(c) {
  if (c.gap) { $('#ungap').onclick = () => toggleGap(M.box.get(c.box_id), false, [c.id]); return; }
  const lbl = $('#c-label');
  if (lbl) lbl.onchange = async e => { await api('PATCH', `api/cells/${c.id}`, { label: e.target.value }); if (!e.target.value.trim()) labelOpen = null; await reload(); };
  $('#c-label-open')?.addEventListener('click', () => { labelOpen = c.id; renderPanel(); $('#c-label')?.focus(); });
  $('#c-tidy')?.addEventListener('click', async () => { await api('POST', `api/cells/${c.id}/tidy`); labelOpen = null; await reload(); });
  panel.querySelectorAll('[data-sub]').forEach(el => el.onclick = async () => {
    const [k, d] = el.dataset.sub.split(':');
    const sub_rows = clamp(c.sub_rows + (k === 'r' ? +d : 0), 1, 12), sub_cols = clamp(c.sub_cols + (k === 'c' ? +d : 0), 1, 12);
    if (sub_rows === c.sub_rows && sub_cols === c.sub_cols) return;
    await api('PATCH', `api/cells/${c.id}`, { sub_rows, sub_cols });
    const r = Math.min(Math.floor(selSlot / c.sub_cols), sub_rows - 1), k2 = Math.min(selSlot % c.sub_cols, sub_cols - 1);
    selSlot = r * sub_cols + k2;
    await reload();
  });
  panel.querySelectorAll('[data-slot]').forEach(el => el.onclick = () => { selSlot = +el.dataset.slot; writeHash(); renderPanel(); updateHighlights(); });
  $('#add-item').onsubmit = async e => {
    e.preventDefault();
    const name = $('#new-name').value.trim(); if (!name) return;
    await api('POST', 'api/items', { cell_id: c.id, slot: selSlot, name, qty: $('#new-qty').value });
    await reload(); $('#new-name')?.focus();
  };
  panel.querySelectorAll('[data-item]').forEach(row => {
    const id = +row.dataset.item, it = M.item.get(id);
    row.querySelectorAll('input[data-f]').forEach(inp => inp.onchange = async () => {
      if (inp.dataset.f === 'name' && !inp.value.trim()) { inp.value = it.name; return; }
      await api('PATCH', `api/items/${id}`, { [inp.dataset.f]: inp.value }); await reload();
    });
    row.querySelector('[data-exp]').onclick = () => { openItems.has(id) ? openItems.delete(id) : openItems.add(id); renderPanel(); };
    row.querySelector('[data-del]').onclick = async () => {
      const ok = await dialog({ title: `„${it.name}“ löschen?`, ok: 'Löschen', danger: true });
      if (ok) { await api('DELETE', `api/items/${id}`); await reload(); }
    };
    row.querySelector('[data-move]').onclick = () => moveItem(id);

    // Labels
    row.querySelectorAll('[data-tagdel]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      await api('PATCH', `api/items/${id}`, { tags: it.tags.filter(t => t !== +b.dataset.tagdel) }); await reload();
    });
    const tf = row.querySelector('[data-addtag]');
    if (tf) tf.onsubmit = async e => { e.preventDefault(); await addTagToItem(id, tf.elements.tag.value); document.getElementById(`nt-${id}`)?.focus(); };

    // Links
    const lf = row.querySelector('[data-addlink]');
    if (lf) {
      const typeSel = lf.elements.type, url = lf.elements.url, label = lf.elements.label;
      typeSel.onchange = () => { typeSel.dataset.touched = '1'; };
      const guess = () => { if (!typeSel.dataset.touched) typeSel.value = guessLinkType(url.value, label.value); };
      url.oninput = guess; label.oninput = guess;
      lf.onsubmit = async e => {
        e.preventDefault();
        if (!url.value.trim()) return url.focus();
        const links = [...(it.links || []), { type: typeSel.value, label: label.value.trim(), url: url.value.trim() }];
        await api('PATCH', `api/items/${id}`, { links }); await reload();
        document.getElementById(`nl-u-${id}`)?.focus();
      };
    }
    row.querySelectorAll('[data-ldel]').forEach(b => b.onclick = async () => {
      const links = (it.links || []).filter((_, i) => i !== +b.dataset.ldel);
      await api('PATCH', `api/items/${id}`, { links }); await reload();
    });

    // Technische Daten
    const saveProps = async () => {
      const props = [...row.querySelectorAll('[data-prop]')].map(r => ({ k: r.querySelector('[data-pk]').value.trim(), v: r.querySelector('[data-pv]').value.trim() })).filter(p => p.k);
      await api('PATCH', `api/items/${id}`, { props }); await reload();
    };
    row.querySelectorAll('[data-pk],[data-pv]').forEach(inp => inp.onchange = saveProps);
    row.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => {
      const props = (it.props || []).filter((_, i) => i !== +b.dataset.pdel);
      await api('PATCH', `api/items/${id}`, { props }); await reload();
    });
    const pf = row.querySelector('[data-addprop]');
    if (pf) pf.onsubmit = async e => {
      e.preventDefault();
      const k = pf.elements.k.value.trim(); if (!k) return pf.elements.k.focus();
      const props = [...(it.props || []), { k, v: pf.elements.v.value.trim() }];
      await api('PATCH', `api/items/${id}`, { props }); await reload();
      document.getElementById(`np-k-${id}`)?.focus();
    };
  });
  bindTagChips(panel);
  ensureTagList();
  // Vorschläge für Eigenschaftsnamen aus allen vorhandenen Teilen
  let dl = document.getElementById('prop-keys');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'prop-keys'; document.body.appendChild(dl); }
  const keys = [...new Set(D.items.flatMap(i => (i.props || []).map(p => p.k)).concat(['Eingang', 'Ausgang', 'Versorgung', 'Bauform', 'Gehäuse', 'Schnittstelle', 'Hersteller', 'Artikelnr.', 'Preis']))].sort();
  dl.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
}

/* ---------- Labels: Zuweisen, Trefferansicht, Verwaltung ---------- */
async function addTagToItem(id, name) {
  name = (name || '').trim(); if (!name) return;
  const it = M.item.get(id);
  let tid = D.tags.find(t => t.name.toLowerCase() === name.toLowerCase())?.id;
  if (!tid) tid = (await api('POST', 'api/tags', { name })).id;
  if (!(it.tags || []).includes(tid)) await api('PATCH', `api/items/${id}`, { tags: [...(it.tags || []), tid] });
  await reload();
}

function bindTagChips(root) {
  root.querySelectorAll('.tg[data-tag]').forEach(el => el.onclick = e => {
    if (e.target.closest('[data-tagdel]')) return;
    showSearch({ tag: +el.dataset.tag });
  });
}

function ensureTagList() {
  let dl = document.getElementById('tag-list');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'tag-list'; document.body.appendChild(dl); }
  dl.innerHTML = tagTreeOrder().map(({ t }) => `<option value="${esc(t.name)}" label="${esc(tagPath(t.id))}">`).join('');
}

function searchTitle() {
  if (sel.tag != null) return M.tag.get(sel.tag)?.name || 'Label';
  return `„${sel.q || ''}“`;
}

function renderSearchPanel() {
  const items = findItems(sel);
  // Fächer, die nur über ihre Beschriftung passen, erscheinen als eigener Eintrag
  const hits = [...items, ...findLabelCells(sel, items).map(c => ({ cell_id: c.id, slot: 0, name: c.label, qty: '', tags: [], cellOnly: true }))];
  const byBox = new Map();
  for (const i of hits) {
    const c = M.cell.get(i.cell_id);
    if (!byBox.has(c.box_id)) byBox.set(c.box_id, []);
    byBox.get(c.box_id).push(i);
  }
  const boxes = [...byBox.keys()].map(id => M.box.get(id)).sort((a, b) => (areaPath(a.area_id) + boxLabel(a)).localeCompare(areaPath(b.area_id) + boxLabel(b), 'de', { numeric: true }));
  const t = sel.tag != null ? M.tag.get(sel.tag) : null;
  const kids = t ? tagKids(t.id) : [];
  panel.innerHTML = `
    <div class="p-head"><div class="kicker">${t ? 'Label' : 'Suche'}</div>
      <h2>${t ? `<span class="dot" style="background:${esc(t.color)}"></span>` : ''}${esc(searchTitle())}</h2>
      <div class="path">${t && t.parent_id ? `<a href="#" data-up="${t.parent_id}">${esc(tagPath(t.parent_id))}</a> › ` : ''}${hits.length} Treffer in ${boxes.length} ${boxes.length === 1 ? 'Kasten' : 'Kästen'}</div>
      ${t?.synonyms ? `<div class="path" style="margin-top:4px">Auch gefunden über: ${esc(t.synonyms)}</div>` : ''}
    </div>
    ${kids.length ? `<div class="sec"><div class="sec-title">Genauer</div><div class="tags">${kids.map(k => tagChip(k.id)).join('')}</div></div>` : ''}
    ${boxes.length ? boxes.map(b => `
      <div class="sec">
        <div class="sec-title"><span style="text-transform:none;letter-spacing:0;color:var(--fg);font-size:13px">${esc(boxLabel(b))}</span><span style="text-transform:none;letter-spacing:0">${esc(areaPath(b.area_id))}</span></div>
        <div class="hits">${byBox.get(b.id).sort((x, y) => x.cell_id - y.cell_id || x.slot - y.slot).map(i => {
          const c = M.cell.get(i.cell_id);
          return `<div class="hit" data-hit="${i.id ?? ''}" data-hcell="${i.cell_id}"><span class="code">${slotCode(c, i.slot || 0)}</span>
            <span class="hn">${esc(i.name)}${i.qty ? ` <i>· ${esc(i.qty)}</i>` : ''}</span>
            <span class="tags">${(i.tags || []).map(x => tagChip(x)).join('')}</span></div>`;
        }).join('')}</div>
      </div>`).join('') : '<div class="sec"><div class="no-items">Nichts gefunden. Tipp: einem Teil ein Label geben, dann findest du es auch über Oberbegriffe.</div></div>'}
    <div class="sec"><button class="btn sm" id="close-search">Suche schließen</button></div>`;
  panel.querySelectorAll('[data-hit]').forEach(el => el.onclick = e => {
    if (e.target.closest('.tg')) return;
    const i = el.dataset.hit ? M.item.get(+el.dataset.hit) : null;
    goCell(i ? i.cell_id : +el.dataset.hcell, i ? i.slot || 0 : 0);
  });
  panel.querySelectorAll('[data-up]').forEach(el => el.onclick = e => { e.preventDefault(); showSearch({ tag: +el.dataset.up }); });
  bindTagChips(panel);
  $('#close-search').onclick = () => { sIn.value = ''; sel = { type: null, id: null }; const s = store.get('sel', null); if (s?.type === 'box' && M.box.has(s.id)) select('box', s.id, null); else if (s?.type === 'area' && M.area.has(s.id)) select('area', s.id); else { writeHash(); renderAll(); } };
}

function tagFields(t = {}) {
  const excl = t.id ? tagDesc(t.id) : new Set();
  return [
    { name: 'name', label: 'Name', value: t.name || '', required: true, placeholder: 'z. B. Step-Down' },
    { name: 'parent_id', label: 'Gehört zu (Oberbegriff)', type: 'select', value: t.parent_id ?? '', options: [{ value: '', label: '— oberste Ebene —' },
      ...tagTreeOrder().filter(({ t: x }) => !excl.has(x.id)).map(({ t: x, depth }) => ({ value: x.id, label: '  '.repeat(depth) + x.name }))] },
    { name: 'synonyms', label: 'Auch finden über (Synonyme, mit Komma)', value: t.synonyms || '', placeholder: 'z. B. Buck, Abwärtswandler' },
  ];
}

function renderTagManager() {
  const rows = tagTreeOrder();
  const count = id => { const ds = tagDesc(id); return D.items.filter(i => (i.tags || []).some(t => ds.has(t))).length; };
  panel.innerHTML = `
    <div class="p-head"><div class="kicker">Labels</div><h2>Labels verwalten</h2>
      <div class="path">Ein Label findet automatisch auch alles aus seinen Unter-Labels. „Spannungsversorgung“ findet z. B. auch alles mit „Step-Down“.</div></div>
    <div class="sec btn-row"><button class="btn sm primary" id="tag-new">+ Label</button><button class="btn sm ghost" id="tag-close">Schließen</button></div>
    <div class="sec">${rows.length ? rows.map(({ t, depth }) => `
      <div class="tag-row" style="padding-left:${depth * 16}px">
        <input type="color" data-tc="${t.id}" value="${esc(t.color)}" title="Farbe">
        <div class="tr-main"><span class="tr-name">${esc(t.name)}</span>${t.synonyms ? `<span class="tr-syn">${esc(t.synonyms)}</span>` : ''}</div>
        <span class="cnt">${count(t.id)}</span>
        <button data-tshow="${t.id}" title="Alle Fächer zeigen">◎</button>
        <button data-tedit="${t.id}" title="Bearbeiten">✎</button>
        <button data-tdel="${t.id}" class="del" title="Löschen">✕</button>
      </div>`).join('') : '<div class="no-items">Noch keine Labels. Leg hier welche an oder tippe sie direkt beim Teil ein.</div>'}
    </div>`;
  $('#tag-close').onclick = () => { panelMode = null; renderPanel(); };
  $('#tag-new').onclick = async () => {
    const r = await dialog({ title: 'Neues Label', fields: tagFields(), ok: 'Anlegen' }); if (!r) return;
    await api('POST', 'api/tags', { name: r.name, parent_id: r.parent_id ? +r.parent_id : null, synonyms: r.synonyms }); await reload();
  };
  panel.querySelectorAll('[data-tc]').forEach(el => el.onchange = async () => { await api('PATCH', `api/tags/${el.dataset.tc}`, { color: el.value }); await reload(); });
  panel.querySelectorAll('[data-tshow]').forEach(el => el.onclick = () => showSearch({ tag: +el.dataset.tshow }));
  panel.querySelectorAll('[data-tedit]').forEach(el => el.onclick = async () => {
    const t = M.tag.get(+el.dataset.tedit);
    const r = await dialog({ title: `Label „${t.name}“`, fields: tagFields(t), ok: 'Speichern' }); if (!r) return;
    await api('PATCH', `api/tags/${t.id}`, { name: r.name, parent_id: r.parent_id ? +r.parent_id : null, synonyms: r.synonyms }); await reload();
  });
  panel.querySelectorAll('[data-tdel]').forEach(el => el.onclick = async () => {
    const t = M.tag.get(+el.dataset.tdel);
    const ok = await dialog({ title: `Label „${t.name}“ löschen?`, text: 'Die Teile bleiben erhalten und verlieren nur dieses Label. Unter-Labels rutschen eine Ebene nach oben.', ok: 'Löschen', danger: true });
    if (ok) { await api('DELETE', `api/tags/${t.id}`); await reload(); }
  });
}

async function moveItem(id) {
  const it = M.item.get(id);
  const opts = [];
  for (const c of D.cells) if (!c.gap) for (let s = 0; s < slotCount(c); s++)
    opts.push({ value: `${c.id}:${s}`, label: cellPath(c, s) + (c.label ? ` – ${c.label}` : '') });
  opts.sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true }));
  const r = await dialog({ title: `„${it.name}“ verschieben`, fields: [{ name: 'to', label: 'Ziel-Fach', type: 'select', value: `${it.cell_id}:${it.slot || 0}`, options: opts }], ok: 'Verschieben' });
  if (!r) return;
  const [cid, slot] = r.to.split(':').map(Number);
  if (cid === it.cell_id && slot === (it.slot || 0)) return;
  await api('PATCH', `api/items/${id}`, { cell_id: cid, slot });
  const c = M.cell.get(cid);
  await reload(); select('box', c.box_id, c.id, { pulse: true, slot });
}

/* ---------- Raster-Operationen ---------- */
async function saveLayout(b, layout) {
  layout = { col_w: fracs(b.col_w, b.cols), row_h: fracs(b.row_h, b.rows), ...layout };
  await api('PUT', `api/boxes/${b.id}/layout`, layout);
  await reload();
}

function resizeGrid(b, rows, cols) {
  rows = clamp(rows | 0, 1, 60); cols = clamp(cols | 0, 1, 60);
  if (rows === b.rows && cols === b.cols) return renderPanel();
  const taken = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cells = [];
  for (const c of boxCells(b.id)) {
    if (c.row >= rows || c.col >= cols) continue;
    const rs = Math.min(c.rowspan, rows - c.row), cs = Math.min(c.colspan, cols - c.col);
    cells.push({ ...layoutOf(c), rowspan: rs, colspan: cs });
    for (let r = c.row; r < c.row + rs; r++) for (let k = c.col; k < c.col + cs; k++) taken[r][k] = true;
  }
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) if (!taken[r][k]) cells.push({ row: r, col: k, rowspan: 1, colspan: 1, label: '' });
  const lost = boxCells(b.id).filter(c => (c.row >= rows || c.col >= cols) && !c.gap && (cnt.cell.get(c.id) || c.label));
  if (lost.length) toast(`Inhalt aus ${lost.length} weggefallenen Fächern wurde ins Randfach verschoben.`);
  // Bei angepassten Breiten: neue Spalten/Zeilen bekommen die Durchschnittsgröße
  const fit = (f, n) => { const m = f.reduce((a, x) => a + x, 0) / f.length; return f.length >= n ? f.slice(0, n) : [...f, ...Array(n - f.length).fill(m)]; };
  saveLayout(b, { rows, cols, cells, col_w: fit(fracs(b.col_w, b.cols), cols), row_h: fit(fracs(b.row_h, b.rows), rows) });
}

function mergeCells(b) {
  const sc = [...multi].map(id => M.cell.get(id)).filter(c => c && c.box_id === b.id);
  if (sc.length < 2) return toast('Mindestens zwei Fächer mit Shift-Klick auswählen.');
  const r0 = Math.min(...sc.map(c => c.row)), c0 = Math.min(...sc.map(c => c.col));
  const r1 = Math.max(...sc.map(c => c.row + c.rowspan)), c1 = Math.max(...sc.map(c => c.col + c.colspan));
  const area = sc.reduce((s, c) => s + c.rowspan * c.colspan, 0);
  if (area !== (r1 - r0) * (c1 - c0)) return toast('Die Auswahl muss ein lückenloses Rechteck ergeben.', true);
  sc.sort((a, b) => a.row - b.row || a.col - b.col);
  const keep = sc.find(c => !c.gap) || sc[0];
  const cells = boxCells(b.id).filter(c => !multi.has(c.id)).map(layoutOf);
  cells.push({ id: keep.id, row: r0, col: c0, rowspan: r1 - r0, colspan: c1 - c0, label: sc.find(c => c.label)?.label || '', gap: sc.every(c => c.gap) });
  selCell = keep.id; multi = new Set([keep.id]);
  saveLayout(b, { rows: b.rows, cols: b.cols, cells });
}

function splitCells(b) {
  const cells = [];
  for (const c of boxCells(b.id)) {
    if (multi.has(c.id) && (c.rowspan > 1 || c.colspan > 1)) {
      for (let r = c.row; r < c.row + c.rowspan; r++) for (let k = c.col; k < c.col + c.colspan; k++) {
        const first = r === c.row && k === c.col;
        cells.push({ id: first ? c.id : undefined, row: r, col: k, rowspan: 1, colspan: 1, label: first ? c.label : '', gap: !!c.gap });
      }
    } else cells.push(layoutOf(c));
  }
  saveLayout(b, { rows: b.rows, cols: b.cols, cells });
}

function toggleGap(b, makeGap, ids = [...multi]) {
  const pick = new Set(ids.filter(id => M.cell.get(id)?.box_id === b.id));
  if (!pick.size) return;
  if (makeGap) {
    const full = [...pick].map(id => M.cell.get(id)).filter(c => !c.gap && cnt.cell.get(c.id));
    if (full.length) return toast(`${full.map(cellCode).join(', ')} ${full.length === 1 ? 'ist' : 'sind'} nicht leer. Inhalt erst verschieben oder löschen.`, true);
    if (pick.size === boxCells(b.id).filter(c => !c.gap).length) return toast('Mindestens ein Fach muss bleiben.', true);
  }
  const cells = boxCells(b.id).map(c => pick.has(c.id) ? { ...layoutOf(c), gap: makeGap, label: makeGap ? '' : c.label } : layoutOf(c));
  saveLayout(b, { rows: b.rows, cols: b.cols, cells });
}

/* =====================================================================
   3D
   ===================================================================== */
const view = $('#view'), canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.fog = new THREE.Fog(0x14171c, 1e5, 1e6);
const camera = new THREE.PerspectiveCamera(38, 1, 1, 1e5);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.495;

scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x2a2f3a, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

const content = new THREE.Group(); scene.add(content);
const WHITE = new THREE.Color(0xffffff);
const ACCENT = 0xff9f43;
let pickables = [];
const cellMeshes = new Map();
let sceneKey = '';
let hoverCell = null;
let pulse = null;
let viewOrientation = 'liegend';

function disposeTree(o) {
  o.traverse(n => {
    n.geometry?.dispose();
    const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    mats.forEach(m => { m.map?.dispose(); m.dispose(); });
  });
}

function runs(set) {
  const a = [...set].sort((x, y) => x - y); const out = [];
  let s = a[0], p = a[0];
  for (let i = 1; i <= a.length; i++) {
    if (a[i] === p + 1) { p = a[i]; continue; }
    out.push([s, p + 1]); s = p = a[i];
  }
  return out;
}

function mesh(geo, mat) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m; }

function wrapText(g, text, maxW, maxLines) {
  const words = text.split(/\s+/); const lines = []; let line = '', cut = false;
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; cut = true; }
  const out = lines.map(l => { while (g.measureText(l).width > maxW && l.length > 2) { l = l.slice(0, -2) + '…'; cut = true; } return l; });
  out.cut = cut; return out;
}

function labelTexture(code, title, sub, wMm, hMm, light) {
  const k = Math.min(6, 512 / Math.max(wMm, hMm));
  const W = Math.max(48, Math.round(wMm * k)), H = Math.max(48, Math.round(hMm * k));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const s = Math.min(W, H);
  const fg = light ? '#141a22' : '#e6eaf0', dim = light ? 'rgba(20,26,34,.55)' : 'rgba(230,234,240,.45)';
  const font = (wt, px) => `${wt} ${Math.round(px)}px Inter, "Segoe UI", system-ui, sans-serif`;
  g.textBaseline = 'top'; g.fillStyle = dim; g.font = font(700, s * 0.15);
  g.fillText(code, s * 0.08, s * 0.07);
  if (title) {
    let px = s * 0.2, lines;
    const maxLines = Math.max(1, Math.min(5, Math.floor(H * 0.6 / (s * 0.1 * 1.15))));
    for (; px > s * 0.1; px *= 0.9) {
      g.font = font(650, px); lines = wrapText(g, title, W * 0.86, maxLines);
      if (!lines.cut && lines.length * px * 1.15 < H * 0.62) break;
    }
    g.font = font(650, px); lines = wrapText(g, title, W * 0.86, Math.max(1, Math.floor(H * 0.62 / (px * 1.15))));
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lh = px * 1.15, y0 = H / 2 - (lines.length - 1) * lh / 2 + s * 0.03;
    lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * lh));
  }
  if (sub) {
    g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillStyle = dim; g.font = font(600, s * 0.12);
    g.fillText(sub, W - s * 0.08, H - s * 0.06);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function plateTexture(text, wMm, hMm) {
  const H = 96, W = clamp(Math.round(H * wMm / hMm), 96, 1024);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#16191f'; g.textAlign = 'center'; g.textBaseline = 'middle';
  let px = H * 0.62;
  const f = p => `700 ${Math.round(p)}px Inter, "Segoe UI", system-ui, sans-serif`;
  g.font = f(px);
  while (g.measureText(text).width > W * 0.92 && px > H * 0.3) { px *= 0.92; g.font = f(px); }
  let t = text;
  while (g.measureText(t).width > W * 0.92 && t.length > 2) t = t.slice(0, -2) + '…';
  g.fillText(t, W / 2, H / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function textSprite(text, color = '#e6eaf0') {
  const cv = document.createElement('canvas'); const g = cv.getContext('2d');
  const px = 64; g.font = `700 ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + px; cv.width = w; cv.height = px * 1.6;
  g.font = `700 ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  g.fillStyle = 'rgba(20,23,28,.78)';
  g.beginPath(); g.roundRect(0, 0, cv.width, cv.height, px * 0.4); g.fill();
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, px / 2, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sp.userData.aspect = cv.width / cv.height;
  return sp;
}

function buildBox(b, showTitle) {
  const wrap = new THREE.Group();
  const inner = new THREE.Group(); wrap.add(inner);
  const W = +b.width || 300, Dp = +b.depth || 200, H = +b.height || 50;
  const rows = b.rows, cols = b.cols, x0 = -W / 2, z0 = -Dp / 2;
  const { X, Z } = boxEdges(b);
  const minStep = Math.min(...X.slice(1).map((x, i) => x - X[i]), ...Z.slice(1).map((z, i) => z - Z[i]));
  const t = clamp(minStep * 0.05, 0.8, 4);
  const to = t * 1.8, baseH = Math.max(2, to);
  const col = new THREE.Color(b.color || '#4f7cac');
  const matShell = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.05 });
  const matWall = new THREE.MeshStandardMaterial({ color: col.clone().lerp(WHITE, 0.3), roughness: 0.4, transparent: true, opacity: 0.5, depthWrite: false });
  const matEmpty = new THREE.Color(0x353b45), matFull = col.clone().lerp(WHITE, 0.66);

  const cells = realCells(b.id);
  const hasGap = cells.length !== boxCells(b.id).length;

  // Boden: am Stück, bei Aussparungen nur unter den echten Fächern
  if (!hasGap) {
    const base = mesh(new THREE.BoxGeometry(W + to, baseH, Dp + to), matShell);
    base.position.y = -baseH / 2; inner.add(base);
  } else for (const c of cells) {
    const base = mesh(new THREE.BoxGeometry(X[c.col + c.colspan] - X[c.col] + to, baseH, Z[c.row + c.rowspan] - Z[c.row] + to), matShell);
    base.position.set(x0 + (X[c.col] + X[c.col + c.colspan]) / 2, -baseH / 2, z0 + (Z[c.row] + Z[c.row + c.rowspan]) / 2); inner.add(base);
  }

  // Trennwände aus den Fachgrenzen ableiten; Außenwand = Rand oder Grenze zu einer Aussparung
  const occ = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const c of cells) for (let r = c.row; r < c.row + c.rowspan; r++) for (let k = c.col; k < c.col + c.colspan; k++) if (occ[r]) occ[r][k] = c.id;
  const at = (r, k) => (r < 0 || k < 0 || r >= rows || k >= cols) ? null : occ[r][k];
  const lines = { h: [new Map(), new Map()], v: [new Map(), new Map()] };  // [innen, außen]
  const add = (m, i, k) => { if (!m.has(i)) m.set(i, new Set()); m.get(i).add(k); };
  for (let i = 0; i <= rows; i++) for (let k = 0; k < cols; k++) {
    const a = at(i - 1, k), e = at(i, k);
    if (a === e) continue;
    add(lines.h[a == null || e == null ? 1 : 0], i, k);
  }
  for (let i = 0; i <= cols; i++) for (let r = 0; r < rows; r++) {
    const a = at(r, i - 1), e = at(r, i);
    if (a === e) continue;
    add(lines.v[a == null || e == null ? 1 : 0], i, r);
  }
  lines.h.forEach((map, outer) => { for (const [i, ks] of map) for (const [a, e] of runs(ks)) {
    const th = outer ? to : t, hh = outer ? H : H * 0.88;
    const m = mesh(new THREE.BoxGeometry(X[e] - X[a] + th, hh, th), outer ? matShell : matWall);
    m.position.set(x0 + (X[a] + X[e]) / 2, hh / 2, z0 + Z[i]); inner.add(m);
  } });
  lines.v.forEach((map, outer) => { for (const [i, rs] of map) for (const [a, e] of runs(rs)) {
    const th = outer ? to : t, hh = outer ? H : H * 0.88;
    const m = mesh(new THREE.BoxGeometry(th, hh, Z[e] - Z[a] + th), outer ? matShell : matWall);
    m.position.set(x0 + X[i], hh / 2, z0 + (Z[a] + Z[e]) / 2); inner.add(m);
  } });

  // Fachböden, Trenner + Beschriftung
  const matDiv = new THREE.MeshStandardMaterial({ color: col.clone().lerp(WHITE, 0.75), roughness: 0.3, transparent: true, opacity: 0.55, depthWrite: false });
  const td = Math.max(0.6, t * 0.6), dh = H * 0.72;
  const matPlate = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.6 });
  for (const c of cells) {
    const w = X[c.col + c.colspan] - X[c.col] - t, d = Z[c.row + c.rowspan] - Z[c.row] - t;
    const cx = x0 + (X[c.col] + X[c.col + c.colspan]) / 2, cz = z0 + (Z[c.row] + Z[c.row + c.rowspan]) / 2;
    const sr = c.sub_rows || 1, sc = c.sub_cols || 1, n = sr * sc;
    const sw = w / sc, sd = d / sr;
    // Trenner
    for (let k = 1; k < sc; k++) {
      const m = mesh(new THREE.BoxGeometry(td, dh, d), matDiv);
      m.position.set(cx - w / 2 + k * sw, dh / 2, cz); inner.add(m);
    }
    for (let r = 1; r < sr; r++) {
      const m = mesh(new THREE.BoxGeometry(w, dh, td), matDiv);
      m.position.set(cx, dh / 2, cz - d / 2 + r * sd); inner.add(m);
    }
    // Bereiche
    for (let r = 0; r < sr; r++) for (let k = 0; k < sc; k++) {
      const s = r * sc + k;
      const items = slotItems(c.id, s), cntN = items.length;
      const filled = cntN > 0 || (n === 1 && !!c.label);
      const tw = sw - (sc > 1 ? td : 0), tdp = sd - (sr > 1 ? td : 0);
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(tw, tdp),
        new THREE.MeshStandardMaterial({ color: filled ? matFull : matEmpty, roughness: 0.85 }));
      tile.rotation.x = -Math.PI / 2; tile.receiveShadow = true;
      tile.position.set(cx - w / 2 + (k + 0.5) * sw, 0.15, cz - d / 2 + (r + 0.5) * sd);
      tile.userData = { cellId: c.id, slot: s, boxId: b.id, base: (filled ? matFull : matEmpty).getHex() };
      inner.add(tile); pickables.push(tile); cellMeshes.set(`${c.id}:${s}`, tile);

      const title = items.map(i => i.name).join(', ');
      const sub = cntN ? `${cntN} ${cntN === 1 ? 'Teil' : 'Teile'}` : '';
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(tw, tdp), new THREE.MeshBasicMaterial({
        map: labelTexture(slotCode(c, s), title, sub, tw, tdp, filled), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
      }));
      lab.rotation.x = -Math.PI / 2; lab.position.copy(tile.position); lab.position.y = 0.3;
      lab.raycast = () => {};
      tile.userData.lab = lab;
      inner.add(lab);
    }

    // Beschriftungsschild vorne am Fach (wie der Einschieber am echten Kasten)
    if (c.label) {
      const sh = clamp(Math.min(d * 0.26, w * 0.32), 5, 24);
      const sw2 = w - t * 0.5;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(sw2, 0.8, sh), matPlate);
      const top = b.label_pos === 'oben';  // Schild hinten/oben oder vorne/unten am Fach – wie in der 2D-Ansicht
      plate.position.set(cx, H + 0.4, top ? cz - d / 2 + sh / 2 - t / 2 : cz + d / 2 - sh / 2 + t / 2);
      plate.castShadow = true;
      plate.userData = { cellId: c.id, slot: 0, boxId: b.id };
      pickables.push(plate);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(sw2 * 0.97, sh * 0.86), new THREE.MeshBasicMaterial({
        map: plateTexture(c.label, sw2, sh), toneMapped: false,
      }));
      face.rotation.x = -Math.PI / 2; face.position.set(plate.position.x, H + 0.85, plate.position.z);
      face.raycast = () => {};
      inner.add(plate, face);
    }
  }

  let footW = W + to, footD, height;
  if (b.orientation === 'stehend') {
    inner.rotation.x = Math.PI / 2;
    inner.position.set(0, (Dp + to) / 2, baseH);
    footD = H + baseH; height = Dp + to;
  } else {
    inner.position.y = baseH;
    footD = Dp + to; height = H + baseH;
  }
  if (showTitle) {
    const sp = textSprite(boxLabel(b));
    const sh = clamp(Math.max(footW, height) * 0.075, 12, 70);
    sp.scale.set(sh * sp.userData.aspect, sh, 1);
    sp.position.set(0, height + sh * 0.9, b.orientation === 'stehend' ? footD / 2 : 0);
    wrap.add(sp);
  }
  wrap.userData = { footW, footD, height, boxId: b.id };
  return wrap;
}

let floor = null, grid = null;
function render3D() {
  disposeTree(content); content.clear(); pickables = []; cellMeshes.clear(); hoverCell = null;
  if (floor) { scene.remove(floor, grid); disposeTree(floor); disposeTree(grid); floor = grid = null; }
  const empty = $('#view-empty'); const info = $('#view-info');

  let boxes = [];
  searchHits = new Set();
  let hits = [];
  if (sel.type === 'box' && M.box.has(sel.id)) boxes = sidesOf(M.box.get(sel.id));  // doppelseitig: beide Seiten nebeneinander
  else if (sel.type === 'area' && M.area.has(sel.id)) boxes = areaBoxes(sel.id).flatMap(sidesOf);
  else if (sel.type === 'search') {
    hits = findItems(sel);
    const lc = findLabelCells(sel, hits);
    hits.forEach(i => searchHits.add(`${i.cell_id}:${i.slot || 0}`));
    lc.forEach(c => { for (let s = 0; s < slotCount(c); s++) searchHits.add(`${c.id}:${s}`); });
    hits = [...hits, ...lc];
    const ids = [...new Set([...hits.map(i => M.cell.get(i.cell_id ?? i.id).box_id)])];
    boxes = ids.map(id => M.box.get(id)).sort((a, b) => (areaPath(a.area_id) + boxLabel(a)).localeCompare(areaPath(b.area_id) + boxLabel(b), 'de', { numeric: true }));
  }

  view2d.innerHTML = ''; boxes2d = [];
  if (!boxes.length) {
    empty.classList.remove('hidden'); info.classList.add('hidden');
    empty.innerHTML = sel.type === 'search' ? `<div><b>Keine Treffer für ${esc(searchTitle())}</b></div>` : sel.type === 'area'
      ? `<div><b>${esc(M.area.get(sel.id).name)}</b><br>Hier liegen noch keine Kästen direkt.<br>Leg rechts einen an oder wähle einen Unterbereich.</div>`
      : `<div><b>Kein Element gewählt</b><br>Wähle links einen Bereich oder Kasten.</div>`;
    sceneKey = ''; return;
  }
  empty.classList.add('hidden'); info.classList.remove('hidden');
  setViewInfo(boxes, hits);
  if (mode2d) { sceneKey = ''; render2D(boxes); return; }

  const groups = boxes.map(b => buildBox(b, boxes.length > 1 || sel.type === 'search'));
  const maxW = Math.max(...groups.map(g => g.userData.footW));
  const gap = Math.max(40, maxW * 0.18);
  const total = groups.reduce((s, g) => s + g.userData.footW, 0) + gap * (groups.length - 1);
  let x = -total / 2;
  for (const g of groups) { g.position.x = x + g.userData.footW / 2; x += g.userData.footW + gap; content.add(g); }

  // Boden + Licht passend zur Szenengröße
  const bb = new THREE.Box3().setFromObject(content);
  const size = bb.getSize(new THREE.Vector3()), center = bb.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.z, size.y, 200);
  floor = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ opacity: 0.32 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(center.x, -0.05, center.z); floor.receiveShadow = true;
  const step = span > 1500 ? 100 : 50, gsize = Math.ceil(span * 4 / step) * step;
  grid = new THREE.GridHelper(gsize, gsize / step, 0x2c323d, 0x20252d);
  grid.position.set(center.x, -0.1, center.z);
  scene.add(floor, grid);
  sun.position.set(center.x + span * 0.5, span * 1.6, center.z + span * 0.9);
  sun.target.position.copy(center);
  const sc = sun.shadow.camera; sc.left = sc.bottom = -span; sc.right = sc.top = span; sc.near = 1; sc.far = span * 5; sc.updateProjectionMatrix();
  scene.fog.near = span * 6; scene.fog.far = span * 14;

  const nSt = boxes.filter(b => b.orientation === 'stehend').length;
  viewOrientation = nSt === boxes.length ? 'stehend' : nSt ? 'gemischt' : 'liegend';
  const key = sel.type + '|' + boxes.map(b => `${b.id}:${b.width}:${b.depth}:${b.height}:${b.orientation}`).join('|');
  if (key !== sceneKey) { fitCamera(); sceneKey = key; }

  updateHighlights();
}

function setViewInfo(boxes, hits) {
  const info = $('#view-info');
  if (sel.type === 'search') {
    info.innerHTML = `<b>${esc(searchTitle())}</b> · ${hits.length} Treffer in ${boxes.length} ${boxes.length === 1 ? 'Kasten' : 'Kästen'} · Fach anklicken zum Öffnen`;
  } else if (sel.type === 'box') {
    const b = M.box.get(sel.id);
    info.innerHTML = `<b>${esc(boxLabel(b))}</b> · ${realCells(b.id).length} Fächer · ${cnt.box.get(b.id) || 0} Teile · ${b.width}×${b.depth}×${b.height} mm`;
  } else {
    info.innerHTML = `<b>${esc(M.area.get(sel.id).name)}</b> · ${boxes.length} Kästen · Fach anklicken zum Öffnen`;
  }
}

/* =====================================================================
   2D-Draufsicht (Alternative zur 3D-Ansicht)
   ===================================================================== */
let mode2d = !!store.get('mode2d', false);
let boxes2d = [];
const view2d = $('#view2d');

function render2D(boxes) {
  boxes2d = boxes;
  const multiBox = boxes.length > 1 || sel.type === 'search';
  view2d.innerHTML = boxes.map(b => {
    const cw = fracs(b.col_w, b.cols), rh = fracs(b.row_h, b.rows);
    const cells = boxCells(b.id).map(c => {
      const pos = `grid-row:${c.row + 1} / span ${c.rowspan};grid-column:${c.col + 1} / span ${c.colspan}`;
      if (c.gap) return `<div class="c2 gap" style="${pos}"></div>`;
      const n = slotCount(c);
      const slots = Array.from({ length: n }, (_, s) => {
        const its = slotItems(c.id, s);
        const title = its.length ? its[0].name + (its.length > 1 ? ` +${its.length - 1}` : '') : (n === 1 && c.label ? c.label : '');
        return `<div class="s2${its.length || (n === 1 && c.label) ? ' full' : ''}" data-k="${c.id}:${s}" data-c="${c.id}" data-s="${s}" data-b="${b.id}">
          <span class="s2-code">${slotCode(c, s)}</span>${title ? `<span class="s2-t">${esc(title)}</span>` : ''}${its.length && its[0].qty ? `<span class="s2-q">${esc(its[0].qty)}</span>` : ''}</div>`;
      }).join('');
      const label = c.label && (n > 1 || cellItems(c.id).length) ? `<div class="c2-lbl">${esc(c.label)}</div>` : '';
      return `<div class="c2${b.label_pos === 'oben' ? ' lbl-top' : ''}" style="${pos}">${label}<div class="c2-in" style="grid-template-columns:repeat(${c.sub_cols || 1},1fr);grid-template-rows:repeat(${c.sub_rows || 1},1fr)">${slots}</div></div>`;
    }).join('');
    return `<div class="b2" data-box2="${b.id}">${multiBox ? `<div class="b2-title"><span class="swatch" style="background:${esc(b.color)}"></span>${esc(boxLabel(b))}</div>` : ''}
      <div class="b2-grid" style="--boxc:${esc(b.color)};grid-template-columns:${cw.map(f => `${(f * 100).toFixed(3)}fr`).join(' ')};grid-template-rows:${rh.map(f => `${(f * 100).toFixed(3)}fr`).join(' ')}">${cells}</div></div>`;
  }).join('');
  layout2D();
  updateHighlights();
}

// Alle Kästen im gleichen Maßstab, so groß wie möglich (Zeilenumbruch bei mehreren Kästen)
function layout2D() {
  if (!mode2d || !boxes2d.length) return;
  const cs = getComputedStyle(view2d);
  const W = view2d.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  const H = view2d.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 2;
  if (W <= 0 || H <= 0) return;
  const multiBox = boxes2d.length > 1 || sel.type === 'search';
  const titleH = multiBox ? 26 : 0, gap = 24;
  const fits = k => {
    let x = 0, y = 0, rowH = 0;
    for (const b of boxes2d) {
      const w = b.width * k, h = b.depth * k + titleH;
      if (w > W) return false;
      if (x && x + w > W) { y += rowH + gap; x = 0; rowH = 0; }
      x += w + gap; rowH = Math.max(rowH, h);
    }
    return y + rowH <= H;
  };
  let k = Math.min(...boxes2d.map(b => Math.min(W / b.width, (H - titleH) / b.depth)));
  while (k > 0.02 && !fits(k)) k *= 0.95;
  view2d.querySelectorAll('[data-box2]').forEach(el => {
    const b = M.box.get(+el.dataset.box2);
    const g = el.querySelector('.b2-grid');
    g.style.width = b.width * k + 'px'; g.style.height = b.depth * k + 'px';
  });
}

function update2D() {
  if (!mode2d) return;
  view2d.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k, cid = +el.dataset.c, s = +el.dataset.s;
    const search = sel.type === 'search';
    el.classList.toggle('hit', search && searchHits.has(k));
    el.classList.toggle('dim', search && !searchHits.has(k));
    el.classList.toggle('sel', !search && cid === selCell && s === selSlot);
    el.classList.toggle('multi', !search && cid !== selCell && multi.has(cid));
    el.classList.toggle('insel', !search && cid === selCell && s !== selSlot);
  });
}

function tipHtml(c, slot) {
  const b = M.box.get(c.box_id), items = slotItems(c.id, slot);
  return `<div class="h"><span>${slotCode(c, slot)}</span>${esc(c.label || boxLabel(b))}</div>` +
    (items.length ? `<ul>${items.slice(0, 6).map(i => `<li><span>${esc(i.name)}</span>${i.qty ? ' · ' + esc(i.qty) : ''}${(i.links || []).length ? ' ' + i.links.map(l => LT[l.type]?.ico || '🔗').join('') : ''}${(i.tags || []).length ? `<div class="tags tip-tags">${i.tags.map(t => tagChip(t)).join('')}</div>` : ''}</li>`).join('')}${items.length > 6 ? `<li>… ${items.length - 6} weitere</li>` : ''}</ul>` : '<div style="color:var(--dim)">leer</div>');
}
function placeTip(e) {
  const tip = $('#tip'), vr = view.getBoundingClientRect();
  tip.classList.remove('hidden');
  tip.style.left = Math.min(e.clientX - vr.left + 14, vr.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(e.clientY - vr.top + 14, vr.height - tip.offsetHeight - 8) + 'px';
}

view2d.addEventListener('click', e => {
  const el = e.target.closest('[data-k]'); if (!el) return;
  const cid = +el.dataset.c, s = +el.dataset.s, bid = +el.dataset.b;
  if (sel.type === 'box' && sel.id === bid) setCell(cid, e.shiftKey || e.ctrlKey || e.metaKey, s);
  else select('box', bid, cid, { slot: s });
});
view2d.addEventListener('pointermove', e => {
  const el = e.target.closest('[data-k]');
  if (!el || e.pointerType === 'touch') { $('#tip').classList.add('hidden'); return; }
  $('#tip').innerHTML = tipHtml(M.cell.get(+el.dataset.c), +el.dataset.s); placeTip(e);
});
view2d.addEventListener('pointerleave', () => $('#tip').classList.add('hidden'));

function setMode2d(on) {
  mode2d = on; store.set('mode2d', on);
  document.body.classList.toggle('mode2d', on);
  $('#view-2d').textContent = on ? '3D' : '2D';
  $('#view-2d').title = on ? 'Zur 3D-Ansicht wechseln' : 'Zur flachen 2D-Draufsicht wechseln';
  $('#tip').classList.add('hidden');
  render3D();
}

function fitCamera(mode) {
  const bb = new THREE.Box3().setFromObject(content);
  if (bb.isEmpty()) return;
  const size = bb.getSize(new THREE.Vector3()), center = bb.getCenter(new THREE.Vector3());
  const r = size.length() / 2;
  let dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
  dist *= Math.max(1, 1.15 / camera.aspect);
  mode = mode || { stehend: 'front', gemischt: 'mixed', liegend: 'iso' }[viewOrientation];
  const dir = { iso: new THREE.Vector3(0.06, 1.9, 0.75), mixed: new THREE.Vector3(0.08, 0.75, 1), front: new THREE.Vector3(0.12, 0.28, 1), top: new THREE.Vector3(0, 1, 0.001) }[mode].normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.5, dist / 200); camera.far = dist * 30; camera.updateProjectionMatrix();
  controls.target.copy(center); controls.update();
}

function updateHighlights() {
  update2D();
  for (const [key, m] of cellMeshes) {
    const { cellId, slot } = m.userData;
    const active = cellId === selCell && slot === selSlot;
    let e = 0x000000, i = 0;
    if (sel.type === 'search') {
      const hit = searchHits.has(key);
      m.material.color.setHex(hit ? ACCENT : m.userData.base);
      if (!hit) m.material.color.multiplyScalar(0.35);
      if (m.userData.lab) m.userData.lab.material.opacity = hit ? 1 : 0.25;
      m.material.emissive.setHex(hit ? ACCENT : key === hoverCell ? 0xffffff : 0);
      m.material.emissiveIntensity = hit ? (key === hoverCell ? 0.5 : 0.3) : 0.12;
      continue;
    }
    if (m.userData.lab) m.userData.lab.material.opacity = 1;
    m.material.color.setHex(active ? ACCENT : m.userData.base);
    if (active) { e = ACCENT; i = 0.25; }
    else if (cellId === selCell || multi.has(cellId)) { e = ACCENT; i = 0.3; }
    else if (key === hoverCell) { e = 0xffffff; i = 0.14; }
    m.material.emissive.setHex(e); m.material.emissiveIntensity = i;
  }
}

function pulseCell(id, slot = 0) {
  pulse = { id: `${id}:${slot}`, t0: performance.now() };
  if (mode2d) {
    const el = view2d.querySelector(`[data-k="${id}:${slot}"]`);
    if (el) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 2700); }
  }
}

/* ---------- Interaktion ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObjects(pickables, false)[0]?.object.userData || null;
}

let down = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
  down = null;
  const hit = pick(e);
  if (!hit) return;
  if (sel.type === 'box' && sel.id === hit.boxId) setCell(hit.cellId, e.shiftKey || e.ctrlKey || e.metaKey, hit.slot);
  else select('box', hit.boxId, hit.cellId, { slot: hit.slot });
});
canvas.addEventListener('pointermove', e => {
  if (e.buttons) { $('#tip').classList.add('hidden'); return; }
  const hit = pick(e);
  const key = hit ? `${hit.cellId}:${hit.slot}` : null;
  canvas.style.cursor = key ? 'pointer' : '';
  if (key !== hoverCell) { hoverCell = key; updateHighlights(); }
  const tip = $('#tip');
  if (!key) { tip.classList.add('hidden'); return; }
  tip.innerHTML = tipHtml(M.cell.get(hit.cellId), hit.slot);
  placeTip(e);
});
canvas.addEventListener('pointerleave', () => { $('#tip').classList.add('hidden'); if (hoverCell) { hoverCell = null; updateHighlights(); } });

$('#fit').onclick = () => fitCamera();
$('#view-front').onclick = () => fitCamera('front');
$('#view-top').onclick = () => fitCamera('top');
$('#view-2d').onclick = () => setMode2d(!mode2d);

new ResizeObserver(() => {
  const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  layout2D();
}).observe(view);

renderer.setAnimationLoop(now => {
  if (mode2d) return;  // in 2D nichts rendern (spart Strom)
  controls.update();
  if (pulse) {
    const m = cellMeshes.get(pulse.id), dt = now - pulse.t0;
    if (!m || dt > 2600) { pulse = null; updateHighlights(); }
    else { m.material.emissive.setHex(ACCENT); m.material.emissiveIntensity = 0.45 + 0.55 * Math.abs(Math.sin(dt / 160)); }
  }
  renderer.render(scene, camera);
});

/* =====================================================================
   Suche
   ===================================================================== */
const sIn = $('#search'), sOut = $('#results');
let results = [], activeRes = 0;

function hl(text, words) {
  let out = esc(text);
  for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  return out;
}

function runSearch() {
  const q = sIn.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) { sOut.classList.add('hidden'); results = []; return; }
  const match = x => matchWords(words, x || '');
  results = [];
  const hits = findItems({ q });
  const lc = findLabelCells({ q }, hits);
  const boxN = new Set([...hits.map(i => M.cell.get(i.cell_id).box_id), ...lc.map(c => c.box_id)]).size;
  const nHits = hits.length + lc.length;
  if (nHits > 1) results.push({ k: '3D', t: `Alle ${nHits} Treffer zeigen`, s: `in ${boxN} ${boxN === 1 ? 'Kasten' : 'Kästen'} markieren`, all: true, go: () => showSearch({ q: sIn.value.trim() }) });
  for (const t of D.tags) if (match(`${t.name} ${t.synonyms}`))
    results.push({ k: 'Label', t: t.name, s: tagPath(t.id), go: () => showSearch({ tag: t.id }) });
  for (const i of hits)
    results.push({ k: 'Teil', t: i.name + (i.qty ? ` · ${i.qty}` : ''), s: cellPath(M.cell.get(i.cell_id), i.slot || 0), go: () => goCell(i.cell_id, i.slot || 0) });
  for (const c of lc)
    results.push({ k: 'Fach', t: c.label, s: cellPath(c), go: () => goCell(c.id) });
  for (const b of D.boxes) if (!b.pair_id && match(b.name + ' ' + sidesOf(b).map(x => x.notes).join(' ')))
    results.push({ k: 'Kasten', t: b.name, s: areaPath(b.area_id), go: () => select('box', b.id) });
  for (const a of D.areas) if (match(a.name))
    results.push({ k: 'Bereich', t: a.name, s: areaPath(a.parent_id) || '', go: () => select('area', a.id) });
  results = results.slice(0, 40); activeRes = 0;
  sOut.innerHTML = results.length
    ? results.map((r, i) => `<div class="res${i === 0 ? ' active' : ''}${r.all ? ' all' : ''}" data-i="${i}"><span class="k">${r.k}</span><span class="t">${hl(r.t, words)}</span><span class="s">${esc(r.s)}</span></div>`).join('')
    : '<div class="res-empty">Nichts gefunden.</div>';
  sOut.classList.remove('hidden');
  sOut.querySelectorAll('.res').forEach(el => el.onmousedown = e => { e.preventDefault(); choose(+el.dataset.i); });
}
function goCell(cid, slot = 0) { const c = M.cell.get(cid); select('box', c.box_id, cid, { pulse: true, slot }); }
function choose(i) { const r = results[i]; if (!r) return; sOut.classList.add('hidden'); sIn.blur(); r.go(); }

sIn.addEventListener('input', runSearch);
sIn.addEventListener('focus', () => sIn.value && runSearch());
sIn.addEventListener('blur', () => setTimeout(() => sOut.classList.add('hidden'), 120));
sIn.addEventListener('keydown', e => {
  const els = sOut.querySelectorAll('.res');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!els.length) return;
    els[activeRes]?.classList.remove('active');
    activeRes = (activeRes + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
    els[activeRes].classList.add('active'); els[activeRes].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); choose(activeRes); }
  else if (e.key === 'Escape') { sIn.value = ''; sOut.classList.add('hidden'); sIn.blur(); }
});
document.addEventListener('keydown', e => {
  if ((e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault(); sIn.focus(); sIn.select();
  }
});

/* =====================================================================
   Start
   ===================================================================== */
$('#add-area').onclick = () => addArea(null);
$('#add-box').onclick = () => addBox(sel.type === 'area' ? sel.id : sel.type === 'box' ? M.box.get(sel.id).area_id : null);
$('#toggle-tree').onclick = () => document.body.classList.toggle('tree-open');
$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  toast(`Lese „${f.name}“ …`);
  let data;
  try { data = JSON.parse(await f.text()); } catch { e.target.value = ''; return toast('Die Datei ist kein gültiges JSON (vielleicht eine HTML-Seite statt des Exports?).', true); }
  e.target.value = '';
  if (!Array.isArray(data?.areas) || !Array.isArray(data?.items)) return toast('Das ist keine Fachfinder-Exportdatei.', true);
  const ok = await dialog({
    title: 'Daten importieren?',
    text: `„${f.name}“ enthält ${data.areas.length} Bereiche, ${(data.boxes || []).length} Kästen, ${data.items.length} Teile und ${(data.tags || []).length} Labels. ` +
      `Alle aktuellen Daten (${D.items.length} Teile) werden dadurch ersetzt. Vorher wird automatisch eine Sicherung angelegt.`,
    ok: 'Ersetzen & importieren', danger: true,
  });
  if (!ok) return;
  const r = await api('POST', 'api/import', data);
  sel = { type: null, id: null }; selCell = null; panelMode = null;
  await reload(); writeHash();
  toast(`Import fertig: ${r.items} Teile in ${r.boxes} Kästen. Sicherung: ${r.backup}`);
});
$('#open-tags').onclick = () => { panelMode = panelMode === 'tags' ? null : 'tags'; renderPanel(); };

async function checkVersion() {
  try {
    const h = await (await fetch('api/health')).json();
    if (h.version !== APP_VERSION) {
      const t = $('#toast');
      t.textContent = `Server (${h.version || 'alt'}) und Oberfläche (${APP_VERSION}) passen nicht zusammen. Bitte Server/App neu starten und Seite neu laden.`;
      t.className = 'toast err'; clearTimeout(toastTimer);
    }
  } catch { /* offline o. Ä. */ }
}

(async () => {
  document.body.classList.toggle('mode2d', mode2d);
  $('#view-2d').textContent = mode2d ? '3D' : '2D';
  await reload();
  checkVersion();
  const h = readHash() || store.get('sel', null);
  if (h?.q) showSearch({ q: h.q });
  else if (h?.tag != null && M.tag.has(h.tag)) showSearch({ tag: h.tag });
  else if (h?.type === 'box' && M.box.has(h.id)) select('box', h.id, M.cell.has(h.cell) ? h.cell : null, { pulse: !!h.cell, slot: h.slot || 0 });
  else if (h?.type === 'area' && M.area.has(h.id)) select('area', h.id);
  window.addEventListener('hashchange', () => {
    const x = readHash(); if (!x) return;
    if (x.q) { if (sel.type !== 'search' || sel.q !== x.q) showSearch({ q: x.q }); }
    else if (x.tag != null) { if (sel.type !== 'search' || sel.tag !== x.tag) showSearch({ tag: x.tag }); }
    else if (x.type === 'box' && M.box.has(x.id) && (x.id !== sel.id || x.cell !== selCell || x.slot !== selSlot)) select('box', x.id, x.cell, { pulse: !!x.cell, slot: x.slot || 0 });
    else if (x.type === 'area' && M.area.has(x.id) && x.id !== sel.id) select('area', x.id);
  });
})();
