/* CaissePharma — gestion des caisses de pharmacie */
const App = (() => {

  // ── FIREBASE ───────────────────────────────────────────────────────────
  let db = null;
  const FS_DOC = 'caissepharma/main';

  function initFirebase() {
    if (typeof FIREBASE_CONFIG === 'undefined' || FIREBASE_CONFIG.projectId === 'VOTRE_PROJECT_ID') return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      // Cache local Firestore → fonctionne hors connexion
      db.enablePersistence({ synchronizeTabs: false }).catch(() => {});
    } catch(e) { console.warn('Firebase init:', e.message); }
  }

  // ── STATE ──────────────────────────────────────────────────────────────
  const state = {
    pharmacies: [],
    entries: {},   // key: "pharmacyId|YYYY-MM-DD" → { caisseId: {sobrus,espece,tpe,remise,remarque,savedAt} }
    pharmacyId: null,
    date: todayStr(),
    view: 'day',          // day | history | histDetail | settings
    detailPharmacyId: null,
    detailDate: null,
  };

  // ── HELPERS ────────────────────────────────────────────────────────────
  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function formatDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  }

  function num(v) {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }

  const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmt(v)    { return nf.format(num(v)) + ' DH'; }
  function fmtD(v)   { const n = num(v); return (n >= 0 ? '+' : '') + nf.format(n) + ' DH'; }
  function esc(s)    { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── STORAGE ────────────────────────────────────────────────────────────
  const STORE_KEY = 'caissepharma_v1';

  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ pharmacies: state.pharmacies, entries: state.entries }));
    } catch(e) {}
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        state.pharmacies = d.pharmacies || [];
        state.entries    = d.entries    || {};
      }
    } catch(e) {}
  }

  function ensureDefaultPharmacy() {
    if (state.pharmacies.length === 0) {
      state.pharmacies = [
        {
          id: uid(),
          name: 'Pharmacie AGDAL',
          caisses: [
            { id: uid(), name: 'Haj'   },
            { id: uid(), name: 'Hasna' },
            { id: uid(), name: 'Kamal' },
          ]
        },
        {
          id: uid(),
          name: 'Pharmacie LES AMICALES',
          caisses: [
            { id: uid(), name: 'Zineb'   },
            { id: uid(), name: 'Khadija' },
            { id: uid(), name: 'Youssra' },
            { id: uid(), name: 'Lehcen'  },
            { id: uid(), name: 'Yamina'  },
          ]
        }
      ];
    }
    state.pharmacyId = state.pharmacies[0].id;
  }

  // Sauvegarde localStorage (immédiat) + Firestore (cloud, arrière-plan)
  function save() {
    saveLocal();
    if (db) {
      db.doc(FS_DOC)
        .set({ pharmacies: state.pharmacies, entries: state.entries })
        .catch(e => console.warn('Firestore save:', e.message));
    }
  }

  async function load() {
    // 1. Chargement local immédiat (affichage instantané)
    loadLocal();
    ensureDefaultPharmacy();

    // 2. Synchronisation Firestore (cloud)
    if (db) {
      try {
        const snap = await db.doc(FS_DOC).get();
        if (snap.exists) {
          const d = snap.data();
          if (d.pharmacies?.length) {
            state.pharmacies = d.pharmacies;
            state.entries    = d.entries || {};
            state.pharmacyId = state.pharmacies[0].id;
            saveLocal(); // Met à jour le cache local
          }
        } else {
          // Première connexion : pousse les données locales vers Firestore
          await db.doc(FS_DOC).set({ pharmacies: state.pharmacies, entries: state.entries });
        }
      } catch(e) {
        console.warn('Firestore load (mode hors-ligne ?):', e.message);
      }
    }
  }

  // ── ENTRY ACCESS ───────────────────────────────────────────────────────
  function entryKey(pid, date)    { return `${pid}|${date}`; }
  function dayData(pid, date)     { return state.entries[entryKey(pid, date)] || {}; }

  function getEntry(pid, date, cid) {
    return (dayData(pid, date))[cid] || { sobrus:'', espece:'', tpe:'', cheque:'', fournisseur_nom:'', fournisseur_montant:'', depenses:'', remise:'', remarque:'', savedAt:null };
  }

  function setField(pid, date, cid, field, value) {
    const k = entryKey(pid, date);
    if (!state.entries[k]) state.entries[k] = {};
    if (!state.entries[k][cid]) state.entries[k][cid] = { sobrus:'', espece:'', tpe:'', cheque:'', fournisseur_nom:'', fournisseur_montant:'', depenses:'', remise:'', remarque:'', savedAt:null };
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

    let headerTitle = 'CaissePharma';
    let headerSub   = '';
    let showBack    = false;

    if (state.view === 'day') {
      headerTitle = pharmacy?.name ?? 'CaissePharma';
      headerSub   = formatDate(state.date);
    } else if (state.view === 'history') {
      headerTitle = 'Historique';
    } else if (state.view === 'histDetail') {
      const dp = state.pharmacies.find(p => p.id === state.detailPharmacyId);
      headerTitle = dp?.name ?? 'Détail';
      headerSub   = formatDate(state.detailDate);
      showBack    = true;
    } else if (state.view === 'settings') {
      headerTitle = 'Réglages';
    }

    document.getElementById('app').innerHTML = `
      <div class="header">
        <div class="header-inner">
          ${showBack ? `<button class="btn-icon" onclick="App.back()" aria-label="Retour">‹</button>` : `
          <div class="header-logo">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="8" y="2" width="4" height="16" rx="1.5" fill="white"/>
              <rect x="2" y="8" width="16" height="4" rx="1.5" fill="white"/>
            </svg>
          </div>`}
          <div class="header-text">
            <div class="header-title">${esc(headerTitle)}</div>
            ${headerSub ? `<div class="header-subtitle">${esc(headerSub)}</div>` : ''}
          </div>
        </div>
      </div>

      <div class="content">
        ${renderView(pharmacy)}
      </div>

      <nav class="bottom-nav">
        <button class="nav-item ${state.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">
          <span class="nav-icon">📋</span>Saisie
        </button>
        <button class="nav-item ${['history','histDetail'].includes(state.view) ? 'active' : ''}" onclick="App.setView('history')">
          <span class="nav-icon">📅</span>Historique
        </button>
        <button class="nav-item ${state.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">
          <span class="nav-icon">⚙️</span>Réglages
        </button>
      </nav>
    `;

    generateIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function renderView(pharmacy) {
    if (state.view === 'day')       return renderDay(pharmacy);
    if (state.view === 'history')   return renderHistory(pharmacy);
    if (state.view === 'histDetail') return renderDetail();
    if (state.view === 'settings')  return renderSettings();
    return '';
  }

  // ── DAY VIEW ───────────────────────────────────────────────────────────
  function renderDay(pharmacy) {
    if (!pharmacy) return emptyState('🏥', 'Aucune pharmacie', 'Ajoutez-en une dans Réglages.');

    const cards  = pharmacy.caisses.map((c, i) => renderCard(pharmacy, c, i)).join('');
    const status = daySummary(pharmacy);

    return `
      <div class="controls-bar">
        <div class="pharma-select-wrap">
          <select class="pharma-select" onchange="App.selectPharmacy(this.value)">
            ${state.pharmacies.map(p => `<option value="${p.id}" ${p.id === state.pharmacyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <input type="date" class="date-input" value="${state.date}" max="${todayStr()}"
          onchange="App.changeDate(this.value)" aria-label="Date">
        ${state.date !== todayStr() ? `<button class="btn-today" onclick="App.changeDate('${todayStr()}')">Auj.</button>` : ''}
      </div>

      <div class="save-all-bar">
        <div class="day-summary">
          <strong>${formatDate(state.date)}</strong><br>${status}
        </div>
        <button class="btn btn-primary btn-sm" onclick="App.saveAll('${pharmacy.id}')">
          💾 Tout sauvegarder
        </button>
      </div>

      <div class="caisse-grid">
        ${cards}
      </div>
    `;
  }

  function daySummary(pharmacy) {
    let ok = 0, issues = 0, empty = 0;
    pharmacy.caisses.forEach(c => {
      const e = getEntry(pharmacy.id, state.date, c.id);
      const r = calc(e);
      if (!r.hasData)      empty++;
      else if (r.isValid)  ok++;
      else                 issues++;
    });
    const parts = [];
    if (ok     > 0) parts.push(`<span style="color:var(--green)">${ok} équilibrée${ok > 1 ? 's' : ''}</span>`);
    if (issues > 0) parts.push(`<span style="color:var(--red)">${issues} écart${issues > 1 ? 's' : ''}</span>`);
    if (empty  > 0) parts.push(`<span style="color:var(--gray-400)">${empty} non saisie${empty > 1 ? 's' : ''}</span>`);
    return parts.join(' · ') || 'Aucune saisie';
  }

  function renderCard(pharmacy, caisse, idx) {
    const entry = getEntry(pharmacy.id, state.date, caisse.id);
    const c = calc(entry);
    const pid = pharmacy.id;
    const cid = caisse.id;

    const cardClass   = c.hasData ? (c.isValid ? 'valid' : 'invalid') : '';
    const badgeClass  = c.hasData ? (c.isValid ? 'badge-valid' : 'badge-invalid') : 'badge-neutral';
    const badgeText   = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : 'En attente';

    const showResult  = c.hasData;
    const showDiff    = !c.isValid && c.hasData && c.sobrusEntered;

    const savedInfo = entry.savedAt
      ? `<span class="save-status">✓ Sauvegardé ${formatTime(entry.savedAt)}</span>`
      : `<span class="save-status"></span>`;

    return `
    <div class="caisse-card ${cardClass}" id="card-${cid}" style="animation-delay:${idx*0.06}s">
      <div class="caisse-head">
        <div class="caisse-name">💊 ${esc(caisse.name)}</div>
        <span class="badge ${badgeClass}" data-badge="${cid}">${badgeText}</span>
      </div>

      <div class="caisse-body">
        <div class="field-label">🖥 Caisse Sobrus</div>
        <input type="number" class="input-field input-sobrus"
          id="f-${cid}-sobrus"
          placeholder="Montant affiché Sobrus"
          value="${esc(entry.sobrus)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','sobrus',this.value)">

        <div class="sep">Détail caisse</div>

        <div class="trio">
          <div>
            <div class="field-label">💵 Espèce</div>
            <input type="number" class="input-field"
              id="f-${cid}-espece"
              placeholder="0,00"
              value="${esc(entry.espece)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','espece',this.value)">
          </div>
          <div>
            <div class="field-label">💳 TPE</div>
            <input type="number" class="input-field"
              id="f-${cid}-tpe"
              placeholder="0,00"
              value="${esc(entry.tpe)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','tpe',this.value)">
          </div>
          <div>
            <div class="field-label">🏦 Chèque</div>
            <input type="number" class="input-field"
              id="f-${cid}-cheque"
              placeholder="0,00"
              value="${esc(entry.cheque)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','cheque',this.value)">
          </div>
        </div>

        <div class="fournisseur-row">
          <div>
            <div class="field-label">🏭 Fournisseur</div>
            <select class="select-field"
              id="f-${cid}-fournisseur_nom"
              onchange="App.onInput('${pid}','${cid}','fournisseur_nom',this.value)">
              <option value="">— Aucun —</option>
              ${['EXPERT','PARA2000','2A PARA'].map(n => `<option value="${n}" ${entry.fournisseur_nom === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div>
            <div class="field-label">💰 Montant</div>
            <input type="number" class="input-field"
              id="f-${cid}-fournisseur_montant"
              placeholder="0,00"
              value="${esc(entry.fournisseur_montant)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','fournisseur_montant',this.value)">
          </div>
        </div>

        <div class="duo">
          <div>
            <div class="field-label">💸 Dépenses</div>
            <input type="number" class="input-field"
              id="f-${cid}-depenses"
              placeholder="0,00"
              value="${esc(entry.depenses)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','depenses',this.value)">
          </div>
          <div>
            <div class="field-label">🏷 Remise</div>
            <input type="number" class="input-field"
              id="f-${cid}-remise"
              placeholder="0,00"
              value="${esc(entry.remise)}"
              step="0.01" min="0" inputmode="decimal"
              oninput="App.onInput('${pid}','${cid}','remise',this.value)">
          </div>
        </div>

        <div class="result-section ${showResult ? 'show' : ''}" id="res-${cid}">
          <div class="result-box">
            <div class="result-row">
              <span>Total détail</span>
              <span style="font-weight:600" id="rtotal-${cid}">${fmt(c.total)}</span>
            </div>
            <div class="result-row total ${c.isValid ? 'ok' : 'bad'}" id="rcomp-${cid}">
              <span id="rcomp-label-${cid}">${c.isValid ? '✓ Équilibré' : '✗ Total Sobrus'}</span>
              <span id="rcomp-val-${cid}">${fmt(c.sobrus)}</span>
            </div>
          </div>
          <div class="diff-alert ${showDiff ? '' : 'hidden'}" id="diff-${cid}" style="${showDiff ? '' : 'display:none'}">
            ⚠️ Écart&nbsp;: <span id="diffval-${cid}">${fmtD(c.diff)}</span>
          </div>
        </div>

        <div class="remarque-wrap">
          <div class="field-label" id="rlabel-${cid}">📝 Remarque${showDiff ? ' <span style="color:var(--red)">· requis si écart</span>' : ''}</div>
          <textarea class="remarque-field"
            id="f-${cid}-remarque"
            placeholder="Cause de l'écart, observations…"
            oninput="App.onInput('${pid}','${cid}','remarque',this.value)"
          >${esc(entry.remarque)}</textarea>
        </div>
      </div>

      <div class="caisse-foot">
        ${savedInfo}
        <button class="btn btn-primary btn-sm" onclick="App.saveCard('${pid}','${cid}')">
          💾 Sauvegarder
        </button>
      </div>
    </div>`;
  }

  // ── CARD LIVE UPDATE ───────────────────────────────────────────────────
  function updateCard(pid, cid) {
    const entry  = getEntry(pid, state.date, cid);
    const c      = calc(entry);
    const card   = document.getElementById(`card-${cid}`);
    if (!card) return;

    // Border
    card.className = `caisse-card ${c.hasData ? (c.isValid ? 'valid' : 'invalid') : ''}`;

    // Badge
    const badge = document.querySelector(`[data-badge="${cid}"]`);
    if (badge) {
      badge.className = `badge ${c.hasData ? (c.isValid ? 'badge-valid' : 'badge-invalid') : 'badge-neutral'}`;
      badge.textContent = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : 'En attente';
    }

    // Result section
    const res = document.getElementById(`res-${cid}`);
    if (res) {
      res.className = `result-section ${c.hasData ? 'show' : ''}`;
      const rtotal = document.getElementById(`rtotal-${cid}`);
      if (rtotal) rtotal.textContent = fmt(c.total);
      const rcomp = document.getElementById(`rcomp-${cid}`);
      if (rcomp) {
        rcomp.className = `result-row total ${c.isValid ? 'ok' : 'bad'}`;
        document.getElementById(`rcomp-label-${cid}`).textContent = c.isValid ? '✓ Équilibré' : '✗ Total Sobrus';
        document.getElementById(`rcomp-val-${cid}`).textContent   = fmt(c.sobrus);
      }
    }

    // Diff
    const diff    = document.getElementById(`diff-${cid}`);
    const showDiff = !c.isValid && c.hasData && c.sobrusEntered;
    if (diff) {
      diff.style.display = showDiff ? '' : 'none';
      const dv = document.getElementById(`diffval-${cid}`);
      if (dv) dv.textContent = fmtD(c.diff);
    }

    // Remarque label
    const rl = document.getElementById(`rlabel-${cid}`);
    if (rl) rl.innerHTML = `📝 Remarque${showDiff ? ' <span style="color:var(--red)">· requis si écart</span>' : ''}`;
  }

  // ── HISTORY VIEW ───────────────────────────────────────────────────────
  function renderHistory(pharmacy) {
    if (!pharmacy) return emptyState('📅', 'Aucune pharmacie', 'Ajoutez-en une dans Réglages.');

    const prefix = `${pharmacy.id}|`;
    const dates  = Object.keys(state.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(state.entries[k]).length > 0)
      .map(k => k.slice(prefix.length))
      .sort().reverse();

    const selector = `
      <div class="controls-bar" style="margin-bottom:16px">
        <div class="pharma-select-wrap" style="flex:1">
          <select class="pharma-select" onchange="App.selectPharmacy(this.value)">
            ${state.pharmacies.map(p => `<option value="${p.id}" ${p.id === state.pharmacyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
      </div>`;

    if (dates.length === 0) {
      return selector + emptyState('📅', 'Aucun historique', 'Les saisies sauvegardées apparaîtront ici.');
    }

    const items = dates.map(date => {
      const day     = dayData(pharmacy.id, date);
      const entries = Object.values(day);
      const count   = entries.length;
      const issues  = entries.filter(e => { const r = calc(e); return r.hasData && !r.isValid; }).length;
      const allOk   = count > 0 && entries.every(e => calc(e).isValid);
      const dotClass = allOk ? 'dot-ok' : issues > 0 ? 'dot-issue' : 'dot-partial';
      const label    = allOk ? 'Tout équilibré' : issues > 0 ? `${issues} écart${issues>1?'s':''}` : 'En cours';

      return `
        <div class="history-item" onclick="App.showDetail('${pharmacy.id}','${date}')">
          <div class="status-dot ${dotClass}"></div>
          <div>
            <div class="history-date">${formatDate(date)}</div>
            <div class="history-sub">${count} caisse${count>1?'s':''} · ${label}</div>
          </div>
          <div class="chevron">›</div>
        </div>`;
    }).join('');

    return selector + `<div class="section-title">Journées archivées</div><div class="history-list">${items}</div>`;
  }

  // ── DETAIL VIEW ────────────────────────────────────────────────────────
  function renderDetail() {
    const pharmacy = state.pharmacies.find(p => p.id === state.detailPharmacyId);
    if (!pharmacy) return emptyState('📅', 'Données introuvables', '');

    const day   = dayData(pharmacy.id, state.detailDate);
    const cards = pharmacy.caisses.map(caisse => {
      const entry = day[caisse.id];
      if (!entry) return '';
      const c = calc(entry);
      return `
        <div class="detail-card ${c.isValid ? 'valid' : c.hasData ? 'invalid' : ''}">
          <div class="detail-head">
            <div class="detail-name">💊 ${esc(caisse.name)}</div>
            <span class="badge ${c.isValid ? 'badge-valid' : c.hasData ? 'badge-invalid' : 'badge-neutral'}">
              ${c.isValid ? '✓ Équilibré' : c.hasData ? '✗ Écart' : 'Non saisi'}
            </span>
          </div>
          <div class="detail-body">
            <div class="detail-row"><span class="detail-key">Caisse Sobrus</span><span class="detail-val">${fmt(c.sobrus)}</span></div>
            <div class="detail-row"><span class="detail-key">Espèce</span><span class="detail-val">${fmt(c.espece)}</span></div>
            <div class="detail-row"><span class="detail-key">TPE</span><span class="detail-val">${fmt(c.tpe)}</span></div>
            <div class="detail-row"><span class="detail-key">Chèque</span><span class="detail-val">${fmt(c.cheque)}</span></div>
            ${(entry.fournisseur_nom || c.fourni > 0) ? `<div class="detail-row"><span class="detail-key">Fournisseur</span><span class="detail-val">${entry.fournisseur_nom ? esc(entry.fournisseur_nom) + ' · ' : ''}${fmt(c.fourni)}</span></div>` : ''}
            <div class="detail-row"><span class="detail-key">Dépenses</span><span class="detail-val">${fmt(c.depenses)}</span></div>
            <div class="detail-row"><span class="detail-key">Remise</span><span class="detail-val">${fmt(c.remise)}</span></div>
            <div class="detail-row" style="margin-top:6px;padding-top:10px;border-top:2px solid var(--gray-200)">
              <span class="detail-key" style="font-weight:600">Total</span>
              <span class="detail-val ${c.isValid ? '' : 'bad'}" style="color:${c.isValid?'var(--green)':'var(--red)'}">${fmt(c.total)}</span>
            </div>
            ${!c.isValid && c.hasData ? `
              <div class="diff-alert" style="margin-top:10px">⚠️ Écart&nbsp;: ${fmtD(c.diff)}</div>` : ''}
            ${entry.remarque ? `
              <div class="detail-remarque"><strong>📝 Remarque :</strong> ${esc(entry.remarque)}</div>` : ''}
          </div>
        </div>`;
    }).filter(Boolean).join('');

    return `
      <div class="section-title" style="margin-bottom:14px">${esc(pharmacy.name)} — ${formatDate(state.detailDate)}</div>
      ${cards || emptyState('📋', 'Aucune donnée', '')}`;
  }

  // ── SETTINGS ───────────────────────────────────────────────────────────
  function renderSettings() {
    const sections = state.pharmacies.map(p => {
      const rows = p.caisses.map(c => `
        <div class="settings-row">
          <div class="settings-label">💊 ${esc(c.name)}</div>
          <div style="display:flex;gap:7px">
            <button class="btn btn-outline btn-sm" onclick="App.renameCaisse('${p.id}','${c.id}')">✏️</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCaisse('${p.id}','${c.id}')">🗑</button>
          </div>
        </div>`).join('');

      return `
        <div class="settings-card">
          <div class="settings-card-head">
            <span class="ph-name">🏥 ${esc(p.name)}</span>
            <button class="btn btn-outline btn-sm" onclick="App.renamePharmacy('${p.id}')">✏️ Renommer</button>
            ${state.pharmacies.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="App.deletePharmacy('${p.id}')">🗑</button>` : ''}
          </div>
          ${rows}
          <div class="settings-row">
            <button class="btn btn-outline btn-sm" onclick="App.addCaisse('${p.id}')">+ Ajouter une caisse</button>
          </div>
        </div>`;
    }).join('');

    return `
      ${sections}

      <button class="btn btn-primary btn-full" style="margin-bottom:24px" onclick="App.addPharmacy()">
        🏥 Ajouter une pharmacie
      </button>

      <div class="settings-card">
        <div class="settings-card-head">Sauvegarde & Export</div>
        <div class="settings-row">
          <div><div class="settings-label">Exporter les données</div><div class="settings-sub">Fichier JSON de sauvegarde</div></div>
          <button class="btn btn-outline btn-sm" onclick="App.exportData()">📤 Export</button>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Importer des données</div><div class="settings-sub">Restaurer depuis JSON</div></div>
          <button class="btn btn-outline btn-sm" onclick="App.importData()">📥 Import</button>
        </div>
      </div>

      <div style="text-align:center;color:var(--gray-400);font-size:13px;padding:16px 0">
        CaissePharma · Données stockées localement
      </div>`;
  }

  // ── HELPERS ─────────────────────────────────────────────────────────────
  function emptyState(icon, title, text) {
    return `<div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      ${text ? `<div class="empty-text">${text}</div>` : ''}
    </div>`;
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch(e) { return ''; }
  }

  // ── ICON GENERATION ────────────────────────────────────────────────────
  function generateIcon() {
    if (document.querySelector('link[rel="apple-touch-icon"]')) return;
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 180;
      const x = cv.getContext('2d');
      const r = 30;
      x.fillStyle = '#1e40af';
      x.beginPath();
      x.moveTo(r, 0); x.lineTo(180-r, 0);
      x.arcTo(180, 0, 180, r, r);
      x.lineTo(180, 180-r);
      x.arcTo(180, 180, 180-r, 180, r);
      x.lineTo(r, 180);
      x.arcTo(0, 180, 0, 180-r, r);
      x.lineTo(0, r);
      x.arcTo(0, 0, r, 0, r);
      x.closePath();
      x.fill();
      x.fillStyle = 'white';
      x.fillRect(70, 32, 40, 116);
      x.fillRect(32, 70, 116, 40);
      const link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      link.href = cv.toDataURL('image/png');
      document.head.appendChild(link);
    } catch(e) {}
  }

  // ── MODAL ──────────────────────────────────────────────────────────────
  function showModal({ title, placeholder, value = '', onConfirm }) {
    removeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${esc(title)}</div>
        <input class="modal-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" id="modal-inp" autocomplete="off">
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="App.removeModal()">Annuler</button>
          <button class="btn btn-primary" id="modal-ok">Confirmer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('#modal-inp');
    inp.focus(); inp.select();
    const confirm = () => {
      const v = inp.value.trim();
      if (v) { onConfirm(v); removeModal(); }
    };
    overlay.querySelector('#modal-ok').onclick = confirm;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') removeModal();
    });
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) removeModal(); });
  }

  function showConfirm({ title, message, onConfirm, danger = true }) {
    removeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${esc(title)}</div>
        <p style="color:var(--gray-500);margin-bottom:18px;font-size:15px">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="App.removeModal()">Annuler</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-ok">${danger ? '🗑 Supprimer' : 'Confirmer'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modal-ok').onclick = () => { onConfirm(); removeModal(); };
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) removeModal(); });
  }

  function removeModal() {
    document.getElementById('modal-overlay')?.remove();
  }

  // ── TOAST ──────────────────────────────────────────────────────────────
  let _toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── PUBLIC ACTIONS ─────────────────────────────────────────────────────
  function setView(v) {
    state.view = v;
    render();
    window.scrollTo(0, 0);
  }

  function back() {
    if (state.view === 'histDetail') { state.view = 'history'; render(); }
  }

  function selectPharmacy(id) {
    state.pharmacyId = id;
    render();
  }

  function changeDate(d) {
    state.date = d;
    render();
  }

  function onInput(pid, cid, field, value) {
    setField(pid, state.date, cid, field, value);
    updateCard(pid, cid);
  }

  function saveCard(pid, cid) {
    const k = entryKey(pid, state.date);
    if (!state.entries[k]) state.entries[k] = {};
    if (!state.entries[k][cid]) state.entries[k][cid] = { sobrus:'', espece:'', tpe:'', cheque:'', fournisseur_nom:'', fournisseur_montant:'', depenses:'', remise:'', remarque:'' };
    state.entries[k][cid].savedAt = new Date().toISOString();
    save();
    toast('✓ Sauvegardé');
    const foot = document.querySelector(`#card-${cid} .caisse-foot .save-status`);
    if (foot) {
      const t = formatTime(state.entries[k][cid].savedAt);
      foot.textContent = `✓ Sauvegardé ${t}`;
    }
  }

  function saveAll(pid) {
    const pharmacy = state.pharmacies.find(p => p.id === pid);
    if (!pharmacy) return;
    pharmacy.caisses.forEach(c => saveCard(pid, c.id));
    toast(`✓ Tout sauvegardé (${pharmacy.caisses.length} caisses)`);
  }

  function showDetail(pid, date) {
    state.detailPharmacyId = pid;
    state.detailDate = date;
    state.view = 'histDetail';
    render();
    window.scrollTo(0, 0);
  }

  // ── PHARMACY CRUD ──────────────────────────────────────────────────────
  function addPharmacy() {
    showModal({
      title: 'Nouvelle pharmacie',
      placeholder: 'Nom de la pharmacie',
      onConfirm: name => {
        const pid = uid();
        state.pharmacies.push({ id: pid, name, caisses: [{ id: uid(), name: 'Caisse 1' }] });
        state.pharmacyId = pid;
        save(); render();
        toast('✓ Pharmacie créée');
      }
    });
  }

  function renamePharmacy(pid) {
    const p = state.pharmacies.find(x => x.id === pid);
    if (!p) return;
    showModal({
      title: 'Renommer la pharmacie',
      placeholder: 'Nouveau nom',
      value: p.name,
      onConfirm: name => { p.name = name; save(); render(); }
    });
  }

  function deletePharmacy(pid) {
    const p = state.pharmacies.find(x => x.id === pid);
    if (!p) return;
    showConfirm({
      title: 'Supprimer la pharmacie ?',
      message: `Toutes les données de "${p.name}" seront définitivement supprimées.`,
      onConfirm: () => {
        state.pharmacies = state.pharmacies.filter(x => x.id !== pid);
        Object.keys(state.entries).forEach(k => { if (k.startsWith(pid + '|')) delete state.entries[k]; });
        state.pharmacyId = state.pharmacies[0]?.id ?? null;
        save(); render();
        toast('Pharmacie supprimée');
      }
    });
  }

  // ── CAISSE CRUD ────────────────────────────────────────────────────────
  function addCaisse(pid) {
    showModal({
      title: 'Nouvelle caisse',
      placeholder: 'Nom (ex : Haj, Fatima…)',
      onConfirm: name => {
        const p = state.pharmacies.find(x => x.id === pid);
        if (!p) return;
        p.caisses.push({ id: uid(), name });
        save(); render();
        toast('✓ Caisse ajoutée');
      }
    });
  }

  function renameCaisse(pid, cid) {
    const p = state.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid);
    if (!c) return;
    showModal({
      title: 'Renommer la caisse',
      placeholder: 'Nouveau nom',
      value: c.name,
      onConfirm: name => { c.name = name; save(); render(); }
    });
  }

  function deleteCaisse(pid, cid) {
    const p = state.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid);
    if (!c) return;
    if (p.caisses.length <= 1) { toast('⚠️ Au moins une caisse est requise'); return; }
    showConfirm({
      title: 'Supprimer la caisse ?',
      message: `"${c.name}" et toutes ses données seront supprimées.`,
      onConfirm: () => {
        p.caisses = p.caisses.filter(x => x.id !== cid);
        Object.values(state.entries).forEach(day => delete day[cid]);
        save(); render();
        toast('Caisse supprimée');
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
    a.href  = URL.createObjectURL(blob);
    a.download = `caissepharma_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('✓ Export téléchargé');
  }

  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const d = JSON.parse(ev.target.result);
          if (!Array.isArray(d.pharmacies)) throw new Error();
          state.pharmacies = d.pharmacies;
          state.entries    = d.entries || {};
          state.pharmacyId = state.pharmacies[0]?.id ?? null;
          save(); render();
          toast('✓ Import réussi');
        } catch { toast('⚠️ Fichier invalide'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ── INIT ───────────────────────────────────────────────────────────────
  async function init() {
    initFirebase();

    // Écran de démarrage
    document.getElementById('app').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100dvh;flex-direction:column;gap:14px">
        <div style="width:64px;height:64px;background:#1e40af;border-radius:16px;display:flex;align-items:center;justify-content:center">
          <svg width="36" height="36" viewBox="0 0 20 20" fill="none">
            <rect x="8" y="2" width="4" height="16" rx="1.5" fill="white"/>
            <rect x="2" y="8" width="16" height="4" rx="1.5" fill="white"/>
          </svg>
        </div>
        <div style="font-size:17px;font-weight:700;color:#1e293b">CaissePharma</div>
        <div style="font-size:13px;color:#94a3b8">${db ? 'Synchronisation…' : 'Chargement…'}</div>
      </div>`;

    await load();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);

  // ── PUBLIC API ─────────────────────────────────────────────────────────
  return {
    setView, back,
    selectPharmacy, changeDate,
    onInput, saveCard, saveAll,
    showDetail,
    addPharmacy, renamePharmacy, deletePharmacy,
    addCaisse, renameCaisse, deleteCaisse,
    exportData, importData,
    removeModal,
  };
})();
