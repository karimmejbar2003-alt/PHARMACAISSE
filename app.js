/* PharmaCaisse — iOS Design */
const App = (() => {

  // ── FIREBASE ───────────────────────────────────────────────────────────
  let db = null;
  const FS_DOC = 'caissepharma/main';

  function initFirebase() {
    if (typeof FIREBASE_CONFIG === 'undefined' || FIREBASE_CONFIG.projectId === 'VOTRE_PROJECT_ID') return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      db.enablePersistence({ synchronizeTabs: false }).catch(() => {});
    } catch(e) { console.warn('Firebase:', e.message); }
  }

  // ── STATE ──────────────────────────────────────────────────────────────
  const state = {
    pharmacies: [],
    entries: {},
    pharmacyId: null,
    date: todayStr(),
    view: 'day',
    detailPharmacyId: null,
    detailDate: null,
  };

  const FOURNISSEURS = ['EXPERT', 'PARA2000', '2A PARA'];

  // ── HELPERS ────────────────────────────────────────────────────────────
  function todayStr() { return new Date().toISOString().split('T')[0]; }

  function formatDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }

  function formatDateLong(d) {
    if (!d) return '';
    try {
      return new Date(d + 'T12:00:00')
        .toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
    } catch(e) { return formatDate(d); }
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function num(v) {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }

  const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmt(v)  { return nf.format(num(v)) + ' DH'; }
  function fmtD(v) { const n = num(v); return (n >= 0 ? '+' : '') + nf.format(n) + ' DH'; }
  function esc(s)  {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }); }
    catch(e) { return ''; }
  }

  // ── STORAGE ────────────────────────────────────────────────────────────
  const STORE_KEY = 'caissepharma_v1';

  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ pharmacies: state.pharmacies, entries: state.entries })); }
    catch(e) {}
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const d = JSON.parse(raw); state.pharmacies = d.pharmacies || []; state.entries = d.entries || {}; }
    } catch(e) {}
  }

  function ensureDefaultPharmacy() {
    if (state.pharmacies.length === 0) {
      state.pharmacies = [
        {
          id: uid(), name: 'Pharmacie AGDAL',
          caisses: [
            { id: uid(), name: 'Haj' },
            { id: uid(), name: 'Hasna' },
            { id: uid(), name: 'Kamal' },
          ]
        },
        {
          id: uid(), name: 'Pharmacie LES AMICALES',
          caisses: [
            { id: uid(), name: 'Zineb' },
            { id: uid(), name: 'Khadija' },
            { id: uid(), name: 'Youssra' },
            { id: uid(), name: 'Lehcen' },
            { id: uid(), name: 'Yamina' },
          ]
        }
      ];
    }
    state.pharmacyId = state.pharmacies[0].id;
  }

  function save() {
    saveLocal();
    if (db) db.doc(FS_DOC).set({ pharmacies: state.pharmacies, entries: state.entries })
      .catch(e => console.warn('Firestore save:', e.message));
  }

  async function load() {
    loadLocal();
    ensureDefaultPharmacy();
    if (db) {
      try {
        const snap = await db.doc(FS_DOC).get();
        if (snap.exists) {
          const d = snap.data();
          if (d.pharmacies?.length) {
            state.pharmacies = d.pharmacies;
            state.entries    = d.entries || {};
            state.pharmacyId = state.pharmacies[0].id;
            saveLocal();
          }
        } else {
          await db.doc(FS_DOC).set({ pharmacies: state.pharmacies, entries: state.entries });
        }
      } catch(e) { console.warn('Firestore load:', e.message); }
    }
  }

  // ── ENTRY ACCESS ───────────────────────────────────────────────────────
  function entryKey(pid, date) { return `${pid}|${date}`; }
  function dayData(pid, date)  { return state.entries[entryKey(pid, date)] || {}; }

  function blank() {
    return { sobrus:'', espece:'', tpe:'', cheque:'', fournisseur_nom:'', fournisseur_montant:'', depenses:'', remise:'', remarque:'', savedAt:null };
  }

  function getEntry(pid, date, cid) { return (dayData(pid, date))[cid] || blank(); }

  function setField(pid, date, cid, field, value) {
    const k = entryKey(pid, date);
    if (!state.entries[k]) state.entries[k] = {};
    if (!state.entries[k][cid]) state.entries[k][cid] = blank();
    state.entries[k][cid][field] = value;
    save();
  }

  // ── CALCULATIONS ────────────────────────────────────────────────────────
  function calc(entry) {
    const sobrus   = num(entry.sobrus);
    const espece   = num(entry.espece);
    const tpe      = num(entry.tpe);
    const cheque   = num(entry.cheque);
    const fourni   = num(entry.fournisseur_montant);
    const depenses = num(entry.depenses);
    const remise   = num(entry.remise);
    const total    = espece + tpe + cheque + fourni + depenses + remise;
    const diff     = total - sobrus;
    const sobrusEntered = entry.sobrus !== '' && entry.sobrus !== null;
    const anyDetail = entry.espece !== '' || entry.tpe !== '' || entry.cheque !== '' ||
                      entry.fournisseur_montant !== '' || entry.depenses !== '' || entry.remise !== '';
    const hasData = sobrusEntered || anyDetail;
    const isValid = sobrusEntered && Math.abs(diff) < 0.005;
    return { sobrus, espece, tpe, cheque, fourni, depenses, remise, total, diff, hasData, isValid, sobrusEntered };
  }

  // ── RENDER ROOT ────────────────────────────────────────────────────────
  function render() {
    const pharmacy = state.pharmacies.find(p => p.id === state.pharmacyId);
    const isDetail = state.view === 'histDetail';

    let navTitle = 'PharmaCaisse';
    let showBack = false;

    if (state.view === 'day')       navTitle = pharmacy?.name ?? 'PharmaCaisse';
    if (state.view === 'history')   navTitle = 'Historique';
    if (state.view === 'settings')  navTitle = 'Réglages';
    if (state.view === 'histDetail') {
      navTitle = formatDate(state.detailDate);
      showBack = true;
    }

    document.getElementById('app').innerHTML = `
      <div class="nav">
        <div class="nav-inner">
          ${showBack
            ? `<button class="nav-back" onclick="App.back()">‹ Retour</button>`
            : `<div style="width:44px"></div>`}
          <div class="nav-title">${esc(navTitle)}</div>
          ${!showBack
            ? `<button class="nav-action" onclick="App.setView('settings')">Réglages</button>`
            : `<div style="width:72px"></div>`}
        </div>
      </div>

      <div class="content">
        ${renderView(pharmacy)}
      </div>

      <nav class="tabbar">
        <button class="tab ${state.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">
          <span class="tab-icon">📋</span>Saisie
        </button>
        <button class="tab ${['history','histDetail'].includes(state.view) ? 'active' : ''}" onclick="App.setView('history')">
          <span class="tab-icon">📅</span>Historique
        </button>
        <button class="tab ${state.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">
          <span class="tab-icon">⚙️</span>Réglages
        </button>
      </nav>`;

    generateIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function renderView(pharmacy) {
    if (state.view === 'day')        return renderDay(pharmacy);
    if (state.view === 'history')    return renderHistory(pharmacy);
    if (state.view === 'histDetail') return renderDetail();
    if (state.view === 'settings')   return renderSettings();
    return '';
  }

  // ── SEGMENTED CONTROL ──────────────────────────────────────────────────
  function renderSegment() {
    if (state.pharmacies.length <= 1) return '';
    return `
      <div class="segment-wrap">
        <div class="segment">
          ${state.pharmacies.map(p => `
            <button class="seg-btn ${p.id === state.pharmacyId ? 'active' : ''}"
              onclick="App.selectPharmacy('${p.id}')">
              ${esc(p.name.replace(/pharmacie\s*/i, ''))}
            </button>`).join('')}
        </div>
      </div>`;
  }

  // ── DAY VIEW ───────────────────────────────────────────────────────────
  function renderDay(pharmacy) {
    if (!pharmacy) return emptyState('🏥', 'Aucune pharmacie', 'Ajoutez-en une dans Réglages.');

    const status  = daySummary(pharmacy);
    const isToday = state.date >= todayStr();
    const cards   = pharmacy.caisses.map((c, i) => renderCard(pharmacy, c, i)).join('');

    return `
      ${renderSegment()}

      <div class="date-row">
        <button class="date-arrow" onclick="App.prevDay()">‹</button>
        <div class="date-center">
          <div class="date-main">${formatDateLong(state.date)}</div>
          <div class="date-sub">${status}</div>
        </div>
        <button class="date-arrow ${isToday ? 'off' : ''}" onclick="App.nextDay()">›</button>
      </div>

      <div class="save-all-bar">
        <button class="btn btn-blue btn-sm" onclick="App.saveAll('${pharmacy.id}')">
          Tout sauvegarder
        </button>
      </div>

      <div class="caisse-grid">
        ${cards}
      </div>`;
  }

  function daySummary(pharmacy) {
    let ok = 0, bad = 0, empty = 0;
    pharmacy.caisses.forEach(c => {
      const r = calc(getEntry(pharmacy.id, state.date, c.id));
      if (!r.hasData) empty++;
      else if (r.isValid) ok++;
      else bad++;
    });
    const parts = [];
    if (ok   > 0) parts.push(`<span style="color:var(--green)">${ok} OK</span>`);
    if (bad  > 0) parts.push(`<span style="color:var(--red)">${bad} écart${bad>1?'s':''}</span>`);
    if (empty> 0) parts.push(`<span style="color:var(--label3)">${empty} vide${empty>1?'s':''}</span>`);
    return parts.join(' · ') || 'Aucune saisie';
  }

  // ── CAISSE CARD ────────────────────────────────────────────────────────
  function renderCard(pharmacy, caisse, idx) {
    const entry = getEntry(pharmacy.id, state.date, caisse.id);
    const c     = calc(entry);
    const pid   = pharmacy.id;
    const cid   = caisse.id;

    const cardCls  = c.hasData ? (c.isValid ? 'ok' : 'bad') : '';
    const badgeCls = c.hasData ? (c.isValid ? 'badge-ok' : 'badge-bad') : 'badge-n';
    const badgeTxt = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : '—';
    const showDiff = !c.isValid && c.hasData && c.sobrusEntered;

    return `
    <div class="card ${cardCls}" id="card-${cid}" style="animation-delay:${idx*0.06}s">

      <div class="card-hd">
        <div class="card-name">💊 ${esc(caisse.name)}</div>
        <span class="badge ${badgeCls}" id="badge-${cid}">${badgeTxt}</span>
      </div>

      <div class="sobrus-wrap">
        <div class="sobrus-lbl">Caisse Sobrus</div>
        <input type="number" class="sobrus-input"
          id="f-${cid}-sobrus"
          placeholder="0,00"
          value="${esc(entry.sobrus)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','sobrus',this.value)">
      </div>

      <div class="inner-lbl">Détail caisse</div>

      <div class="frow">
        <span class="frow-lbl">💵 Espèce</span>
        <input type="number" class="frow-inp"
          id="f-${cid}-espece" placeholder="0,00"
          value="${esc(entry.espece)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','espece',this.value)">
      </div>

      <div class="frow">
        <span class="frow-lbl">💳 TPE</span>
        <input type="number" class="frow-inp"
          id="f-${cid}-tpe" placeholder="0,00"
          value="${esc(entry.tpe)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','tpe',this.value)">
      </div>

      <div class="frow">
        <span class="frow-lbl">🏦 Chèque</span>
        <input type="number" class="frow-inp"
          id="f-${cid}-cheque" placeholder="0,00"
          value="${esc(entry.cheque)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','cheque',this.value)">
      </div>

      <div class="frow">
        <span class="frow-lbl">🏭 Fournisseur</span>
        <div class="fourni-right">
          <select class="fourni-select"
            id="f-${cid}-fournisseur_nom"
            onchange="App.onInput('${pid}','${cid}','fournisseur_nom',this.value)">
            <option value="">Aucun</option>
            ${FOURNISSEURS.map(n => `<option value="${n}" ${entry.fournisseur_nom === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
          <input type="number" class="fourni-inp"
            id="f-${cid}-fournisseur_montant" placeholder="0,00"
            value="${esc(entry.fournisseur_montant)}"
            step="0.01" min="0" inputmode="decimal"
            oninput="App.onInput('${pid}','${cid}','fournisseur_montant',this.value)">
        </div>
      </div>

      <div class="frow">
        <span class="frow-lbl">💸 Dépenses</span>
        <input type="number" class="frow-inp"
          id="f-${cid}-depenses" placeholder="0,00"
          value="${esc(entry.depenses)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','depenses',this.value)">
      </div>

      <div class="frow" style="border-bottom:none">
        <span class="frow-lbl">🏷 Remise</span>
        <input type="number" class="frow-inp"
          id="f-${cid}-remise" placeholder="0,00"
          value="${esc(entry.remise)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','remise',this.value)">
      </div>

      <div class="result-sec ${c.hasData ? 'on' : ''}" id="res-${cid}">
        <div class="result-bg">
          <div class="result-row">
            <span>Total détail</span>
            <span id="rtotal-${cid}">${fmt(c.total)}</span>
          </div>
          <div class="result-row total ${c.isValid ? 'ok' : 'bad'}" id="rcomp-${cid}">
            <span id="rcomp-label-${cid}">${c.isValid ? '✓ Équilibré avec Sobrus' : '✗ Sobrus attendu'}</span>
            <span id="rcomp-val-${cid}">${fmt(c.sobrus)}</span>
          </div>
        </div>
        <div class="diff-row" id="diff-${cid}" style="${showDiff ? '' : 'display:none'}">
          <span>⚠️ Écart</span>
          <span id="diffval-${cid}">${showDiff ? fmtD(c.diff) : ''}</span>
        </div>
      </div>

      <div class="remarque-wrap">
        <div class="remarque-lbl" id="rlabel-${cid}">
          Remarque${showDiff ? ' · Requis si écart' : ''}
        </div>
        <textarea class="remarque-inp"
          id="f-${cid}-remarque"
          placeholder="Cause de l'écart, observations…"
          oninput="App.onInput('${pid}','${cid}','remarque',this.value)"
        >${esc(entry.remarque)}</textarea>
      </div>

      <div class="card-ft">
        <span class="card-ft-status" id="ft-status-${cid}">
          ${entry.savedAt ? `✓ Sauvegardé ${formatTime(entry.savedAt)}` : ''}
        </span>
        <button class="btn btn-blue btn-sm" onclick="App.saveCard('${pid}','${cid}')">
          Sauvegarder
        </button>
      </div>
    </div>`;
  }

  // ── CARD LIVE UPDATE ───────────────────────────────────────────────────
  function updateCard(pid, cid) {
    const entry = getEntry(pid, state.date, cid);
    const c     = calc(entry);
    const card  = document.getElementById(`card-${cid}`);
    if (!card) return;

    card.className = `card ${c.hasData ? (c.isValid ? 'ok' : 'bad') : ''}`;

    const badge = document.getElementById(`badge-${cid}`);
    if (badge) {
      badge.className = `badge ${c.hasData ? (c.isValid ? 'badge-ok' : 'badge-bad') : 'badge-n'}`;
      badge.textContent = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : '—';
    }

    const res = document.getElementById(`res-${cid}`);
    if (res) {
      res.className = `result-sec ${c.hasData ? 'on' : ''}`;
      const rt = document.getElementById(`rtotal-${cid}`);
      if (rt) rt.textContent = fmt(c.total);
      const rc = document.getElementById(`rcomp-${cid}`);
      if (rc) {
        rc.className = `result-row total ${c.isValid ? 'ok' : 'bad'}`;
        document.getElementById(`rcomp-label-${cid}`).textContent = c.isValid ? '✓ Équilibré avec Sobrus' : '✗ Sobrus attendu';
        document.getElementById(`rcomp-val-${cid}`).textContent   = fmt(c.sobrus);
      }
    }

    const showDiff = !c.isValid && c.hasData && c.sobrusEntered;
    const diff = document.getElementById(`diff-${cid}`);
    if (diff) {
      diff.style.display = showDiff ? '' : 'none';
      const dv = document.getElementById(`diffval-${cid}`);
      if (dv) dv.textContent = showDiff ? fmtD(c.diff) : '';
    }

    const rl = document.getElementById(`rlabel-${cid}`);
    if (rl) rl.textContent = `Remarque${showDiff ? ' · Requis si écart' : ''}`;
  }

  // ── HISTORY ────────────────────────────────────────────────────────────
  function renderHistory(pharmacy) {
    if (!pharmacy) return emptyState('📅', 'Aucune pharmacie', '');

    const prefix = `${pharmacy.id}|`;
    const dates  = Object.keys(state.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(state.entries[k]).length > 0)
      .map(k => k.slice(prefix.length))
      .sort().reverse();

    const seg = renderSegment();

    if (dates.length === 0) return seg + emptyState('📅', 'Aucun historique', 'Les saisies apparaîtront ici une fois sauvegardées.');

    const items = dates.map(date => {
      const day    = dayData(pharmacy.id, date);
      const vals   = Object.values(day);
      const count  = vals.length;
      const bad    = vals.filter(e => { const r = calc(e); return r.hasData && !r.isValid; }).length;
      const allOk  = count > 0 && vals.every(e => calc(e).isValid);
      const dotCls = allOk ? 'dot-g' : bad > 0 ? 'dot-r' : 'dot-o';
      const label  = allOk ? 'Tout équilibré' : bad > 0 ? `${bad} écart${bad>1?'s':''}` : 'En cours';

      return `
        <div class="ios-li" onclick="App.showDetail('${pharmacy.id}','${date}')">
          <div class="dot ${dotCls}"></div>
          <div>
            <div class="li-main">${formatDate(date)}</div>
            <div class="li-sub">${count} caisse${count>1?'s':''} · ${label}</div>
          </div>
          <div class="li-chev">›</div>
        </div>`;
    }).join('');

    return `${seg}<div class="sec-hd">Journées archivées</div><div class="ios-list">${items}</div>`;
  }

  // ── HISTORY DETAIL ─────────────────────────────────────────────────────
  function renderDetail() {
    const pharmacy = state.pharmacies.find(p => p.id === state.detailPharmacyId);
    if (!pharmacy) return emptyState('📅', 'Données introuvables', '');

    const day   = dayData(pharmacy.id, state.detailDate);
    const cards = pharmacy.caisses.map(caisse => {
      const entry = day[caisse.id];
      if (!entry) return '';
      const c = calc(entry);
      return `
        <div class="det-card ${c.isValid ? 'ok' : c.hasData ? 'bad' : ''}">
          <div class="det-hd">
            <div class="det-name">💊 ${esc(caisse.name)}</div>
            <span class="badge ${c.isValid ? 'badge-ok' : c.hasData ? 'badge-bad' : 'badge-n'}">
              ${c.isValid ? '✓ Équilibré' : c.hasData ? '✗ Écart' : 'Non saisi'}
            </span>
          </div>
          <div class="det-row"><span class="det-key">Caisse Sobrus</span><span class="det-val">${fmt(c.sobrus)}</span></div>
          <div class="det-row"><span class="det-key">Espèce</span><span class="det-val">${fmt(c.espece)}</span></div>
          <div class="det-row"><span class="det-key">TPE</span><span class="det-val">${fmt(c.tpe)}</span></div>
          <div class="det-row"><span class="det-key">Chèque</span><span class="det-val">${fmt(c.cheque)}</span></div>
          ${(entry.fournisseur_nom || c.fourni > 0) ? `<div class="det-row"><span class="det-key">Fournisseur</span><span class="det-val">${entry.fournisseur_nom ? esc(entry.fournisseur_nom) + ' · ' : ''}${fmt(c.fourni)}</span></div>` : ''}
          <div class="det-row"><span class="det-key">Dépenses</span><span class="det-val">${fmt(c.depenses)}</span></div>
          <div class="det-row"><span class="det-key">Remise</span><span class="det-val">${fmt(c.remise)}</span></div>
          <div class="det-row" style="border-top:1.5px solid var(--sep-l);margin-top:2px;padding-top:12px">
            <span class="det-key" style="font-weight:600">Total</span>
            <span class="det-val ${c.isValid ? 'g' : 'r'}">${fmt(c.total)}</span>
          </div>
          ${!c.isValid && c.hasData ? `<div class="diff-row" style="margin:0;border-radius:0">
            <span>⚠️ Écart</span><span>${fmtD(c.diff)}</span>
          </div>` : ''}
          ${entry.remarque ? `<div class="det-remarque"><strong>📝</strong> ${esc(entry.remarque)}</div>` : ''}
        </div>`;
    }).filter(Boolean).join('');

    return `
      <div class="sec-hd">${esc(pharmacy.name)}</div>
      ${cards || emptyState('📋', 'Aucune donnée', '')}`;
  }

  // ── SETTINGS ───────────────────────────────────────────────────────────
  function renderSettings() {
    const sections = state.pharmacies.map(p => {
      const rows = p.caisses.map(c => `
        <div class="set-row">
          <span class="set-lbl">💊 ${esc(c.name)}</span>
          <div class="set-btns">
            <button class="btn btn-gray btn-sm" onclick="App.renameCaisse('${p.id}','${c.id}')">✏️</button>
            <button class="btn btn-red btn-sm" onclick="App.deleteCaisse('${p.id}','${c.id}')">🗑</button>
          </div>
        </div>`).join('');

      return `
        <div class="set-card">
          <div class="set-hd">
            <span class="set-hd-name">🏥 ${esc(p.name)}</span>
            <button class="btn btn-gray btn-sm" onclick="App.renamePharmacy('${p.id}')">✏️ Renommer</button>
            ${state.pharmacies.length > 1 ? `<button class="btn btn-red btn-sm" onclick="App.deletePharmacy('${p.id}')">🗑</button>` : ''}
          </div>
          ${rows}
          <div class="set-row">
            <button class="btn btn-ghost btn-sm" onclick="App.addCaisse('${p.id}')">+ Ajouter une caisse</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="sec-hd">Pharmacies</div>
      ${sections}
      <div style="padding:0 16px 16px">
        <button class="btn btn-blue btn-full btn-lg" onclick="App.addPharmacy()">
          🏥 Ajouter une pharmacie
        </button>
      </div>

      <div class="sec-hd">Données</div>
      <div class="set-card">
        <div class="set-row">
          <div>
            <div class="set-lbl">Exporter</div>
            <div class="set-sub">Télécharger une sauvegarde JSON</div>
          </div>
          <button class="btn btn-gray btn-sm" onclick="App.exportData()">📤 Export</button>
        </div>
        <div class="set-row">
          <div>
            <div class="set-lbl">Importer</div>
            <div class="set-sub">Restaurer depuis un fichier JSON</div>
          </div>
          <button class="btn btn-gray btn-sm" onclick="App.importData()">📥 Import</button>
        </div>
      </div>
      <div style="text-align:center;color:var(--label2);font-size:13px;padding:12px 0 24px">
        PharmaCaisse · Données stockées localement et dans Firebase
      </div>`;
  }

  // ── EMPTY STATE ────────────────────────────────────────────────────────
  function emptyState(icon, title, text) {
    return `<div class="empty">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      ${text ? `<div class="empty-txt">${text}</div>` : ''}
    </div>`;
  }

  // ── ICON GENERATION ────────────────────────────────────────────────────
  function generateIcon() {
    if (document.querySelector('link[rel="apple-touch-icon"]')) return;
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 180;
      const x = cv.getContext('2d');
      const r = 30;
      x.fillStyle = '#007AFF';
      x.beginPath();
      x.moveTo(r,0); x.lineTo(180-r,0);
      x.arcTo(180,0,180,r,r); x.lineTo(180,180-r);
      x.arcTo(180,180,180-r,180,r); x.lineTo(r,180);
      x.arcTo(0,180,0,180-r,r); x.lineTo(0,r);
      x.arcTo(0,0,r,0,r); x.closePath(); x.fill();
      x.fillStyle = 'white';
      x.fillRect(70, 32, 40, 116);
      x.fillRect(32, 70, 116, 40);
      const link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      link.href = cv.toDataURL('image/png');
      document.head.appendChild(link);
    } catch(e) {}
  }

  // ── BOTTOM SHEET MODAL ─────────────────────────────────────────────────
  function showModal({ title, placeholder, value = '', onConfirm }) {
    removeModal();
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-title">${esc(title)}</div>
        <input class="sheet-inp" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" id="modal-inp" autocomplete="off">
        <div class="sheet-acts">
          <button class="sheet-btn cancel" onclick="App.removeModal()">Annuler</button>
          <button class="sheet-btn confirm" id="modal-ok">Confirmer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('#modal-inp');
    inp.focus(); inp.select();
    const confirm = () => { const v = inp.value.trim(); if (v) { onConfirm(v); removeModal(); } };
    overlay.querySelector('#modal-ok').onclick = confirm;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') removeModal();
    });
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) removeModal(); });
  }

  function showConfirm({ title, message, onConfirm }) {
    removeModal();
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-title">${esc(title)}</div>
        <div class="sheet-msg">${esc(message)}</div>
        <div class="sheet-acts">
          <button class="sheet-btn cancel" onclick="App.removeModal()">Annuler</button>
          <button class="sheet-btn danger" id="modal-ok">Supprimer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modal-ok').onclick = () => { onConfirm(); removeModal(); };
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) removeModal(); });
  }

  function removeModal() { document.getElementById('modal-overlay')?.remove(); }

  // ── TOAST ──────────────────────────────────────────────────────────────
  let _tt;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_tt);
    _tt = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── NAVIGATION ACTIONS ─────────────────────────────────────────────────
  function setView(v) { state.view = v; render(); window.scrollTo(0, 0); }
  function back()     { if (state.view === 'histDetail') { state.view = 'history'; render(); } }

  function prevDay() {
    const d = new Date(state.date + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    state.date = d.toISOString().split('T')[0];
    render();
  }

  function nextDay() {
    if (state.date >= todayStr()) return;
    const d = new Date(state.date + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    state.date = d.toISOString().split('T')[0];
    render();
  }

  function selectPharmacy(id) { state.pharmacyId = id; render(); }

  // ── FIELD ACTIONS ──────────────────────────────────────────────────────
  function onInput(pid, cid, field, value) {
    setField(pid, state.date, cid, field, value);
    updateCard(pid, cid);
  }

  function saveCard(pid, cid) {
    const k = entryKey(pid, state.date);
    if (!state.entries[k]) state.entries[k] = {};
    if (!state.entries[k][cid]) state.entries[k][cid] = blank();
    state.entries[k][cid].savedAt = new Date().toISOString();
    save();
    toast('✓ Sauvegardé');
    const ft = document.getElementById(`ft-status-${cid}`);
    if (ft) ft.textContent = `✓ Sauvegardé ${formatTime(state.entries[k][cid].savedAt)}`;
  }

  function saveAll(pid) {
    const pharmacy = state.pharmacies.find(p => p.id === pid);
    if (!pharmacy) return;
    pharmacy.caisses.forEach(c => saveCard(pid, c.id));
    toast(`✓ ${pharmacy.caisses.length} caisses sauvegardées`);
  }

  function showDetail(pid, date) {
    state.detailPharmacyId = pid;
    state.detailDate = date;
    state.view = 'histDetail';
    render(); window.scrollTo(0, 0);
  }

  // ── PHARMACY CRUD ──────────────────────────────────────────────────────
  function addPharmacy() {
    showModal({ title: 'Nouvelle pharmacie', placeholder: 'Nom de la pharmacie',
      onConfirm: name => {
        const pid = uid();
        state.pharmacies.push({ id: pid, name, caisses: [{ id: uid(), name: 'Caisse 1' }] });
        state.pharmacyId = pid;
        save(); render(); toast('✓ Pharmacie créée');
      }
    });
  }

  function renamePharmacy(pid) {
    const p = state.pharmacies.find(x => x.id === pid);
    if (!p) return;
    showModal({ title: 'Renommer la pharmacie', placeholder: 'Nouveau nom', value: p.name,
      onConfirm: name => { p.name = name; save(); render(); }
    });
  }

  function deletePharmacy(pid) {
    const p = state.pharmacies.find(x => x.id === pid);
    if (!p) return;
    showConfirm({ title: 'Supprimer la pharmacie ?', message: `Toutes les données de "${p.name}" seront supprimées.`,
      onConfirm: () => {
        state.pharmacies = state.pharmacies.filter(x => x.id !== pid);
        Object.keys(state.entries).forEach(k => { if (k.startsWith(pid + '|')) delete state.entries[k]; });
        state.pharmacyId = state.pharmacies[0]?.id ?? null;
        save(); render(); toast('Pharmacie supprimée');
      }
    });
  }

  // ── CAISSE CRUD ────────────────────────────────────────────────────────
  function addCaisse(pid) {
    showModal({ title: 'Nouvelle caisse', placeholder: 'Nom (ex : Haj, Fatima…)',
      onConfirm: name => {
        const p = state.pharmacies.find(x => x.id === pid);
        if (!p) return;
        p.caisses.push({ id: uid(), name });
        save(); render(); toast('✓ Caisse ajoutée');
      }
    });
  }

  function renameCaisse(pid, cid) {
    const p = state.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid);
    if (!c) return;
    showModal({ title: 'Renommer la caisse', placeholder: 'Nouveau nom', value: c.name,
      onConfirm: name => { c.name = name; save(); render(); }
    });
  }

  function deleteCaisse(pid, cid) {
    const p = state.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid);
    if (!c) return;
    if (p.caisses.length <= 1) { toast('⚠️ Au moins une caisse requise'); return; }
    showConfirm({ title: 'Supprimer la caisse ?', message: `"${c.name}" et ses données seront supprimées.`,
      onConfirm: () => {
        p.caisses = p.caisses.filter(x => x.id !== cid);
        Object.values(state.entries).forEach(day => delete day[cid]);
        save(); render(); toast('Caisse supprimée');
      }
    });
  }

  // ── EXPORT / IMPORT ────────────────────────────────────────────────────
  function exportData() {
    const blob = new Blob(
      [JSON.stringify({ pharmacies: state.pharmacies, entries: state.entries }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pharmacaisse_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('✓ Export téléchargé');
  }

  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const d = JSON.parse(ev.target.result);
          if (!Array.isArray(d.pharmacies)) throw new Error();
          state.pharmacies = d.pharmacies;
          state.entries    = d.entries || {};
          state.pharmacyId = state.pharmacies[0]?.id ?? null;
          save(); render(); toast('✓ Import réussi');
        } catch { toast('⚠️ Fichier invalide'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ── INIT ───────────────────────────────────────────────────────────────
  async function init() {
    initFirebase();

    document.getElementById('app').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100dvh;flex-direction:column;gap:16px">
        <div style="width:72px;height:72px;background:#007AFF;border-radius:18px;display:flex;align-items:center;justify-content:center">
          <svg width="40" height="40" viewBox="0 0 20 20" fill="none">
            <rect x="8" y="2" width="4" height="16" rx="1.5" fill="white"/>
            <rect x="2" y="8" width="16" height="4" rx="1.5" fill="white"/>
          </svg>
        </div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.3px;color:#000">PharmaCaisse</div>
        <div style="font-size:14px;color:#8E8E93">${db ? 'Synchronisation…' : 'Chargement…'}</div>
      </div>`;

    await load();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setView, back, prevDay, nextDay,
    selectPharmacy,
    onInput, saveCard, saveAll,
    showDetail,
    addPharmacy, renamePharmacy, deletePharmacy,
    addCaisse, renameCaisse, deleteCaisse,
    exportData, importData,
    removeModal,
  };
})();
