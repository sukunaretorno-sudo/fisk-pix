/**
 * Fisk Pay - Client Application
 * Distinct views for Students, Teachers & Pedagogical Coordination
 */

const BADGE = `<svg viewBox="0 0 260 220" width="180" role="img" aria-label="Falou Fisk, falou tudo"><defs><path id="ta" d="M56,110 A74,74 0 0 1 204,110"/><path id="ba" d="M44,110 A86,86 0 0 0 216,110"/></defs><circle cx="130" cy="110" r="100" fill="none" style="stroke:var(--teal)" stroke-width="6"/><rect x="20" y="80" width="220" height="58" style="fill:var(--card)"/><text font-family="Archivo Black,Arial Black,sans-serif" font-size="23" text-anchor="middle" style="fill:var(--teal)"><textPath href="#ta" startOffset="50%">FALOU</textPath></text><text font-family="Archivo Black,Arial Black,sans-serif" font-size="23" text-anchor="middle" style="fill:var(--teal)"><textPath href="#ba" startOffset="50%">FALOU TUDO</textPath></text><text x="130" y="130" text-anchor="middle" font-family="Archivo Black,Arial Black,sans-serif" font-size="58" textLength="210" lengthAdjust="spacingAndGlyphs" style="fill:var(--teal)">FISK</text><text x="0" y="116" font-size="20" style="fill:var(--teal)">★</text><text x="238" y="116" font-size="20" style="fill:var(--teal)">★</text></svg>`;
const BUDDY_SRC = '/assets/buddy.jpg';

const ROLE_LABELS = {
  aluno: 'Aluno',
  admin: 'Coordenação Pedagógica',
  teacher: 'Professor(a)',
  coordenacao: 'Coordenação Pedagógica'
};

let currentUser = null;
let authToken = localStorage.getItem('fisk_token') || null;
let activeTab = 'pix';
let pixSubMode = 'send'; // 'send' or 'qrcode'
let pendingPix = null;
let lastReceipt = null;
let txFilter = 'all';
let attendanceDate = localDate();
let feedbackMsg = null;
let eventSource = null;
let isOnline = false;
let userQrCode = null;
let qrRequestToken = null;
let pixSending = false;
let bindGeneration = 0;
let pixDraft = { key: '', recipient: '', amount: '', note: '' };
let attendanceNote = '';

const $ = sel => document.querySelector(sel);
const fmt = n => 'F$ ' + Number(n).toLocaleString('pt-BR');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = t => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ========================================================
   Avatar with Profile Frame Renderer
   ======================================================== */
function renderBuddy(frameClass = 'none', customStyle = '', mascot = 'buddy') {
  const frame = frameClass || 'none';
  const hasCrown = frame === 'frame-crown';
  return `
    <div class="buddy-container ${['buddy-celebrate', 'buddy-study'].includes(mascot) ? mascot : ''}" style="${customStyle}">
      ${hasCrown ? '<div class="crown-badge">👑</div>' : ''}
      <img class="buddy ${esc(frame)} ${['buddy-celebrate', 'buddy-study'].includes(mascot) ? mascot : ''}" alt="Buddy" src="${BUDDY_SRC}">
    </div>
  `;
}

/* ========================================================
   Audio Feedback
   ======================================================== */
function playPixSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.08);
    osc.frequency.setValueAtTime(783.99, now + 0.16);
    osc.frequency.setValueAtTime(1046.50, now + 0.24);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(now + 0.55);
  } catch (e) {}
}

/* ========================================================
   Toast Notification System
   ======================================================== */
function showToast(text, isPix = true) {
  const container = $('#toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${isPix ? 'pix' : ''}`;
  toast.innerHTML = `<span>${esc(text)}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

/* ========================================================
   API Client
   ======================================================== */
async function api(endpoint, method = 'GET', body = null) {
  const requestToken = authToken;
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 || res.status === 403) {
    if (requestToken && requestToken === authToken && endpoint !== '/api/auth/login') {
      logout('Sua sessão expirou. Faça login novamente.');
      throw new Error(data.error || 'Sessão expirada');
    }
  }

  if (!res.ok) {
    throw new Error(data.error || 'Erro na requisição.');
  }

  return data;
}

/* ========================================================
   Real-Time Server-Sent Events (SSE)
   ======================================================== */
function connectSSE() {
  if (!authToken) return;
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/events?token=${encodeURIComponent(authToken)}`);

  eventSource.onopen = () => {
    isOnline = true;
    updateOnlineBadge();
  };

  eventSource.onerror = () => {
    isOnline = false;
    updateOnlineBadge();
  };

  eventSource.addEventListener('pix_received', (e) => {
    const d = JSON.parse(e.data);
    playPixSound();
    showToast(`💸 Você recebeu ${fmt(d.amount)} de ${d.from}!`);
    refreshUserData();
  });

  eventSource.addEventListener('attendance_updated', (e) => {
    const d = JSON.parse(e.data);
    const msg = d.status === 'p' ? 'Presença confirmada (+F$ 3)!' : 'Marcação de presença alterada.';
    showToast(`📝 ${msg}`);
    refreshUserData();
  });

  eventSource.addEventListener('balance_adjusted', (e) => {
    const d = JSON.parse(e.data);
    showToast(`⚡ Saldo atualizado pela escola: ${fmt(d.newBalance)}`);
    refreshUserData();
  });

  eventSource.addEventListener('bulk_reward', (e) => {
    const d = JSON.parse(e.data);
    playPixSound();
    showToast(`🎁 Bônus da escola: +${fmt(d.amount)} adicionados!`);
    refreshUserData();
  });

  eventSource.addEventListener('balance_updated', () => {
    if (activeTab === 'rank' || activeTab === 'att' || activeTab === 'store') {
      render();
    }
  });
}

function updateOnlineBadge() {
  const badge = $('#online-badge');
  if (badge) {
    badge.innerHTML = `<span class="status-dot ${isOnline ? '' : 'offline'}"></span> ${isOnline ? 'Servidor Online' : 'Conectando...'}`;
  }
}

async function refreshUserData() {
  const token = authToken;
  try {
    const data = await api('/api/auth/me');
    if (!currentUser || authToken !== token) return;
    currentUser = { ...currentUser, ...data };
    // Update the overview without discarding a form the user is completing.
    const amount = $('.wallet-amount');
    if (amount) amount.textContent = balanceHidden ? 'F$ ••••' : fmt(currentUser.balance);
    const streak = $('.streak-card');
    if (streak && currentUser.role === 'aluno') streak.outerHTML = streakHTML(currentUser.streaks);
  } catch (e) {}
}

/* ========================================================
   Auth Actions
   ======================================================== */
async function doLogin() {
  const button = $('#go');
  if (!button || button.disabled) return;
  const username = $('#nick').value.trim();
  const password = $('#pw').value;
  if (!username || !password) return showFeedback('Preencha seu usuário e sua senha.');
  button.disabled = true;
  button.textContent = 'Entrando…';
  button.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/auth/login', 'POST', { username, password });
    authToken = data.token;
    localStorage.setItem('fisk_token', authToken);
    currentUser = data.user;
    feedbackMsg = null;
    activeTab = currentUser.role === 'teacher' ? 'att' : ['coordenacao', 'admin'].includes(currentUser.role) ? 'coord_classes' : 'pix';
    connectSSE();
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    showFeedback(err.message === 'Failed to fetch' ? 'Não foi possível conectar. Verifique sua conexão e tente novamente.' : err.message);
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = `Entrar na minha conta ${icon('arrow')}`;
  }
}

function logout(customMessage = null) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  authToken = null;
  currentUser = null;
  localStorage.removeItem('fisk_token');
  pendingPix = null;
  lastReceipt = null;
  userQrCode = null;
  qrRequestToken = null;
  pixDraft = { key: '', recipient: '', amount: '', note: '' };
  attendanceNote = '';
  isOnline = false;
  pixSubMode = 'send';
  feedbackMsg = customMessage ? { t: customMessage, k: 'bad' } : null;
  render();
  window.scrollTo(0, 0);
}

async function checkExistingSession() {
  if (!authToken) return render();
  try {
    currentUser = await api('/api/auth/me');
    if (currentUser.role === 'teacher' && activeTab === 'pix') {
      activeTab = 'att';
    } else if (['coordenacao', 'admin'].includes(currentUser.role) && activeTab === 'pix') {
      activeTab = 'coord_classes';
    }
    connectSSE();
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    logout();
  }
}

/* ========================================================
   Pix Transfer Flow & QR Code (Students)
   ======================================================== */
async function loadUserQrCode() {
  if (userQrCode || !currentUser || qrRequestToken === authToken) return;
  const token = authToken;
  const username = currentUser.username;
  qrRequestToken = token;
  try {
    const data = await api(`/api/pix/qrcode/${encodeURIComponent(username)}`);
    if (authToken !== token || currentUser?.username !== username) return;
    userQrCode = data;
    if (activeTab === 'pix' && pixSubMode === 'qrcode') render();
  } catch (e) {
    if (authToken === token) showLoadError(e);
  } finally {
    if (qrRequestToken === token) qrRequestToken = null;
  }
}

async function preparePix() {
  const toSelect = $('#to');
  const directKeyInput = $('#direct-key');
  let toUserId = toSelect ? toSelect.value : null;
  let toUsername = null;

  if (directKeyInput && directKeyInput.value.trim()) {
    toUsername = directKeyInput.value.trim();
    toUserId = null;
  }

  const amount = Number($('#amt').value);
  const note = $('#note').value.trim().slice(0, 100);

  if (!Number.isSafeInteger(amount) || amount < 1) return showFeedback('Informe um valor inteiro maior que zero.');
  if (amount > 10000) return showFeedback('O limite de envio é de F$ 10.000 por dia.');
  if (!toUsername && !toUserId) return showFeedback('Digite uma chave Pix ou selecione um colega.');

  if (amount > currentUser.balance) {
    return showFeedback('Saldo insuficiente para realizar este Pix.');
  }

  let recipientName = '';
  if (toSelect && toSelect.selectedIndex >= 0) {
    recipientName = toSelect.options[toSelect.selectedIndex].text;
  }
  if (toUsername) {
    recipientName = toUsername.startsWith('@') ? toUsername : `@${toUsername}`;
  }

  pendingPix = { toUserId, toUsername, recipientName, amount, note };
  render();
}

async function confirmPix() {
  if (!pendingPix || pixSending) return;
  const p = pendingPix;
  const token = authToken;
  pixSending = true;
  const button = $('#confirm-pix-btn');
  if (button) { button.disabled = true; button.textContent = 'Enviando…'; }
  if ($('#cancel-pix-btn')) $('#cancel-pix-btn').disabled = true;

  try {
    const res = await api('/api/pix/send', 'POST', {
      toUserId: p.toUserId,
      toUsername: p.toUsername,
      amount: p.amount,
      note: p.note
    });

    if (authToken !== token || !currentUser) return;
    pendingPix = null;
    pixDraft = { key: '', recipient: '', amount: '', note: '' };
    currentUser.balance = res.receipt.new_balance;
    lastReceipt = res.receipt;
    playPixSound();
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    if (authToken === token && currentUser) {
      feedbackMsg = { t: err.message, k: 'bad' };
      render();
    }
  } finally {
    pixSending = false;
  }
}

/* ========================================================
   Fisk Store & Molduras Actions
   ======================================================== */
async function handleBuyItem(itemId, itemName, price) {
  const token = authToken;
  if (currentUser.balance < price) {
    feedbackMsg = { t: `Saldo insuficiente para comprar ${itemName}!`, k: 'bad' };
    return render();
  }

  const purchase = await confirmAction('Comprar personalização', `<p>Comprar <strong>${esc(itemName)}</strong> por <strong>${fmt(price)}</strong>?</p><p>Seu saldo após a compra: ${fmt(currentUser.balance - price)}.</p>`, 'Comprar e equipar', true);
  if (!purchase || authToken !== token) return;
  try {
    const res = await api('/api/store/buy', 'POST', { itemId, note: purchase.note });
    if (authToken !== token || !currentUser) return;
    currentUser.balance = res.result.newBalance;
    if (res.result.item.category === 'theme') currentUser.active_theme = res.result.item.id;
    else currentUser.active_frame = res.result.item.frame_css;
    playPixSound();
    showToast(`🎉 Parabéns! Você equipou a ${itemName}!`);
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleEquipFrame(frameId) {
  const token = authToken;
  try {
    await api('/api/store/equip', 'POST', { frameId });
    if (authToken !== token || !currentUser) return;
    currentUser.active_frame = frameId;
    showToast(frameId === 'none' ? 'Moldura removida.' : 'Moldura equipada!');
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

/* ========================================================
   Teacher & Coordenação Actions
   ======================================================== */
async function markAttendance(studentId, status) {
  try {
    const res = await api('/api/attendance/mark', 'POST', {
      date: attendanceDate,
      studentId,
      status,
      note: attendanceNote
    });

    feedbackMsg = { 
      t: `Chamada de ${res.result.status === 'p' ? 'Presença (+F$ 3)' : res.result.status === 'f' ? 'Falta' : 'Desmarcado'} atualizada!`, 
      k: 'ok' 
    };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleTeacherAward() {
  const studentId = $('#award_student').value;
  const amount = Number($('#award_amt').value);
  const reason = $('#award_reason').value.trim();

  if (!studentId || !Number.isSafeInteger(amount) || amount < 1) {
    feedbackMsg = { t: 'Selecione o aluno e informe um valor válido.', k: 'bad' };
    return render();
  }

  try {
    const res = await api('/api/teacher/award', 'POST', { studentId, amount, reason });
    feedbackMsg = { t: res.message, k: 'ok' };
    $('#award_amt').value = '';
    $('#award_reason').value = '';
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleBulkReward() {
  const amount = Number($('#bulk_amt').value);
  const note = $('#bulk_reason').value.trim().slice(0, 100);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    feedbackMsg = { t: 'Informe um valor válido maior que zero.', k: 'bad' };
    return render();
  }

  try {
    const { users } = await api('/api/users/recipients');
    if (!users.length) return showFeedback('Nenhum aluno ativo para receber o bônus.');
    if (!await confirmAction('Revisar bônus coletivo', `<p><strong>${users.length} alunos</strong> receberão <strong>${fmt(amount)} cada</strong>.</p><p>Total a distribuir: <strong>${fmt(amount * users.length)}</strong>.</p><p>Descrição: ${esc(note || 'Bônus coletivo')}</p>`, 'Confirmar distribuição')) return;
    const res = await api('/api/admin/bulk-reward', 'POST', { amount, note });
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleCreateUser(forcedRole = 'aluno') {
  const username = $('#nn').value.trim().toLowerCase();
  const name = $('#nm').value.trim();
  const password = $('#ns').value;

  if (!username || !name || password.length < 6) {
    feedbackMsg = { t: 'Preencha apelido, nome e senha com no mínimo 6 caracteres.', k: 'bad' };
    return render();
  }

  try {
    await api('/api/admin/create-user', 'POST', { username, name, password, role: forcedRole, note: $('#new-student-note')?.value || '' });
    feedbackMsg = { t: `${forcedRole === 'teacher' ? 'Professor(a)' : 'Aluno(a)'} ${name} cadastrado(a)!`, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleChangePassword() {
  const token = authToken;
  const newPassword = $('#np').value;
  if (!newPassword || newPassword.length < 6) {
    feedbackMsg = { t: 'A senha precisa ter pelo menos 6 caracteres.', k: 'bad' };
    return render();
  }

  try {
    const res = await api('/api/auth/change-password', 'POST', { newPassword });
    if (token !== authToken || !currentUser) return;
    acceptSessionToken(res);
    $('#np').value = '';
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

function exportExcel(type) {
  const url = type === 'attendance'
    ? `/api/admin/export/attendance?token=${encodeURIComponent(authToken)}`
    : `/api/admin/export/transactions?token=${encodeURIComponent(authToken)}`;
  window.location.href = url;
}

/* ========================================================
   Main Render Function
   ======================================================== */
async function render() {
  const app = $('#app');
  if (!app) return;
  document.documentElement.dataset.storeTheme = currentUser?.active_theme || 'default';

  // The same account determines the available school tools after sign-in.
  if (!currentUser) {
    app.className = 'login-page';
    app.innerHTML = `
      <header class="login-header">
        ${brandHTML()}
        <button class="icon-button" id="toggle-theme-btn" aria-label="Alternar tema claro e escuro">${icon('sun')}</button>
      </header>
      <main class="login-layout" id="main-content">
        <section class="login-story">
          <div class="eyebrow"><span class="accent-dot"></span> SEU APRENDIZADO VALE MAIS</div>
          <h1>Pequenas conquistas.<br><em>Grandes possibilidades.</em></h1>
          <p>Aprenda, participe e conquiste Fisk Dollars. Seu progresso e o dia a dia na Fisk, juntos em um só lugar.</p>
          <div class="login-benefits">
            <div class="benefit"><span>${icon('pix')}</span><div><strong>Conecte-se com seus colegas</strong><p>Envie e receba Fisk Dollars com Pix.</p></div></div>
            <div class="benefit"><span>${icon('star')}</span><div><strong>Cada conquista conta</strong><p>Ganhe méritos, mantenha sua sequência e evolua.</p></div></div>
            <div class="benefit"><span>${icon('store')}</span><div><strong>Seu perfil, do seu jeito</strong><p>Troque suas conquistas por molduras para o Buddy.</p></div></div>
          </div>
          <div class="brand-seal">${BADGE}<span>Uma experiência feita<br>para a comunidade Fisk.</span></div>
        </section>
        <section class="login-panel" aria-labelledby="login-title">
          <div class="login-card">
            <div class="login-mascot">${renderBuddy()}</div>
            <div class="eyebrow">BEM-VINDO AO FISK PAY</div>
            <h2 id="login-title">Vamos nessa?</h2>
            <p>Entre na sua conta e continue sua jornada.</p>
            <form class="login-form" id="login-form">
              <label for="nick">Seu usuário</label>
              <div class="input-wrap">${icon('user')}<input id="nick" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Digite seu usuário" required></div>
              <label for="pw">Sua senha</label>
              <div class="password-wrap"><input id="pw" type="password" autocomplete="current-password" placeholder="Digite sua senha" required><button type="button" id="toggle-password" class="icon-button" aria-label="Mostrar senha" aria-pressed="false">${icon('eye')}</button></div>
              <div id="form-feedback" class="msg ${feedbackMsg ? feedbackMsg.k : ''}" role="status" aria-live="polite">${feedbackMsg ? esc(feedbackMsg.t) : ''}</div>
              <button type="submit" class="btn" id="go">Entrar na minha conta ${icon('arrow')}</button>
            </form>
            <details class="login-help"><summary>Precisa de ajuda para entrar?</summary><p>Use o usuário e a senha fornecidos pela escola. Se esqueceu seu acesso, procure seu professor ou a coordenação.</p></details>
            <div class="login-role-note">Alunos, professores e coordenação.<br>Um só acesso, cada um com seu espaço.</div>
          </div>
        </section>
      </main>
      <footer class="login-footer"><span>Fisk Pay · Conquistas que ensinam</span><span>Falou Fisk, falou tudo!</span></footer>`;
    $('#login-form').onsubmit = e => { e.preventDefault(); doLogin(); };
    $('#toggle-password').onclick = () => {
      const visible = $('#pw').type === 'password';
      $('#pw').type = visible ? 'text' : 'password';
      $('#toggle-password').setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
      $('#toggle-password').setAttribute('aria-pressed', String(visible));
      $('#toggle-password').innerHTML = icon(visible ? 'eyeOff' : 'eye');
    };
    bindTheme();
    return;
  }
  app.className = 'app-shell';

  // 2. Navigation Tabs based on Role
  let tabs = [];
  if (currentUser.role === 'aluno') {
    tabs = [
      ['pix', 'Pix'],
      ['store', 'Lojinha 🛍️'],
      ['ext', 'Extrato'],
      ['rank', 'Ranking']
    ];
  } else if (currentUser.role === 'teacher') {
    tabs = [
      ['att', 'Chamada 📝'],
      ['merit', 'Lançar Méritos ⭐'],
      ['students', 'Alunos 👥'],
      ['cards', 'Imprimir Cartões 💳'],
      ['reports', 'Relatórios 📥']
    ];
  } else if (['coordenacao', 'admin'].includes(currentUser.role)) {
    tabs = [
      ['coord_classes', 'Pessoas e Perfis 👥'],
      ['coord_audit', 'Auditoria dos Professores 📋'],
      ['cards', 'Imprimir Cartões 💳'],
      ['adm', 'Gestão Monetária 💰'],
      ['reports', 'Relatórios 📥']
    ];
  }

  const hasWallet = currentUser.role === 'aluno';
  const headerHTML = hasWallet ? `
    <section class="wallet-card" aria-label="Sua carteira Fisk">
      <div class="wallet-top"><span class="wallet-brand">FISK <span>PAY</span></span><span class="wallet-tag">CARTEIRA DO ALUNO</span></div>
      <div class="wallet-label">Saldo disponível <button id="toggle-balance-btn" class="icon-button" aria-label="${balanceHidden ? 'Mostrar' : 'Ocultar'} saldo" aria-pressed="${balanceHidden}">${icon(balanceHidden ? 'eyeOff' : 'eye')}</button></div>
      <div class="wallet-amount">${balanceHidden ? 'F$ ••••' : fmt(currentUser.balance)}</div>
      <div class="wallet-bottom"><div><span>SUA CHAVE PIX</span><strong>@${esc(currentUser.username)}</strong><small>${esc(currentUser.serial)}</small></div>${renderBuddy(currentUser.active_frame, '', currentUser.mascot)}</div>
    </section>
    ${streakHTML(currentUser.streaks)}
  ` : `<section class="staff-welcome"><div><div class="eyebrow">${currentUser.role === 'teacher' ? 'ESPAÇO DO PROFESSOR' : 'COORDENAÇÃO PEDAGÓGICA'}</div><h2>Mais tempo para ensinar.<br>Mais espaço para evoluir.</h2><p>Alunos, frequência e conquistas em um só lugar.</p><div id="online-badge" class="status-badge"></div></div>${renderBuddy(currentUser.active_frame, '', currentUser.mascot)}</section>`;

const tabsHTML = `<nav class="tabs" aria-label="Navegação principal">${tabs.map(t => `<button aria-label="${esc(NAV[t[0]]?.label || t[1])}" data-t="${t[0]}" class="${activeTab === t[0] ? 'on' : ''}" ${activeTab === t[0] ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(NAV[t[0]]?.icon || 'grid')}</span><span class="nav-text" data-mobile-label="${esc(({coord_classes:'Pessoas',coord_audit:'Auditoria',cards:'Cartões',adm:'Saldos',ext:'Extrato'})[t[0]] || NAV[t[0]]?.label || t[1])}">${NAV[t[0]]?.label || esc(t[1])}</span>${icon('chevron')}</button>`).join('')}</nav>`;

  let tabContent = '<div class="empty">Carregando dados...</div>';

  /* ========================================================
     Tab: PIX (Students Only)
     ======================================================== */
  if (activeTab === 'pix') {
    if (lastReceipt) {
      tabContent = `
        <div class='note'>
          <div class='top'>
            <div class='fisk'>Fisk</div>
            <div class='flag'></div>
          </div>
          <div class='title'>Comprovante Oficial de Pix</div>
          <div class='bal'>
            <b>${fmt(lastReceipt.amount)}</b>
            ${renderBuddy(currentUser.active_frame)}
          </div>
          <div class='row'>
            <div>De<small>${esc(lastReceipt.from.name)}</small></div>
            <div>Para<small>${esc(lastReceipt.to.name)}</small></div>
          </div>
          ${lastReceipt.note ? `<div class='row'><div>Mensagem<small>“${esc(lastReceipt.note)}”</small></div></div>` : ''}
          <div class='serial'>
            <span>${esc(lastReceipt.code)}</span>
            <span>${when(lastReceipt.created_at)}</span>
          </div>
          <div class='legal'>Autenticação Bancária Fisk · Falou Fisk, falou tudo!</div>
          <button class='btn alt' id='newp'>Fazer Novo Pix</button>
        </div>
      `;
    } else if (pendingPix) {
      tabContent = `
        <div class='note'>
          <div class='title'>Confirmar Transferência Pix</div>
          <div class='bal'>
            <b>${fmt(pendingPix.amount)}</b>
          </div>
          <div class='row'>
            <div>Destinatário<small>${esc(pendingPix.recipientName)}</small></div>
          </div>
          ${pendingPix.note ? `<div class='row'><div>Mensagem<small>“${esc(pendingPix.note)}”</small></div></div>` : ''}
          <button class='btn' id='confirm-pix-btn'>Confirmar e Enviar</button>
          <button class='btn alt' id='cancel-pix-btn'>Cancelar</button>
        </div>
      `;
    } else if (pixSubMode === 'qrcode') {
      tabContent = `
        <div class="note">
          <div class="segmented-control" aria-label="Tipo de operação Pix">
            <button class="btn alt" style="flex:1" id="submode-send">${icon('send')} Enviar Pix</button>
            <button class="btn green" style="flex:1" id="submode-qr">${icon('qr')} Receber Pix</button>
          </div>
          <div class="title">Receber Pix no Fisk Pay</div>
          <div class="qr-box">
            ${userQrCode && userQrCode.qrDataUrl 
              ? `<img src="${userQrCode.qrDataUrl}" alt="QR Code Pix">` 
              : '<div class="empty">Gerando QR Code...</div>'}
            <button type="button" class="pix-key-pill" id="copy-key-btn">
              <span>Chave: <b>@${esc(currentUser.username)}</b></span> Copiar chave
            </button>
          </div>
          <div class="legal">Peça para seu colega escanear ou transferir para @${esc(currentUser.username)}</div>
        </div>
      `;
    } else {
      tabContent = `
        <div class="note">
          <div class="segmented-control" aria-label="Tipo de operação Pix">
            <button class="btn green" style="flex:1" id="submode-send">${icon('send')} Enviar Pix</button>
            <button class="btn alt" style="flex:1" id="submode-qr">${icon('qr')} Receber Pix</button>
          </div>
          <div class="title">Enviar Pix no Fisk Pay</div>
          
          <label for="direct-key">Para quem vamos enviar?</label>
          <input id="direct-key" value="${esc(pixDraft.key)}" placeholder="@usuario" autocapitalize="none" spellcheck="false">

          <label for="recipient-search">Busque um colega</label>
          <input id="recipient-search" type="search" placeholder="Nome ou @usuário" autocomplete="off">
          <label for="to">Ou escolha um colega</label>
          <select id="to"><option value="">Carregando colegas...</option></select>
          <small id="recipient-count" role="status"></small>
          
          <label for="amt">Valor em Fisk Dollars (F$)</label>
          <input id="amt" value="${esc(pixDraft.amount)}" type="number" min="1" max="10000" step="1" inputmode="numeric" placeholder="Quanto deseja transferir?">
          <small id="pix-limit" role="status">Limite de envio: F$ 10.000 por dia.</small>
          
          <label for="note">Mensagem ou Motivo (opcional)</label>
          <input id="note" value="${esc(pixDraft.note)}" maxlength="100" placeholder="ex: Valeu pela ajuda no speaking!">
          
          <button class="btn" id="send-btn">Revisar transferência ${icon('arrow')}</button>
        </div>
      `;
    }
  }

  /* ========================================================
     Tab: LOJINHA DE MOLDURAS (Students Only)
     ======================================================== */
  else if (activeTab === 'store') {
    tabContent = `
      <div class="note">
        <div class="title">Sua coleção Fisk</div>
        <div style="text-align:center;font-size:13px;margin:6px 0;color:var(--ink)">
          Seu saldo: <b>${fmt(currentUser.balance)}</b> · Escolha uma moldura ou transforme o app com um tema.
        </div>
        <div class="store-category-tabs" aria-label="Categorias da loja"><button class="btn alt" data-store-category="frame">Molduras</button><button class="btn alt" data-store-category="theme">Temas premium</button></div>
        <div id="store-container"><div class="empty">Carregando coleção...</div></div>
      </div>
    `;
  }

  /* ========================================================
     Tab: EXTRATO (Students Only)
     ======================================================== */
  else if (activeTab === 'ext') {
    tabContent = `
      <div class="note">
        <div class='title'>Extrato de Movimentações</div>
        <label class="sr-only" for="flt">Filtrar movimentações</label><select id='flt'>
          <option value='all' ${txFilter === 'all' ? 'selected' : ''}>Todas as transações</option>
          <option value='in' ${txFilter === 'in' ? 'selected' : ''}>Apenas Recebidos</option>
          <option value='out' ${txFilter === 'out' ? 'selected' : ''}>Apenas Enviados</option>
        </select>
        <div id="statement-list"><div class="empty">Buscando extrato...</div></div>
      </div>
    `;
  }

  /* ========================================================
     Tab: RANKING
     ======================================================== */
  else if (activeTab === 'rank') {
    tabContent = `
      <div class="note">
        <div class='title'>Ranking dos Alunos</div>
        <div id="leaderboard-list"><div class="empty">Carregando classificação...</div></div>
      </div>
    `;
  }

  /* ========================================================
     Tab: CHAMADA (Teacher / Admin)
     ======================================================== */
  else if (activeTab === 'att') {
    tabContent = `
      <div class='note'>
        <div class='title'>Chamada de Aula · +F$ 3 por presença</div>
        <div style="margin-bottom:8px">
          <div>
            <label for='ad'>Data da aula</label>
            <input id='ad' type='date' value='${attendanceDate}'>
          </div>
        </div>
        <label for="attendance-note">Descrição da chamada (opcional)</label>
        <input id="attendance-note" maxlength="100" value="${esc(attendanceNote)}" placeholder="ex: Aula de conversação">
        <button class="btn alt" id="attendance-all-btn">Marcar todos como presentes</button>
        <p class="field-hint">Alunos já presentes não recebem a recompensa novamente.</p>
        <div id="attendance-list"><div class="empty">Carregando alunos...</div></div>
      </div>
    `;
  }

  /* ========================================================
     Tab: LANÇAR MÉRITOS (Teacher / Admin)
     ======================================================== */
  else if (activeTab === 'merit') {
    tabContent = `
      <div class='note'>
        <div class='title'>Premiar Aluno com Fisk Dollars ⭐</div>
        <label for="award_student">Selecionar Aluno</label>
        <select id="award_student"><option value="">Carregando alunos...</option></select>

        <label for="award_amt">Quantidade de Fisk Dollars (F$)</label>
        <input id="award_amt" type="number" min="1" step="1" placeholder="ex: 5, 10, 15">

        <label for="award_reason">Descrição / elogio (opcional)</label>
        <input id="award_reason" placeholder="ex: Excelente speaking no diálogo da lição 4">

        <button class="btn green" id="award-btn">Lançar Prêmio de Mérito</button>
      </div>

      <div class='note'>
        <div class='title'>Bônus Coletivo para Todos os Alunos</div>
        <label for="bulk_amt">Valor em Fisk Dollars para cada aluno (F$)</label>
        <input id='bulk_amt' type='number' min='1' step='1' placeholder='ex: 10'>

        <label for='bulk_reason'>Descrição do bônus (opcional)</label>
        <input id='bulk_reason' placeholder='ex: Excelente participação no evento!'>

        <button class='btn alt' id='bulk-btn'>Distribuir Bônus para Todos os Alunos</button>
      </div>
    `;
  }

  /* ========================================================
     Tab: ALUNOS (Teacher)
     ======================================================== */
  else if (activeTab === 'students') {
    tabContent = `
      <div class="note">
        <div class="title">Alunos Cadastrados</div>
        <div class="scroll">
          <table id="teacher-students-table">
            <tr><th>Aluno</th><th>Usuário</th><th>Saldo</th></tr>
          </table>
        </div>
      </div>

      <div class='note'>
        <div class='title'>Cadastrar Novo Aluno</div>
        <label for='nn'>Apelido (login)</label>
        <input id='nn' autocapitalize='none' placeholder='ex: pedro'>
        <label for='nm'>Nome completo</label>
        <input id='nm' placeholder='ex: Pedro Santos'>
        <label for='ns'>Senha inicial (mín. 6)</label>
        <input id='ns' type='password' autocomplete='new-password'>
        <label for='new-student-note'>Descrição do cadastro (opcional)</label>
        <input id='new-student-note' maxlength='100' placeholder='ex: Novo acesso'>
        <button class='btn' id='create-student-btn'>Cadastrar Aluno</button>
      </div>
    `;
  }

  /* ========================================================
     Tab: IMPRIMIR CARTÕES FÍSICOS (Ideia 6)
     ======================================================== */
  else if (activeTab === 'cards') {
    tabContent = `
      <div class="note" id="print-controls-card">
        <div class="title">Gerador de Cartões Físicos dos Alunos 💳</div>
        <div style="font-size:12px;text-align:center;color:var(--ink);margin:6px 0">
          Gere carteirinhas prontas para imprimir e plastificar no formato cartão de crédito (CR80) com QR Code Pix!
        </div>
        
        <button class="btn green" id="print-now-btn" style="margin-top:14px">🖨️ Imprimir Cartões dos Alunos</button>
      </div>

      <div class="note" id="print-section">
        <div class="title" style="margin-bottom:12px">Visualização dos Cartões para Impressão</div>
        <div id="cards-grid" class="cards-print-grid">
          <div class="empty">Carregando cartões dos alunos...</div>
        </div>
      </div>
    `;
  }

  /* ========================================================
     Tab: COORDENAÇÃO - PESSOAS E PERFIS
     ======================================================== */
  else if (activeTab === 'coord_classes') {
    tabContent = peoplePageHTML();
  }

  /* ========================================================
     Tab: COORDENAÇÃO - AUDITORIA DOS PROFESSORES
     ======================================================== */
  else if (activeTab === 'coord_audit') {
    tabContent = `
      <div class="note">
        <div class="title">Histórico de atividades</div>
        <div style="font-size:12px;text-align:center;color:var(--ink);margin:6px 0">
          Cadastros, acessos, ações pedagógicas e ajustes de saldo registrados em um só lugar.
        </div>
        <div class="scroll">
          <table id="audit-table">
            <tr><th>Data/Hora</th><th>Responsável</th><th>Ação</th><th>Pessoa</th><th>Descrição</th></tr>
          </table>
        </div>
      </div>
    `;
  }

  /* ========================================================
     Tab: GESTÃO MONETÁRIA (Coordenação / Admin)
     ======================================================== */
  else if (activeTab === 'adm') {
    tabContent = `
      <div class="note">
        <div class="title" id="economy-title">Estatísticas Gerais do Banco Fisk</div>
        <div class="scroll">
          <table id="accounts-table">
            <tr><th>Usuário</th><th>Perfil</th><th>Saldo</th></tr>
          </table>
        </div>
        <h3 style="margin-top:16px">Últimas 15 movimentações no sistema</h3>
        <div id="global-tx-list"><div class="empty">Carregando histórico...</div></div>
      </div>

      <div class='note'>
        <div class='title'>Gestão Monetária de Saldos</div>
        <label for="au">Conta do Aluno / Usuário</label>
        <select id="au"><option value="">Carregando contas...</option></select>
        
        <label for="aa">Valor em Fisk Dollars (F$)</label>
        <input id='aa' type='number' min='0' step='1' inputmode='numeric' placeholder='0'>
        
        <label for='ar'>Motivo</label>
        <input id='ar' maxlength='100' placeholder='ex: Correção de saldo'>
        
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" style="flex:1" id="mint-btn">Emitir Moeda</button>
          <button class="btn alt" style="flex:1" id="set-btn">Definir Saldo</button>
          <button class="btn alt" style="flex:1" id="withdraw-btn">Retirar Valor</button>
        </div>
      </div>
    `;
  }

  /* ========================================================
     Tab: RELATÓRIOS EXCEL
     ======================================================== */
  else if (activeTab === 'reports') {
    tabContent = reportsPageHTML();
  }

  const section = NAV[activeTab] || NAV.pix;
  const firstName = currentUser.role === 'teacher' ? currentUser.name : currentUser.name.split(' ')[0];
  const footerHTML = profileSettingsHTML() + `<details class="note account-settings"><summary>${icon('lock')} Segurança da conta <span>Alterar senha</span></summary><label for="np">Nova senha (mínimo 6 caracteres)</label><input id="np" type="password" autocomplete="new-password" minlength="6"><button class="btn alt" id="chpw-btn">Salvar nova senha</button></details><footer class="app-footer"><span>Fisk Pay · Juntos, a gente vai além.</span><span>Falou Fisk, falou tudo!</span></footer>`;
  app.innerHTML = `
    <aside class="sidebar">
      ${brandHTML()}<div class="brand-caption">CONQUISTAS QUE ENSINAM</div>
      <div class="nav-label">MEU ESPAÇO</div>${tabsHTML}
      <div class="sidebar-bottom"><div class="sidebar-motto">Seu esforço.<br>Suas conquistas.<br><strong>Seu futuro.</strong></div><button class="icon-text-button" id="toggle-theme-btn" aria-label="Alternar tema">${icon('sun')}<span>Alternar tema</span></button><button class="icon-text-button" id="logout-btn" aria-label="Sair da conta">${icon('logout')}<span>Sair da conta</span></button></div>
    </aside>
    <main class="main-area" id="main-content">
      <header class="workspace-header"><div><div class="eyebrow">${hasWallet ? 'SUA JORNADA FISK' : 'GESTÃO PEDAGÓGICA'}</div><h1>Olá, ${esc(firstName)} <span class="greeting-wave">✦</span></h1></div><button type="button" class="user-chip" id="open-profile-btn" aria-label="Editar meu perfil"><span class="user-initials">${esc(currentUser.name.split(' ').map(n => n[0]).slice(0,2).join(''))}</span><div><strong>${esc(currentUser.name)}</strong><small>${esc(ROLE_LABELS[currentUser.role])}</small></div></button></header>
      <div class="workspace-body">
        <div class="overview-grid ${hasWallet ? '' : 'staff-overview'}">${headerHTML}</div>
        <div class="content-heading"><div><h2 tabindex="-1">${section.title}</h2><p>${section.description}</p></div>${hasWallet ? `<span class="status-badge" ${currentUser.role === 'aluno' ? 'id="online-badge"' : ''}><span class="status-dot ${isOnline ? '' : 'offline'}"></span>${isOnline ? 'Conectado' : 'Conectando'}</span>` : ''}</div>
        <div id="form-feedback" class="msg ${feedbackMsg ? feedbackMsg.k : ''}" role="status" aria-live="polite">${feedbackMsg ? esc(feedbackMsg.t) : ''}</div>
        <div class="content-grid ${activeTab === 'pix' ? 'with-context' : ''}"><section class="primary-content" aria-label="${section.title}">${tabContent}</section>${activeTab === 'pix' ? `<aside class="context-panel"><section class="tip-card buddy-tip"><div class="eyebrow">BUDDY TE LEMBRA</div><h3>Aprender também<br>é compartilhar.</h3><p>Ajuda no speaking, parceria no homework… um Pix pode dizer “valeu”!</p><div class="tip-footer">${renderBuddy()}<span>Good vibes.<br><strong>Great learning.</strong></span></div></section><section class="tip-card"><span class="tip-icon">${icon('shield')}</span><h3>Confira antes de enviar</h3><p>Revise o colega e o valor na próxima etapa. Sua chave é o seu @usuário.</p></section></aside>` : ''}</div>
        ${footerHTML}
      </div>
    </main>`;
  updateOnlineBadge();
  if ($('#toggle-balance-btn')) $('#toggle-balance-btn').onclick = () => {
    balanceHidden = !balanceHidden;
    localStorage.setItem('fisk_hide_balance', String(balanceHidden));
    $('.wallet-amount').textContent = balanceHidden ? 'F$ ••••' : fmt(currentUser.balance);
    $('#toggle-balance-btn').innerHTML = icon(balanceHidden ? 'eyeOff' : 'eye');
    $('#toggle-balance-btn').setAttribute('aria-label', balanceHidden ? 'Mostrar saldo' : 'Ocultar saldo');
    $('#toggle-balance-btn').setAttribute('aria-pressed', String(balanceHidden));
  };
  bindEvents();
}

/* ========================================================
   Event Binding & Data Loaders
   ======================================================== */
async function bindEvents() {
  const generation = ++bindGeneration;
  const token = authToken;
  const tab = activeTab;
  const isCurrentView = () => generation === bindGeneration && token === authToken && tab === activeTab;
  // Navigation Tabs
  document.querySelectorAll('[data-t]').forEach(b => {
    b.onclick = async () => {
      if (activeTab === b.dataset.t) return;
      activeTab = b.dataset.t;
      pendingPix = null;
      lastReceipt = null;
      feedbackMsg = null;
      await render();
      $('.content-heading h2')?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
  });

  // Logout
  const outBtn = $('#logout-btn');
  if (outBtn) outBtn.onclick = () => logout();

  bindTheme();
  bindProfileSettings();

  // Change password
  const chpwBtn = $('#chpw-btn');
  if (chpwBtn) chpwBtn.onclick = handleChangePassword;

  /* Tab: Pix (Students) */
  if (activeTab === 'pix') {
    const sendSubBtn = $('#submode-send');
    if (sendSubBtn) sendSubBtn.onclick = () => { pixSubMode = 'send'; feedbackMsg = null; render(); };

    const qrSubBtn = $('#submode-qr');
    if (qrSubBtn) qrSubBtn.onclick = () => {
      pixSubMode = 'qrcode';
      feedbackMsg = null;
      loadUserQrCode();
      render();
    };

    if (pixSubMode === 'qrcode') {
      loadUserQrCode();
      const copyBtn = $('#copy-key-btn');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(`@${currentUser.username}`);
            showToast(`Chave @${currentUser.username} copiada!`);
          } catch { showToast(`Copie sua chave: @${currentUser.username}`, false); }
        };
      }
    } else if (lastReceipt) {
      const newpBtn = $('#newp');
      if (newpBtn) newpBtn.onclick = () => {
        lastReceipt = null;
        feedbackMsg = null;
        render();
      };
    } else if (pendingPix) {
      const confBtn = $('#confirm-pix-btn');
      if (confBtn) confBtn.onclick = confirmPix;
      const cancBtn = $('#cancel-pix-btn');
      if (cancBtn) cancBtn.onclick = () => { pendingPix = null; render(); };
    } else {
      const sendBtn = $('#send-btn');
      if (sendBtn) sendBtn.onclick = preparePix;
      for (const [id, key] of [['direct-key', 'key'], ['to', 'recipient'], ['amt', 'amount'], ['note', 'note']]) {
        const field = document.getElementById(id);
        if (field) field.oninput = () => { pixDraft[key] = field.value; };
      }

      try {
        const { users } = await api('/api/users/recipients');
      if (!isCurrentView()) return;
        bindRecipientSearch(users);
        const limit = await api('/api/pix/limit');
        if (isCurrentView() && $('#pix-limit')) $('#pix-limit').textContent = `${fmt(limit.remaining)} disponíveis para envio hoje · limite de ${fmt(limit.limit)}/dia.`;
      } catch (e) { if (isCurrentView()) showLoadError(e); }
    }
  }

  /* Tab: Store */
  if (activeTab === 'store') {
    await loadStore(isCurrentView);
  }

  /* Tab: Extrato (Students) */
  if (activeTab === 'ext') {
    const flt = $('#flt');
    if (flt) {
      flt.onchange = () => {
        txFilter = flt.value;
        bindEvents();
      };
    }

    try {
      const { transactions } = await api(`/api/pix/statement?filter=${txFilter}`);
      if (!isCurrentView()) return;
      const listEl = $('#statement-list');
      if (listEl) {
        if (!transactions.length) {
          listEl.innerHTML = '<div class="empty">Nenhuma movimentação encontrada.</div>';
        } else {
          listEl.innerHTML = transactions.map(tx => {
            const isReceived = tx.to_user_id === currentUser.id && tx.from_user_id !== currentUser.id;
            const isNegative = tx.amount < 0 || (!isReceived && tx.type === 'pix');
            const sign = isNegative ? '−' : '+';
            const cls = isNegative ? 'neg' : 'pos';

            let title = '';
            if (tx.type === 'pix') {
              title = isReceived ? `Pix de ${esc(tx.from_name)}` : `Pix para ${esc(tx.to_name)}`;
            } else if (tx.type === 'att') {
              title = tx.amount > 0 ? 'Presença em Aula' : 'Estorno de Presença';
            } else if (tx.type === 'mint') {
              title = `Mérito de ${esc(tx.from_name || 'Teacher')}`;
            } else if (tx.type === 'bulk') {
              title = `Bônus da Escola`;
            } else if (tx.type === 'withdraw' && tx.note?.startsWith('Loja:')) {
              title = 'Compra na loja';
            } else {
              title = ACTION_LABELS[tx.type] || 'Ajuste de saldo';
            }

            return `
              <div class="row">
                <div>
                  <b>${title}</b>
                  ${tx.note ? `<br><em>“${esc(tx.note)}”</em>` : ''}
                  <small>${when(tx.created_at)} · Cód: ${esc(tx.code)}</small>
                </div>
                <div class="${cls}">${sign} ${fmt(Math.abs(tx.amount))}</div>
              </div>
            `;
          }).join('');
        }
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Ranking */
  if (activeTab === 'rank') {
    try {
      const rankRes = await api('/api/ranking');
      if (!isCurrentView()) return;

      const rankEl = $('#leaderboard-list');
      if (rankEl) {
        const sortedByBalance = [...rankRes.leaderboard].sort((a, b) => b.balance - a.balance);
        const sortedByStreak = [...rankRes.leaderboard].sort((a, b) => (b.streak || 0) - (a.streak || 0));

        const balanceHTML = sortedByBalance.map((s, idx) => `
          <div class="row">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-weight:bold">${['🥇', '🥈', '🥉'][idx] || (idx + 1) + 'º'}</span>
              ${renderBuddy(s.active_frame, 'transform:scale(0.5);width:34px;height:34px;margin-right:2px', s.mascot)}
              <div>
                <b>${esc(s.name)}</b> <small style="display:inline">(@${esc(s.username)})</small>
              </div>
            </div>
            <div class="pos">${fmt(s.balance)}</div>
          </div>
        `).join('');

        const streakHTML = sortedByStreak.map(s => `
          <div class="row">
            <div style="display:flex;align-items:center;gap:8px">
              ${renderBuddy(s.active_frame, 'transform:scale(0.5);width:34px;height:34px;margin-right:2px', s.mascot)}
              <div>
                <b>${esc(s.name)}</b>
              </div>
            </div>
            <div class="pos">🔥 ${s.streak || 0} aula(s)</div>
          </div>
        `).join('');

        rankEl.innerHTML = `
          ${balanceHTML}
          <h3>Ofensiva e Frequência 🔥</h3>
          ${streakHTML}
        `;
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Chamada (Teacher / Admin) */
  if (activeTab === 'att') {
    if ($('#attendance-note')) $('#attendance-note').oninput = e => { attendanceNote = e.target.value; };
    if ($('#attendance-all-btn')) $('#attendance-all-btn').onclick = () => runAction('attendance-bulk', markAllPresent);
    const adInput = $('#ad');
    if (adInput) {
      adInput.onchange = () => {
        attendanceDate = adInput.value;
        bindEvents();
      };
    }

    try {
      const attRes = await api(`/api/attendance?date=${attendanceDate}`);
      if (!isCurrentView()) return;

      const attListEl = $('#attendance-list');
      if (attListEl) {
        const students = attRes.records;
        if (!students.length) {
          attListEl.innerHTML = '<div class="empty">Nenhum aluno cadastrado.</div>';
        } else {
          attListEl.innerHTML = students.map(s => {
            const st = s.status;
            return `
              <div class='row'>
                <div>
                  <b>${esc(s.name)}</b>
                  <small>@${esc(s.username)}</small>
                </div>
                <div class='ab'>
                  <button class='mk ${st === 'p' ? 'on' : ''}' data-uid='${s.user_id}' data-st='p'>Presente</button>
                  <button class='mk f ${st === 'f' ? 'on' : ''}' data-uid='${s.user_id}' data-st='f'>Falta</button>
                </div>
              </div>
            `;
          }).join('');

          document.querySelectorAll('.mk').forEach(btn => {
            btn.onclick = () => runAction('attendance-mark', () => markAttendance(btn.dataset.uid, btn.dataset.st));
          });
        }
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Lançar Méritos (Teacher / Admin) */
  if (activeTab === 'merit') {
    const awardBtn = $('#award-btn');
    if (awardBtn) awardBtn.onclick = () => runAction('award', handleTeacherAward);

    const bulkBtn = $('#bulk-btn');
    if (bulkBtn) bulkBtn.onclick = () => runAction('bulk-reward', handleBulkReward);

    try {
      const { users } = await api('/api/users/recipients');
      if (!isCurrentView()) return;
      const sel = $('#award_student');
      if (sel) {
        sel.innerHTML = `<option value="">Selecione o aluno...</option>` +
          users.map(u => `<option value="${u.id}">${esc(u.name)} (@${esc(u.username)})</option>`).join('');
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Alunos (Teacher) */
  if (activeTab === 'students') {
    const createStudBtn = $('#create-student-btn');
    if (createStudBtn) createStudBtn.onclick = () => runAction('create-user', () => handleCreateUser('aluno'));

    try {
      const statsRes = await api('/api/admin/stats');
      if (!isCurrentView()) return;

      const stTable = $('#teacher-students-table');
      if (stTable) {
        const students = statsRes.users.filter(u => u.role === 'aluno');
        stTable.innerHTML = `
          <tr><th>Aluno</th><th>Usuário</th><th>Saldo</th></tr>
          ${students.map(s => `
            <tr>
              <td>${esc(s.name)}</td>
              <td>@${esc(s.username)}</td>
              <td><b>${fmt(s.balance)}</b></td>
            </tr>
          `).join('')}
        `;
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Imprimir Cartões Físicos (Ideia 6) */
  if (activeTab === 'cards') {
    const printNowBtn = $('#print-now-btn');
    if (printNowBtn) {
      printNowBtn.onclick = () => window.print();
    }

    try {
      const cardsRes = await api('/api/cards/students');
      if (!isCurrentView()) return;

      const grid = $('#cards-grid');
      if (grid) {
        if (!cardsRes.cards.length) {
          grid.innerHTML = '<div class="empty">Nenhum aluno cadastrado para gerar cartões.</div>';
        } else {
          grid.innerHTML = cardsRes.cards.map(c => `
            <div class="fisk-id-card">
              <div class="id-card-top">
                <span class="id-card-title">FISK PAY</span>
                <span style="font-size:10px;font-weight:bold;color:#1c3f8f">STUDENT ID</span>
              </div>
              <div class="id-card-body">
                ${renderBuddy(c.active_frame, 'width:58px;height:58px', c.mascot)}
                <div class="id-card-info">
                  <div class="id-card-name">${esc(c.name)}</div>
                  <div class="id-card-nick">@${esc(c.username)}</div>
                  <div class="id-card-class">ALUNO FISK</div>
                  <div class="id-card-serial">${esc(c.serial)}</div>
                </div>
                <div class="id-card-qr">
                  <img src="${c.qrDataUrl}" alt="QR Pix">
                </div>
              </div>
              <div class="id-card-footer">
                ★ Falou Fisk, falou tudo! · Banco Digital Oficial ★
              </div>
            </div>
          `).join('');
        }
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Coordenação - Pessoas & Perfis */
  if (activeTab === 'coord_classes') {
    await loadPeople(isCurrentView);
  }

  /* Tab: Coordenação - Auditoria */
  if (activeTab === 'coord_audit') {
    try {
      const { logs } = await api('/api/coordenacao/audit');
      if (!isCurrentView()) return;
      const table = $('#audit-table');
      if (table) {
        if (!logs.length) {
          table.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma ação registrada até o momento.</td></tr>';
        } else {
          table.innerHTML = `
            <tr><th>Data/Hora</th><th>Responsável</th><th>Ação</th><th>Pessoa</th><th>Descrição</th></tr>
            ${logs.map(l => `
              <tr>
                <td><small>${when(l.created_at)}</small></td>
                <td><b>${esc(l.teacher_name)}</b></td>
                <td><span class="class-pill">${esc(ACTION_LABELS[l.action] || l.action)}</span></td>
                <td>${esc(l.target_name || '—')}</td>
                <td>${esc(l.details)}</td>
              </tr>
            `).join('')}
          `;
        }
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Gestão Monetária (Coordenação / Admin) */
  if (activeTab === 'adm') {
    const mintBtn = $('#mint-btn');
    if (mintBtn) mintBtn.onclick = () => handleAdminAction('mint');

    const setBtn = $('#set-btn');
    if (setBtn) setBtn.onclick = () => handleAdminAction('set');

    const withdrawBtn = $('#withdraw-btn');
    if (withdrawBtn) withdrawBtn.onclick = () => handleAdminAction('withdraw');

    try {
      const statsRes = await api('/api/admin/stats');
      if (!isCurrentView()) return;
      const auSelect = $('#au');
      if (auSelect) {
        auSelect.innerHTML = '<option value="">Selecione a conta</option>' + statsRes.users.map(u => `
          <option value="${u.id}">${esc(u.name)} (${ROLE_LABELS[u.role]} · ${fmt(u.balance)})</option>
        `).join('');
      }

      const accTable = $('#accounts-table');
      if (accTable) {
        accTable.innerHTML = `
          <tr><th>Usuário</th><th>Perfil</th><th>Saldo</th></tr>
          ${statsRes.users.map(u => `
            <tr>
              <td>${esc(u.name)} (@${esc(u.username)})</td>
              <td>${ROLE_LABELS[u.role]}</td>
              <td><b>${fmt(u.balance)}</b></td>
            </tr>
          `).join('')}
        `;
      }

      const econTitle = $('#economy-title');
      if (econTitle) {
        econTitle.textContent = `Em circulação: ${fmt(statsRes.stats.totalInCirculation)} · Alunos: ${statsRes.stats.totalUsers} · Professores: ${statsRes.stats.totalTeachers}`;
      }

      const gTxEl = $('#global-tx-list');
      if (gTxEl && statsRes.recentTransactions) {
        gTxEl.innerHTML = statsRes.recentTransactions.map(tx => `
          <div class="row">
            <div>
              <b>${esc(ACTION_LABELS[tx.type] || tx.type)}: ${esc(tx.from_name || 'Sistema')} → ${esc(tx.to_name)}</b>
              ${tx.note ? `<br><em>“${esc(tx.note)}”</em>` : ''}
              <small>${when(tx.created_at)}</small>
            </div>
            <div class="pos">${fmt(tx.amount)}</div>
          </div>
        `).join('');
      }
    } catch (e) { if (isCurrentView()) showLoadError(e); }
  }

  /* Tab: Relatórios Excel */
  if (activeTab === 'reports') {
    await loadReports(isCurrentView);
  }
}

// Start
checkExistingSession();
