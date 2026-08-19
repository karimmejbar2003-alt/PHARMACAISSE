/* PharmaCaisse — iOS 26 Premium */
const App = (() => {

  // ── FIREBASE ────────────────────────────────────────────────────────────
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

  // ── STATE ───────────────────────────────────────────────────────────────
  const S = {
    pharmacies: [], entries: {},
    pharmacyId: null, date: today(),
    view: 'day', detailPid: null, detailDate: null,
  };

  const FOURNISSEURS = ['EXPERT', 'PARA2000', '2A PARA'];

  // ── EMPLOYEE MODE ────────────────────────────────────────────────────────
  const _urlParams = new URLSearchParams(window.location.search);
  const EMP = { pid: _urlParams.get('pid'), cid: _urlParams.get('emp') };
  const IS_EMP = !!(EMP.pid && EMP.cid);

  // ── HELPERS ─────────────────────────────────────────────────────────────
  function today() { return new Date().toISOString().split('T')[0]; }

  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }

  function fmtDateLong(d) {
    if (!d) return '';
    try {
      return new Date(d + 'T12:00:00')
        .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    } catch { return fmtDate(d); }
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }); }
    catch { return ''; }
  }

  function uid() {
    return crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function num(v) { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; }

  const NF = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmt(v)  { return NF.format(num(v)) + ' DH'; }
  function fmtD(v) { const n = num(v); return (n >= 0 ? '+' : '') + NF.format(n) + ' DH'; }
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── STORAGE ─────────────────────────────────────────────────────────────
  const KEY = 'caissepharma_v1';

  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify({ pharmacies: S.pharmacies, entries: S.entries })); }
    catch {}
  }

  function loadLocal() {
    try {
      const r = localStorage.getItem(KEY);
      if (r) { const d = JSON.parse(r); S.pharmacies = d.pharmacies || []; S.entries = d.entries || {}; }
    } catch {}
  }

  function defaults() {
    if (S.pharmacies.length === 0) {
      S.pharmacies = [
        { id: uid(), name: 'Pharmacie AGDAL', caisses: [
          { id: uid(), name: 'Haj' }, { id: uid(), name: 'Hasna' }, { id: uid(), name: 'Kamal' }
        ]},
        { id: uid(), name: 'Pharmacie LES AMICALES', caisses: [
          { id: uid(), name: 'Zineb' }, { id: uid(), name: 'Khadija' },
          { id: uid(), name: 'Youssra' }, { id: uid(), name: 'Lehcen' }, { id: uid(), name: 'Yamina' }
        ]}
      ];
    }
    S.pharmacyId = S.pharmacies[0].id;
  }

  function save() {
    saveLocal();
    if (db) db.doc(FS_DOC).set({ pharmacies: S.pharmacies, entries: S.entries })
      .catch(e => console.warn('FS save:', e.message));
  }

  async function load() {
    loadLocal(); defaults();
    if (db) {
      try {
        const snap = await db.doc(FS_DOC).get();
        if (snap.exists) {
          const d = snap.data();
          if (d.pharmacies?.length) {
            S.pharmacies = d.pharmacies; S.entries = d.entries || {};
            S.pharmacyId = S.pharmacies[0].id; saveLocal();
          }
        } else {
          await db.doc(FS_DOC).set({ pharmacies: S.pharmacies, entries: S.entries });
        }
      } catch(e) { console.warn('FS load:', e.message); }
    }
  }

  // ── ENTRIES ─────────────────────────────────────────────────────────────
  function eKey(pid, date) { return `${pid}|${date}`; }
  function dayData(pid, date) { return S.entries[eKey(pid, date)] || {}; }

  function blank() {
    return { sobrus:'', espece:'', tpe:'', cheque:'',
             fournisseurs:[{nom:'',montant:''}],
             depenses:'', remise:'', remarque:'', savedAt:null };
  }

  function normFournisseurs(e) {
    if (e.fournisseurs) return e.fournisseurs;
    return [{ nom: e.fournisseur_nom || '', montant: e.fournisseur_montant || '' }];
  }

  function getEntry(pid, date, cid) { return (dayData(pid, date))[cid] || blank(); }

  function setField(pid, date, cid, field, value) {
    const k = eKey(pid, date);
    if (!S.entries[k]) S.entries[k] = {};
    if (!S.entries[k][cid]) S.entries[k][cid] = blank();
    S.entries[k][cid][field] = value;
    save();
  }

  // ── CALC ────────────────────────────────────────────────────────────────
  function calc(e) {
    const fournisseurs = normFournisseurs(e);
    const sobrus   = num(e.sobrus), espece = num(e.espece), tpe = num(e.tpe),
          cheque   = num(e.cheque),
          fourni   = fournisseurs.reduce((s, f) => s + num(f.montant), 0),
          depenses = num(e.depenses), remise = num(e.remise);
    const total = espece + tpe + cheque + fourni + depenses + remise;
    const diff  = total - sobrus;
    const sobrusOk  = e.sobrus !== '' && e.sobrus !== null;
    const anyDetail = e.espece !== '' || e.tpe !== '' || e.cheque !== '' ||
                      fournisseurs.some(f => f.montant !== '') ||
                      e.depenses !== '' || e.remise !== '';
    const hasData = sobrusOk || anyDetail;
    const isValid = sobrusOk && Math.abs(diff) < 0.005;
    return { sobrus, espece, tpe, cheque, fourni, fournisseurs, depenses, remise, total, diff, hasData, isValid, sobrusOk };
  }

  // ── RENDER ──────────────────────────────────────────────────────────────
  function renderEmpPage() {
    const pharmacy = S.pharmacies.find(p => p.id === EMP.pid);
    const caisse   = pharmacy?.caisses.find(c => c.id === EMP.cid);
    document.body.classList.add('emp-mode');

    let content;
    if (!pharmacy || !caisse) {
      content = empty('⚠️', 'Lien invalide', 'Ce lien n\'est plus valide. Demandez-en un nouveau au patron.');
    } else {
      content = `
        <div class="emp-header">
          <div class="emp-pharma">${esc(pharmacy.name)}</div>
          <div class="emp-name">💊 ${esc(caisse.name)}</div>
          <div class="emp-date">${fmtDateLong(S.date)}</div>
        </div>
        <div class="emp-grid">
          ${renderCard(pharmacy, caisse, 0)}
        </div>
        <div class="emp-footer">📡 Données transmises au patron en temps réel</div>`;
    }

    document.getElementById('app').innerHTML = `<div class="content emp-content">${content}</div>`;
    genIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function render() {
    if (IS_EMP) { renderEmpPage(); return; }
    const pharmacy = S.pharmacies.find(p => p.id === S.pharmacyId);
    const isDetail = S.view === 'histDetail';

    let title = 'PharmaCaisse', showBack = false;
    if (S.view === 'day')        title = pharmacy?.name ?? 'PharmaCaisse';
    if (S.view === 'history')    title = 'Historique';
    if (S.view === 'settings')   title = 'Réglages';
    if (S.view === 'histDetail') { title = fmtDate(S.detailDate); showBack = true; }

    document.getElementById('app').innerHTML = `
      <div class="navbar">
        <div class="navbar-inner">
          ${showBack
            ? `<button class="navbar-back" onclick="App.back()">‹ Retour</button>`
            : `<div style="width:48px"></div>`}
          <div class="navbar-title">${esc(title)}</div>
          <div style="display:flex;align-items:center;gap:4px">
            <button class="theme-btn" id="theme-btn" onclick="App.toggleTheme()" title="Changer le thème">
              ${isDark() ? '☀️' : '🌙'}
            </button>
            ${!showBack
              ? `<div class="desk-nav">
                  <button class="desk-nav-btn ${S.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">📋 Saisie</button>
                  <button class="desk-nav-btn ${['history','histDetail'].includes(S.view) ? 'active' : ''}" onclick="App.setView('history')">📅 Historique</button>
                  <button class="desk-nav-btn ${S.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">⚙️ Réglages</button>
                </div>`
              : ''}
          </div>
        </div>
      </div>

      <div class="content">${renderView(pharmacy)}</div>

      <nav class="tabbar">
        <button class="tab-item ${S.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">
          <span class="tab-icon">📋</span>Saisie
        </button>
        <button class="tab-item ${['history','histDetail'].includes(S.view) ? 'active' : ''}" onclick="App.setView('history')">
          <span class="tab-icon">📅</span>Historique
        </button>
        <button class="tab-item ${S.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">
          <span class="tab-icon">⚙️</span>Réglages
        </button>
      </nav>`;

    genIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function renderView(p) {
    if (S.view === 'day')        return renderDay(p);
    if (S.view === 'history')    return renderHistory(p);
    if (S.view === 'histDetail') return renderDetail();
    if (S.view === 'settings')   return renderSettings();
    return '';
  }

  // ── SEGMENTED CONTROL ───────────────────────────────────────────────────
  function renderSegment() {
    if (S.pharmacies.length <= 1) return '';
    const btns = S.pharmacies.map(p =>
      `<button class="seg-btn ${p.id === S.pharmacyId ? 'active' : ''}" onclick="App.selectPharmacy('${p.id}')">
        ${esc(p.name.replace(/pharmacie\s*/i, '').trim())}
      </button>`).join('');
    return `<div class="segment-wrap"><div class="segment">${btns}</div></div>`;
  }

  // ── DAY TOTAL ────────────────────────────────────────────────────────────
  function renderDayTotal(pharmacy) {
    let totalSobrus = 0, totalDetail = 0, cntSobrus = 0;
    pharmacy.caisses.forEach(c => {
      const r = calc(getEntry(pharmacy.id, S.date, c.id));
      if (r.sobrusOk) { totalSobrus += r.sobrus; cntSobrus++; }
      if (r.hasData) totalDetail += r.total;
    });
    if (cntSobrus === 0 && totalDetail === 0) return '';
    const diff = totalDetail - totalSobrus;
    const balanced = cntSobrus > 0 && Math.abs(diff) < 0.005;
    return `
      <div class="day-total">
        <div class="day-total-row">
          <span class="day-total-label">Total Sobrus</span>
          <span class="day-total-val">${fmt(totalSobrus)}</span>
        </div>
        <div class="day-total-row">
          <span class="day-total-label">Total Détail</span>
          <span class="day-total-val">${fmt(totalDetail)}</span>
        </div>
        ${cntSobrus > 0 ? `<div class="day-total-row ${balanced ? 'ok' : 'bad'}">
          <span>${balanced ? '✓ Tout équilibré' : '⚠ Écart global'}</span>
          <span class="day-total-val">${balanced ? '' : fmtD(diff)}</span>
        </div>` : ''}
      </div>`;
  }

  // ── DAY VIEW ────────────────────────────────────────────────────────────
  function renderDay(pharmacy) {
    if (!pharmacy) return empty('🏥', 'Aucune pharmacie', 'Ajoutez-en une dans Réglages.');

    const isToday = S.date >= today();
    const summary = daySummary(pharmacy);
    const cards   = pharmacy.caisses.map((c, i) => renderCard(pharmacy, c, i)).join('');

    return `
      ${renderSegment()}

      <div class="date-nav">
        <button class="date-arrow" onclick="App.prevDay()">‹</button>
        <div class="date-center">
          <div class="date-main">${fmtDateLong(S.date)}</div>
          <div class="date-sub">${summary}</div>
        </div>
        <button class="date-arrow ${isToday ? 'off' : ''}" onclick="App.nextDay()">›</button>
      </div>

      ${renderDayTotal(pharmacy)}

      <div class="top-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.saveAll('${pharmacy.id}')">
          Tout sauvegarder
        </button>
      </div>

      <div class="caisse-grid">${cards}</div>`;
  }

  function daySummary(pharmacy) {
    let ok = 0, bad = 0, empty = 0;
    pharmacy.caisses.forEach(c => {
      const r = calc(getEntry(pharmacy.id, S.date, c.id));
      if (!r.hasData) empty++; else if (r.isValid) ok++; else bad++;
    });
    const parts = [];
    if (ok   > 0) parts.push(`<span style="color:var(--ok)">${ok} équilibrée${ok>1?'s':''}</span>`);
    if (bad  > 0) parts.push(`<span style="color:var(--bad)">${bad} écart${bad>1?'s':''}</span>`);
    if (empty> 0) parts.push(`<span>${empty} en attente</span>`);
    return parts.join(' · ') || 'Aucune saisie';
  }

  // ── CAISSE CARD ─────────────────────────────────────────────────────────
  function renderCard(pharmacy, caisse, idx) {
    const entry = getEntry(pharmacy.id, S.date, caisse.id);
    const c = calc(entry);
    const pid = pharmacy.id, cid = caisse.id;

    const cardCls  = c.hasData ? (c.isValid ? 'ok' : 'bad') : '';
    const pillCls  = c.hasData ? (c.isValid ? 'pill-ok' : 'pill-bad') : 'pill-idle';
    const pillTxt  = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : 'En attente';
    const showDiff = !c.isValid && c.hasData && c.sobrusOk;
    const delay    = idx * 0.07;

    return `
    <div class="pc ${cardCls}" id="card-${cid}" style="animation-delay:${delay}s">

      <div class="pc-header">
        <div class="pc-name">💊 ${esc(caisse.name)}</div>
        <div class="pill ${pillCls}" id="badge-${cid}">
          <div class="pill-dot"></div>${pillTxt}
        </div>
      </div>

      <div class="sobrus-hero">
        <div class="sobrus-eyebrow">Caisse Sobrus</div>
        <div class="sobrus-amount-row">
          <input type="number" class="sobrus-input"
            id="f-${cid}-sobrus"
            placeholder="0,00"
            value="${esc(entry.sobrus)}"
            step="0.01" min="0" inputmode="decimal"
            oninput="App.onInput('${pid}','${cid}','sobrus',this.value)">
          <span class="sobrus-currency">DH</span>
        </div>
      </div>

      <div class="fields-label">Détail</div>

      <div class="field-row">
        <span class="field-label">💵 Espèce</span>
        <input type="number" class="field-input"
          id="f-${cid}-espece" placeholder="0,00"
          value="${esc(entry.espece)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','espece',this.value)">
      </div>

      <div class="field-row">
        <span class="field-label">💳 TPE</span>
        <input type="number" class="field-input"
          id="f-${cid}-tpe" placeholder="0,00"
          value="${esc(entry.tpe)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','tpe',this.value)">
      </div>

      <div class="field-row">
        <span class="field-label">🏦 Chèque</span>
        <input type="number" class="field-input"
          id="f-${cid}-cheque" placeholder="0,00"
          value="${esc(entry.cheque)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','cheque',this.value)">
      </div>

      ${normFournisseurs(entry).map((f, idx) => `
      <div class="field-row">
        <span class="field-label">🏭 ${idx === 0 ? 'Fournisseur' : ''}</span>
        <div class="fourni-group">
          <select class="fourni-picker" onchange="App.onFourni('${pid}','${cid}',${idx},'nom',this.value)">
            <option value="">Aucun</option>
            ${FOURNISSEURS.map(n => `<option value="${n}" ${f.nom === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
          <input type="number" class="fourni-amount" placeholder="0,00"
            value="${esc(f.montant)}"
            step="0.01" min="0" inputmode="decimal"
            oninput="App.onFourni('${pid}','${cid}',${idx},'montant',this.value)">
          ${normFournisseurs(entry).length > 1 ? `<button class="fourni-del" onclick="App.removeFourni('${pid}','${cid}',${idx})">✕</button>` : ''}
        </div>
      </div>`).join('')}
      <div class="field-row fourni-add-row">
        <button class="btn btn-ghost" style="font-size:14px;padding:6px 0" onclick="App.addFourni('${pid}','${cid}')">＋ Fournisseur</button>
      </div>

      <div class="field-row">
        <span class="field-label">💸 Dépenses</span>
        <input type="number" class="field-input"
          id="f-${cid}-depenses" placeholder="0,00"
          value="${esc(entry.depenses)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','depenses',this.value)">
      </div>

      <div class="field-row" style="border-bottom:none">
        <span class="field-label">🏷 Remise</span>
        <input type="number" class="field-input"
          id="f-${cid}-remise" placeholder="0,00"
          value="${esc(entry.remise)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','remise',this.value)">
      </div>

      <div class="result-section ${c.hasData ? 'on' : ''}" id="res-${cid}">
        <div class="result-surface">
          <div class="result-line">
            <span>Total détail</span>
            <span class="result-val" id="rtotal-${cid}">${fmt(c.total)}</span>
          </div>
          <div class="result-line verdict ${c.isValid ? 'ok' : 'bad'}" id="rcomp-${cid}">
            <span id="rcomp-label-${cid}">${c.isValid ? '✓ Équilibré avec Sobrus' : '✗ Sobrus attendu'}</span>
            <span id="rcomp-val-${cid}">${fmt(c.sobrus)}</span>
          </div>
        </div>
        <div class="diff-alert" id="diff-${cid}" style="${showDiff ? '' : 'display:none'}">
          <span>⚠ Écart détecté</span>
          <span id="diffval-${cid}">${showDiff ? fmtD(c.diff) : ''}</span>
        </div>
      </div>

      <div class="note-section">
        <div class="note-label ${showDiff ? 'warn' : ''}" id="rlabel-${cid}">
          Remarque${showDiff ? ' · Requis si écart' : ''}
        </div>
        <textarea class="note-input"
          id="f-${cid}-remarque"
          placeholder="Cause de l'écart, observations…"
          oninput="App.onInput('${pid}','${cid}','remarque',this.value)"
        >${esc(entry.remarque)}</textarea>
      </div>

      <div class="pc-footer">
        <span class="save-status" id="ft-${cid}">
          ${entry.savedAt ? `✓ Sauvegardé à ${fmtTime(entry.savedAt)}` : ''}
        </span>
        <button class="btn btn-primary btn-sm" onclick="App.saveCard('${pid}','${cid}')">
          Sauvegarder
        </button>
      </div>
    </div>`;
  }

  // ── LIVE CARD UPDATE ────────────────────────────────────────────────────
  function updateCard(pid, cid) {
    const entry = getEntry(pid, S.date, cid);
    const c     = calc(entry);
    const card  = document.getElementById(`card-${cid}`);
    if (!card) return;

    card.className = `pc ${c.hasData ? (c.isValid ? 'ok' : 'bad') : ''}`;

    const badge = document.getElementById(`badge-${cid}`);
    if (badge) {
      badge.className = `pill ${c.hasData ? (c.isValid ? 'pill-ok' : 'pill-bad') : 'pill-idle'}`;
      badge.innerHTML = `<div class="pill-dot"></div>${c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : 'En attente'}`;
    }

    const res = document.getElementById(`res-${cid}`);
    if (res) {
      res.className = `result-section ${c.hasData ? 'on' : ''}`;
      const rt = document.getElementById(`rtotal-${cid}`);
      if (rt) rt.textContent = fmt(c.total);
      const rc = document.getElementById(`rcomp-${cid}`);
      if (rc) {
        rc.className = `result-line verdict ${c.isValid ? 'ok' : 'bad'}`;
        document.getElementById(`rcomp-label-${cid}`).textContent = c.isValid ? '✓ Équilibré avec Sobrus' : '✗ Sobrus attendu';
        document.getElementById(`rcomp-val-${cid}`).textContent   = fmt(c.sobrus);
      }
    }

    const showDiff = !c.isValid && c.hasData && c.sobrusOk;
    const diff = document.getElementById(`diff-${cid}`);
    if (diff) {
      diff.style.display = showDiff ? '' : 'none';
      const dv = document.getElementById(`diffval-${cid}`);
      if (dv) dv.textContent = showDiff ? fmtD(c.diff) : '';
    }

    const rl = document.getElementById(`rlabel-${cid}`);
    if (rl) {
      rl.className = `note-label ${showDiff ? 'warn' : ''}`;
      rl.textContent = `Remarque${showDiff ? ' · Requis si écart' : ''}`;
    }
  }

  // ── HISTORY ─────────────────────────────────────────────────────────────
  function renderHistory(pharmacy) {
    if (!pharmacy) return empty('📅', 'Aucune pharmacie', '');

    const prefix = `${pharmacy.id}|`;
    const dates  = Object.keys(S.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(S.entries[k]).length > 0)
      .map(k => k.slice(prefix.length)).sort().reverse();

    const seg = renderSegment();

    if (dates.length === 0)
      return seg + `<div style="padding-top:8px">` + empty('📅', 'Aucun historique', 'Les journées sauvegardées apparaîtront ici.') + `</div>`;

    const rows = dates.map(date => {
      const day   = dayData(pharmacy.id, date);
      const vals  = Object.values(day);
      const cnt   = vals.length;
      const bad   = vals.filter(e => { const r = calc(e); return r.hasData && !r.isValid; }).length;
      const allOk = cnt > 0 && vals.every(e => calc(e).isValid);
      const dot   = allOk ? 'sd-ok' : bad > 0 ? 'sd-bad' : 'sd-warn';
      const lbl   = allOk ? 'Tout équilibré' : bad > 0 ? `${bad} écart${bad>1?'s':''}` : 'En cours';
      return `
        <div class="list-row" onclick="App.showDetail('${pharmacy.id}','${date}')">
          <div class="status-dot ${dot}"></div>
          <div>
            <div class="row-main">${fmtDate(date)}</div>
            <div class="row-sub">${cnt} caisse${cnt>1?'s':''} · ${lbl}</div>
          </div>
          <div class="row-chev">›</div>
        </div>`;
    }).join('');

    return `${seg}<div class="sec-caption">Journées archivées</div><div class="list-card">${rows}</div>`;
  }

  // ── DETAIL ──────────────────────────────────────────────────────────────
  function renderDetail() {
    const pharmacy = S.pharmacies.find(p => p.id === S.detailPid);
    if (!pharmacy) return empty('📅', 'Données introuvables', '');

    const day   = dayData(pharmacy.id, S.detailDate);
    const cards = pharmacy.caisses.map((caisse, i) => {
      const entry = day[caisse.id]; if (!entry) return '';
      const c = calc(entry);
      return `
        <div class="det-card ${c.isValid ? 'ok' : c.hasData ? 'bad' : ''}" style="animation-delay:${i*0.06}s">
          <div class="det-header">
            <div class="det-name">💊 ${esc(caisse.name)}</div>
            <div class="pill ${c.isValid ? 'pill-ok' : c.hasData ? 'pill-bad' : 'pill-idle'}">
              <div class="pill-dot"></div>
              ${c.isValid ? 'Équilibré' : c.hasData ? 'Écart' : 'Non saisi'}
            </div>
          </div>
          <div class="det-row"><span class="det-key">Caisse Sobrus</span><span class="det-val">${fmt(c.sobrus)}</span></div>
          <div class="det-row"><span class="det-key">Espèce</span><span class="det-val">${fmt(c.espece)}</span></div>
          <div class="det-row"><span class="det-key">TPE</span><span class="det-val">${fmt(c.tpe)}</span></div>
          <div class="det-row"><span class="det-key">Chèque</span><span class="det-val">${fmt(c.cheque)}</span></div>
          ${c.fournisseurs.filter(f => f.nom || num(f.montant) > 0).map(f =>
            `<div class="det-row"><span class="det-key">Fournisseur</span><span class="det-val">${f.nom ? esc(f.nom) + ' · ' : ''}${fmt(f.montant)}</span></div>`
          ).join('')}
          <div class="det-row"><span class="det-key">Dépenses</span><span class="det-val">${fmt(c.depenses)}</span></div>
          <div class="det-row"><span class="det-key">Remise</span><span class="det-val">${fmt(c.remise)}</span></div>
          <div class="det-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:14px">
            <span class="det-key" style="font-weight:600;color:var(--t1)">Total</span>
            <span class="det-val ${c.isValid ? 'ok' : 'bad'}">${fmt(c.total)}</span>
          </div>
          ${!c.isValid && c.hasData ? `<div class="diff-alert" style="margin:0;border-radius:0">
            <span>⚠ Écart</span><span>${fmtD(c.diff)}</span>
          </div>` : ''}
          ${entry.remarque ? `<div class="det-note">📝 ${esc(entry.remarque)}</div>` : ''}
        </div>`;
    }).filter(Boolean).join('');

    return `
      <div class="sec-caption">${esc(pharmacy.name)}</div>
      ${cards || empty('📋', 'Aucune donnée', '')}`;
  }

  // ── SETTINGS ────────────────────────────────────────────────────────────
  function renderSettings() {
    const groups = S.pharmacies.map(p => {
      const rows = p.caisses.map(c => `
        <div class="set-row">
          <span class="set-row-label">💊 ${esc(c.name)}</span>
          <div class="set-btns">
            <button class="btn btn-muted btn-sm" onclick="App.renameCaisse('${p.id}','${c.id}')">✏️</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCaisse('${p.id}','${c.id}')">🗑</button>
          </div>
        </div>`).join('');
      return `
        <div class="set-group">
          <div class="set-group-hd">
            <span class="set-group-title">🏥 ${esc(p.name)}</span>
            <button class="btn btn-muted btn-sm" onclick="App.renamePharmacy('${p.id}')">Renommer</button>
            ${S.pharmacies.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="App.deletePharmacy('${p.id}')">🗑</button>` : ''}
          </div>
          ${rows}
          <div class="set-row">
            <button class="btn btn-ghost" onclick="App.addCaisse('${p.id}')">+ Ajouter une caisse</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="sec-caption">Pharmacies & Caisses</div>
      ${groups}
      <div style="padding:0 18px 18px">
        <button class="btn btn-primary btn-full btn-lg" onclick="App.addPharmacy()">
          🏥 Ajouter une pharmacie
        </button>
      </div>

      <div class="sec-caption">Accès employés</div>
      <div class="set-group" style="margin:0 var(--gutter) 6px">
        <div class="set-row" style="border-bottom:none">
          <div class="set-row-sub" style="flex:1;line-height:1.55">
            Envoyez ce lien à chaque employé — il saisit ses données sur son téléphone, elles s'affichent ici instantanément.
          </div>
        </div>
      </div>
      ${S.pharmacies.map(p => `
        <div class="set-group">
          <div class="set-group-hd">
            <span class="set-group-title">🏥 ${esc(p.name)}</span>
          </div>
          ${p.caisses.map(c => `
            <div class="set-row">
              <span class="set-row-label">💊 ${esc(c.name)}</span>
              <button class="btn btn-secondary btn-sm" onclick="App.copyEmpLink('${p.id}','${c.id}')">🔗 Copier le lien</button>
            </div>`).join('')}
        </div>`).join('')}

      <div class="sec-caption">Données</div>
      <div class="set-group">
        <div class="set-row">
          <div>
            <div class="set-row-label">Exporter les données</div>
            <div class="set-row-sub">Sauvegarde JSON locale</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.exportData()">📤 Export</button>
        </div>
        <div class="set-row">
          <div>
            <div class="set-row-label">Importer des données</div>
            <div class="set-row-sub">Restaurer depuis JSON</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.importData()">📥 Import</button>
        </div>
      </div>

      <div style="text-align:center;color:var(--t2);font-size:13px;padding:16px 0 28px;letter-spacing:-0.1px">
        PharmaCaisse · Synchronisé avec Firebase
      </div>`;
  }

  // ── UTILS ───────────────────────────────────────────────────────────────
  function empty(icon, title, body) {
    return `<div class="empty">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      ${body ? `<div class="empty-body">${body}</div>` : ''}
    </div>`;
  }

  function genIcon() {
    if (document.querySelector('link[rel="apple-touch-icon"]')) return;
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 180;
      const x = cv.getContext('2d');
      x.fillStyle = '#0071E3';
      const r = 36;
      x.beginPath();
      x.moveTo(r,0); x.lineTo(180-r,0); x.arcTo(180,0,180,r,r);
      x.lineTo(180,180-r); x.arcTo(180,180,180-r,180,r);
      x.lineTo(r,180); x.arcTo(0,180,0,180-r,r);
      x.lineTo(0,r); x.arcTo(0,0,r,0,r); x.closePath(); x.fill();
      x.fillStyle = 'rgba(255,255,255,0.15)';
      x.fillRect(0, 0, 180, 45);
      x.fillStyle = 'white';
      x.fillRect(70, 30, 40, 120); x.fillRect(30, 70, 120, 40);
      const l = document.createElement('link');
      l.rel = 'apple-touch-icon'; l.href = cv.toDataURL('image/png');
      document.head.appendChild(l);
    } catch {}
  }

  // ── BOTTOM SHEET ────────────────────────────────────────────────────────
  function showModal({ title, placeholder, value = '', onConfirm }) {
    closeModal();
    const el = document.createElement('div');
    el.className = 'sheet-overlay'; el.id = 'modal-overlay';
    el.innerHTML = `
      <div class="sheet">
        <div class="sheet-pull"></div>
        <div class="sheet-title">${esc(title)}</div>
        <input class="sheet-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" id="modal-inp" autocomplete="off">
        <div class="sheet-actions">
          <button class="sheet-btn cancel" onclick="App.closeModal()">Annuler</button>
          <button class="sheet-btn confirm" id="modal-ok">Confirmer</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const inp = el.querySelector('#modal-inp');
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const ok = () => { const v = inp.value.trim(); if (v) { onConfirm(v); closeModal(); } };
    el.querySelector('#modal-ok').onclick = ok;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') closeModal(); });
    el.addEventListener('pointerdown', e => { if (e.target === el) closeModal(); });
  }

  function showConfirm({ title, message, onConfirm }) {
    closeModal();
    const el = document.createElement('div');
    el.className = 'sheet-overlay'; el.id = 'modal-overlay';
    el.innerHTML = `
      <div class="sheet">
        <div class="sheet-pull"></div>
        <div class="sheet-title">${esc(title)}</div>
        <div class="sheet-msg">${esc(message)}</div>
        <div class="sheet-actions">
          <button class="sheet-btn cancel" onclick="App.closeModal()">Annuler</button>
          <button class="sheet-btn danger" id="modal-ok">Supprimer</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#modal-ok').onclick = () => { onConfirm(); closeModal(); };
    el.addEventListener('pointerdown', e => { if (e.target === el) closeModal(); });
  }

  function closeModal() { document.getElementById('modal-overlay')?.remove(); }

  // ── TOAST ───────────────────────────────────────────────────────────────
  let _tt;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(_tt);
    _tt = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ── ACTIONS ─────────────────────────────────────────────────────────────
  function setView(v)  { S.view = v; render(); window.scrollTo(0, 0); }
  function back()      { if (S.view === 'histDetail') { S.view = 'history'; render(); } }
  function selectPharmacy(id) { S.pharmacyId = id; render(); }

  function prevDay() {
    const d = new Date(S.date + 'T12:00:00'); d.setDate(d.getDate() - 1);
    S.date = d.toISOString().split('T')[0]; render();
  }

  function nextDay() {
    if (S.date >= today()) return;
    const d = new Date(S.date + 'T12:00:00'); d.setDate(d.getDate() + 1);
    S.date = d.toISOString().split('T')[0]; render();
  }

  function onInput(pid, cid, field, value) {
    setField(pid, S.date, cid, field, value);
    updateCard(pid, cid);
  }

  function saveCard(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]) S.entries[k] = {};
    if (!S.entries[k][cid]) S.entries[k][cid] = blank();
    S.entries[k][cid].savedAt = new Date().toISOString();
    save(); toast('✓ Sauvegardé');
    const ft = document.getElementById(`ft-${cid}`);
    if (ft) ft.textContent = `✓ Sauvegardé à ${fmtTime(S.entries[k][cid].savedAt)}`;
  }

  function saveAll(pid) {
    const p = S.pharmacies.find(x => x.id === pid); if (!p) return;
    p.caisses.forEach(c => saveCard(pid, c.id));
    toast(`✓ ${p.caisses.length} caisses sauvegardées`);
  }

  function showDetail(pid, date) {
    S.detailPid = pid; S.detailDate = date;
    S.view = 'histDetail'; render(); window.scrollTo(0, 0);
  }

  // ── PHARMACY CRUD ────────────────────────────────────────────────────────
  function addPharmacy() {
    showModal({ title: 'Nouvelle pharmacie', placeholder: 'Nom de la pharmacie',
      onConfirm: name => {
        const pid = uid();
        S.pharmacies.push({ id: pid, name, caisses: [{ id: uid(), name: 'Caisse 1' }] });
        S.pharmacyId = pid; save(); render(); toast('✓ Pharmacie créée');
      }
    });
  }

  function renamePharmacy(pid) {
    const p = S.pharmacies.find(x => x.id === pid); if (!p) return;
    showModal({ title: 'Renommer', placeholder: 'Nouveau nom', value: p.name,
      onConfirm: name => { p.name = name; save(); render(); }
    });
  }

  function deletePharmacy(pid) {
    const p = S.pharmacies.find(x => x.id === pid); if (!p) return;
    showConfirm({ title: 'Supprimer la pharmacie ?', message: `Toutes les données de "${p.name}" seront perdues.`,
      onConfirm: () => {
        S.pharmacies = S.pharmacies.filter(x => x.id !== pid);
        Object.keys(S.entries).forEach(k => { if (k.startsWith(pid + '|')) delete S.entries[k]; });
        S.pharmacyId = S.pharmacies[0]?.id ?? null;
        save(); render(); toast('Pharmacie supprimée');
      }
    });
  }

  // ── CAISSE CRUD ──────────────────────────────────────────────────────────
  function addCaisse(pid) {
    showModal({ title: 'Nouvelle caisse', placeholder: 'Nom (ex : Haj, Fatima…)',
      onConfirm: name => {
        const p = S.pharmacies.find(x => x.id === pid); if (!p) return;
        p.caisses.push({ id: uid(), name }); save(); render(); toast('✓ Caisse ajoutée');
      }
    });
  }

  function renameCaisse(pid, cid) {
    const p = S.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid); if (!c) return;
    showModal({ title: 'Renommer la caisse', placeholder: 'Nouveau nom', value: c.name,
      onConfirm: name => { c.name = name; save(); render(); }
    });
  }

  function deleteCaisse(pid, cid) {
    const p = S.pharmacies.find(x => x.id === pid);
    const c = p?.caisses.find(x => x.id === cid); if (!c) return;
    if (p.caisses.length <= 1) { toast('⚠ Au moins une caisse requise'); return; }
    showConfirm({ title: 'Supprimer la caisse ?', message: `"${c.name}" et ses données seront supprimées.`,
      onConfirm: () => {
        p.caisses = p.caisses.filter(x => x.id !== cid);
        Object.values(S.entries).forEach(day => delete day[cid]);
        save(); render(); toast('Caisse supprimée');
      }
    });
  }

  // ── EXPORT / IMPORT ──────────────────────────────────────────────────────
  function exportData() {
    const blob = new Blob(
      [JSON.stringify({ pharmacies: S.pharmacies, entries: S.entries }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pharmacaisse_${today()}.json`;
    a.click(); URL.revokeObjectURL(a.href);
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
          S.pharmacies = d.pharmacies; S.entries = d.entries || {};
          S.pharmacyId = S.pharmacies[0]?.id ?? null;
          save(); render(); toast('✓ Import réussi');
        } catch { toast('⚠ Fichier invalide'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ── FOURNISSEURS MULTI ───────────────────────────────────────────────────
  function _ensureEntry(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]) S.entries[k] = {};
    if (!S.entries[k][cid]) S.entries[k][cid] = blank();
    const e = S.entries[k][cid];
    if (!e.fournisseurs) e.fournisseurs = normFournisseurs(e);
    return e;
  }

  function addFourni(pid, cid) {
    const e = _ensureEntry(pid, cid);
    e.fournisseurs.push({ nom: '', montant: '' });
    save(); render();
  }

  function removeFourni(pid, cid, idx) {
    const e = _ensureEntry(pid, cid);
    if (e.fournisseurs.length <= 1) return;
    e.fournisseurs.splice(idx, 1);
    save(); render();
  }

  function onFourni(pid, cid, idx, field, value) {
    const e = _ensureEntry(pid, cid);
    if (!e.fournisseurs[idx]) e.fournisseurs[idx] = { nom: '', montant: '' };
    e.fournisseurs[idx][field] = value;
    save(); updateCard(pid, cid);
  }

  // ── EMPLOYEE LINKS ───────────────────────────────────────────────────────
  function copyEmpLink(pid, cid) {
    const base = window.location.origin + window.location.pathname;
    const url  = `${base}?pid=${encodeURIComponent(pid)}&emp=${encodeURIComponent(cid)}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('✓ Lien copié')).catch(() => fallbackCopy(url));
    } else {
      fallbackCopy(url);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); toast('✓ Lien copié'); }
    catch { toast('⚠ Copiez ce lien manuellement'); }
    ta.remove();
  }

  // ── THEME ────────────────────────────────────────────────────────────────
  function initTheme() {
    const saved = localStorage.getItem('pharma_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark')  return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pharma_theme', next);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = isDark() ? '☀️' : '🌙';
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  async function init() {
    initTheme();
    initFirebase();

    document.getElementById('app').innerHTML = `
      <div class="splash">
        <div class="splash-icon">
          <svg width="44" height="44" viewBox="0 0 20 20" fill="none">
            <rect x="8.5" y="2" width="3" height="16" rx="1.5" fill="white"/>
            <rect x="2" y="8.5" width="16" height="3" rx="1.5" fill="white"/>
          </svg>
        </div>
        <div class="splash-name">PharmaCaisse</div>
        <div class="splash-sub">${db ? 'Synchronisation Firebase…' : 'Chargement…'}</div>
      </div>`;

    await load();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setView, back, prevDay, nextDay, selectPharmacy,
    onInput, saveCard, saveAll, showDetail,
    addPharmacy, renamePharmacy, deletePharmacy,
    addCaisse, renameCaisse, deleteCaisse,
    exportData, importData, closeModal, toggleTheme, copyEmpLink,
    addFourni, removeFourni, onFourni,
  };
})();
