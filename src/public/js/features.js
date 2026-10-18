/* Fisk Pay: profile, people, collection and reports. */
const actionLocks = new Set();
let storeCategory = 'frame';
let reportData = null;
let reportRange = null;
let dialogOpen = false;

async function runAction(key, action) {
  if (actionLocks.has(key)) return;
  actionLocks.add(key);
  try { return await action(); }
  catch (error) { showFeedback(error.message); }
  finally { actionLocks.delete(key); }
}

function acceptSessionToken(response) {
  if (!response.token) return;
  authToken = response.token;
  localStorage.setItem('fisk_token', authToken);
  connectSSE();
}

function openFormDialog(title, content, submitLabel, onSubmit) {
  if (dialogOpen) return Promise.resolve(null);
  dialogOpen = true;
  const sessionToken = authToken;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog-card';
  dialog.setAttribute('aria-labelledby', 'action-dialog-title');
  dialog.innerHTML = `<form id="action-dialog-form"><div class="dialog-heading"><h2 id="action-dialog-title">${esc(title)}</h2><button type="button" class="icon-button dialog-close" aria-label="Fechar">×</button></div>${content}<p id="dialog-error" class="msg bad" role="alert"></p><div class="dialog-actions"><button type="button" class="btn alt dialog-cancel">Cancelar</button><button type="submit" class="btn">${esc(submitLabel)}</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  return new Promise(resolve => {
    let submitting = false;
    const finish = value => {
      dialog.close(); dialog.remove(); dialogOpen = false;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    dialog.querySelector('.dialog-close').onclick = () => { if (!submitting) finish(null); };
    dialog.querySelector('.dialog-cancel').onclick = () => { if (!submitting) finish(null); };
    dialog.oncancel = e => { e.preventDefault(); if (!submitting) finish(null); };
    dialog.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      if (submitting) return;
      if (authToken !== sessionToken) return finish(null);
      submitting = true;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      try { const result = await onSubmit(new FormData(e.target)); finish(authToken === sessionToken ? result ?? true : null); }
      catch (error) {
        dialog.querySelector('#dialog-error').textContent = error.message;
        submitting = false; submit.disabled = false;
      }
    };
  });
}

function confirmAction(title, content, submitLabel = 'Confirmar', description = false) {
  return openFormDialog(title, content + (description ? `<label for="action-note">Descrição (opcional)</label><input id="action-note" name="note" maxlength="100" placeholder="Uma observação para o extrato">` : ''), submitLabel, data => ({ note: String(data.get('note') || '') }));
}

function profileSettingsHTML() {
  return `<details class="note account-settings" id="profile-settings"><summary>${icon('user')} Meu perfil <span>Nome e Buddy</span></summary><form class="profile-form" id="profile-form"><label for="profile-name">Seu nome</label><input id="profile-name" name="name" maxlength="80" required value="${esc(currentUser.name)}"><fieldset><legend>Escolha seu Buddy</legend><div class="mascot-options">${[['buddy','Clássico'],['buddy-celebrate','Celebração'],['buddy-study','Estudos']].map(([id,label]) => `<label class="mascot-choice"><input type="radio" name="mascot" value="${id}" ${(currentUser.mascot || 'buddy') === id ? 'checked' : ''}>${renderBuddy(currentUser.active_frame, '', id)}<span>${label}</span></label>`).join('')}</div></fieldset><label for="profile-note">Descrição da alteração (opcional)</label><input id="profile-note" name="note" maxlength="100"><button class="btn alt" type="submit">Salvar meu perfil</button></form>${currentUser.role === 'aluno' ? `<div class="user-actions"><button class="btn alt" id="remove-frame-btn">Usar Buddy sem moldura</button><button class="btn alt" id="default-theme-btn">Usar tema Fisk padrão</button></div>` : ''}</details>`;
}

function bindProfileSettings() {
  if ($('#open-profile-btn')) $('#open-profile-btn').onclick = () => {
    const profile = $('#profile-settings'); profile.open = true;
    profile.scrollIntoView({behavior:'smooth',block:'start'});
    $('#profile-name').focus({preventScroll:true});
  };
  const form = $('#profile-form');
  if (form) form.onsubmit = e => {
    e.preventDefault();
    runAction('profile', async () => {
      const token = authToken;
      const values = Object.fromEntries(new FormData(form));
      if (!values.name.trim()) return showFeedback('Informe seu nome.');
      const result = await api('/api/profile', 'PATCH', values);
      if (token !== authToken || !currentUser) return;
      acceptSessionToken(result);
      currentUser = { ...currentUser, ...result.user };
      userQrCode = null;
      feedbackMsg = { t: 'Seu perfil foi atualizado.', k: 'ok' };
      await render();
    });
  };
  if ($('#remove-frame-btn')) $('#remove-frame-btn').onclick = () => runAction('equip', () => handleEquipFrame('none'));
  if ($('#default-theme-btn')) $('#default-theme-btn').onclick = () => runAction('equip-theme', () => equipTheme('default'));
}

function bindRecipientSearch(users) {
  const select = $('#to');
  const search = $('#recipient-search');
  if (!select || !search) return;
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^@/, '');
  const update = () => {
    const needle = normalize(search.value.trim());
    const matches = users.filter(u => normalize(`${u.name} ${u.username}`).includes(needle));
    const chosen = users.find(u => String(u.id) === String(pixDraft.recipient));
    const options = chosen && !matches.includes(chosen) ? [chosen, ...matches] : matches;
    select.innerHTML = '<option value="">Selecione um colega</option>' + options.map(u => `<option value="${u.id}">${esc(u.name)} (@${esc(u.username)})</option>`).join('');
    select.value = pixDraft.recipient;
    $('#recipient-count').textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'colega encontrado' : 'colegas encontrados'}.` : 'Nenhum colega encontrado.';
  };
  search.oninput = update;
  select.onchange = () => {
    pixDraft.recipient = select.value;
    if (select.value) { pixDraft.key = ''; $('#direct-key').value = ''; }
  };
  $('#direct-key').oninput = e => {
    pixDraft.key = e.target.value;
    if (e.target.value) { pixDraft.recipient = ''; select.value = ''; }
  };
  update();
}

async function equipTheme(themeId) {
  const token = authToken;
  await api('/api/store/equip-theme', 'POST', { themeId });
  if (token !== authToken || !currentUser) return;
  currentUser.active_theme = themeId;
  feedbackMsg = { t: 'Tema aplicado ao seu Fisk Pay.', k: 'ok' };
  await render();
}

async function loadStore(isCurrentView) {
  try {
    const { items } = await api('/api/store/items');
    if (!isCurrentView()) return;
    const draw = () => {
      document.querySelectorAll('[data-store-category]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.storeCategory === storeCategory));
        button.onclick = () => { storeCategory = button.dataset.storeCategory; draw(); };
      });
      $('#store-container').innerHTML = `<p class="field-hint">${storeCategory === 'theme' ? 'Os temas mudam as cores de todo o app e custam mais que as molduras.' : 'Molduras para colecionar e usar com seu Buddy.'}</p><div class="store-grid">${items.filter(it => it.category === storeCategory).map(it => {
        const theme = it.category === 'theme';
        const equipped = theme ? currentUser.active_theme === it.id : currentUser.active_frame === it.frame_css;
        const action = equipped ? '<button class="store-btn equipped" disabled>Em uso</button>' : it.owned ? `<button class="store-btn owned" data-item-equip="${esc(it.id)}">Usar ${theme ? 'tema' : 'moldura'}</button>` : `<button class="store-btn" data-item-buy="${esc(it.id)}" ${currentUser.balance < it.price ? 'disabled' : ''}>${currentUser.balance < it.price ? 'Saldo insuficiente' : 'Comprar'}</button>`;
        return `<article class="store-card"><div class="store-header"><span class="store-icon">${esc(it.icon || '✦')}</span><span class="store-category">${theme ? 'Tema premium' : 'Moldura'}</span></div><h3 class="store-title">${esc(it.name)}</h3><p class="store-desc">${esc(it.description)}</p>${theme ? `<div class="theme-preview ${esc(it.id)}" aria-label="Prévia do tema ${esc(it.name)}"><div class="theme-preview-nav">FISK PAY</div><div class="theme-preview-content"><span>Seu espaço</span><b>F$ 250</b><div class="theme-preview-line"></div></div></div>` : `<div style="margin:14px auto">${renderBuddy(it.frame_css, '', currentUser.mascot)}</div>`}<div class="store-footer"><span class="store-price">${fmt(it.price)}</span>${action}</div></article>`;
      }).join('')}</div>`;
      document.querySelectorAll('[data-item-buy]').forEach(b => b.onclick = () => runAction('purchase', () => { const it = items.find(i => i.id === b.dataset.itemBuy); return handleBuyItem(it.id, it.name, it.price); }));
      document.querySelectorAll('[data-item-equip]').forEach(b => b.onclick = () => runAction('equip', () => { const it = items.find(i => i.id === b.dataset.itemEquip); return it.category === 'theme' ? equipTheme(it.id) : handleEquipFrame(it.frame_css); }));
    };
    draw();
  } catch (error) { if (isCurrentView()) showLoadError(error); }
}

async function markAllPresent() {
  const token = authToken;
  const { records } = await api(`/api/attendance?date=${attendanceDate}`);
  if (authToken !== token) return;
  const pending = records.filter(r => r.status !== 'p');
  if (!pending.length) return showFeedback('Todos os alunos já estão presentes nessa data.', 'ok');
  if (!await confirmAction('Confirmar chamada coletiva', `<p>Marcar <strong>${pending.length} ${pending.length === 1 ? 'aluno' : 'alunos'}</strong> como presentes em <strong>${esc(attendanceDate.split('-').reverse().join('/'))}</strong>?</p><p>Recompensa de ${fmt(3)} por aluno. As presenças existentes serão mantidas.</p><p>${esc(attendanceNote)}</p>`, 'Marcar presenças')) return;
  const response = await api('/api/attendance/bulk', 'POST', {date: attendanceDate, status: 'p', note: attendanceNote});
  if (authToken !== token) return;
  feedbackMsg = { t: `${response.result.affected} presenças registradas. ${response.result.unchanged} já estavam confirmadas.`, k: 'ok' };
  await render();
}

function peoplePageHTML() {
  return `<section class="note"><div class="title">Pessoas e acessos</div><div class="management-toolbar"><div><label for="people-search">Buscar pessoa</label><input type="search" id="people-search" placeholder="Nome ou @usuário"></div><div><label for="people-role">Perfil</label><select id="people-role"><option value="">Todos os perfis</option><option value="aluno">Aluno</option><option value="teacher">Professor</option><option value="coordenacao">Coordenação</option></select></div><div><label for="people-status">Situação</label><select id="people-status"><option value="">Todos</option><option value="1">Ativos</option><option value="0">Desativados</option></select></div></div><div id="people-count" role="status"></div><div class="scroll"><table id="people-table"><tbody><tr><td class="empty">Carregando pessoas...</td></tr></tbody></table></div></section><details class="note"><summary>Cadastrar uma pessoa</summary><form id="create-person-form"><label for="person-role">Perfil de acesso</label><select id="person-role" name="role"><option value="aluno">Aluno</option><option value="teacher">Professor</option><option value="coordenacao">Coordenação</option></select><label for="person-name">Nome completo</label><input id="person-name" name="name" maxlength="80" required><label for="person-username">Usuário</label><input id="person-username" name="username" minlength="2" maxlength="40" autocapitalize="none" spellcheck="false" required><label for="person-password">Senha inicial (mínimo 6 caracteres)</label><input id="person-password" name="password" type="password" minlength="6" autocomplete="new-password" required><label for="person-note">Descrição do cadastro (opcional)</label><input id="person-note" name="note" maxlength="100"><button type="submit" class="btn">Criar acesso</button></form></details>`;
}

async function loadPeople(isCurrentView) {
  const form = $('#create-person-form');
  form.onsubmit = e => { e.preventDefault(); runAction('create-person', async () => {
    const token = authToken;
    await api('/api/admin/create-user', 'POST', Object.fromEntries(new FormData(form)));
    if (authToken !== token) return;
    feedbackMsg = { t: 'Acesso criado com sucesso.', k: 'ok' }; await render();
  }); };
  try {
    const { users } = await api('/api/admin/stats');
    if (!isCurrentView()) return;
    const draw = () => {
      const query = $('#people-search').value.toLocaleLowerCase('pt-BR').trim().replace(/^@/, '');
      const role = $('#people-role').value;
      const status = $('#people-status').value;
      const visible = users.filter(u => `${u.name} ${u.username}`.toLocaleLowerCase('pt-BR').includes(query) && (!role || (u.role === 'admin' ? 'coordenacao' : u.role) === role) && (!status || String(u.is_active ?? 1) === status));
      $('#people-count').textContent = `${visible.length} ${visible.length === 1 ? 'pessoa encontrada' : 'pessoas encontradas'}`;
      $('#people-table').innerHTML = `<thead><tr><th>Nome e usuário</th><th>Perfil</th><th>Situação</th><th>Ações</th></tr></thead><tbody>${visible.map(u => `<tr><td><strong>${esc(u.name)}</strong><small style="display:block">@${esc(u.username)}</small></td><td>${esc(ROLE_LABELS[u.role])}</td><td>${u.is_active === 0 ? 'Desativado' : 'Ativo'}</td><td><div class="user-actions"><button class="btn alt" data-person-edit="${u.id}" aria-label="Editar ${esc(u.name)}">Editar</button><button class="btn alt" data-person-password="${u.id}" aria-label="Redefinir senha de ${esc(u.name)}">Senha</button><button class="btn alt" data-person-toggle="${u.id}" ${u.id === currentUser.id ? 'disabled' : ''}>${u.is_active === 0 ? 'Ativar' : 'Desativar'}</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma pessoa encontrada.</td></tr>'}</tbody>`;
      document.querySelectorAll('[data-person-edit]').forEach(b => b.onclick = () => editPerson(users.find(u => u.id === Number(b.dataset.personEdit))));
      document.querySelectorAll('[data-person-password]').forEach(b => b.onclick = () => resetPersonPassword(users.find(u => u.id === Number(b.dataset.personPassword))));
      document.querySelectorAll('[data-person-toggle]').forEach(b => b.onclick = () => runAction('toggle-person', () => togglePerson(users.find(u => u.id === Number(b.dataset.personToggle)))));
    };
    ['people-search','people-role','people-status'].forEach(id => { $('#'+id).oninput = draw; });
    draw();
  } catch (error) { if (isCurrentView()) showLoadError(error); }
}

async function editPerson(user) {
  const response = await openFormDialog('Editar acesso', `<p>@${esc(user.username)}</p><label for="edit-name">Nome</label><input id="edit-name" name="name" required maxlength="80" value="${esc(user.name)}"><label for="edit-username">Usuário</label><input id="edit-username" name="username" required minlength="2" maxlength="40" autocapitalize="none" value="${esc(user.username)}"><label for="edit-role">Perfil</label><select id="edit-role" name="role">${[['aluno','Aluno'],['teacher','Professor'],['coordenacao','Coordenação']].map(([role,label])=>`<option value="${role}" ${(user.role === 'admin' ? 'coordenacao' : user.role) === role ? 'selected' : ''}>${label}</option>`).join('')}</select><label for="edit-note">Descrição da alteração (opcional)</label><input id="edit-note" name="note" maxlength="100">`, 'Salvar alterações', values => api(`/api/admin/users/${user.id}`, 'PATCH', Object.fromEntries(values)));
  if (!response) return;
  acceptSessionToken(response);
  if (user.id === currentUser.id) {
    currentUser = { ...currentUser, ...response.user }; userQrCode = null;
    activeTab = currentUser.role === 'aluno' ? 'pix' : currentUser.role === 'teacher' ? 'att' : 'coord_classes';
  }
  feedbackMsg = { t: 'Cadastro atualizado.', k: 'ok' }; await render();
}

async function resetPersonPassword(user) {
  const response = await openFormDialog('Redefinir senha', `<p>Nova senha para <strong>${esc(user.name)}</strong> (@${esc(user.username)}).</p><label for="reset-password">Nova senha</label><input id="reset-password" name="newPassword" type="password" minlength="6" required autocomplete="new-password"><label for="reset-password-confirm">Repita a nova senha</label><input id="reset-password-confirm" name="confirmPassword" type="password" minlength="6" required autocomplete="new-password"><label for="reset-note">Descrição (opcional)</label><input id="reset-note" name="note" maxlength="100"><p class="field-hint">As sessões anteriores serão encerradas.</p>`, 'Redefinir senha', values => {
    if (values.get('newPassword') !== values.get('confirmPassword')) throw new Error('As senhas precisam ser iguais.');
    return api(`/api/admin/users/${user.id}/password`, 'POST', {newPassword:values.get('newPassword'),note:values.get('note')});
  });
  if (!response) return;
  acceptSessionToken(response);
  feedbackMsg = { t: `Senha de ${user.name} atualizada.`, k: 'ok' }; await render();
}

async function togglePerson(user) {
  const activating = user.is_active === 0;
  const result = await confirmAction(`${activating ? 'Ativar' : 'Desativar'} acesso`, `<p>${esc(user.name)} (@${esc(user.username)}) ${activating ? 'poderá acessar o Fisk Pay novamente' : 'deixará de acessar o Fisk Pay'}. O histórico será preservado.</p>`, activating ? 'Ativar acesso' : 'Desativar acesso', true);
  if (!result) return;
  await api(`/api/admin/users/${user.id}`, 'PATCH', {active:activating,note:result.note});
  feedbackMsg = { t: activating ? 'Acesso ativado.' : 'Acesso desativado.', k: 'ok' }; await render();
}

function reportsPageHTML() {
  if (!reportRange) { const start = new Date(); start.setDate(start.getDate() - 29); reportRange = {from:localDate(start),to:localDate()}; }
  return `<section class="note"><div class="title">Painel de acompanhamento</div><form class="filter-bar" id="report-filter-form"><div><label for="report-from">De</label><input type="date" id="report-from" name="from" value="${reportRange.from}" required></div><div><label for="report-to">Até</label><input type="date" id="report-to" name="to" value="${reportRange.to}" required></div><button class="btn" type="submit">Aplicar período</button></form><p class="field-hint">Períodos de até 366 dias. Horário de Brasília.</p><div id="report-content"><div class="empty">Carregando relatório...</div></div></section>`;
}

async function loadReports(isCurrentView) {
  const form = $('#report-filter-form');
  form.onsubmit = e => {
    e.preventDefault();
    const from = $('#report-from').value, to = $('#report-to').value;
    if (from > to) return showFeedback('A data inicial precisa ser anterior à data final.');
    reportRange = {from,to}; render();
  };
  try {
    const response = await api(`/api/reports?${new URLSearchParams(reportRange)}`);
    if (!isCurrentView()) return;
    reportData = response;
    const s = response.summary;
    const days = response.byDay.filter(d => d.transactions || d.present || d.absent).slice(-14);
    const max = Math.max(1, ...days.map(d => Number(d.rewards) + Number(d.pixVolume)));
    const tiles = [['Alunos ativos',s.activeStudents],['Presença no período',`${Number(s.attendanceRate).toLocaleString('pt-BR',{maximumFractionDigits:1})}%`],['Recompensas',fmt(s.rewards)],['Volume Pix',fmt(s.pixVolume)],['Movimentações',s.totalTransactions],['Saldo em circulação',fmt(s.totalInCirculation)]];
    $('#report-content').innerHTML = `<div class="stat-grid">${tiles.map(([label,value])=>`<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><p>${s.present} ${s.present === 1 ? 'presença' : 'presenças'} · ${s.absent} ${s.absent === 1 ? 'falta registrada' : 'faltas registradas'}. A taxa considera somente chamadas registradas. Saldo e contas ativas refletem a situação atual.</p><h3>Movimento por dia</h3><p class="field-hint">Pix + recompensas nos últimos 14 dias com registros dentro do período.</p><div class="report-chart">${days.map(d=>`<div class="chart-row"><span>${esc(d.date.slice(5).split('-').reverse().join('/'))}</span><div class="chart-track"><div class="chart-bar" style="width:${Math.max(1,(Number(d.rewards)+Number(d.pixVolume))/max*100)}%"></div></div><strong>${fmt(Number(d.rewards)+Number(d.pixVolume))}</strong></div>`).join('') || '<p class="empty">Sem registros no período.</p>'}</div><h3>Resumo por operação</h3><div class="scroll"><table><thead><tr><th>Operação</th><th>Quantidade</th><th>Total registrado</th></tr></thead><tbody>${response.byType.map(t=>`<tr><td>${esc(ACTION_LABELS[t.type] || t.type)}</td><td>${t.count}</td><td>${fmt(t.total)}</td></tr>`).join('') || '<tr><td colspan="3">Sem movimentações.</td></tr>'}</tbody></table></div><h3>Acompanhamento por aluno</h3><label for="report-student-search">Buscar aluno</label><input id="report-student-search" type="search" placeholder="Nome ou @usuário"><div class="user-actions"><button class="btn alt" id="report-students-csv">Exportar alunos (CSV)</button><button class="btn alt" id="report-attendance-csv">Exportar chamada detalhada</button></div><div class="scroll"><table id="report-students"></table></div><h3>Movimentações do período</h3><div class="filter-bar"><div><label for="report-tx-search">Buscar descrição ou pessoa</label><input type="search" id="report-tx-search" placeholder="Digite para filtrar"></div><div><label for="report-tx-type">Operação</label><select id="report-tx-type"><option value="">Todas</option>${response.byType.map(t=>`<option value="${esc(t.type)}">${esc(ACTION_LABELS[t.type] || t.type)}</option>`).join('')}</select></div></div><div class="user-actions"><button class="btn alt" id="report-transactions-csv">Exportar lista filtrada</button><button class="btn alt" id="report-all-transactions-csv">Exportar período completo</button></div><p id="report-tx-count" role="status"></p><div class="scroll"><table id="report-transactions"></table></div>${response.truncated ? '<p class="field-hint">A visualização inclui apenas as movimentações mais recentes. Use “Exportar período completo” para obter todas.</p>' : ''}`;
    let visibleStudents = [], visibleTransactions = [];
    const drawStudents = () => {
      const q = $('#report-student-search').value.toLowerCase().trim().replace(/^@/,'');
      visibleStudents = response.students.filter(u=>`${u.name} ${u.username}`.toLowerCase().includes(q));
      $('#report-students').innerHTML = `<thead><tr><th>Aluno</th><th>Presenças</th><th>Faltas</th><th>Frequência</th><th>Recompensas</th><th>Saldo atual</th></tr></thead><tbody>${visibleStudents.map(u=>`<tr><td>${esc(u.name)}<small style="display:block">@${esc(u.username)}${u.is_active === 0 ? ' · Desativado' : ''}</small></td><td>${u.present}</td><td>${u.absent}</td><td>${u.present + u.absent ? Number(u.attendanceRate).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%' : '—'}</td><td>${fmt(u.rewards)}</td><td>${fmt(u.balance)}</td></tr>`).join('') || '<tr><td colspan="6">Nenhum aluno encontrado.</td></tr>'}</tbody>`;
    };
    const drawTransactions = () => {
      const q = $('#report-tx-search').value.toLowerCase().trim(), type = $('#report-tx-type').value;
      visibleTransactions = response.transactions.filter(t=>(!type || t.type===type) && `${t.from_name || ''} ${t.to_name || ''} ${t.note || ''} ${t.code}`.toLowerCase().includes(q));
      $('#report-tx-count').textContent = `${visibleTransactions.length} registros na lista · ${response.transactionCount} no período.`;
      $('#report-transactions').innerHTML = `<thead><tr><th>Data</th><th>Operação</th><th>De / para</th><th>Descrição</th><th>Valor</th></tr></thead><tbody>${visibleTransactions.map(t=>`<tr><td>${when(t.created_at)}</td><td>${esc(ACTION_LABELS[t.type] || t.type)}</td><td>${esc(t.from_name || 'Sistema')} → ${esc(t.to_name || '—')}</td><td>${esc(t.note || '—')}</td><td>${fmt(t.amount)}</td></tr>`).join('') || '<tr><td colspan="5">Nenhuma movimentação encontrada.</td></tr>'}</tbody>`;
    };
    $('#report-student-search').oninput = drawStudents;
    $('#report-tx-search').oninput = drawTransactions;
    $('#report-tx-type').onchange = drawTransactions;
    $('#report-students-csv').onclick = () => downloadCSV('alunos', ['Nome','Usuário','Presenças','Faltas','Frequência (%)','Recompensas','Pix enviado','Pix recebido','Gastos','Saldo atual'], visibleStudents.map(u=>[u.name,u.username,u.present,u.absent,u.attendanceRate,u.rewards,u.pixSent,u.pixReceived,u.spent,u.balance]));
    $('#report-transactions-csv').onclick = () => downloadCSV('movimentacoes', ['Código','Data','Operação','Origem','Destino','Descrição','Valor'], visibleTransactions.map(t=>[t.code,new Date(t.created_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),ACTION_LABELS[t.type] || t.type,t.from_name,t.to_name,t.note,t.amount]));
    $('#report-attendance-csv').onclick = () => exportReport('attendance');
    $('#report-all-transactions-csv').onclick = () => exportReport('transactions');
    drawStudents(); drawTransactions();
  } catch (error) { if (isCurrentView()) showLoadError(error); }
}

function downloadCSV(name, headers, rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (typeof value !== 'number' && /^\s*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g,'""') + '"';
  };
  const csv = '\uFEFF' + [headers,...rows].map(row=>row.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = `fisk-pay-${name}-${reportRange.from}-${reportRange.to}.csv`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function exportReport(type) {
  window.location.href = `/api/admin/export/${type}?${new URLSearchParams({...reportRange,token:authToken})}`;
}
