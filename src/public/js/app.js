/**
 * Fisk Pix - Client Application (Production Frontend)
 * Distinct views for Students, Teachers & Pedagogical Coordination
 */

const BADGE = `<svg viewBox="0 0 260 220" width="180" role="img" aria-label="Falou Fisk, falou tudo"><defs><path id="ta" d="M56,110 A74,74 0 0 1 204,110"/><path id="ba" d="M44,110 A86,86 0 0 0 216,110"/></defs><circle cx="130" cy="110" r="100" fill="none" style="stroke:var(--teal)" stroke-width="6"/><rect x="20" y="80" width="220" height="58" style="fill:var(--card)"/><text font-family="Archivo Black,Arial Black,sans-serif" font-size="23" text-anchor="middle" style="fill:var(--teal)"><textPath href="#ta" startOffset="50%">FALOU</textPath></text><text font-family="Archivo Black,Arial Black,sans-serif" font-size="23" text-anchor="middle" style="fill:var(--ba)" startOffset="50%">FALOU TUDO</textPath></text><text x="130" y="130" text-anchor="middle" font-family="Archivo Black,Arial Black,sans-serif" font-size="58" textLength="210" lengthAdjust="spacingAndGlyphs" style="fill:var(--teal)">FISK</text><text x="0" y="116" font-size="20" style="fill:var(--teal)">★</text><text x="238" y="116" font-size="20" style="fill:var(--teal)">★</text></svg>`;
const BUDDY_SRC = '/assets/buddy.jpg';

const ROLE_LABELS = {
  aluno: 'Aluno',
  admin: 'Administrador',
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
let selectedClassId = ''; // '' for all classes
let attendanceDate = new Date().toISOString().split('T')[0];
let feedbackMsg = null;
let eventSource = null;
let isOnline = false;
let userQrCode = null;

const $ = sel => document.querySelector(sel);
const fmt = n => 'F$ ' + Number(n).toLocaleString('pt-BR');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = t => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ========================================================
   Avatar with Profile Frame Renderer
   ======================================================== */
function renderBuddy(frameClass = 'none', customStyle = '') {
  const frame = frameClass || 'none';
  const hasCrown = frame === 'frame-crown';
  return `
    <div class="buddy-container" style="${customStyle}">
      ${hasCrown ? '<div class="crown-badge">👑</div>' : ''}
      <img class="buddy ${esc(frame)}" alt="Buddy" src="${BUDDY_SRC}">
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
    if (authToken && endpoint !== '/api/auth/login') {
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
  try {
    const data = await api('/api/auth/me');
    currentUser = { ...currentUser, ...data };
    render();
  } catch (e) {}
}

/* ========================================================
   Auth Actions
   ======================================================== */
async function doLogin() {
  const username = $('#nick').value.trim();
  const password = $('#pw').value;

  if (!username || !password) {
    feedbackMsg = { t: 'Preencha usuário e senha.', k: 'bad' };
    return render();
  }

  try {
    const data = await api('/api/auth/login', 'POST', { username, password });
    authToken = data.token;
    localStorage.setItem('fisk_token', authToken);
    currentUser = data.user;
    feedbackMsg = null;
    
    // Set appropriate initial tab based on role
    if (currentUser.role === 'teacher') {
      activeTab = 'att';
    } else if (currentUser.role === 'coordenacao') {
      activeTab = 'coord_classes';
    } else {
      activeTab = 'pix';
    }

    connectSSE();
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
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
  feedbackMsg = customMessage ? { t: customMessage, k: 'bad' } : null;
  render();
}

async function checkExistingSession() {
  if (!authToken) return render();
  try {
    currentUser = await api('/api/auth/me');
    if (currentUser.role === 'teacher' && activeTab === 'pix') {
      activeTab = 'att';
    } else if (currentUser.role === 'coordenacao' && activeTab === 'pix') {
      activeTab = 'coord_classes';
    }
    connectSSE();
    render();
  } catch (err) {
    logout();
  }
}

/* ========================================================
   Pix Transfer Flow & QR Code (Students)
   ======================================================== */
async function loadUserQrCode() {
  if (userQrCode || !currentUser) return;
  try {
    const data = await api(`/api/pix/qrcode/${currentUser.username}`);
    userQrCode = data;
    render();
  } catch (e) {}
}

async function preparePix() {
  const toSelect = $('#to');
  const directKeyInput = $('#direct-key');
  let toUserId = toSelect ? toSelect.value : null;
  let toUsername = null;

  if (directKeyInput && directKeyInput.value.trim()) {
    toUsername = directKeyInput.value.trim();
  }

  const amount = parseInt($('#amt').value, 10);
  const note = $('#note').value.trim().slice(0, 100);

  if (!amount || amount < 1) {
    feedbackMsg = { t: 'Informe um valor válido em Fisk Dollars.', k: 'bad' };
    return render();
  }

  if (amount > currentUser.balance) {
    feedbackMsg = { t: 'Saldo insuficiente para realizar este Pix.', k: 'bad' };
    return render();
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
  if (!pendingPix) return;
  const p = pendingPix;
  pendingPix = null;

  try {
    const res = await api('/api/pix/send', 'POST', {
      toUserId: p.toUserId,
      toUsername: p.toUsername,
      amount: p.amount,
      note: p.note
    });

    currentUser.balance = res.receipt.new_balance;
    lastReceipt = res.receipt;
    playPixSound();
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

/* ========================================================
   Fisk Store & Molduras Actions
   ======================================================== */
async function handleBuyItem(itemId, itemName, price) {
  if (currentUser.balance < price) {
    feedbackMsg = { t: `Saldo insuficiente para comprar ${itemName}!`, k: 'bad' };
    return render();
  }

  try {
    const res = await api('/api/store/buy', 'POST', { itemId });
    currentUser.balance = res.result.newBalance;
    currentUser.active_frame = res.result.item.frame_css;
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
  try {
    await api('/api/store/equip', 'POST', { frameId });
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
      status
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
  const amount = parseInt($('#award_amt').value, 10);
  const reason = $('#award_reason').value.trim();

  if (!studentId || !amount || amount < 1) {
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
  const amount = parseInt($('#bulk_amt').value, 10);
  const note = $('#bulk_reason').value.trim().slice(0, 100);
  const classId = selectedClassId ? Number(selectedClassId) : null;

  if (!amount || amount < 1) {
    feedbackMsg = { t: 'Informe um valor válido maior que zero.', k: 'bad' };
    return render();
  }

  try {
    const res = await api('/api/admin/bulk-reward', 'POST', { amount, note, classId });
    feedbackMsg = { t: res.message, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleCreateUser(forcedRole = 'aluno') {
  const username = $('#nn').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const name = $('#nm').value.trim().slice(0, 30);
  const password = $('#ns').value;
  const classId = $('#nc') ? $('#nc').value : null;

  if (!username || !name || password.length < 6) {
    feedbackMsg = { t: 'Preencha apelido, nome e senha com no mínimo 6 caracteres.', k: 'bad' };
    return render();
  }

  try {
    await api('/api/admin/create-user', 'POST', { username, name, password, role: forcedRole, classId });
    feedbackMsg = { t: `${forcedRole === 'teacher' ? 'Professor(a)' : 'Aluno(a)'} ${name} cadastrado(a)!`, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleCreateClass() {
  const name = $('#c_name').value.trim();
  const level = $('#c_level').value.trim();
  const teacherId = $('#c_teacher') ? $('#c_teacher').value : null;

  if (!name) {
    feedbackMsg = { t: 'Informe o nome da turma.', k: 'bad' };
    return render();
  }

  try {
    await api('/api/classes', 'POST', { name, level, teacherId });
    feedbackMsg = { t: `Turma "${name}" criada com sucesso!`, k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleAssignTeacherToClass() {
  const classId = $('#link_class').value;
  const teacherId = $('#link_teacher').value;

  if (!classId || !teacherId) {
    feedbackMsg = { t: 'Selecione a turma e o professor.', k: 'bad' };
    return render();
  }

  try {
    await api('/api/classes/set-teacher', 'POST', { classId, teacherId });
    feedbackMsg = { t: 'Professor vinculado à turma com sucesso!', k: 'ok' };
    render();
  } catch (err) {
    feedbackMsg = { t: err.message, k: 'bad' };
    render();
  }
}

async function handleChangePassword() {
  const newPassword = $('#np').value;
  if (!newPassword || newPassword.length < 6) {
    feedbackMsg = { t: 'A senha precisa ter pelo menos 6 caracteres.', k: 'bad' };
    return render();
  }

  try {
    const res = await api('/api/auth/change-password', 'POST', { newPassword });
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
    ? `/api/admin/export/attendance?token=${encodeURIComponent(authToken)}&classId=${selectedClassId}`
    : `/api/admin/export/transactions?token=${encodeURIComponent(authToken)}`;
  window.location.href = url;
}

/* ========================================================
   Main Render Function
   ======================================================== */
async function render() {
  const app = $('#app');
  if (!app) return;

  // 1. Unauthenticated Login Screen
  if (!currentUser) {
    app.innerHTML = `
      <div class="note login">
        <div style="display:flex;justify-content:center;align-items:center;gap:12px">
          ${BADGE}
          <img class="buddy" style="width:84px;height:84px" alt="Buddy" src="${BUDDY_SRC}">
        </div>
        <div class="title">Fisk English School · Sistema Integrado</div>
        
        <label for="nick">Usuário</label>
        <input id="nick" autocomplete="username" autocapitalize="none" placeholder="Coloque seu nickname Fisk (nota do dev eu realmente estava sem ideia doq colocar aqui)">
        
        <label for="pw">Senha</label>
        <input id="pw" type="password" autocomplete="current-password" placeholder="Sua senha segura">
        
        <button class="btn" id="go">Acessar Sistema Fisk</button>
        <div class="msg ${feedbackMsg ? feedbackMsg.k : ''}">${feedbackMsg ? esc(feedbackMsg.t) : ''}</div>
        
        <div class="legal">
          Falou Fisk, falou tudo! · Banco Digital & Gestão Pedagógica<br>
          <small style="opacity:0.85">Acessos: Coordenação (Coordenação26@) · teacher (teacher123) · alunos: tyller, bia, cadu</small>
        </div>
      </div>
    `;

    $('#go').onclick = doLogin;
    $('#pw').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
    return;
  }

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
      ['students', 'Turmas & Alunos 👥'],
      ['cards', 'Imprimir Cartões 💳'],
      ['reports', 'Relatórios 📥']
    ];
  } else if (currentUser.role === 'coordenacao') {
    tabs = [
      ['coord_classes', 'Turmas & Professores 🏫'],
      ['coord_audit', 'Auditoria dos Professores 📋'],
      ['cards', 'Imprimir Cartões 💳'],
      ['adm', 'Gestão Monetária 💰'],
      ['reports', 'Relatórios 📥']
    ];
  } else {
    // Admin (Cadu)
    tabs = [
      ['pix', 'Pix'],
      ['store', 'Lojinha 🛍️'],
      ['rank', 'Ranking'],
      ['att', 'Chamada 📝'],
      ['cards', 'Imprimir Cartões 💳'],
      ['adm', 'Painel Master ⚙️'],
      ['reports', 'Relatórios 📥']
    ];
  }

  // Header Card
  let headerHTML = '';

  if (currentUser.role === 'aluno' || currentUser.role === 'admin') {
    // Banknote Card for Students
    headerHTML = `
      <div class="note">
        <div class="top">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="fisk">Fisk</div>
            <div class="flag"></div>
          </div>
          <div style="text-align:right">
            <div class="small">${ROLE_LABELS[currentUser.role]} ${currentUser.class_name ? `<span class="class-pill">${esc(currentUser.class_name)}</span>` : ''}</div>
            <b>${esc(currentUser.name)}</b>
            <div id="online-badge" class="status-badge">
              <span class="status-dot ${isOnline ? '' : 'offline'}"></span>
              ${isOnline ? 'Servidor Online' : 'Conectando...'}
            </div>
          </div>
        </div>

        <div class="title">Fisk Dollars · Saldo Disponível</div>
        <div class="bal">
          <b>${fmt(currentUser.balance)}</b>
          ${renderBuddy(currentUser.active_frame)}
        </div>
        <div class="serial">
          <span>${esc(currentUser.serial)}</span>
          <span>Chave Pix: @${esc(currentUser.username)}</span>
        </div>
        <div class="legal">Falou Fisk, falou tudo! · Banco Digital Oficial da Turma</div>
      </div>
      ${currentUser.role === 'aluno' ? streakHTML(currentUser.streaks) : ''}
    `;
  } else {
    // Teacher & Coordenação Administrative Header (No Banknote or personal Pix balance!)
    headerHTML = `
      <div class="note" style="border-color:var(--teal)">
        <div class="top">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="fisk">Fisk</div>
            <div class="flag"></div>
          </div>
          <div style="text-align:right">
            <div class="small" style="color:var(--teal);font-weight:bold">${ROLE_LABELS[currentUser.role]}</div>
            <b>${esc(currentUser.name)}</b>
            <div id="online-badge" class="status-badge">
              <span class="status-dot ${isOnline ? '' : 'offline'}"></span>
              ${isOnline ? 'Servidor Conectado' : 'Conectando...'}
            </div>
          </div>
        </div>
        <div class="title" style="margin-top:12px;font-size:14px">
          ${currentUser.role === 'teacher' ? 'Painel Pedagógico do Professor' : 'Painel Geral da Coordenação Pedagógica'}
        </div>
        <div style="font-size:12px;text-align:center;color:var(--ink);margin-top:4px">
          Ambiente administrativo · Gestão de turmas, frequência e méritos escolares
        </div>
      </div>
    `;
  }

  // Navigation Tabs Bar
  const tabsHTML = `
    <div class="tabs">
      ${tabs.map(t => `<button data-t="${t[0]}" class="${activeTab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}
    </div>
  `;

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
          <div style="display:flex;gap:6px;margin-bottom:12px">
            <button class="btn alt" style="flex:1" id="submode-send">Enviar Pix 💸</button>
            <button class="btn green" style="flex:1" id="submode-qr">Meu QR Code 📱</button>
          </div>
          <div class="title">Receber Fisk Pix via QR Code</div>
          <div class="qr-box">
            ${userQrCode && userQrCode.qrDataUrl 
              ? `<img src="${userQrCode.qrDataUrl}" alt="QR Code Pix">` 
              : '<div class="empty">Gerando QR Code...</div>'}
            <div class="pix-key-pill" id="copy-key-btn">
              <span>Chave: <b>@${esc(currentUser.username)}</b></span> 📋 Copiar
            </div>
          </div>
          <div class="legal">Peça para seu colega escanear ou transferir para @${esc(currentUser.username)}</div>
        </div>
      `;
    } else {
      tabContent = `
        <div class="note">
          <div style="display:flex;gap:6px;margin-bottom:12px">
            <button class="btn green" style="flex:1" id="submode-send">Enviar Pix 💸</button>
            <button class="btn alt" style="flex:1" id="submode-qr">Meu QR Code 📱</button>
          </div>
          <div class="title">Enviar Fisk Pix</div>
          
          <label for="direct-key">Chave Pix do Colega (@apelido)</label>
          <input id="direct-key" placeholder="ex: @tyller ou @bia (ou selecione abaixo)">

          <label for="to">Ou Selecione na Turma</label>
          <select id="to"><option value="">Carregando colegas...</option></select>
          
          <label for="amt">Valor em Fisk Dollars (F$)</label>
          <input id="amt" type="number" min="1" step="1" inputmode="numeric" placeholder="Quanto deseja transferir?">
          
          <label for="note">Mensagem ou Motivo (opcional)</label>
          <input id="note" maxlength="100" placeholder="ex: Valeu pela ajuda no speaking!">
          
          <button class="btn" id="send-btn">Revisar e Enviar Pix</button>
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
        <div class="title">Lojinha de Molduras da Fisk 🛍️</div>
        <div style="text-align:center;font-size:13px;margin:6px 0;color:var(--ink)">
          Seu saldo: <b>${fmt(currentUser.balance)}</b> · Destaque seu perfil com molduras animadas!
        </div>
        <div id="store-container"><div class="empty">Carregando molduras...</div></div>
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
        <select id='flt'>
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
        <div class='title'>Ranking da Turma</div>
        <label for="class-rank-filter">Filtrar Turma</label>
        <select id="class-rank-filter"><option value="">Todas as Turmas</option></select>
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
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <div style="flex:1">
            <label for='ad'>Data da aula</label>
            <input id='ad' type='date' value='${attendanceDate}'>
          </div>
          <div style="flex:1">
            <label for='class-att-filter'>Turma</label>
            <select id='class-att-filter'><option value=''>Todas as Turmas</option></select>
          </div>
        </div>
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

        <label for="award_reason">Motivo Pedagógico / Elogio</label>
        <input id="award_reason" placeholder="ex: Excelente speaking no diálogo da lição 4">

        <button class="btn green" id="award-btn">Lançar Prêmio de Mérito</button>
      </div>

      <div class='note'>
        <div class='title'>Bônus Coletivo para a Turma Inteira</div>
        <label for="bulk_amt">Valor em Fisk Dollars para cada aluno (F$)</label>
        <input id='bulk_amt' type='number' min='1' step='1' placeholder='ex: 10'>

        <label for='bulk_reason'>Motivo do Bônus</label>
        <input id='bulk_reason' placeholder='ex: 100% da turma entregou o homework!'>

        <button class='btn alt' id='bulk-btn'>Distribuir Bônus para Alunos da Turma Selecionada</button>
      </div>
    `;
  }

  /* ========================================================
     Tab: TURMAS & ALUNOS (Teacher)
     ======================================================== */
  else if (activeTab === 'students') {
    tabContent = `
      <div class="note">
        <div class="title">Alunos Matriculados</div>
        <label for="students-class-filter">Filtrar por Turma</label>
        <select id="students-class-filter"><option value="">Todas as Turmas</option></select>
        <div class="scroll">
          <table id="teacher-students-table">
            <tr><th>Aluno</th><th>Turma</th><th>Saldo</th></tr>
          </table>
        </div>
      </div>

      <div class='note'>
        <div class='title'>Matricular Novo Aluno na Turma</div>
        <label for='nn'>Apelido (login)</label>
        <input id='nn' autocapitalize='none' placeholder='ex: pedro'>
        <label for='nm'>Nome completo</label>
        <input id='nm' placeholder='ex: Pedro Santos'>
        <label for='nc'>Turma</label>
        <select id='nc'><option value=''>Selecione a turma...</option></select>
        <label for='ns'>Senha inicial (mín. 6)</label>
        <input id='ns' type='password' autocomplete='new-password'>
        <button class='btn' id='create-student-btn'>Cadastrar e Matricular Aluno</button>
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
        
        <label for="cards-class-filter">Selecione a Turma para Impressão</label>
        <select id="cards-class-filter"><option value="">Todas as Turmas</option></select>

        <button class="btn green" id="print-now-btn" style="margin-top:14px">🖨️ Imprimir Cartões da Turma</button>
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
     Tab: COORDENAÇÃO - TURMAS & PROFESSORES
     ======================================================== */
  else if (activeTab === 'coord_classes') {
    tabContent = `
      <div class="note">
        <div class="title">Turmas & Professores Atribuídos</div>
        <div class="scroll">
          <table id="classes-table">
            <tr><th>Turma</th><th>Nível</th><th>Professor(a)</th><th>Qtd. Alunos</th></tr>
          </table>
        </div>
      </div>

      <div class="note">
        <div class="title">Atribuir Professor a uma Turma</div>
        <label for="link_class">Selecione a Turma</label>
        <select id="link_class"><option value="">Carregando turmas...</option></select>

        <label for="link_teacher">Selecione o Professor(a)</label>
        <select id="link_teacher"><option value="">Carregando professores...</option></select>

        <button class="btn green" id="link-teacher-btn">Salvar Atribuição</button>
      </div>

      <div class='note'>
        <div class='title'>Cadastrar Novo Professor(a)</div>
        <label for='t_username'>Usuário do Professor</label>
        <input id='t_username' autocapitalize='none' placeholder='ex: teacher_ana'>
        <label for='t_name'>Nome do Professor(a)</label>
        <input id='t_name' placeholder='ex: Teacher Ana Paula'>
        <label for='t_password'>Senha inicial (mín. 6)</label>
        <input id='t_password' type='password' autocomplete='new-password'>
        <button class='btn alt' id='create-teacher-btn'>Cadastrar Professor(a)</button>
      </div>

      <div class='note'>
        <div class='title'>Cadastrar Nova Turma</div>
        <label for='c_name'>Nome da Turma</label>
        <input id='c_name' placeholder='ex: Teens 2'>
        <label for='c_level'>Nível (opcional)</label>
        <input id='c_level' placeholder='ex: Intermediário'>
        <label for='c_teacher'>Professor(a) Responsável</label>
        <select id='c_teacher'><option value=''>Sem professor por enquanto</option></select>
        <button class='btn alt' id='create-class-btn'>Criar Turma</button>
      </div>
    `;
  }

  /* ========================================================
     Tab: COORDENAÇÃO - AUDITORIA DOS PROFESSORES
     ======================================================== */
  else if (activeTab === 'coord_audit') {
    tabContent = `
      <div class="note">
        <div class="title">Histórico de Auditoria dos Professores 📋</div>
        <div style="font-size:12px;text-align:center;color:var(--ink);margin:6px 0">
          Registro em tempo real de todas as ações pedagógicas e financeiras realizadas pelo corpo docente.
        </div>
        <div class="scroll">
          <table id="audit-table">
            <tr><th>Data/Hora</th><th>Professor(a)</th><th>Ação</th><th>Aluno</th><th>Detalhes</th></tr>
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
            <tr><th>Usuário</th><th>Turma</th><th>Função</th><th>Saldo</th></tr>
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
    tabContent = `
      <div class="note">
        <div class="title">Exportação de Planilhas para Excel (.csv) 📊</div>
        <div style="font-size:12px;text-align:center;color:var(--ink);margin:8px 0">
          Gere relatórios oficiais com suporte nativo a acentuação para Microsoft Excel.
        </div>
        <button class="btn green" id="export-att-btn">📥 Exportar Frequência da Turma para Excel</button>
        <button class="btn alt" id="export-tx-btn">📥 Exportar Livro Geral de Transações</button>
      </div>
    `;
  }

  // Footer Actions
  const footerHTML = `
    <div class="msg ${feedbackMsg ? feedbackMsg.k : ''}">${feedbackMsg ? esc(feedbackMsg.t) : ''}</div>
    
    <details class='note'>
      <summary class='small' style='cursor:pointer'>Alterar minha senha</summary>
      <label for='np'>Nova senha segura (mínimo 6 caracteres)</label>
      <input id='np' type='password' autocomplete='new-password'>
      <button class='btn alt' id='chpw-btn'>Salvar Nova Senha</button>
    </details>

    <button class='btn alt' id='toggle-theme-btn' style='margin:4px 8px;width:calc(100% - 16px)'>
      Alternar Tema Claro / Escuro
    </button>
    <button class="btn alt" id="logout-btn" style="margin:4px 7px;width:calc(100% - 14px);color:var(--bad);border-color:var(--bad)">
      Sair da Conta (${esc(currentUser.name)})
    </button>
  `;

  app.innerHTML = headerHTML + tabsHTML + tabContent + footerHTML;
  bindEvents();
}

/* ========================================================
   Event Binding & Data Loaders
   ======================================================== */
async function bindEvents() {
  // Navigation Tabs
  document.querySelectorAll('[data-t]').forEach(b => {
    b.onclick = () => {
      activeTab = b.dataset.t;
      pendingPix = null;
      lastReceipt = null;
      feedbackMsg = null;
      render();
    };
  });

  // Logout
  const outBtn = $('#logout-btn');
  if (outBtn) outBtn.onclick = () => logout();

  // Theme toggle
  const themeBtn = $('#toggle-theme-btn');
  if (themeBtn) {
    themeBtn.onclick = () => {
      const root = document.documentElement;
      const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = isDark ? 'light' : 'dark';
    };
  }

  // Change password
  const chpwBtn = $('#chpw-btn');
  if (chpwBtn) chpwBtn.onclick = handleChangePassword;

  /* Tab: Pix (Students) */
  if (activeTab === 'pix') {
    const sendSubBtn = $('#submode-send');
    if (sendSubBtn) sendSubBtn.onclick = () => { pixSubMode = 'send'; render(); };

    const qrSubBtn = $('#submode-qr');
    if (qrSubBtn) qrSubBtn.onclick = () => {
      pixSubMode = 'qrcode';
      loadUserQrCode();
      render();
    };

    if (pixSubMode === 'qrcode') {
      loadUserQrCode();
      const copyBtn = $('#copy-key-btn');
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(`@${currentUser.username}`);
          showToast(`Chave @${currentUser.username} copiada!`);
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

      try {
        const { users } = await api('/api/users/recipients');
        const sel = $('#to');
        if (sel) {
          sel.innerHTML = users.map(u => `
            <option value="${u.id}">${esc(u.name)} (@${esc(u.username)})${u.class_name ? ` · ${esc(u.class_name)}` : ''}</option>
          `).join('');
        }
      } catch (e) {}
    }
  }

  /* Tab: Store (Frames Only) */
  if (activeTab === 'store') {
    try {
      const { items } = await api('/api/store/items');
      const storeContainer = $('#store-container');
      if (storeContainer) {
        storeContainer.innerHTML = `
          <div class="store-grid">
            ${items.map(it => {
              let actionBtn = '';
              if (it.equipped) {
                actionBtn = `<button class="store-btn equipped">Equipada</button>`;
              } else if (it.owned) {
                actionBtn = `<button class="store-btn owned" data-equip="${it.frame_css}">Equipar</button>`;
              } else {
                actionBtn = `<button class="store-btn" data-buy="${it.id}" data-name="${esc(it.name)}" data-price="${it.price}">Comprar</button>`;
              }

              return `
                <div class="store-card">
                  <div class="store-header">
                    <div class="store-icon">${it.icon || '🖼️'}</div>
                    <span class="store-category">Moldura VIP</span>
                  </div>
                  <div class="store-title">${esc(it.name)}</div>
                  <div class="store-desc">${esc(it.description)}</div>
                  <div style="text-align:center;margin:8px 0">
                    <small style="display:block;margin-bottom:4px;color:var(--ink)">Preview no Buddy:</small>
                    ${renderBuddy(it.frame_css, 'transform:scale(0.85);margin:0 auto;')}
                  </div>
                  <div class="store-footer">
                    <div class="store-price">${fmt(it.price)}</div>
                    ${actionBtn}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;

        document.querySelectorAll('[data-buy]').forEach(b => {
          b.onclick = () => handleBuyItem(b.dataset.buy, b.dataset.name, Number(b.dataset.price));
        });

        document.querySelectorAll('[data-equip]').forEach(b => {
          b.onclick = () => handleEquipFrame(b.dataset.equip);
        });
      }
    } catch (e) {}
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
            } else {
              title = `Compra de Moldura na Loja`;
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
    } catch (e) {}
  }

  /* Tab: Ranking */
  if (activeTab === 'rank') {
    const classFilter = $('#class-rank-filter');
    if (classFilter) {
      classFilter.onchange = () => {
        selectedClassId = classFilter.value;
        bindEvents();
      };
    }

    try {
      const [rankRes, classesRes] = await Promise.all([
        api(`/api/ranking?classId=${selectedClassId}`),
        api('/api/classes')
      ]);

      if (classFilter && classFilter.children.length <= 1) {
        classFilter.innerHTML = `<option value="">Todas as Turmas</option>` +
          classesRes.classes.map(c => `<option value="${c.id}" ${selectedClassId == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      }

      const rankEl = $('#leaderboard-list');
      if (rankEl) {
        const sortedByBalance = [...rankRes.leaderboard].sort((a, b) => b.balance - a.balance);
        const sortedByStreak = [...rankRes.leaderboard].sort((a, b) => (b.streak || 0) - (a.streak || 0));

        const balanceHTML = sortedByBalance.map((s, idx) => `
          <div class="row">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-weight:bold">${['🥇', '🥈', '🥉'][idx] || (idx + 1) + 'º'}</span>
              ${renderBuddy(s.active_frame, 'transform:scale(0.5);width:34px;height:34px;margin-right:2px')}
              <div>
                <b>${esc(s.name)}</b> <small style="display:inline">(@${esc(s.username)})</small>
                ${s.class_name ? `<span class="class-pill">${esc(s.class_name)}</span>` : ''}
              </div>
            </div>
            <div class="pos">${fmt(s.balance)}</div>
          </div>
        `).join('');

        const streakHTML = sortedByStreak.map(s => `
          <div class="row">
            <div style="display:flex;align-items:center;gap:8px">
              ${renderBuddy(s.active_frame, 'transform:scale(0.5);width:34px;height:34px;margin-right:2px')}
              <div>
                <b>${esc(s.name)}</b>
                ${s.class_name ? `<span class="class-pill">${esc(s.class_name)}</span>` : ''}
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
    } catch (e) {}
  }

  /* Tab: Chamada (Teacher / Admin) */
  if (activeTab === 'att') {
    const adInput = $('#ad');
    if (adInput) {
      adInput.onchange = () => {
        attendanceDate = adInput.value;
        bindEvents();
      };
    }

    const classAttFilter = $('#class-att-filter');
    if (classAttFilter) {
      classAttFilter.onchange = () => {
        selectedClassId = classAttFilter.value;
        bindEvents();
      };
    }

    try {
      const [attRes, classesRes] = await Promise.all([
        api(`/api/attendance?date=${attendanceDate}&classId=${selectedClassId}`),
        api('/api/classes' + (currentUser.role === 'teacher' ? '?mine=true' : ''))
      ]);

      if (classAttFilter && classAttFilter.children.length <= 1) {
        classAttFilter.innerHTML = `<option value="">Todas as Minhas Turmas</option>` +
          classesRes.classes.map(c => `<option value="${c.id}" ${selectedClassId == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      }

      const attListEl = $('#attendance-list');
      if (attListEl) {
        const students = attRes.records;
        if (!students.length) {
          attListEl.innerHTML = '<div class="empty">Nenhum aluno encontrado nesta turma.</div>';
        } else {
          attListEl.innerHTML = students.map(s => {
            const st = s.status;
            return `
              <div class='row'>
                <div>
                  <b>${esc(s.name)}</b> ${s.class_name ? `<span class="class-pill">${esc(s.class_name)}</span>` : ''}
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
            btn.onclick = () => markAttendance(btn.dataset.uid, btn.dataset.st);
          });
        }
      }
    } catch (e) {}
  }

  /* Tab: Lançar Méritos (Teacher / Admin) */
  if (activeTab === 'merit') {
    const awardBtn = $('#award-btn');
    if (awardBtn) awardBtn.onclick = handleTeacherAward;

    const bulkBtn = $('#bulk-btn');
    if (bulkBtn) bulkBtn.onclick = handleBulkReward;

    try {
      const { users } = await api('/api/users/recipients');
      const sel = $('#award_student');
      if (sel) {
        sel.innerHTML = `<option value="">Selecione o aluno...</option>` +
          users.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.class_name || 'Geral')})</option>`).join('');
      }
    } catch (e) {}
  }

  /* Tab: Turmas & Alunos (Teacher) */
  if (activeTab === 'students') {
    const stFilter = $('#students-class-filter');
    if (stFilter) {
      stFilter.onchange = () => {
        selectedClassId = stFilter.value;
        bindEvents();
      };
    }

    const createStudBtn = $('#create-student-btn');
    if (createStudBtn) createStudBtn.onclick = () => handleCreateUser('aluno');

    try {
      const [statsRes, classesRes] = await Promise.all([
        api(`/api/admin/stats?classId=${selectedClassId}`),
        api('/api/classes' + (currentUser.role === 'teacher' ? '?mine=true' : ''))
      ]);

      if (stFilter && stFilter.children.length <= 1) {
        stFilter.innerHTML = `<option value="">Todas as Turmas</option>` +
          classesRes.classes.map(c => `<option value="${c.id}" ${selectedClassId == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      }

      const ncSelect = $('#nc');
      if (ncSelect) {
        ncSelect.innerHTML = `<option value="">Selecione a turma...</option>` +
          classesRes.classes.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.level || 'Geral')})</option>`).join('');
      }

      const stTable = $('#teacher-students-table');
      if (stTable) {
        const students = statsRes.users.filter(u => u.role === 'aluno');
        stTable.innerHTML = `
          <tr><th>Aluno</th><th>Turma</th><th>Saldo</th></tr>
          ${students.map(s => `
            <tr>
              <td>${esc(s.name)} <small style="display:block;color:var(--ink)">@${esc(s.username)}</small></td>
              <td>${esc(s.class_name || '—')}</td>
              <td><b>${fmt(s.balance)}</b></td>
            </tr>
          `).join('')}
        `;
      }
    } catch (e) {}
  }

  /* Tab: Imprimir Cartões Físicos (Ideia 6) */
  if (activeTab === 'cards') {
    const cardClassFilter = $('#cards-class-filter');
    if (cardClassFilter) {
      cardClassFilter.onchange = () => {
        selectedClassId = cardClassFilter.value;
        bindEvents();
      };
    }

    const printNowBtn = $('#print-now-btn');
    if (printNowBtn) {
      printNowBtn.onclick = () => window.print();
    }

    try {
      const [cardsRes, classesRes] = await Promise.all([
        api(`/api/cards/students?classId=${selectedClassId}`),
        api('/api/classes' + (currentUser.role === 'teacher' ? '?mine=true' : ''))
      ]);

      if (cardClassFilter && cardClassFilter.children.length <= 1) {
        cardClassFilter.innerHTML = `<option value="">Todas as Turmas</option>` +
          classesRes.classes.map(c => `<option value="${c.id}" ${selectedClassId == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      }

      const grid = $('#cards-grid');
      if (grid) {
        if (!cardsRes.cards.length) {
          grid.innerHTML = '<div class="empty">Nenhum aluno cadastrado nesta turma para gerar cartões.</div>';
        } else {
          grid.innerHTML = cardsRes.cards.map(c => `
            <div class="fisk-id-card">
              <div class="id-card-top">
                <span class="id-card-title">FISK PIX</span>
                <span style="font-size:10px;font-weight:bold;color:#1c3f8f">STUDENT ID</span>
              </div>
              <div class="id-card-body">
                ${renderBuddy(c.active_frame, 'width:58px;height:58px')}
                <div class="id-card-info">
                  <div class="id-card-name">${esc(c.name)}</div>
                  <div class="id-card-nick">@${esc(c.username)}</div>
                  <div class="id-card-class">${esc(c.class_name)}</div>
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
    } catch (e) {}
  }

  /* Tab: Coordenação - Turmas & Professores */
  if (activeTab === 'coord_classes') {
    const linkTeacherBtn = $('#link-teacher-btn');
    if (linkTeacherBtn) linkTeacherBtn.onclick = handleAssignTeacherToClass;

    const createTeachBtn = $('#create-teacher-btn');
    if (createTeachBtn) {
      createTeachBtn.onclick = () => {
        const u = $('#t_username').value;
        const n = $('#t_name').value;
        const p = $('#t_password').value;
        if (!u || !n || p.length < 6) return showToast('Preencha os campos do professor.');
        api('/api/admin/create-user', 'POST', { username: u, name: n, password: p, role: 'teacher' })
          .then(() => { showToast('Professor cadastrado!'); render(); })
          .catch(err => showToast(err.message));
      };
    }

    const createClassBtn = $('#create-class-btn');
    if (createClassBtn) createClassBtn.onclick = handleCreateClass;

    try {
      const statsRes = await api('/api/admin/stats');
      const table = $('#classes-table');
      if (table) {
        table.innerHTML = `
          <tr><th>Turma</th><th>Nível</th><th>Professor(a)</th><th>Qtd. Alunos</th></tr>
          ${statsRes.classes.map(c => `
            <tr>
              <td><b>${esc(c.name)}</b></td>
              <td>${esc(c.level || 'Geral')}</td>
              <td>${esc(c.teacher_name || '—')}</td>
              <td>${c.student_count || 0}</td>
            </tr>
          `).join('')}
        `;
      }

      const linkClassSel = $('#link_class');
      if (linkClassSel) {
        linkClassSel.innerHTML = statsRes.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      }

      const linkTeacherSel = $('#link_teacher');
      const createClassTeacherSel = $('#c_teacher');
      if (linkTeacherSel && statsRes.teachers) {
        const teacherOpts = statsRes.teachers.map(t => `<option value="${t.id}">${esc(t.name)} (@${esc(t.username)})</option>`).join('');
        linkTeacherSel.innerHTML = teacherOpts;
        if (createClassTeacherSel) {
          createClassTeacherSel.innerHTML = `<option value="">Sem professor por enquanto</option>` + teacherOpts;
        }
      }
    } catch (e) {}
  }

  /* Tab: Coordenação - Auditoria */
  if (activeTab === 'coord_audit') {
    try {
      const { logs } = await api('/api/coordenacao/audit');
      const table = $('#audit-table');
      if (table) {
        if (!logs.length) {
          table.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma ação registrada até o momento.</td></tr>';
        } else {
          table.innerHTML = `
            <tr><th>Data/Hora</th><th>Professor(a)</th><th>Ação</th><th>Aluno</th><th>Detalhes</th></tr>
            ${logs.map(l => `
              <tr>
                <td><small>${when(l.created_at)}</small></td>
                <td><b>${esc(l.teacher_name)}</b></td>
                <td><span class="class-pill">${esc(l.action)}</span></td>
                <td>${esc(l.target_name || '—')}</td>
                <td>${esc(l.details)}</td>
              </tr>
            `).join('')}
          `;
        }
      }
    } catch (e) {}
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
      const auSelect = $('#au');
      if (auSelect) {
        auSelect.innerHTML = statsRes.users.map(u => `
          <option value="${u.id}">${esc(u.name)} (${ROLE_LABELS[u.role]}${u.class_name ? ` · ${esc(u.class_name)}` : ''} - ${fmt(u.balance)})</option>
        `).join('');
      }

      const accTable = $('#accounts-table');
      if (accTable) {
        accTable.innerHTML = `
          <tr><th>Usuário</th><th>Turma</th><th>Função</th><th>Saldo</th></tr>
          ${statsRes.users.map(u => `
            <tr>
              <td>${esc(u.name)} (@${esc(u.username)})</td>
              <td>${esc(u.class_name || '—')}</td>
              <td>${ROLE_LABELS[u.role]}</td>
              <td><b>${fmt(u.balance)}</b></td>
            </tr>
          `).join('')}
        `;
      }

      const econTitle = $('#economy-title');
      if (econTitle) {
        econTitle.textContent = `Em Circulação: ${fmt(statsRes.stats.totalInCirculation)} · Total Alunos: ${statsRes.stats.totalUsers} · Professores: ${statsRes.stats.totalTeachers} · Turmas: ${statsRes.stats.totalClasses}`;
      }

      const gTxEl = $('#global-tx-list');
      if (gTxEl && statsRes.recentTransactions) {
        gTxEl.innerHTML = statsRes.recentTransactions.map(tx => `
          <div class="row">
            <div>
              <b>${tx.type.toUpperCase()}: ${esc(tx.from_name || 'Sistema')} → ${esc(tx.to_name)}</b>
              ${tx.note ? `<br><em>“${esc(tx.note)}”</em>` : ''}
              <small>${when(tx.created_at)}</small>
            </div>
            <div class="pos">${fmt(tx.amount)}</div>
          </div>
        `).join('');
      }
    } catch (e) {}
  }

  /* Tab: Relatórios Excel */
  if (activeTab === 'reports') {
    const expAttBtn = $('#export-att-btn');
    if (expAttBtn) expAttBtn.onclick = () => exportExcel('attendance');

    const expTxBtn = $('#export-tx-btn');
    if (expTxBtn) expTxBtn.onclick = () => exportExcel('transactions');
  }
}

// Start
checkExistingSession();
