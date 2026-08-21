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
    month: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })(),
  };

  const FOURNISSEURS = ['EXPERT', 'PARA2000', '2A PARA'];

  // ── PUSH NOTIFICATIONS ───────────────────────────────────────────────────
  const VAPID_PUBLIC_KEY = 'BOcHvHhgz2K8SRE7R5e0sk5jLM2GEi-0cV8bdWjx7tkIc_qM5_oehXl9gjK2_JE2k_2rZbEwSsWQAxqGuR6oRBU';

  function urlBase64ToUint8Array(base64String) {
    const pad = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return toast('⚠ Notifications non supportées sur ce navigateur');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('⚠ Permission de notification refusée');

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      if (db) {
        await db.doc(FS_DOC).update({
          pushSubscriptions: firebase.firestore.FieldValue.arrayUnion(JSON.parse(JSON.stringify(sub)))
        }).catch(() =>
          db.doc(FS_DOC).set({ pushSubscriptions: [JSON.parse(JSON.stringify(sub))] }, { merge: true })
        );
      }
      localStorage.setItem('push_subscribed', '1');
      toast('✓ Notifications activées !');
      render();
    } catch (err) {
      console.warn('Push subscribe error:', err);
      toast('⚠ Erreur lors de l\'activation');
    }
  }

  function isPushSubscribed() {
    return localStorage.getItem('push_subscribed') === '1'
      && Notification.permission === 'granted';
  }

  async function sendReminder(pid, cid) {
    if (!db) return toast('Firebase non connecté');
    const pharmacy = S.pharmacies.find(p => p.id === pid); if (!pharmacy) return;
    const caisse   = pharmacy.caisses.find(c => c.id === cid); if (!caisse) return;
    if (dayData(pid, S.date)[cid]?.lockedByEmp) return toast(`${caisse.name} a déjà soumis ses données`);
    const snap = await db.doc(FS_DOC).get().catch(() => null);
    if (!snap) return;
    const subs = (snap.data()?.empPushSubs || []).filter(s => s.pharmacyId === pid && s.caisseId === cid);
    if (!subs.length) return toast(`${caisse.name} n'a pas activé les rappels`);
    const payload = {
      title: 'PharmaCaisse — Rappel',
      body: `Merci de saisir vos chiffres du jour`,
      icon: '/icon-192.png'
    };
    await Promise.all(subs.map(s =>
      fetch('/api/notify', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ subscription: s.sub, payload }) }).catch(() => {})
    ));
    toast(`Rappel envoyé à ${caisse.name}`);
  }

  async function empSubscribePush() {
    if (!('PushManager' in window)) return toast('Non supporté sur ce navigateur');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Permission refusée');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
      const session = getEmpSession();
      if (db && session) {
        await db.doc(FS_DOC).update({
          empPushSubs: firebase.firestore.FieldValue.arrayUnion({ pharmacyId: session.pharmacyId, caisseId: session.caisseId, name: session.name, sub: JSON.parse(JSON.stringify(sub)) })
        }).catch(() => db.doc(FS_DOC).set({ empPushSubs: [{ pharmacyId: session.pharmacyId, caisseId: session.caisseId, name: session.name, sub: JSON.parse(JSON.stringify(sub)) }] }, { merge: true }));
      }
      localStorage.setItem('emp_push_sub', '1');
      toast('Rappels activés');
      renderEmpDashboard();
    } catch (e) { toast('Erreur activation'); }
  }

  async function sendOwnerNotification(pharmacyName, caisseName, empName) {
    if (!db) return;
    try {
      const snap = await db.doc(FS_DOC).get();
      const subs = snap.data()?.pushSubscriptions || [];
      const payload = {
        title: 'PharmaCaisse',
        body: `${empName} a envoyé ses chiffres — ${caisseName} (${pharmacyName})`,
        icon: '/icon-192.png'
      };
      await Promise.all(subs.map(sub =>
        fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub, payload })
        }).catch(() => {})
      ));
    } catch (err) {
      console.warn('Push send error:', err);
    }
  }

  // ── EMPLOYEE SESSION ─────────────────────────────────────────────────────
  const _loginParams   = new URLSearchParams(window.location.search);
  const IS_LOGIN_MODE  = _loginParams.has('login');
  const LOGIN_URL_PID  = _loginParams.get('pid') || null;
  const EMP_KEY = 'pharma_emp_session';
  let _ls = { pid: LOGIN_URL_PID, eid: null, pin: '', err: '' };

  function getEmpSession() {
    try { return JSON.parse(localStorage.getItem(EMP_KEY) || 'null'); } catch { return null; }
  }
  function setEmpSession(s) { localStorage.setItem(EMP_KEY, JSON.stringify(s)); }
  function clearEmpSession() { localStorage.removeItem(EMP_KEY); }

  // ── HELPERS ─────────────────────────────────────────────────────────────
  function today()        { return new Date().toISOString().split('T')[0]; }
  function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

  function fmtMonth(m) {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 15)
      .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  }

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

  let _lastSaveTs  = 0;   // timestamp de notre dernier save
  let _isTyping    = false;
  let _typingTimer = null;

  function markTyping() {
    _isTyping = true;
    clearTimeout(_typingTimer);
    _typingTimer = setTimeout(() => { _isTyping = false; }, 3000);
  }

  function save() {
    saveLocal();
    _lastSaveTs = Date.now();
    if (db) db.doc(FS_DOC).set({ pharmacies: S.pharmacies, entries: S.entries })
      .catch(e => console.warn('FS save:', e.message));
  }

  function migrate() {
    let changed = false;
    // Rename first pharmacy to AGDAL if only one exists and not yet named
    if (S.pharmacies.length === 1 && !/AGDAL/i.test(S.pharmacies[0].name)) {
      S.pharmacies[0].name = 'Pharmacie AGDAL'; changed = true;
    }
    // Add LES AMICALES if absent
    if (!S.pharmacies.some(p => /AMICALES/i.test(p.name))) {
      S.pharmacies.push({ id: uid(), name: 'Pharmacie LES AMICALES', caisses: [
        { id: uid(), name: 'Zineb' }, { id: uid(), name: 'Khadija' },
        { id: uid(), name: 'Youssra' }, { id: uid(), name: 'Lehcen' }, { id: uid(), name: 'Yamina' }
      ]}); changed = true;
    }
    if (changed) save();
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
  // ── LOGIN PAGE ────────────────────────────────────────────────────────────
  function renderLoginPage() {
    document.body.classList.add('emp-mode');
    if (!_ls.pid && S.pharmacies.length) _ls.pid = S.pharmacies[0].id;
    const pharma  = S.pharmacies.find(p => p.id === _ls.pid);
    const emps    = pharma?.employees || [];
    const pinDots = '●'.repeat(_ls.pin.length) + '○'.repeat(4 - _ls.pin.length);

    // Pharmacy segment (only if multiple)
    const pharmSeg = S.pharmacies.length > 1 && !LOGIN_URL_PID ? `
      <div class="login-field">
        <div class="login-label">Pharmacie</div>
        <div class="login-pharma-seg">
          ${S.pharmacies.map(p => `
            <button class="login-pharma-btn ${p.id === _ls.pid ? 'active' : ''}"
              onclick="App.lsPharmacy('${p.id}')">
              ${esc(p.name.replace(/pharmacie\s*/i,'').trim())}
            </button>`).join('')}
        </div>
      </div>` : '';

    // Employee name buttons
    const empGrid = emps.length ? `
      <div class="login-field">
        <div class="login-label">Qui êtes-vous ?</div>
        <div class="emp-name-grid">
          ${emps.map(e => `
            <button class="emp-name-btn ${e.id === _ls.eid ? 'selected' : ''}"
              onclick="App.lsEmployee('${e.id}')">
              
              ${esc(e.name)}
            </button>`).join('')}
        </div>
      </div>` : `<div class="login-empty">Aucun employé configuré.<br>Contactez le patron.</div>`;

    // PIN (only if employee selected)
    const pinSection = _ls.eid ? `
      <div class="login-field">
        <div class="login-label">Code PIN</div>
        <div class="pin-display">${pinDots}</div>
      </div>
      <div class="pin-pad">
        ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="pin-btn" onclick="App.lsPin('${n}')">${n}</button>`).join('')}
        <span></span>
        <button class="pin-btn" onclick="App.lsPin('0')">0</button>
        <button class="pin-btn pin-del" onclick="App.lsPinDel()">⌫</button>
      </div>` : '';

    document.getElementById('app').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="login-logo">Rx</div>
          <div class="login-title">PharmaCaisse</div>
          <div class="login-sub">Espace employé</div>
          ${pharmSeg}
          ${empGrid}
          ${pinSection}
          ${_ls.err ? `<div class="login-error">${esc(_ls.err)}</div>` : ''}
        </div>
      </div>`;
  }

  function lsPharmacy(pid) { _ls.pid = pid; _ls.eid = null; _ls.pin = ''; _ls.err = ''; renderLoginPage(); }
  function lsEmployee(eid) { _ls.eid = eid; _ls.pin = ''; _ls.err = ''; renderLoginPage(); }
  function lsPinDel()      { _ls.pin = _ls.pin.slice(0,-1); _ls.err = ''; renderLoginPage(); }
  function lsPin(d) {
    if (_ls.pin.length >= 4) return;
    _ls.pin += d;
    if (_ls.pin.length === 4) doLogin(); else renderLoginPage();
  }

  function doLogin() {
    const pharma = S.pharmacies.find(p => p.id === _ls.pid);
    const emp    = pharma?.employees?.find(e => e.id === _ls.eid);
    if (!emp) { _ls.err = 'Sélectionnez un employé'; _ls.pin = ''; renderLoginPage(); return; }
    if (emp.pin !== _ls.pin) { _ls.err = 'Code PIN incorrect'; _ls.pin = ''; renderLoginPage(); return; }
    setEmpSession({ pharmacyId: pharma.id, caisseId: emp.caisseId,
                    name: emp.name, pharmacyName: pharma.name });
    renderEmpDashboard();
  }

  function renderEmpDashboard() {
    const session = getEmpSession();
    if (!session) { renderLoginPage(); return; }
    document.body.classList.add('emp-mode');
    if (!S.date || S.date > today()) S.date = today(); // init seulement

    const pharmacy = S.pharmacies.find(p => p.id === session.pharmacyId);
    const caisse   = pharmacy?.caisses.find(c => c.id === session.caisseId);

    if (!pharmacy || !caisse) {
      document.getElementById('app').innerHTML = `
        <div class="content emp-content">
          ${empty('!', 'Session invalide', 'Contactez le patron pour reconfigurer votre accès.')}
          <div style="text-align:center;padding:16px">
            <button class="btn btn-secondary" onclick="App.empLogout()">Se déconnecter</button>
          </div>
        </div>`;
      return;
    }

    const isToday = S.date >= today();
    document.getElementById('app').innerHTML = `
      <div class="emp-topbar">
        <span class="emp-topbar-name">${esc(session.name)}</span>
        <button class="emp-logout-btn" onclick="App.empLogout()">Déconnexion</button>
      </div>
      <div class="content emp-content">
        <div class="emp-header">
          <div class="emp-pharma">${esc(pharmacy.name)}</div>
          <div class="emp-name">${esc(caisse.name)}</div>
        </div>
        <div class="emp-date-nav">
          <button class="date-arrow" onclick="App.empPrevDay()">‹</button>
          <div class="emp-date-label">
            ${isToday ? 'Aujourd\'hui' : fmtDateLong(S.date)}
          </div>
          <button class="date-arrow ${isToday ? 'off' : ''}" onclick="App.empNextDay()">›</button>
        </div>
        <div class="emp-grid">${renderEmpCard(pharmacy, caisse)}</div>
        ${!localStorage.getItem('emp_push_sub') ? `
        <div class="emp-push-row">
          <button class="btn btn-secondary btn-sm" onclick="App.empSubscribePush()">
            Activer les rappels du patron
          </button>
        </div>` : ''}
        <div class="emp-footer">Données transmises au patron en temps réel</div>
      </div>`;
    genIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function renderEmpCard(pharmacy, caisse) {
    const entry = getEntry(pharmacy.id, S.date, caisse.id);
    const pid = pharmacy.id, cid = caisse.id;
    const r = calc(entry);

    // ── Verrouillé après envoi ───────────────────────────────────────────
    if (entry.lockedByEmp) {
      const fourniLines = r.fournisseurs.filter(f => f.nom || num(f.montant) > 0)
        .map(f => `<div class="emp-sent-row"><span>${f.nom||'Fournisseur'}</span><span>${fmt(f.montant)}</span></div>`).join('');
      return `
      <div class="pc ok">
        <div class="pc-header">
          <div class="pc-name">${esc(caisse.name)}</div>
          <div class="pill pill-ok"><div class="pill-dot"></div>Données envoyées</div>
        </div>
        <div class="emp-sent-summary">
          <div class="emp-sent-row"><span>Espèce</span><span>${fmt(r.espece)}</span></div>
          <div class="emp-sent-row"><span>TPE</span><span>${fmt(r.tpe)}</span></div>
          <div class="emp-sent-row"><span>Chèque</span><span>${fmt(r.cheque)}</span></div>
          ${fourniLines}
          <div class="emp-sent-row"><span>Dépenses</span><span>${fmt(r.depenses)}</span></div>
          <div class="emp-sent-row"><span>Remise</span><span>${fmt(r.remise)}</span></div>
          ${entry.remarque ? `<div class="emp-sent-note">${esc(entry.remarque)}</div>` : ''}
          <div class="emp-sent-time">✓ Envoyé à ${fmtTime(entry.savedAt)}</div>
        </div>
        <div class="emp-locked-msg">Les données ont été transmises au patron.<br>Contactez-le si une correction est nécessaire.</div>
      </div>`;
    }

    // ── Formulaire de saisie ─────────────────────────────────────────────
    return `
    <div class="pc" id="card-${cid}">
      <div class="pc-header">
        <div class="pc-name">${esc(caisse.name)}</div>
        <div class="pill pill-idle"><div class="pill-dot"></div>Saisie du jour</div>
      </div>
      <div class="fields-label">Détail</div>
      <div class="field-row">
        <span class="field-label">Espèce</span>
        <input type="number" class="field-input" placeholder="0,00" value="${esc(entry.espece)}"
          step="0.01" min="0" inputmode="decimal" oninput="App.onInput('${pid}','${cid}','espece',this.value)">
      </div>
      <div class="field-row">
        <span class="field-label">TPE</span>
        <input type="number" class="field-input" placeholder="0,00" value="${esc(entry.tpe)}"
          step="0.01" min="0" inputmode="decimal" oninput="App.onInput('${pid}','${cid}','tpe',this.value)">
      </div>
      <div class="field-row">
        <span class="field-label">Chèque</span>
        <input type="number" class="field-input" placeholder="0,00" value="${esc(entry.cheque)}"
          step="0.01" min="0" inputmode="decimal" oninput="App.onInput('${pid}','${cid}','cheque',this.value)">
      </div>
      ${renderFourniChips(pid, cid, entry)}
      <div class="field-row">
        <span class="field-label">Dépenses</span>
        <input type="number" class="field-input" placeholder="0,00" value="${esc(entry.depenses)}"
          step="0.01" min="0" inputmode="decimal" oninput="App.onInput('${pid}','${cid}','depenses',this.value)">
      </div>
      <div class="field-row" style="border-bottom:none">
        <span class="field-label">Remise</span>
        <input type="number" class="field-input" placeholder="0,00" value="${esc(entry.remise)}"
          step="0.01" min="0" inputmode="decimal" oninput="App.onInput('${pid}','${cid}','remise',this.value)">
      </div>
      <div class="note-section">
        <div class="note-label">Remarque</div>
        <textarea class="note-input" placeholder="Observations…"
          oninput="App.onInput('${pid}','${cid}','remarque',this.value)">${esc(entry.remarque)}</textarea>
      </div>
      <div class="pc-footer">
        <span class="save-status" id="ft-${cid}"></span>
        <button class="btn btn-primary btn-sm" onclick="App.submitEmpCard('${pid}','${cid}')">
          Envoyer ›
        </button>
      </div>
    </div>`;
  }

  function submitEmpCard(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]) S.entries[k] = {};
    if (!S.entries[k][cid]) S.entries[k][cid] = blank();
    const _now = new Date().toISOString();
    S.entries[k][cid].savedAt      = _now;
    S.entries[k][cid].lockedByEmp  = true;
    addLog(S.entries[k][cid], `Envoyé par ${getEmpSession()?.name || 'employé'}`, _now);
    save();
    toast('✓ Données envoyées au patron !');

    const session  = getEmpSession();
    const pharmacy = S.pharmacies.find(p => p.id === pid);
    const caisse   = pharmacy?.caisses.find(c => c.id === cid);
    if (session && pharmacy && caisse) {
      sendOwnerNotification(pharmacy.name, caisse.name, session.name);
    }

    renderEmpDashboard();
  }

  function empPrevDay() {
    const d = new Date(S.date + 'T12:00:00'); d.setDate(d.getDate() - 1);
    S.date = d.toISOString().split('T')[0];
    renderEmpDashboard(); window.scrollTo(0, 0);
  }
  function empNextDay() {
    if (S.date >= today()) return;
    const d = new Date(S.date + 'T12:00:00'); d.setDate(d.getDate() + 1);
    S.date = d.toISOString().split('T')[0];
    renderEmpDashboard(); window.scrollTo(0, 0);
  }

  function empLogout() {
    clearEmpSession();
    _ls = { pid: null, eid: null, pin: '', err: '' };
    renderLoginPage();
  }

  function render() {
    const pharmacy = S.pharmacies.find(p => p.id === S.pharmacyId);
    const isDetail = S.view === 'histDetail';

    let title = 'PharmaCaisse', showBack = false;
    if (S.view === 'day')        title = pharmacy?.name ?? 'PharmaCaisse';
    if (S.view === 'history')    title = 'Historique';
    if (S.view === 'month')      title = 'Résumé';
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
                  <button class="desk-nav-btn ${S.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">Saisie</button>
                  <button class="desk-nav-btn ${['history','histDetail'].includes(S.view) ? 'active' : ''}" onclick="App.setView('history')">Historique</button>
                  <button class="desk-nav-btn ${S.view === 'month' ? 'active' : ''}" onclick="App.setView('month')">Résumé</button>
                  <button class="desk-nav-btn ${S.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">Réglages</button>
                </div>`
              : ''}
          </div>
        </div>
      </div>

      <div class="content">${renderView(pharmacy)}</div>

      <nav class="tabbar">
        <button class="tab-item ${S.view === 'day' ? 'active' : ''}" onclick="App.setView('day')">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3" width="13" height="14" rx="2.5"/><line x1="6.5" y1="7" x2="13.5" y2="7"/><line x1="6.5" y1="10" x2="11" y2="10"/><line x1="6.5" y1="13" x2="12.5" y2="13"/></svg></span>
          Saisie
        </button>
        <button class="tab-item ${['history','histDetail'].includes(S.view) ? 'active' : ''}" onclick="App.setView('history')">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><line x1="3" y1="8.5" x2="17" y2="8.5"/><line x1="7" y1="2.5" x2="7" y2="6.5"/><line x1="13" y1="2.5" x2="13" y2="6.5"/></svg></span>
          Historique
        </button>
        <button class="tab-item ${S.view === 'month' ? 'active' : ''}" onclick="App.setView('month')">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5,15 7,9.5 11,12.5 17.5,5"/><circle cx="2.5" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="7" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="11" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg></span>
          Résumé
        </button>
        <button class="tab-item ${S.view === 'settings' ? 'active' : ''}" onclick="App.setView('settings')">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.22 4.22l1.77 1.77M14.01 14.01l1.77 1.77M15.78 4.22l-1.77 1.77M5.99 14.01l-1.77 1.77"/></svg></span>
          Réglages
        </button>
      </nav>`;

    genIcon();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function renderView(p) {
    if (S.view === 'day')        return renderDay(p);
    if (S.view === 'history')    return renderHistory(p);
    if (S.view === 'histDetail') return renderDetail();
    if (S.view === 'month')      return renderMonth(p);
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
    if (!pharmacy) return empty('—', 'Aucune pharmacie', 'Ajoutez-en une dans Réglages.');

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

      ${isDayLocked(pharmacy.id) ? `
      <div class="day-locked-banner">
        <span>Journée clôturée — lecture seule</span>
        <button class="btn btn-muted btn-sm" onclick="App.unlockDay('${pharmacy.id}')">Réouvrir</button>
      </div>` : ''}

      <div class="top-actions">
        ${!isDayLocked(pharmacy.id) ? `
        <button class="btn btn-secondary btn-sm" onclick="App.saveAll('${pharmacy.id}')">
          Tout sauvegarder
        </button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="App.exportCSV('day')">CSV</button>
        <button class="btn btn-secondary btn-sm" onclick="App.exportPDF('day')">PDF</button>
        ${!isDayLocked(pharmacy.id) ? `
        <button class="btn btn-muted btn-sm" onclick="App.lockDay('${pharmacy.id}')">Clôturer</button>` : ''}
      </div>

      <div class="caisse-grid ${isDayLocked(pharmacy.id) ? 'day-locked' : ''}">${cards}</div>`;
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

    const vu       = !!entry.validated;
    const cardCls  = c.hasData ? (c.isValid ? 'ok' : 'bad') : '';
    const pillCls  = c.hasData ? (c.isValid ? 'pill-ok' : 'pill-bad') : 'pill-idle';
    const pillTxt  = c.hasData ? (c.isValid ? '✓ Équilibré' : '✗ Écart') : 'En attente';
    const showDiff = !c.isValid && c.hasData && c.sobrusOk;
    const delay     = idx * 0.07;

    return `
    <div class="pc ${cardCls}" id="card-${cid}" style="animation-delay:${delay}s">

      <div class="pc-header">
        <div class="pc-name">${esc(caisse.name)}</div>
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
        <span class="field-label">Espèce</span>
        <input type="number" class="field-input"
          id="f-${cid}-espece" placeholder="0,00"
          value="${esc(entry.espece)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','espece',this.value)">
      </div>

      <div class="field-row">
        <span class="field-label">TPE</span>
        <input type="number" class="field-input"
          id="f-${cid}-tpe" placeholder="0,00"
          value="${esc(entry.tpe)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','tpe',this.value)">
      </div>

      <div class="field-row">
        <span class="field-label">Chèque</span>
        <input type="number" class="field-input"
          id="f-${cid}-cheque" placeholder="0,00"
          value="${esc(entry.cheque)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','cheque',this.value)">
      </div>

      ${renderFourniChips(pid, cid, entry)}

      <div class="field-row">
        <span class="field-label">Dépenses</span>
        <input type="number" class="field-input"
          id="f-${cid}-depenses" placeholder="0,00"
          value="${esc(entry.depenses)}"
          step="0.01" min="0" inputmode="decimal"
          oninput="App.onInput('${pid}','${cid}','depenses',this.value)">
      </div>

      <div class="field-row" style="border-bottom:none">
        <span class="field-label">Remise</span>
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

      ${entry._log?.length ? `
      <div class="card-log">
        ${[...entry._log].reverse().slice(0,3).map(l =>
          `<div class="card-log-row"><span>${esc(l.a)}</span><span>${fmtTime(l.t)}</span></div>`
        ).join('')}
      </div>` : ''}

      <div class="pc-footer">
        <span class="save-status" id="ft-${cid}">
          ${entry.savedAt ? `✓ Sauvegardé à ${fmtTime(entry.savedAt)}` : ''}
        </span>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${!entry.lockedByEmp
            ? `<button class="btn btn-muted btn-sm" onclick="App.sendReminder('${pid}','${cid}')">Rappel</button>`
            : `<button class="btn btn-muted btn-sm" onclick="App.unlockForEmp('${pid}','${cid}')">Déverrouiller</button>`}
          ${!c.isValid && c.hasData
            ? vu
              ? `<span class="vu-badge">Vu</span>`
              : `<button class="btn btn-vu btn-sm" onclick="App.validateCard('${pid}','${cid}')">Marquer vu</button>`
            : ''}
          <button class="btn btn-primary btn-sm" onclick="App.saveCard('${pid}','${cid}')">
            Sauvegarder
          </button>
        </div>
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
    if (!pharmacy) return empty('—', 'Aucune pharmacie', '');

    const prefix = `${pharmacy.id}|`;
    const dates  = Object.keys(S.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(S.entries[k]).length > 0)
      .map(k => k.slice(prefix.length)).sort().reverse();

    const seg = renderSegment();

    if (dates.length === 0)
      return seg + `<div style="padding-top:8px">` + empty('—', 'Aucun historique', 'Les journées sauvegardées apparaîtront ici.') + `</div>`;

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
    if (!pharmacy) return empty('—', 'Données introuvables', '');

    const day   = dayData(pharmacy.id, S.detailDate);
    const cards = pharmacy.caisses.map((caisse, i) => {
      const entry = day[caisse.id]; if (!entry) return '';
      const c = calc(entry);
      return `
        <div class="det-card ${c.isValid ? 'ok' : c.hasData ? 'bad' : ''}" style="animation-delay:${i*0.06}s">
          <div class="det-header">
            <div class="det-name">${esc(caisse.name)}</div>
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
          ${entry.remarque ? `<div class="det-note">${esc(entry.remarque)}</div>` : ''}
          ${entry._log?.length ? `
          <div class="det-log">
            <div class="det-log-title">Journal</div>
            ${[...entry._log].reverse().map(l =>
              `<div class="det-log-row"><span>${esc(l.a)}</span><span>${fmtTime(l.t)}</span></div>`
            ).join('')}
          </div>` : ''}
        </div>`;
    }).filter(Boolean).join('');

    return `
      <div class="sec-caption">${esc(pharmacy.name)}</div>
      ${cards || empty('—', 'Aucune donnée', '')}`;
  }

  // ── MONTH CHART ──────────────────────────────────────────────────────────
  function renderMonthChart(pharmacy, days) {
    if (days.length < 2) return '';
    const data = days.map(date => {
      let sobrus = 0, detail = 0, hasEcart = false;
      pharmacy.caisses.forEach(c => {
        const entry = dayData(pharmacy.id, date)[c.id]; if (!entry) return;
        const r = calc(entry); if (!r.hasData) return;
        if (r.sobrusOk) sobrus += r.sobrus;
        detail += r.total;
        if (!r.isValid) hasEcart = true;
      });
      return { date, sobrus, detail, hasEcart };
    });

    const W = 600, H = 160, PAD = 36, BOTTOM = 24, TOP = 12;
    const chartH = H - BOTTOM - TOP;
    const chartW = W - PAD * 2;
    const maxVal = Math.max(...data.map(d => Math.max(d.sobrus, d.detail)), 1);

    const px = (i) => PAD + (i / (data.length - 1)) * chartW;
    const py = (v) => TOP + chartH - (v / maxVal) * chartH;

    // Line Sobrus
    const sobrusPoints = data.map((d, i) => `${px(i)},${py(d.sobrus)}`).join(' ');
    // Line Détail
    const detailPoints = data.map((d, i) => `${px(i)},${py(d.detail)}`).join(' ');

    // Dots colorés sur la ligne Sobrus
    const dots = data.map((d, i) => {
      if (!d.sobrus && !d.detail) return '';
      const col = d.hasEcart ? 'var(--bad)' : 'var(--ok)';
      return `<circle cx="${px(i)}" cy="${py(d.sobrus || d.detail)}" r="3.5" fill="${col}"/>`;
    }).join('');

    // X labels (tous les N jours selon densité)
    const step = Math.max(1, Math.ceil(data.length / 7));
    const labels = data.filter((_, i) => i % step === 0 || i === data.length - 1).map((d, _, arr) => {
      const i = data.indexOf(d);
      return `<text x="${px(i)}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--t2)">${fmtDate(d.date).slice(0,5)}</text>`;
    }).join('');

    // Ligne axe X
    const axis = `<line x1="${PAD}" y1="${H - BOTTOM}" x2="${W - PAD}" y2="${H - BOTTOM}" stroke="var(--border)" stroke-width="1"/>`;

    return `
      <div class="sec-caption">Évolution du mois</div>
      <div class="month-chart-wrap">
        <div class="month-chart-legend">
          <span class="chart-line-sample" style="background:var(--accent)"></span>Total Détail
          <span class="chart-line-sample" style="background:var(--t3)"></span>Sobrus
          <span class="chart-dot ok" style="margin-left:8px"></span>Équilibré
          <span class="chart-dot bad"></span>Écart
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="month-chart" preserveAspectRatio="xMidYMid meet">
          ${axis}
          <polyline points="${sobrusPoints}" fill="none" stroke="var(--t3)" stroke-width="1.8" stroke-dasharray="4,3" stroke-linejoin="round" stroke-linecap="round"/>
          <polyline points="${detailPoints}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
          ${dots}
          ${labels}
        </svg>
      </div>`;
  }

  // ── MONTH VIEW ───────────────────────────────────────────────────────────
  function calcMonthTotals(pharmacy) {
    const prefix = `${pharmacy.id}|${S.month}`;
    let sobrus = 0, espece = 0, tpe = 0, cheque = 0, fourni = 0,
        depenses = 0, remise = 0, ecartCount = 0, ecartSum = 0,
        okCount = 0, dayCount = 0;
    Object.entries(S.entries)
      .filter(([k]) => k.startsWith(prefix) && Object.keys(S.entries[k]).length > 0)
      .forEach(([, day]) => {
        dayCount++;
        pharmacy.caisses.forEach(c => {
          const entry = day[c.id]; if (!entry) return;
          const r = calc(entry); if (!r.hasData) return;
          sobrus   += r.sobrus;   espece += r.espece; tpe     += r.tpe;
          cheque   += r.cheque;   fourni += r.fourni; depenses+= r.depenses;
          remise   += r.remise;
          if (r.isValid) okCount++;
          else if (r.sobrusOk) { ecartCount++; ecartSum += r.diff; }
        });
      });
    return { sobrus, espece, tpe, cheque, fourni, depenses, remise,
             ecartCount, ecartSum, okCount, dayCount };
  }

  function renderMonth(pharmacy) {
    if (!pharmacy) return empty('—', 'Aucune pharmacie', '');

    const t = calcMonthTotals(pharmacy);
    const prefix  = `${pharmacy.id}|${S.month}`;
    const days    = Object.keys(S.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(S.entries[k]).length > 0)
      .map(k => k.slice(pharmacy.id.length + 1)).sort().reverse();
    const canNext = S.month < currentMonth();
    const totalCaisses = t.okCount + t.ecartCount;
    const totalDetail  = t.espece + t.tpe + t.cheque + t.fourni + t.depenses + t.remise;

    const dayRows = days.map(date => {
      const day  = dayData(pharmacy.id, date);
      const vals = Object.values(day);
      const cnt  = vals.length;
      const bad  = vals.filter(e => { const r = calc(e); return r.hasData && !r.isValid; }).length;
      const allOk = cnt > 0 && vals.every(e => calc(e).isValid);
      const dot  = allOk ? 'sd-ok' : bad > 0 ? 'sd-bad' : 'sd-warn';
      const lbl  = allOk ? 'Tout équilibré' : bad > 0 ? `${bad} écart${bad>1?'s':''}` : 'En cours';
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

    return `
      ${renderSegment()}
      <div class="date-nav">
        <button class="date-arrow" onclick="App.prevMonth()">‹</button>
        <div class="date-center">
          <div class="date-main" style="text-transform:capitalize">${fmtMonth(S.month)}</div>
          <div class="date-sub">${t.dayCount} jour${t.dayCount!==1?'s':''} saisi${t.dayCount!==1?'s':''} · ${totalCaisses} caisse${totalCaisses!==1?'s':''}</div>
        </div>
        <button class="date-arrow ${!canNext ? 'off' : ''}" onclick="App.nextMonth()">›</button>
      </div>

      ${t.dayCount > 0 ? `
        <div class="top-actions">
          <button class="btn btn-secondary btn-sm" onclick="App.exportCSV('month')">CSV</button>
          <button class="btn btn-secondary btn-sm" onclick="App.exportPDF('month')">PDF</button>
        </div>` : ''}

      ${t.dayCount === 0
        ? empty('—', 'Aucune donnée', 'Aucune saisie pour ce mois.')
        : `<div class="sec-caption">Totaux du mois</div>
           <div class="month-totals">
             <div class="month-row">
               <span class="month-key">Total Sobrus</span>
               <span class="month-val month-primary">${fmt(t.sobrus)}</span>
             </div>
             <div class="month-row">
               <span class="month-key">Espèce</span>
               <span class="month-val">${fmt(t.espece)}</span>
             </div>
             <div class="month-row">
               <span class="month-key">TPE</span>
               <span class="month-val">${fmt(t.tpe)}</span>
             </div>
             <div class="month-row">
               <span class="month-key">Chèque</span>
               <span class="month-val">${fmt(t.cheque)}</span>
             </div>
             ${t.fourni > 0 ? `<div class="month-row"><span class="month-key">Fournisseurs</span><span class="month-val">${fmt(t.fourni)}</span></div>` : ''}
             ${t.depenses > 0 ? `<div class="month-row"><span class="month-key">Dépenses</span><span class="month-val">${fmt(t.depenses)}</span></div>` : ''}
             ${t.remise > 0 ? `<div class="month-row"><span class="month-key">Remises</span><span class="month-val">${fmt(t.remise)}</span></div>` : ''}
             <div class="month-row month-sep">
               <span class="month-key" style="font-weight:700;color:var(--t1)">Total Détail</span>
               <span class="month-val month-primary">${fmt(totalDetail)}</span>
             </div>
             ${t.ecartCount > 0
               ? `<div class="month-row bad">
                    <span class="month-key">⚠ Écarts (${t.ecartCount} caisse${t.ecartCount>1?'s':''})</span>
                    <span class="month-val">${fmtD(t.ecartSum)}</span>
                  </div>`
               : `<div class="month-row ok">
                    <span class="month-key">✓ Aucun écart</span>
                    <span class="month-val">${t.okCount} équilibrée${t.okCount>1?'s':''}</span>
                  </div>`}
           </div>
           <div class="sec-caption">Journées</div>
           <div class="list-card">${dayRows}</div>
           ${renderMonthDetailTable(pharmacy, days)}
           ${renderMonthChart(pharmacy, days)}`}`;
  }

  function renderMonthDetailTable(pharmacy, days) {
    if (!days.length) return '';
    const rows = days.flatMap(date => {
      const day = dayData(pharmacy.id, date);
      return pharmacy.caisses.map(c => {
        const entry = day[c.id]; if (!entry) return null;
        const r = calc(entry); if (!r.hasData) return null;
        return { date, c, entry, r };
      }).filter(Boolean);
    });
    if (!rows.length) return '';

    const trs = rows.map(({ date, c, entry, r }) => {
      const ok = r.isValid;
      return `<tr>
        <td class="mdt-date">${fmtDate(date)}</td>
        <td class="mdt-caisse">${esc(c.name)}</td>
        <td class="mdt-num">${r.sobrusOk ? fmt(r.sobrus) : '—'}</td>
        <td class="mdt-num">${fmt(r.espece)}</td>
        <td class="mdt-num">${fmt(r.tpe)}</td>
        <td class="mdt-num">${fmt(r.cheque)}</td>
        <td class="mdt-num">${r.fourni > 0 ? fmt(r.fourni) : '—'}</td>
        <td class="mdt-num">${r.depenses > 0 ? fmt(r.depenses) : '—'}</td>
        <td class="mdt-num">${r.remise > 0 ? fmt(r.remise) : '—'}</td>
        <td class="mdt-status ${ok ? 'ok' : 'bad'}">${ok ? '✓' : fmtD(r.diff) + (entry.validated ? ' 👁' : '')}</td>
      </tr>`;
    }).join('');

    return `
      <div class="sec-caption">Détail jour par jour</div>
      <div class="mdt-wrap">
        <table class="mdt">
          <thead><tr>
            <th>Date</th><th>Caisse</th><th>Sobrus</th>
            <th>Espèce</th><th>TPE</th><th>Chèque</th>
            <th>Fourni.</th><th>Dépenses</th><th>Remise</th>
            <th>Statut</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>`;
  }

  // ── SETTINGS ────────────────────────────────────────────────────────────
  function renderSettings() {
    const groups = S.pharmacies.map(p => {
      const rows = p.caisses.map(c => `
        <div class="set-row">
          <span class="set-row-label">${esc(c.name)}</span>
          <div class="set-btns">
            <button class="btn btn-muted btn-sm" onclick="App.renameCaisse('${p.id}','${c.id}')">Modifier</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCaisse('${p.id}','${c.id}')">Suppr.</button>
          </div>
        </div>`).join('');
      return `
        <div class="set-group">
          <div class="set-group-hd">
            <span class="set-group-title">${esc(p.name)}</span>
            <button class="btn btn-muted btn-sm" onclick="App.renamePharmacy('${p.id}')">Renommer</button>
            ${S.pharmacies.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="App.deletePharmacy('${p.id}')">Suppr.</button>` : ''}
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
          Ajouter une pharmacie
        </button>
      </div>

      <div class="sec-caption">Employés</div>
      <div class="set-group" style="margin:0 var(--gutter) 6px">
        <div class="set-row" style="border-bottom:none;padding-bottom:8px">
          <div class="set-row-sub" style="line-height:1.6">
            Chaque pharmacie a son propre lien — envoyez le bon lien aux bons employés.
          </div>
        </div>
        ${S.pharmacies.map(p => `
        <div class="set-row">
          <div style="flex:1;min-width:0">
            <div class="set-row-label">${esc(p.name)}</div>
            <div class="set-row-sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              …?login&pid=${p.id}
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.copyLoginLink('${p.id}')">Copier</button>
        </div>`).join('')}
      </div>
      ${S.pharmacies.map(p => {
        const emps = p.employees || [];
        const empRows = emps.map(e => {
          const caisse = p.caisses.find(c => c.id === e.caisseId);
          return `<div class="set-row">
            <div>
              <div class="set-row-label">${esc(e.name)}</div>
              <div class="set-row-sub">${esc(caisse?.name ?? '—')} · PIN : ${'•'.repeat(4)}</div>
            </div>
            <div class="set-btns">
              <button class="btn btn-muted btn-sm" onclick="App.editEmployee('${p.id}','${e.id}')">Modifier</button>
              <button class="btn btn-danger btn-sm" onclick="App.deleteEmployee('${p.id}','${e.id}')">Suppr.</button>
            </div>
          </div>`;
        }).join('');
        return `
        <div class="set-group">
          <div class="set-group-hd">
            <span class="set-group-title">${esc(p.name)}</span>
          </div>
          ${empRows}
          <div class="set-row">
            <button class="btn btn-ghost" onclick="App.addEmployee('${p.id}')">+ Ajouter un employé</button>
          </div>
        </div>`;
      }).join('')}

      <div class="sec-caption">Données</div>
      <div class="set-group">
        <div class="set-row">
          <div>
            <div class="set-row-label">Exporter les données</div>
            <div class="set-row-sub">Sauvegarde JSON locale</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.exportData()">Exporter</button>
        </div>
        <div class="set-row">
          <div>
            <div class="set-row-label">Importer des données</div>
            <div class="set-row-sub">Restaurer depuis JSON</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.importData()">Importer</button>
        </div>
      </div>

      <div class="sec-caption">Notifications</div>
      <div class="set-group">
        <div class="set-row">
          <div>
            <div class="set-row-label">Notifications push</div>
            <div class="set-row-sub">${isPushSubscribed() ? 'Activées — vous serez notifié à chaque envoi employé' : 'Recevez une alerte quand un employé envoie ses chiffres'}</div>
          </div>
          ${isPushSubscribed()
            ? `<span class="pill pill-ok" style="flex-shrink:0"><div class="pill-dot"></div>Activées</span>`
            : `<button class="btn btn-primary btn-sm" onclick="App.subscribeToPush()">Activer</button>`}
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

  function prevMonth() {
    const [y, m] = S.month.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    S.month = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    render(); window.scrollTo(0, 0);
  }
  function nextMonth() {
    const [y, m] = S.month.split('-').map(Number);
    const d = new Date(y, m, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (next > currentMonth()) return;
    S.month = next; render(); window.scrollTo(0, 0);
  }

  function validateCard(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]?.[cid]) return;
    S.entries[k][cid].validated = true;
    save(); render();
    toast('✓ Caisse validée');
  }

  function unlockForEmp(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]?.[cid]) return;
    S.entries[k][cid].lockedByEmp = false;
    addLog(S.entries[k][cid], 'Déverrouillé par patron', new Date().toISOString());
    save(); render();
    toast('Jour déverrouillé — l\'employé peut modifier');
  }

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
    markTyping();
    setField(pid, S.date, cid, field, value);
    updateCard(pid, cid);
  }

  function saveCard(pid, cid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]) S.entries[k] = {};
    if (!S.entries[k][cid]) S.entries[k][cid] = blank();
    const now = new Date().toISOString();
    S.entries[k][cid].savedAt = now;
    addLog(S.entries[k][cid], 'Modifié (patron)', now);
    save(); toast('✓ Sauvegardé');
    const ft = document.getElementById(`ft-${cid}`);
    if (ft) ft.textContent = `✓ Sauvegardé à ${fmtTime(now)}`;
  }

  function addLog(entry, action, ts) {
    if (!entry._log) entry._log = [];
    entry._log.push({ a: action, t: ts });
    if (entry._log.length > 10) entry._log.shift(); // garder 10 max
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

  // ── EXPORT CSV ───────────────────────────────────────────────────────────
  function exportCSV(type) {
    const pharmacy = S.pharmacies.find(p => p.id === S.pharmacyId);
    if (!pharmacy) return toast('Aucune pharmacie sélectionnée');

    const header = ['Date','Pharmacie','Caisse','Sobrus','Espèce','TPE','Chèque','Fournisseurs','Dépenses','Remise','Total Détail','Écart','Statut'];
    const rows   = [header];

    const addRow = (date, caisse, r, entry) => {
      const fList = r.fournisseurs.filter(f => f.nom && num(f.montant) > 0)
        .map(f => `${f.nom} ${num(f.montant).toFixed(2)}`).join(' + ');
      rows.push([
        fmtDate(date), pharmacy.name, caisse.name,
        r.sobrusOk ? num(r.sobrus).toFixed(2) : '',
        num(r.espece).toFixed(2), num(r.tpe).toFixed(2), num(r.cheque).toFixed(2),
        fList, num(r.depenses).toFixed(2), num(r.remise).toFixed(2),
        num(r.total).toFixed(2),
        r.sobrusOk ? num(r.diff).toFixed(2) : '',
        r.isValid ? 'Équilibré' : r.sobrusOk ? 'Écart' : 'En attente'
      ]);
    };

    if (type === 'day') {
      const day = dayData(pharmacy.id, S.date);
      pharmacy.caisses.forEach(c => {
        const entry = day[c.id]; if (!entry) return;
        const r = calc(entry); if (!r.hasData) return;
        addRow(S.date, c, r, entry);
      });
    } else {
      const prefix = `${pharmacy.id}|${S.month}`;
      Object.keys(S.entries).filter(k => k.startsWith(prefix))
        .map(k => k.slice(pharmacy.id.length + 1)).sort()
        .forEach(date => {
          const day = dayData(pharmacy.id, date);
          pharmacy.caisses.forEach(c => {
            const entry = day[c.id]; if (!entry) return;
            const r = calc(entry); if (!r.hasData) return;
            addRow(date, c, r, entry);
          });
        });
    }

    const csv = '﻿' + rows.map(r =>
      r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')
    ).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
    a.download = `pharmacaisse_${type === 'day' ? S.date : S.month}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('Export CSV téléchargé');
  }

  // ── DAY LOCK ─────────────────────────────────────────────────────────────
  function isDayLocked(pid) {
    return !!(dayData(pid, S.date)['_locked']);
  }
  function lockDay(pid) {
    const k = eKey(pid, S.date);
    if (!S.entries[k]) S.entries[k] = {};
    S.entries[k]['_locked'] = true;
    save(); render(); toast('Journée clôturée');
  }
  function unlockDay(pid) {
    const k = eKey(pid, S.date);
    if (S.entries[k]) S.entries[k]['_locked'] = false;
    save(); render(); toast('Journée réouverte');
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

  // ── PDF EXPORT ───────────────────────────────────────────────────────────
  const PDF_CSS = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,Arial,sans-serif;font-size:12px;color:#111;padding:28px 32px}
    .hd{border-bottom:2px solid #0071E3;padding-bottom:12px;margin-bottom:20px}
    .hd h1{font-size:19px;color:#0071E3;margin-bottom:3px}
    .hd h2{font-size:13px;color:#555;font-weight:400}
    .hd .meta{font-size:11px;color:#888;margin-top:6px}
    h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#444;margin:18px 0 6px}
    table{width:100%;border-collapse:collapse;margin-bottom:4px}
    th{background:#f0f4ff;color:#0071E3;text-align:left;padding:7px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #cde}
    td{padding:7px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
    .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .ok{color:#1a9e30;font-weight:600}
    .bad{color:#d93025;font-weight:600}
    .bold{font-weight:700}
    .total td{font-weight:700;border-top:2px solid #ccc;border-bottom:none;padding-top:9px}
    .sub{font-size:10px;color:#777;margin-top:2px}
    @page{margin:1.5cm}
    @media print{body{padding:0}}
  `;

  function exportPDF(type) {
    const pharmacy = S.pharmacies.find(p => p.id === S.pharmacyId);
    if (!pharmacy) return toast('⚠ Aucune pharmacie sélectionnée');
    const html = type === 'day' ? buildDayPDF(pharmacy) : buildMonthPDF(pharmacy);
    const win  = window.open('', '_blank');
    if (!win) return toast('⚠ Autorisez les popups puis réessayez');
    win.document.write(html);
    win.document.close();
    win.focus();
  }

  function buildDayPDF(pharmacy) {
    const day = dayData(pharmacy.id, S.date);
    let tSobrus=0, tEspece=0, tTPE=0, tCheque=0, tFourni=0, tDep=0, tRemise=0, ecartSum=0, ecartCnt=0;

    const rows = pharmacy.caisses.map(c => {
      const entry = day[c.id]; if (!entry) return '';
      const r = calc(entry); if (!r.hasData) return '';
      tSobrus += r.sobrus; tEspece += r.espece; tTPE += r.tpe;
      tCheque += r.cheque; tFourni += r.fourni; tDep += r.depenses; tRemise += r.remise;
      if (!r.isValid && r.sobrusOk) { ecartCnt++; ecartSum += r.diff; }
      const statusCls = r.isValid ? 'ok' : 'bad';
      const vuTxt     = entry.validated && !r.isValid ? ' <span style="color:#888">(vu)</span>' : '';
      const statusTxt = r.isValid ? '✓ Équilibré' : `⚠ Écart ${fmtD(r.diff)}`;
      const fourniList = r.fournisseurs.filter(f => f.nom || num(f.montant)>0)
        .map(f => `${f.nom ? esc(f.nom)+' ' : ''}${fmt(f.montant)}`).join(', ') || fmt(0);
      return `<tr>
        <td class="bold">${esc(c.name)}</td>
        <td class="num">${fmt(r.sobrus)}</td>
        <td class="num">${fmt(r.espece)}</td>
        <td class="num">${fmt(r.tpe)}</td>
        <td class="num">${fmt(r.cheque)}</td>
        <td class="num">${fourniList}</td>
        <td class="num">${fmt(r.depenses)}</td>
        <td class="num">${fmt(r.remise)}</td>
        <td><span class="${statusCls}">${statusTxt}</span>${vuTxt}${entry.remarque ? `<div class="sub">${esc(entry.remarque)}</div>` : ''}</td>
      </tr>`;
    }).filter(Boolean).join('');

    const tDetail = tEspece+tTPE+tCheque+tFourni+tDep+tRemise;
    const globalOk = ecartCnt === 0;

    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
      <title>${esc(pharmacy.name)} — ${fmtDate(S.date)}</title>
      <style>${PDF_CSS}</style></head><body>
      <div class="hd">
        <h1>${esc(pharmacy.name)}</h1>
        <h2>Récapitulatif journalier</h2>
        <div class="meta">${fmtDateLong(S.date)} · Généré le ${fmtDate(today())}</div>
      </div>
      <table>
        <thead><tr>
          <th>Caisse</th><th>Sobrus</th><th>Espèce</th><th>TPE</th>
          <th>Chèque</th><th>Fournisseur</th><th>Dépenses</th><th>Remise</th><th>Statut</th>
        </tr></thead>
        <tbody>
          ${rows || '<tr><td colspan="9" style="text-align:center;color:#999;padding:20px">Aucune saisie</td></tr>'}
          <tr class="total">
            <td>TOTAL</td>
            <td class="num">${fmt(tSobrus)}</td><td class="num">${fmt(tEspece)}</td>
            <td class="num">${fmt(tTPE)}</td><td class="num">${fmt(tCheque)}</td>
            <td class="num">${fmt(tFourni)}</td><td class="num">${fmt(tDep)}</td>
            <td class="num">${fmt(tRemise)}</td>
            <td><span class="${globalOk?'ok':'bad'}">${globalOk?'✓ Tout équilibré':'⚠ '+ecartCnt+' écart'+(ecartCnt>1?'s':'')+' · '+fmtD(ecartSum)}</span></td>
          </tr>
        </tbody>
      </table>
    </body></html>`;
  }

  function buildMonthPDF(pharmacy) {
    const t = calcMonthTotals(pharmacy);
    const prefix = `${pharmacy.id}|${S.month}`;
    const days = Object.keys(S.entries)
      .filter(k => k.startsWith(prefix) && Object.keys(S.entries[k]).length > 0)
      .map(k => k.slice(pharmacy.id.length + 1)).sort();

    const dayRows = days.map(date => {
      const day = dayData(pharmacy.id, date);
      let dSobrus=0, dDetail=0, dEcart=0;
      let bad=0, okCnt=0;
      pharmacy.caisses.forEach(c => {
        const entry = day[c.id]; if (!entry) return;
        const r = calc(entry); if (!r.hasData) return;
        dSobrus += r.sobrus; dDetail += r.total;
        if (r.isValid) okCnt++;
        else if (r.sobrusOk) { bad++; dEcart += r.diff; }
      });
      const allOk = bad === 0 && okCnt > 0;
      return `<tr>
        <td>${fmtDate(date)}</td>
        <td class="num">${fmt(dSobrus)}</td>
        <td class="num">${fmt(dDetail)}</td>
        <td><span class="${allOk?'ok':bad>0?'bad':''}">${allOk?'✓ Équilibré':bad>0?'⚠ '+bad+' écart'+(bad>1?'s':'')+' '+fmtD(dEcart):'En cours'}</span></td>
      </tr>`;
    }).join('');

    const tDetail = t.espece+t.tpe+t.cheque+t.fourni+t.depenses+t.remise;

    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
      <title>${esc(pharmacy.name)} — ${fmtMonth(S.month)}</title>
      <style>${PDF_CSS}</style></head><body>
      <div class="hd">
        <h1>${esc(pharmacy.name)}</h1>
        <h2>Résumé mensuel — ${fmtMonth(S.month)}</h2>
        <div class="meta">${t.dayCount} jour${t.dayCount!==1?'s':''} saisi${t.dayCount!==1?'s':''} · Généré le ${fmtDate(today())}</div>
      </div>
      <h3>Totaux du mois</h3>
      <table>
        <thead><tr><th>Poste</th><th class="num">Montant</th></tr></thead>
        <tbody>
          <tr><td class="bold">Total Sobrus</td><td class="num bold">${fmt(t.sobrus)}</td></tr>
          <tr><td>Espèce</td><td class="num">${fmt(t.espece)}</td></tr>
          <tr><td>TPE</td><td class="num">${fmt(t.tpe)}</td></tr>
          <tr><td>Chèque</td><td class="num">${fmt(t.cheque)}</td></tr>
          ${t.fourni>0?`<tr><td>Fournisseurs</td><td class="num">${fmt(t.fourni)}</td></tr>`:''}
          ${t.depenses>0?`<tr><td>Dépenses</td><td class="num">${fmt(t.depenses)}</td></tr>`:''}
          ${t.remise>0?`<tr><td>Remises</td><td class="num">${fmt(t.remise)}</td></tr>`:''}
          <tr class="total"><td>Total Détail</td><td class="num">${fmt(tDetail)}</td></tr>
          <tr><td><span class="${t.ecartCount>0?'bad':'ok'}">${t.ecartCount>0?'⚠ Écarts ('+t.ecartCount+' caisse'+(t.ecartCount>1?'s':'')+')':'✓ Aucun écart'}</span></td>
            <td class="num ${t.ecartCount>0?'bad':'ok'}">${t.ecartCount>0?fmtD(t.ecartSum):''}</td></tr>
        </tbody>
      </table>
      <h3>Journées (${days.length})</h3>
      <table>
        <thead><tr><th>Date</th><th class="num">Total Sobrus</th><th class="num">Total Détail</th><th>Statut</th></tr></thead>
        <tbody>${dayRows||'<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">Aucune journée</td></tr>'}</tbody>
      </table>

      <h3 style="margin-top:24px">Détail jour par jour</h3>
      <table>
        <thead><tr>
          <th>Date</th><th>Caisse</th><th class="num">Sobrus</th>
          <th class="num">Espèce</th><th class="num">TPE</th><th class="num">Chèque</th>
          <th class="num">Fourni.</th><th class="num">Dépenses</th><th class="num">Remise</th>
          <th>Statut</th>
        </tr></thead>
        <tbody>
          ${days.flatMap(date => {
            const day = dayData(pharmacy.id, date);
            return pharmacy.caisses.map(c => {
              const entry = day[c.id]; if (!entry) return '';
              const r = calc(entry); if (!r.hasData) return '';
              const ok = r.isValid;
              const vuNote = (!ok && entry.validated) ? ' <span style="color:#888">(vu)</span>' : '';
              return `<tr>
                <td>${fmtDate(date)}</td>
                <td>${esc(c.name)}</td>
                <td class="num">${r.sobrusOk ? fmt(r.sobrus) : '—'}</td>
                <td class="num">${fmt(r.espece)}</td>
                <td class="num">${fmt(r.tpe)}</td>
                <td class="num">${fmt(r.cheque)}</td>
                <td class="num">${r.fourni > 0 ? fmt(r.fourni) : '—'}</td>
                <td class="num">${r.depenses > 0 ? fmt(r.depenses) : '—'}</td>
                <td class="num">${r.remise > 0 ? fmt(r.remise) : '—'}</td>
                <td><span class="${ok?'ok':'bad'}">${ok ? '✓ OK' : '⚠ '+fmtD(r.diff)}</span>${vuNote}</td>
              </tr>`;
            }).join('');
          }).join('')}
        </tbody>
      </table>
    </body></html>`;
  }

  // ── FOURNISSEURS CHIPS ───────────────────────────────────────────────────
  function renderFourniChips(pid, cid, entry) {
    const active     = normFournisseurs(entry).filter(f => f.nom);
    const activeNoms = active.map(f => f.nom);
    const rows = FOURNISSEURS.map(nom => {
      const on = activeNoms.includes(nom);
      const f  = active.find(x => x.nom === nom);
      return `
        <div class="field-row fourni-row">
          <button class="fourni-toggle ${on ? 'on' : ''}"
            onclick="App.toggleFourni('${pid}','${cid}','${nom}')">
            <span class="fourni-check">${on ? '✓' : ''}</span>
            ${esc(nom)}
          </button>
          <input type="number" class="field-input ${on ? '' : 'fourni-off'}"
            placeholder="0,00" value="${esc(f?.montant || '')}"
            step="0.01" min="0" inputmode="decimal"
            ${on ? '' : 'disabled'}
            oninput="App.onFourniAmount('${pid}','${cid}','${nom}',this.value)">
        </div>`;
    }).join('');
    return `<div class="fields-label">Fournisseurs</div>${rows}`;
  }

  function toggleFourni(pid, cid, nom) {
    const e = _ensureEntry(pid, cid);
    e.fournisseurs = normFournisseurs(e).filter(f => f.nom); // purge vides
    const idx = e.fournisseurs.findIndex(f => f.nom === nom);
    if (idx >= 0) e.fournisseurs.splice(idx, 1);
    else          e.fournisseurs.push({ nom, montant: '' });
    save(); render();
  }

  function onFourniAmount(pid, cid, nom, value) {
    markTyping();
    const e = _ensureEntry(pid, cid);
    const f = e.fournisseurs.find(x => x.nom === nom);
    if (f) { f.montant = value; save(); updateCard(pid, cid); }
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

  // ── EMPLOYEE MANAGEMENT ──────────────────────────────────────────────────
  function copyLoginLink(pid) {
    const base = window.location.origin + window.location.pathname;
    const url  = pid ? `${base}?login&pid=${encodeURIComponent(pid)}` : `${base}?login`;
    navigator.clipboard?.writeText(url).then(() => toast('✓ Lien copié')).catch(() => fallbackCopy(url));
  }

  function showEmpSheet(pid, eid) {
    const p   = S.pharmacies.find(x => x.id === pid); if (!p) return;
    const emp = eid ? (p.employees || []).find(e => e.id === eid) : null;
    const caisseOpts = p.caisses.map(c =>
      `<option value="${c.id}" ${emp?.caisseId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');
    closeModal();
    const el = document.createElement('div');
    el.className = 'sheet-overlay'; el.id = 'modal-overlay';
    el.innerHTML = `
      <div class="sheet">
        <div class="sheet-pull"></div>
        <div class="sheet-title">${emp ? 'Modifier l\'employé' : 'Nouvel employé'}</div>
        <div style="padding:0 18px 4px">
          <div class="emp-field-label">Prénom / Nom</div>
          <input class="sheet-input" type="text" id="es-name" placeholder="Ex : Haj, Zineb…"
            value="${esc(emp?.name || '')}" autocomplete="off" style="margin:6px 0 12px">
          <div class="emp-field-label">Caisse assignée</div>
          <select class="sheet-input" id="es-caisse" style="margin:6px 0 12px">${caisseOpts}</select>
          <div class="emp-field-label">Code PIN (4 chiffres)</div>
          <input class="sheet-input" type="tel" id="es-pin" placeholder="Ex : 1234"
            maxlength="4" value="${esc(emp?.pin || '')}" style="margin:6px 0 4px"
            oninput="this.value=this.value.replace(/\\D/g,'').slice(0,4)">
        </div>
        <div class="sheet-actions">
          <button class="sheet-btn cancel" onclick="App.closeModal()">Annuler</button>
          <button class="sheet-btn confirm" onclick="App.saveEmployee('${pid}','${eid || ''}')">
            ${emp ? 'Enregistrer' : 'Créer'}
          </button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#es-name').focus();
    el.addEventListener('pointerdown', e => { if (e.target === el) closeModal(); });
  }

  function addEmployee(pid)       { showEmpSheet(pid, null); }
  function editEmployee(pid, eid) { showEmpSheet(pid, eid);  }

  function saveEmployee(pid, eid) {
    const p    = S.pharmacies.find(x => x.id === pid); if (!p) return;
    const name = document.getElementById('es-name')?.value.trim();
    const cid  = document.getElementById('es-caisse')?.value;
    const pin  = document.getElementById('es-pin')?.value || '';
    if (!name)               return toast('⚠ Nom requis');
    if (!/^\d{4}$/.test(pin)) return toast('⚠ PIN : exactement 4 chiffres');
    if (!cid)                return toast('⚠ Sélectionnez une caisse');
    if (!p.employees) p.employees = [];
    if (eid) {
      const e = p.employees.find(x => x.id === eid);
      if (e) { e.name = name; e.caisseId = cid; e.pin = pin; }
    } else {
      p.employees.push({ id: uid(), name, caisseId: cid, pin });
    }
    save(); closeModal(); render();
    toast(eid ? '✓ Employé modifié' : '✓ Employé créé');
  }

  function deleteEmployee(pid, eid) {
    const p = S.pharmacies.find(x => x.id === pid); if (!p) return;
    const e = (p.employees||[]).find(x => x.id === eid); if (!e) return;
    showConfirm({ title: 'Supprimer l\'employé ?', message: `"${e.name}" sera supprimé.`,
      onConfirm: () => {
        p.employees = (p.employees||[]).filter(x => x.id !== eid);
        save(); render(); toast('Employé supprimé');
      }
    });
  }

  // ── EMPLOYEE LINKS (legacy) ───────────────────────────────────────────────
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
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <line x1="22" y1="5" x2="22" y2="40" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
            <circle cx="22" cy="5" r="2" fill="white"/>
            <path d="M22 11 C14 7 10 14 16 16" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
            <path d="M22 11 C30 7 34 14 28 16" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
            <path d="M22 14 C14 19 14 25 22 27 C30 29 30 35 22 38" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
            <path d="M22 14 C30 19 30 25 22 27 C14 29 14 35 22 38" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="splash-name">PharmaCaisse</div>
        <div class="splash-sub">${db ? 'Synchronisation Firebase…' : 'Chargement…'}</div>
      </div>`;

    await load();
    migrate();
    setupRealtimeSync(); // écoute les mises à jour en temps réel

    if (IS_LOGIN_MODE) {
      document.body.classList.add('emp-mode');
      const session = getEmpSession();
      if (session) renderEmpDashboard();
      else renderLoginPage();
      return;
    }

    render();
  }

  // ── REALTIME SYNC ────────────────────────────────────────────────────────
  function setupRealtimeSync() {
    if (!db) return;
    let _firstSnap = true;

    db.doc(FS_DOC).onSnapshot(snap => {
      // Ignorer le snapshot initial (déjà chargé dans load())
      if (_firstSnap) { _firstSnap = false; return; }
      if (!snap.exists) return;

      // Ignorer nos propres saves (dans les 5 secondes)
      if (Date.now() - _lastSaveTs < 5000) return;

      const data = snap.data();
      if (!data) return;

      // Mettre à jour l'état local
      if (data.pharmacies?.length) {
        S.pharmacies = data.pharmacies;
        S.pharmacyId = S.pharmacies.find(p => p.id === S.pharmacyId)?.id
                    || S.pharmacies[0]?.id;
      }
      if (data.entries) S.entries = data.entries;
      saveLocal();

      // Mode employé : re-rendre pour détecter un déverrouillage
      if (IS_LOGIN_MODE) {
        renderEmpDashboard();
        return;
      }

      // Mode patron : re-rendre seulement si pas en train de taper
      if (!_isTyping) {
        render();
        toast('Données reçues en temps réel');
      }
    }, err => console.warn('Realtime sync error:', err.message));
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setView, back, prevDay, nextDay, selectPharmacy,
    onInput, saveCard, saveAll, showDetail,
    addPharmacy, renamePharmacy, deletePharmacy,
    addCaisse, renameCaisse, deleteCaisse,
    exportData, importData, closeModal, toggleTheme,
    toggleFourni, onFourniAmount,
    prevMonth, nextMonth, validateCard, exportPDF,
    subscribeToPush, sendReminder, empSubscribePush,
    exportCSV, lockDay, unlockDay,
    lsPharmacy, lsEmployee, lsPin, lsPinDel, doLogin,
    empLogout, empPrevDay, empNextDay, submitEmpCard, copyLoginLink,
    unlockForEmp,
    addEmployee, editEmployee, saveEmployee, deleteEmployee,
  };
})();
