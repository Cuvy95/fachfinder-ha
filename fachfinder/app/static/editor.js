/* =====================================================================
   Wand-Editor („Exakt anpassen“)
   Der Kasten wird als Rechtecke in mm bearbeitet: Wände ziehen, Fächer teilen,
   Wände entfernen, Aussparungen setzen. Beim Speichern entsteht daraus wieder ein
   Raster mit unterschiedlich breiten Spalten / hohen Zeilen.
   ===================================================================== */
const EPS = 0.05;          // mm
const MIN = 4;             // kleinstes Fach in mm
const r10 = v => Math.round(v * 10) / 10;
const near = (a, b) => Math.abs(a - b) < EPS;
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('de-DE');
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openLayoutEditor({ box, cells, edges, itemCount, cellName, rowLetter, onSave, toast }) {
  const W = +box.width, H = +box.depth;
  const st = box.orientation === 'stehend';
  const { X, Z } = edges;
  let rects = cells.map(c => ({
    id: c.id, x0: r10(X[c.col]), x1: r10(X[c.col + c.colspan]), y0: r10(Z[c.row]), y1: r10(Z[c.row + c.rowspan]),
    gap: !!c.gap, label: c.label || '', n: itemCount(c.id), name: cellName(c),
  }));
  const history = [];
  let selRect = null, selWall = null;       // selRect: Index, selWall: { dir, pos, mid }
  let mode = 'line';                        // 'line' = ganze Linie, 'piece' = nur dieses Stück
  let drag = null, discardArmed = false;
  let photo = null, photoOp = 0.55;
  try { photo = localStorage.getItem('ff.photo.' + box.id); photoOp = +(localStorage.getItem('ff.photoOp') || 0.55); } catch { /* */ }

  const snap = () => { history.push(JSON.stringify(rects)); if (history.length > 80) history.shift(); discardArmed = false; };
  const undo = () => { if (!history.length) return; rects = JSON.parse(history.pop()); selRect = null; selWall = null; render(); };

  /* ---------- Geometrie ---------- */
  function pieces() {
    const out = [];
    for (const a of rects) for (const b of rects) {
      if (a === b) continue;
      if (near(a.x1, b.x0)) {
        const s0 = Math.max(a.y0, b.y0), s1 = Math.min(a.y1, b.y1);
        if (s1 - s0 > EPS) out.push({ dir: 'v', pos: a.x1, s0, s1, a, b });
      }
      if (near(a.y1, b.y0)) {
        const s0 = Math.max(a.x0, b.x0), s1 = Math.min(a.x1, b.x1);
        if (s1 - s0 > EPS) out.push({ dir: 'h', pos: a.y1, s0, s1, a, b });
      }
    }
    return out;
  }
  const lo = (r, d) => d === 'v' ? r.y0 : r.x0, hi = (r, d) => d === 'v' ? r.y1 : r.x1;
  const endAt = (r, d, p) => near(d === 'v' ? r.x1 : r.y1, p), startAt = (r, d, p) => near(d === 'v' ? r.x0 : r.y0, p);

  // Alle Fächer, die mit dieser Wand zusammen verschoben werden müssen
  function group(pc) {
    let s0 = Math.min(lo(pc.a, pc.dir), lo(pc.b, pc.dir)), s1 = Math.max(hi(pc.a, pc.dir), hi(pc.b, pc.dir));
    if (mode === 'line') {  // ganze zusammenhängende Linie
      const iv = pieces().filter(p => p.dir === pc.dir && near(p.pos, pc.pos)).map(p => [p.s0, p.s1]).sort((x, y) => x[0] - y[0]);
      let changed = true;
      while (changed) { changed = false; for (const [a, b] of iv) if (a < s1 + EPS && b > s0 - EPS && (a < s0 - EPS || b > s1 + EPS)) { s0 = Math.min(s0, a); s1 = Math.max(s1, b); changed = true; } }
    }
    let L, R, changed = true;
    while (changed) {
      changed = false;
      L = rects.filter(r => endAt(r, pc.dir, pc.pos) && lo(r, pc.dir) < s1 - EPS && hi(r, pc.dir) > s0 + EPS);
      R = rects.filter(r => startAt(r, pc.dir, pc.pos) && lo(r, pc.dir) < s1 - EPS && hi(r, pc.dir) > s0 + EPS);
      for (const r of [...L, ...R]) {
        if (lo(r, pc.dir) < s0 - EPS) { s0 = lo(r, pc.dir); changed = true; }
        if (hi(r, pc.dir) > s1 + EPS) { s1 = hi(r, pc.dir); changed = true; }
      }
    }
    const min = Math.max(...L.map(r => (pc.dir === 'v' ? r.x0 : r.y0))) + MIN;
    const max = Math.min(...R.map(r => (pc.dir === 'v' ? r.x1 : r.y1))) - MIN;
    return { L, R, s0, s1, min, max };
  }
  function findWall() {
    if (!selWall) return null;
    return pieces().find(p => p.dir === selWall.dir && near(p.pos, selWall.pos) && p.s0 < selWall.mid && p.s1 > selWall.mid) || null;
  }
  function moveWall(pc, g, to) {
    to = r10(Math.min(g.max, Math.max(g.min, to)));
    for (const r of g.L) pc.dir === 'v' ? (r.x1 = to) : (r.y1 = to);
    for (const r of g.R) pc.dir === 'v' ? (r.x0 = to) : (r.y0 = to);
    selWall = { dir: pc.dir, pos: to, mid: selWall?.mid ?? (pc.s0 + pc.s1) / 2 };
    return to;
  }

  // Raster aus den Rechtecken (für Fachnamen und zum Speichern)
  function toGrid() {
    const uniq = vs => vs.sort((a, b) => a - b).filter((v, i, a) => i === 0 || !near(v, a[i - 1]));
    const xs = uniq(rects.flatMap(r => [r.x0, r.x1])), ys = uniq(rects.flatMap(r => [r.y0, r.y1]));
    const ix = v => xs.findIndex(x => near(x, v)), iy = v => ys.findIndex(y => near(y, v));
    const out = rects.map(r => ({ id: r.id ?? undefined, row: iy(r.y0), col: ix(r.x0), rowspan: iy(r.y1) - iy(r.y0), colspan: ix(r.x1) - ix(r.x0), label: r.gap ? '' : r.label, gap: r.gap }));
    return { xs, ys, cells: out };
  }

  /* ---------- Aktionen ---------- */
  function split(r, dir) {
    const size = dir === 'v' ? r.x1 - r.x0 : r.y1 - r.y0;
    if (size < MIN * 2) return toast('Das Fach ist zu klein zum Teilen.', true);
    snap();
    const mid = r10((dir === 'v' ? r.x0 + r.x1 : r.y0 + r.y1) / 2);
    const nr = { ...r, id: null, n: 0, name: '', label: '' };
    if (dir === 'v') { nr.x0 = mid; r.x1 = mid; } else { nr.y0 = mid; r.y1 = mid; }
    rects.push(nr);
    selRect = null; selWall = { dir, pos: mid, mid: dir === 'v' ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2 };
    render();
  }
  function removeWall(pc) {
    const { a, b, dir } = pc;
    if (!(near(lo(a, dir), lo(b, dir)) && near(hi(a, dir), hi(b, dir))))
      return toast('Die beiden Fächer sind unterschiedlich lang. Zieh erst die Querwände auf eine Linie, dann lässt sich die Wand entfernen.', true);
    snap();
    const keep = (!a.gap && a.id) ? a : (!b.gap && b.id) ? b : a, other = keep === a ? b : a;
    Object.assign(keep, { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
      gap: a.gap && b.gap, label: keep.label || other.label, n: a.n + b.n, name: keep.name || other.name });
    rects = rects.filter(r => r !== other);
    selWall = null; selRect = rects.indexOf(keep);
    render();
  }
  function toggleGap(r) {
    if (!r.gap && r.n) return toast('In diesem Fach liegt noch etwas. Erst verschieben oder löschen.', true);
    if (!r.gap && rects.filter(x => !x.gap).length === 1) return toast('Mindestens ein Fach muss bleiben.', true);
    snap(); r.gap = !r.gap; if (r.gap) r.label = ''; render();
  }

  /* ---------- Oberfläche ---------- */
  const ov = document.createElement('div');
  ov.className = 'led';
  ov.innerHTML = `
    <div class="led-head">
      <div><div class="kicker">Exakt anpassen</div><b>${escH(box.name)}</b> <span class="led-dim">${fmt(W)} × ${fmt(H)} mm</span></div>
      <div class="led-acts">
        <button class="btn sm" data-a="undo" title="Rückgängig (Strg+Z)">↶ Rückgängig</button>
        <button class="btn sm ghost" data-a="cancel">Abbrechen</button>
        <button class="btn sm primary" data-a="save">Speichern</button>
      </div>
    </div>
    <div class="led-body">
      <div class="led-stage"><svg class="led-svg"></svg><div class="led-tip hidden"></div></div>
      <div class="led-side"></div>
    </div>`;
  document.body.appendChild(ov);
  const svg = ov.querySelector('svg'), side = ov.querySelector('.led-side'), tip = ov.querySelector('.led-tip');
  const pad = Math.max(W, H) * 0.035;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const pxPerMm = () => svg.getScreenCTM()?.a || 1;
  function toMm(e) {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  function render() {
    const { xs, ys } = toGrid();
    // Fachnamen wie nach dem Speichern: Reihen fortlaufend, darin von links nach rechts
    const real = rects.filter(r => !r.gap);
    const tops = real.map(r => r.y0).sort((a, b) => a - b).filter((v, i, arr) => i === 0 || !near(v, arr[i - 1]));
    const code = r => rowLetter(tops.findIndex(y => near(y, r.y0))) +
      (real.filter(o => near(o.y0, r.y0)).sort((a, b) => a.x0 - b.x0).indexOf(r) + 1);
    const pcs = pieces();
    const sw = findWall();
    const hl = sw ? group(sw) : null;   // markierter Bereich = alles, was beim Ziehen mitgeht
    const fsBase = Math.max(W, H) / 40;
    let h = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="transparent"/><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,.18)" stroke-width="2"/></pattern></defs>`;
    if (photo) h += `<image href="${photo}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" opacity="${photoOp}" pointer-events="none"/>`;
    rects.forEach((r, i) => {
      const w = r.x1 - r.x0, d = r.y1 - r.y0;
      const cls = ['lr', r.gap ? 'gap' : r.n ? 'full' : '', i === selRect ? 'sel' : ''].join(' ');
      h += `<rect class="${cls}" data-r="${i}" x="${r.x0}" y="${r.y0}" width="${w}" height="${d}" ${r.gap ? 'fill="url(#hatch)"' : ''}/>`;
      const fs = Math.min(fsBase, w / 5, d / 3.2);
      if (fs > 1) {
        const cx = r.x0 + w / 2, cy = r.y0 + d / 2;
        h += `<text class="lt-code" x="${r.x0 + fs * 0.45}" y="${r.y0 + fs * 1.1}" font-size="${fs * 0.85}">${r.gap ? '' : code(r)}</text>`;
        const nm = r.gap ? 'Aussparung' : (r.label || r.name || '');
        if (nm) h += `<text class="lt-name" x="${cx}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="middle">${escH(nm.length > 22 ? nm.slice(0, 21) + '…' : nm)}</text>`;
        h += `<text class="lt-dim" x="${r.x1 - fs * 0.4}" y="${r.y1 - fs * 0.45}" font-size="${fs * 0.7}" text-anchor="end">${fmt(w)}×${fmt(d)}</text>`;
      }
    });
    h += `<rect class="lborder" x="0" y="0" width="${W}" height="${H}"/>`;
    pcs.forEach((p, i) => {
      const [x1, y1, x2, y2] = p.dir === 'v' ? [p.pos, p.s0, p.pos, p.s1] : [p.s0, p.pos, p.s1, p.pos];
      const isSel = sw && p.dir === sw.dir && near(p.pos, sw.pos) && p.s0 < hl.s1 - EPS && p.s1 > hl.s0 + EPS;
      h += `<line class="lw${isSel ? ' sel' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
      h += `<line class="lw-hit ${p.dir}" data-w="${i}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
    });
    svg.innerHTML = h;
    renderSide(pcs, sw);
  }

  function renderSide(pcs, sw) {
    const r = selRect != null ? rects[selRect] : null;
    let h = '';
    if (sw) {
      const g = group(sw);
      const isV = sw.dir === 'v';
      h += `<div class="sec-title">${isV ? 'Senkrechte' : 'Waagrechte'} Wand</div>
        <label class="field"><span>Abstand von ${isV ? 'links' : (st ? 'oben' : 'hinten')} (mm)</span>
          <input id="led-pos" type="number" step="0.5" value="${sw.pos}" min="${g.min}" max="${g.max}"></label>
        <div class="led-seg"><span>Beim Ziehen verschieben:</span>
          <label><input type="radio" name="led-mode" value="line" ${mode === 'line' ? 'checked' : ''}> ganze Linie</label>
          <label><input type="radio" name="led-mode" value="piece" ${mode === 'piece' ? 'checked' : ''}> nur dieses Stück</label></div>
        <button class="btn sm" data-a="delwall">✕ Wand entfernen</button>`;
    } else if (r) {
      h += `<div class="sec-title">${r.gap ? 'Aussparung' : 'Fach'} <span class="led-dim">${fmt(r.x1 - r.x0)} × ${fmt(r.y1 - r.y0)} mm</span></div>
        ${r.gap ? '' : `<div class="led-name">${escH(r.label || r.name || 'leer')}${r.n ? ` · ${r.n} ${r.n === 1 ? 'Teil' : 'Teile'}` : ''}</div>`}
        ${r.gap ? '' : `<div class="btn-row"><button class="btn sm" data-a="split-v">⇹ Senkrecht teilen</button><button class="btn sm" data-a="split-h">⇳ Waagrecht teilen</button></div>`}
        <div class="btn-row" style="margin-top:8px"><button class="btn sm" data-a="gap">${r.gap ? '▣ Wieder Fach' : '▢ Aussparung'}</button></div>`;
    } else {
      h += `<div class="sec-title">So geht's</div>
        <ul class="led-help">
          <li><b>Wand ziehen</b>, um Fächer breiter oder schmaler zu machen. Sie rastet an anderen Wänden ein.</li>
          <li><b>Wand anklicken</b> zeigt die Lage in mm und lässt sie entfernen.</li>
          <li><b>Fach anklicken</b> zum Teilen oder als Aussparung (Griff, Ecke) markieren.</li>
          <li>Tipp: Foto des Kastens von oben als Vorlage einblenden und die Wände nachziehen.</li>
        </ul>`;
    }
    h += `<div class="sec-title" style="margin-top:18px">Foto als Vorlage</div>
      <div class="btn-row"><label class="btn sm" for="led-photo">📷 ${photo ? 'Anderes Foto' : 'Foto wählen'}</label>
      ${photo ? '<button class="btn sm ghost" data-a="nophoto">Entfernen</button>' : ''}</div>
      <input type="file" id="led-photo" class="vh" accept="image/*">
      ${photo ? `<label class="field" style="margin-top:8px"><span>Deckkraft</span><input id="led-op" type="range" min="0.1" max="1" step="0.05" value="${photoOp}"></label>` : ''}
      <div class="hint">Am besten senkrecht von oben fotografieren und auf den Kastenrand zuschneiden – das Foto wird auf die Kastengröße gestreckt.</div>`;
    side.innerHTML = h;

    const pos = side.querySelector('#led-pos');
    if (pos) pos.onchange = () => { const pc = findWall(); if (!pc) return; snap(); moveWall(pc, group(pc), +pos.value); render(); };
    side.querySelectorAll('[name=led-mode]').forEach(el => el.onchange = () => { mode = el.value; render(); });
    const op = side.querySelector('#led-op');
    if (op) op.oninput = () => { photoOp = +op.value; const im = svg.querySelector('image'); if (im) im.setAttribute('opacity', photoOp); try { localStorage.setItem('ff.photoOp', photoOp); } catch { /* */ } };
    side.querySelector('#led-photo').onchange = e => loadPhoto(e.target.files[0]);
  }

  function loadPhoto(f) {
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      photo = cv.toDataURL('image/jpeg', 0.82);
      URL.revokeObjectURL(img.src);
      try { localStorage.setItem('ff.photo.' + box.id, photo); } catch { toast('Foto ist zu groß zum Merken – es bleibt nur bis zum Schließen.'); }
      render();
    };
    img.onerror = () => toast('Das Bild konnte nicht gelesen werden.', true);
    img.src = URL.createObjectURL(f);
  }

  /* ---------- Maus / Finger ---------- */
  svg.addEventListener('pointerdown', e => {
    const w = e.target.closest('[data-w]'), rr = e.target.closest('[data-r]');
    if (w) {
      const pc = pieces()[+w.dataset.w];
      selRect = null; selWall = { dir: pc.dir, pos: pc.pos, mid: (pc.s0 + pc.s1) / 2 };
      const g = group(pc);
      drag = { pc, g, start: pc.pos, moved: false, id: e.pointerId };
      svg.setPointerCapture(e.pointerId);
      render(); e.preventDefault(); return;
    }
    if (rr) { selRect = +rr.dataset.r; selWall = null; render(); return; }
    selRect = null; selWall = null; render();
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = toMm(e);
    let to = drag.pc.dir === 'v' ? p.x : p.y;
    // Einrasten an anderen Wänden (8 px) bzw. auf 0,5 mm
    const tol = 8 / pxPerMm();
    const others = drag.pc.dir === 'v' ? rects.flatMap(r => [r.x0, r.x1]) : rects.flatMap(r => [r.y0, r.y1]);
    let best = null;
    for (const o of others) if (!near(o, drag.pc.pos) && Math.abs(o - to) < tol && (best == null || Math.abs(o - to) < Math.abs(best - to))) best = o;
    to = best ?? Math.round(to * 2) / 2;
    if (!drag.moved) { if (Math.abs(to - drag.start) < 0.5) return; snap(); drag.moved = true; }
    const before = drag.pc.pos;
    const now = moveWall(drag.pc, drag.g, to);
    drag.pc.pos = now;
    if (before !== now) render();
    const L = drag.g.L[0], R = drag.g.R[0], isV = drag.pc.dir === 'v';
    tip.innerHTML = `${fmt(now)} mm · ${fmt(isV ? L.x1 - L.x0 : L.y1 - L.y0)} | ${fmt(isV ? R.x1 - R.x0 : R.y1 - R.y0)}`;
    const sr = ov.querySelector('.led-stage').getBoundingClientRect();
    tip.style.left = (e.clientX - sr.left + 14) + 'px'; tip.style.top = (e.clientY - sr.top + 14) + 'px';
    tip.classList.remove('hidden');
  });
  const endDrag = () => { if (drag) { drag = null; tip.classList.add('hidden'); render(); } };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  ov.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    const r = selRect != null ? rects[selRect] : null;
    if (a === 'undo') undo();
    else if (a === 'split-v' && r) split(r, 'v');
    else if (a === 'split-h' && r) split(r, 'h');
    else if (a === 'gap' && r) toggleGap(r);
    else if (a === 'delwall') { const pc = findWall(); if (pc) removeWall(pc); }
    else if (a === 'nophoto') { photo = null; try { localStorage.removeItem('ff.photo.' + box.id); } catch { /* */ } render(); }
    else if (a === 'cancel') {
      if (history.length && !discardArmed) { discardArmed = true; e.target.textContent = 'Änderungen verwerfen?'; return; }
      close();
    } else if (a === 'save') {
      const { xs, ys, cells: out } = toGrid();
      if (xs.length - 1 > 60 || ys.length - 1 > 60) return toast('Zu viele unterschiedliche Wandpositionen (max. 60 je Richtung). Lass Wände einrasten.', true);
      const diff = v => v.slice(1).map((x, i) => x - v[i]);
      try {
        await onSave({ rows: ys.length - 1, cols: xs.length - 1, cells: out, col_w: diff(xs), row_h: diff(ys) });
        close();
      } catch { /* Fehler zeigt api() an */ }
    }
  });
  const onKey = e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selWall && !/INPUT/.test(document.activeElement.tagName)) { const pc = findWall(); if (pc) removeWall(pc); }
  };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); ov.remove(); }

  render();
}
