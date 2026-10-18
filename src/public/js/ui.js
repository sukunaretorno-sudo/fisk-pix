/* Shared presentation helpers. Business rules remain in the application/API. */
const ACTION_LABELS = { pix: 'Pix', att: 'Presença', attendance: 'Chamada', merit: 'Mérito', mint: 'Crédito', bulk: 'Bônus coletivo', bulk_reward: 'Bônus coletivo', set: 'Ajuste de saldo', withdraw: 'Débito', create_user: 'Cadastro', create_class: 'Organização anterior', set_teacher: 'Vínculo anterior', assign_class: 'Cadastro anterior' };
Object.assign(ACTION_LABELS, {profile_update:'Perfil atualizado',update_user:'Cadastro atualizado',reset_password:'Senha redefinida',attendance_bulk:'Chamada coletiva',equip_frame:'Moldura aplicada',equip_theme:'Tema aplicado'});
const NAV = {
  pix: { label: 'Meu Pix', icon: 'pix', title: 'Seu Pix, sem complicação', description: 'Envie conquistas. Receba reconhecimento.' },
  store: { label: 'Lojinha', icon: 'store', title: 'Um toque de personalidade', description: 'Molduras para seu Buddy. Temas para todo o seu Fisk Pay.' },
  ext: { label: 'Meu extrato', icon: 'receipt', title: 'Cada conquista tem uma história', description: 'Acompanhe seus Fisk Dollars, entrada por entrada.' },
  rank: { label: 'Ranking', icon: 'trophy', title: 'Conquistas que inspiram', description: 'Confira os destaques em Fisk Dollars e frequência.' },
  att: { label: 'Chamada', icon: 'calendar', title: 'Presença que faz a diferença', description: 'Registre a participação dos alunos na aula.' },
  merit: { label: 'Méritos', icon: 'star', title: 'Reconheça cada evolução', description: 'Valorize a participação e as conquistas dos seus alunos.' },
  students: { label: 'Alunos', icon: 'users', title: 'Seus alunos, mais próximos', description: 'Acompanhe os alunos e crie novos acessos.' },
  cards: { label: 'Carteirinhas', icon: 'card', title: 'A identidade dos alunos', description: 'Confira as carteirinhas e imprima quando precisar.' },
  reports: { label: 'Relatórios', icon: 'download', title: 'Uma visão completa do período', description: 'Acompanhe frequência, conquistas e movimentações em um só painel.' },
  coord_classes: { label: 'Pessoas e perfis', icon: 'users', title: 'Cada pessoa em seu espaço', description: 'Gerencie alunos e professores com clareza.' },
  coord_audit: { label: 'Auditoria', icon: 'receipt', title: 'Uma visão de cada ação', description: 'Acompanhe os registros da equipe pedagógica.' },
  adm: { label: 'Gestão de saldos', icon: 'grid', title: 'O movimento da escola', description: 'Consulte contas, acompanhe movimentações e gerencie saldos.' }
};

function icon(name) {
  const paths = {
    pix: '<path d="m12 3 8 9-8 9-8-9 8-9Z"/><path d="m4 12 4-2 4 4 4-4 4 2"/>',
    send: '<path d="m21 3-7 18-4-7-7-4 18-7Z"/><path d="m10 14 11-11"/>',
    qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h4v4h-6z"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    store: '<path d="M4 10v11h16V10M3 6l2-3h14l2 3v4c-2 2-4 2-6 0-2 2-4 2-6 0-2 2-4 2-6 0V6ZM9 21v-7h6v7"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="m3 3 18 18M10 5l2-.1c6 0 10 7.1 10 7.1a18 18 0 0 1-3 4M6 6a21 21 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1M10 10a3 3 0 0 0 4 4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    receipt: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3ZM8 7h8M8 11h8M8 15h4"/>',
    trophy: '<path d="M7 3h10v5a5 5 0 0 1-10 0V3ZM7 5H3v3a4 4 0 0 0 5 4M17 5h4v3a4 4 0 0 1-5 4M12 13v5M8 21h8M9 18h6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18m-13 5 3 3 5-5"/>',
    card: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h4M14 15h4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    logout: '<path d="M9 3H4v18h5M9 12h12m-5-5 5 5-5 5"/>',
    flame: '<path d="M12 3s2 5-2 8c-2-2-2-4-2-4s-5 5-5 9a9 9 0 0 0 18 0c0-5-4-9-4-9s1 5-2 6c1-5-3-10-3-10Z"/>'
  };
  return `<svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}

function brandHTML() {
  return '<div class="brand-lockup" aria-label="Fisk Pay"><span class="fisk">FISK</span><span class="brand-pix">pay<span class="brand-dot">.</span></span></div>';
}

let balanceHidden = localStorage.getItem('fisk_hide_balance') === 'true';
function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function bindTheme() {
  const button = document.querySelector('#toggle-theme-btn');
  if (!button) return;
  button.onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('fisk_theme', root.dataset.theme);
    button.setAttribute('aria-label', `Ativar tema ${dark ? 'escuro' : 'claro'}`);
  };
}

function showFeedback(message, kind = 'bad') {
  feedbackMsg = { t: message, k: kind };
  const el = document.querySelector('#form-feedback');
  if (el) {
    el.className = `msg ${kind}`;
    el.textContent = message;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function showLoadError(error) {
  document.querySelectorAll('.primary-content .empty').forEach(el => {
    if (/Carregando|Buscando|Gerando/.test(el.textContent)) el.textContent = 'Não foi possível carregar os dados.';
  });
  showFeedback(error.message || 'Não foi possível carregar. Tente novamente.');
}

function streakHTML(streaks) {
  const s = streaks || { current: 0, best: 0, recent: [] };
  return `<section class="streak-card"><div class="eyebrow">SEU RITMO DE APRENDIZADO</div><div class="streak"><span class="streak-flame">${icon('flame')}</span><div><b>${Number(s.current) || 0}</b><span> ${Number(s.current) === 1 ? 'aula seguida' : 'aulas seguidas'}</span></div></div><p>Marque presença. Continue evoluindo.</p><div class="dots" aria-label="Últimas aulas">${Array.from({ length: 7 }, (_, i) => { const status = (s.recent || [])[i]; return `<span class="dot ${status || 'future'}" title="${status === 'p' ? 'Presença' : status === 'f' ? 'Falta' : 'Sem registro'}">${status === 'p' ? '✓' : status === 'f' ? '−' : '·'}</span>`; }).join('')}</div><small class="streak-record">Seu recorde: <strong>${Number(s.best) || 0} ${Number(s.best) === 1 ? 'aula' : 'aulas'}</strong> · +F$ 3 por presença</small></section>`;
}

async function handleAdminAction(kind) {
  const toUserId = document.querySelector('#au').value;
  const rawAmount = document.querySelector('#aa').value.trim();
  const amount = Number(rawAmount);
  const note = document.querySelector('#ar').value.trim();
  if (!toUserId || !rawAmount || !Number.isSafeInteger(amount) || amount < 0 || (kind !== 'set' && amount === 0)) return showFeedback('Selecione a conta e informe um valor inteiro válido.');
  const buttons = ['mint-btn', 'set-btn', 'withdraw-btn'].map(id => document.getElementById(id));
  if (buttons.some(b => b?.disabled)) return;
  buttons.forEach(b => { if (b) b.disabled = true; });
  try {
    await api('/api/admin/adjust', 'POST', { kind, toUserId, amount, note });
    feedbackMsg = { t: 'Saldo atualizado com sucesso.', k: 'ok' };
    await render();
  } catch (err) {
    showFeedback(err.message);
    buttons.forEach(b => { if (b) b.disabled = false; });
  }
}
