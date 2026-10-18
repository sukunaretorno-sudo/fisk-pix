require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const { 
  verifyPassword, 
  generateToken, 
  authenticateToken, 
  requireRoles 
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events manager
const sseClients = new Map();

function broadcastToUser(userId, eventName, data) {
  const userClients = sseClients.get(userId);
  if (userClients) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of userClients) {
      try {
        res.write(payload);
      } catch (e) {
        userClients.delete(res);
      }
    }
  }
}

function broadcastToAll(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (e) {
        clients.delete(res);
      }
    }
  }
}

function generateSerial(username) {
  let n = 0;
  for (const c of username) n = (n * 31 + c.charCodeAt(0)) % 100000000;
  return `B ${String(n).padStart(8, '0')} K`;
}

function userToken(user) {
  return generateToken({ id: user.id, username: user.username, name: user.name, role: user.role, token_version: user.token_version });
}

function closeUserStreams(userId) {
  for (const response of sseClients.get(userId) || []) response.end();
  sseClients.delete(userId);
}

function publicUser(user) {
  const { password_hash, token_version, ...safe } = user;
  return { ...safe, serial: generateSerial(user.username) };
}

/* ========================================================
   Server-Sent Events Route
   ======================================================== */
app.get('/api/events', authenticateToken, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.user.id;
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId).add(res);

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  req.on('close', () => {
    const clients = sseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(userId);
    }
  });
});

/* ========================================================
   Authentication Routes
   ======================================================== */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }

  const rawUsername = String(username).trim();

  const lock = (await db.checkLoginLock(rawUsername));
  if (lock.locked) {
    return res.status(429).json({ 
      error: `Conta bloqueada temporariamente. Tente novamente em ${lock.remainingSeconds} segundos.` 
    });
  }

  const user = (await db.getUserByUsername(rawUsername));
  if (!user || !user.is_active) {
    (await db.recordLoginFailure(rawUsername));
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  const passwordOk = verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    (await db.recordLoginFailure(rawUsername));
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  (await db.clearLoginFailures(rawUsername));

  const token = userToken(user);

  const streaks = user.role === 'aluno' ? (await db.calculateStreaks(user.id)) : null;

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      class_id: user.class_id,
      class_name: user.class_name,
      active_frame: user.active_frame || 'none',
      active_theme: user.active_theme || 'default',
      mascot: user.mascot || 'buddy',
      is_active: user.is_active,
      balance: user.role === 'aluno' || user.role === 'admin' ? user.balance : null,
      serial: generateSerial(user.username),
      streaks
    }
  });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const user = (await db.getUserById(req.user.id));
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  const streaks = user.role === 'aluno' ? (await db.calculateStreaks(user.id)) : null;

  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    class_id: user.class_id,
    class_name: user.class_name,
    active_frame: user.active_frame || 'none',
    active_theme: user.active_theme || 'default',
    mascot: user.mascot || 'buddy',
    is_active: user.is_active,
    balance: user.role === 'aluno' || user.role === 'admin' ? user.balance : null,
    serial: generateSerial(user.username),
    streaks
  });
});

app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const user = await db.resetUserPassword(req.user.id, req.user.id, req.body.newPassword, req.body.note);
    closeUserStreams(user.id);
    res.json({ success: true, token: userToken(user), message: 'Senha atualizada com sucesso!' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await db.updateProfile(req.user.id, req.body);
    res.json({ success: true, user: publicUser(user) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/pix/limit', authenticateToken, async (req, res) => {
  res.json(await db.getPixLimit(req.user.id));
});

app.patch('/api/admin/users/:id', authenticateToken, requireRoles('admin', 'coordenacao'), async (req, res) => {
  try {
    const user = await db.editUser(req.user.id, Number(req.params.id), req.body);
    closeUserStreams(user.id);
    res.json({ success: true, user: publicUser(user), ...(user.id === req.user.id ? { token: userToken(user) } : {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/password', authenticateToken, requireRoles('admin', 'coordenacao'), async (req, res) => {
  try {
    const user = await db.resetUserPassword(req.user.id, Number(req.params.id), req.body.newPassword, req.body.note);
    closeUserStreams(user.id);
    res.json({ success: true, message: 'Senha atualizada. A nova senha já pode ser usada no login.', ...(user.id === req.user.id ? { token: userToken(user) } : {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/reports', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  try {
    res.json(await db.getReports(req.query.from, req.query.to));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ========================================================
   Wallet & Pix Routes (Students Only)
   ======================================================== */
app.get('/api/wallet', authenticateToken, async (req, res) => {
  const user = (await db.getUserById(req.user.id));
  const tx = (await db.getTransactions(req.user.id, 'all', 20));
  const streaks = user.role === 'aluno' ? (await db.calculateStreaks(user.id)) : null;

  res.json({
    balance: user.balance,
    serial: generateSerial(user.username),
    active_frame: user.active_frame || 'none',
    active_theme: user.active_theme || 'default',
    mascot: user.mascot || 'buddy',
    pixLimit: await db.getPixLimit(user.id),
    streaks,
    recentTransactions: tx
  });
});

app.post('/api/pix/send', authenticateToken, async (req, res) => {
  const { toUserId, toUsername, amount, note } = req.body;

  let targetId = toUserId ? Number(toUserId) : null;
  if (!targetId && toUsername) {
    const cleanUser = String(toUsername).replace('@', '').trim();
    const u = (await db.getUserByUsername(cleanUser));
    if (u) targetId = u.id;
  }

  if (!targetId) {
    return res.status(400).json({ error: 'Destinatário não informado ou inválido.' });
  }

  try {
    const receipt = (await db.transferPix(req.user.id, targetId, amount, note));

    broadcastToUser(targetId, 'pix_received', {
      from: receipt.from.name,
      amount: receipt.amount,
      note: receipt.note,
      code: receipt.code
    });

    broadcastToAll('balance_updated', {
      users: [req.user.id, targetId]
    });

    res.json({
      success: true,
      message: `Pix de F$ ${receipt.amount} enviado com sucesso para ${receipt.to.name}!`,
      receipt
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/pix/statement', authenticateToken, async (req, res) => {
  const filter = req.query.filter || 'all';
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const tx = (await db.getTransactions(req.user.id, filter, limit));
  res.json({ transactions: tx });
});

app.get('/api/pix/qrcode/:username', authenticateToken, async (req, res) => {
  const username = req.params.username.trim();
  const user = (await db.getUserByUsername(username));
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  try {
    const payload = JSON.stringify({
      app: 'fiskpix',
      key: `@${user.username}`,
      toUserId: user.id,
      name: user.name
    });

    const qrDataUrl = await QRCode.toDataURL(payload, {
      width: 280,
      margin: 2,
      color: {
        dark: '#14295e',
        light: '#ffffff'
      }
    });

    res.json({
      key: `@${user.username}`,
      userId: user.id,
      name: user.name,
      qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar QR Code Pix.' });
  }
});

/* ========================================================
   Printable Fisk Cards (Ideia 6)
   ======================================================== */
app.get('/api/cards/students', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const students = (await db.getAllUsers(classId, 'aluno'));

  try {
    const cards = [];
    for (const s of students) {
      const payload = JSON.stringify({
        app: 'fiskpix',
        key: `@${s.username}`,
        toUserId: s.id,
        name: s.name
      });

      const qrDataUrl = await QRCode.toDataURL(payload, {
        width: 180,
        margin: 1,
        color: {
          dark: '#14295e',
          light: '#ffffff'
        }
      });

      cards.push({
        id: s.id,
        name: s.name,
        username: s.username,
        class_name: s.class_name || 'Geral',
        serial: generateSerial(s.username),
        active_frame: s.active_frame || 'none',
        qrDataUrl
      });
    }

    res.json({ cards });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar cartões dos alunos.' });
  }
});

/* ========================================================
   Classes Routes (Módulo de Múltiplas Turmas)
   ======================================================== */
app.get('/api/classes', authenticateToken, async (req, res) => {
  // If teacher, can optionally filter by their classes, or see all
  const teacherFilter = req.user.role === 'teacher' && req.query.mine === 'true' ? req.user.id : null;
  const classes = (await db.getAllClasses(teacherFilter));
  res.json({ classes });
});

app.post('/api/classes', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { name, level, teacherId } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da turma é obrigatório.' });

  try {
    const assignedTeacher = teacherId ? Number(teacherId) : (req.user.role === 'teacher' ? req.user.id : null);
    const newClass = (await db.createClass(name, level, assignedTeacher));
    (await db.logAudit(req.user.id, 'create_class', null, `Criou a turma "${name}" (${level || 'Geral'})`));
    res.json({ success: true, class: newClass });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/classes/assign', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { userId, classId } = req.body;
  (await db.assignStudentClass(Number(userId), classId ? Number(classId) : null));
  (await db.logAudit(req.user.id, 'assign_student', Number(userId), `Atribuiu aluno à turma ID #${classId || 'Nenhuma'}`));
  res.json({ success: true, message: 'Turma do aluno atualizada com sucesso!' });
});

app.post('/api/classes/set-teacher', authenticateToken, requireRoles('admin', 'coordenacao'), async (req, res) => {
  const { classId, teacherId } = req.body;
  (await db.updateClassTeacher(Number(classId), teacherId ? Number(teacherId) : null));
  (await db.logAudit(req.user.id, 'set_teacher', Number(teacherId), `Definiu professor da turma ID #${classId}`));
  res.json({ success: true, message: 'Professor atribuído à turma!' });
});

/* ========================================================
   Teacher Merit Awards
   ======================================================== */
app.post('/api/teacher/award', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { studentId, amount, reason } = req.body;

  try {
    const result = (await db.teacherAwardMerit(req.user.id, Number(studentId), amount, reason));

    broadcastToUser(Number(studentId), 'pix_received', {
      from: req.user.name,
      amount: result.amount,
      note: `Mérito: ${reason}`,
      code: 'MERIT'
    });

    broadcastToAll('balance_updated', { users: [Number(studentId)] });

    res.json({
      success: true,
      message: `Prêmio de F$ ${result.amount} concedido a ${result.studentName}!`,
      result
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ========================================================
   Users & Directory Routes
   ======================================================== */
app.get('/api/users/recipients', authenticateToken, async (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : null;
  // Students only can transfer to other students (teachers do not receive student peer-to-peer pix)
  const users = (await db.getAllUsers(classId, 'aluno'))
    .filter(u => u.id !== req.user.id)
    .map(u => ({ 
      id: u.id, 
      username: u.username, 
      name: u.name, 
      role: u.role,
      class_name: u.class_name,
      mascot: u.mascot || 'buddy',
      active_frame: u.active_frame || 'none'
    }));

  res.json({ users });
});

app.get('/api/ranking', authenticateToken, async (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const leaderboard = (await db.getLeaderboard(classId));
  res.json({ leaderboard });
});

/* ========================================================
   Attendance Routes
   ======================================================== */
app.get('/api/attendance', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  try {
    const date = req.query.date || db.localDate();
    const classId = req.query.classId ? Number(req.query.classId) : null;
    const list = (await db.getAttendanceForDate(date, classId));
    res.json({ date, records: list });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/attendance/mark', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { date, studentId, status, note } = req.body;

  if (!date || !studentId || !status) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  try {
    const result = (await db.markAttendance(date, Number(studentId), status, req.user.id, note));

    broadcastToUser(Number(studentId), 'attendance_updated', {
      date,
      status: result.status,
      balance: result.new_balance,
      streaks: result.streaks
    });

    broadcastToAll('balance_updated', { users: [Number(studentId)] });

    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/attendance/bulk', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  try {
    if (req.body.status !== 'p') throw new Error('A ação coletiva disponível é marcar todos como presentes.');
    const result = await db.markAllPresent(req.body.date, req.user.id, req.body.note);
    broadcastToAll('balance_updated', { users: result.records.map(record => record.user_id) });
    res.json({ success: true, result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ========================================================
   Fisk Store & Molduras Routes (Frames Only)
   ======================================================== */
app.get('/api/store/items', authenticateToken, async (req, res) => {
  const items = (await db.getStoreItems(req.user.id));
  res.json({ items });
});

app.post('/api/store/buy', authenticateToken, async (req, res) => {
  const { itemId, note } = req.body;
  if (!itemId) return res.status(400).json({ error: 'Item não informado.' });

  try {
    const result = (await db.buyStoreItem(req.user.id, itemId, note));

    broadcastToUser(req.user.id, 'item_bought', {
      item: result.item,
      newBalance: result.newBalance
    });

    res.json({
      success: true,
      message: `Você comprou a "${result.item.name}" com sucesso!`,
      result
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/store/equip', authenticateToken, async (req, res) => {
  const { frameId, note } = req.body;
  try {
    const result = (await db.equipFrame(req.user.id, frameId || 'none', note));
    res.json({ success: true, message: 'Moldura atualizada!', result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/store/equip-theme', authenticateToken, async (req, res) => {
  try {
    const result = await db.equipTheme(req.user.id, req.body.themeId || 'default', req.body.note);
    res.json({ success: true, message: 'Tema atualizado!', result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ========================================================
   Admin & Coordenação Routes
   ======================================================== */
app.get('/api/admin/stats', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const stats = (await db.getSystemStats());
  const users = (await db.getAllUsers(classId, null, req.user.role !== 'teacher'));
  const teachers = (await db.getAllUsers(null, 'teacher'));
  const classes = (await db.getAllClasses());
  const tx = (await db.getTransactions(null, 'all', 20));

  res.json({ stats, users, teachers, classes, recentTransactions: tx });
});

app.get('/api/coordenacao/audit', authenticateToken, requireRoles('admin', 'coordenacao'), async (req, res) => {
  const logs = (await db.getAuditLogs(100));
  res.json({ logs });
});

app.post('/api/admin/adjust', authenticateToken, requireRoles('admin', 'coordenacao'), async (req, res) => {
  const { kind, toUserId, amount, note } = req.body;

  try {
    const result = (await db.adminAdjustBalance(kind, req.user.id, Number(toUserId), amount, note));
    broadcastToUser(Number(toUserId), 'balance_adjusted', { kind, amount, newBalance: result.newBalance });
    broadcastToAll('balance_updated', { users: [Number(toUserId)] });

    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/bulk-reward', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { amount, note, classId } = req.body;

  try {
    const result = (await db.adminBulkReward(req.user.id, amount, note, classId ? Number(classId) : null));
    broadcastToAll('bulk_reward', { amount, note });
    res.json({ success: true, result, message: `Bônus de F$ ${amount} enviado a ${result.affected} alunos!` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/create-user', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  const { username, name, password, role, classId, note } = req.body;

  if (!username || !name || !password || password.length < 6) {
    return res.status(400).json({ error: 'Preencha usuário, nome e senha com no mínimo 6 caracteres.' });
  }

  // Only Coordenação / Admin can create Teacher accounts
  let assignedRole = 'aluno';
  if (role && !['aluno', 'teacher', 'coordenacao'].includes(role)) {
    return res.status(400).json({ error: 'Perfil inválido.' });
  }
  if (req.user.role === 'teacher' && role && role !== 'aluno') {
    return res.status(403).json({ error: 'Somente a coordenação pode criar professores ou outras contas de coordenação.' });
  }
  if (['teacher', 'coordenacao'].includes(role) && (req.user.role === 'admin' || req.user.role === 'coordenacao')) {
    assignedRole = role;
  }

  try {
    const newUser = (await db.createUser(username, name, assignedRole, password, classId ? Number(classId) : null));
    (await db.logAudit(req.user.id, 'create_user', newUser.id, `Cadastrou o ${assignedRole} "${name}" (@${username}). ${db.cleanNote(note)}`));
    res.json({ success: true, user: publicUser(newUser) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Este nome de usuário já está em uso.' });
    }
    res.status(400).json({ error: err.message });
  }
});

// Excel Exports
app.get('/api/admin/export/attendance', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  try {
  const csvData = (await db.exportAttendanceCSV(req.query.from, req.query.to));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fisk-chamada-frequencia.csv"');
  res.send(csvData);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/admin/export/transactions', authenticateToken, requireRoles('teacher', 'admin', 'coordenacao'), async (req, res) => {
  try {
  const csvData = (await db.exportTransactionsCSV(req.query.from, req.query.to));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fisk-extrato-geral.csv"');
  res.send(csvData);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Operação não encontrada.' }));
app.use((err, req, res, next) => {
  console.error('[API]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Não foi possível concluir a operação. Tente novamente.' });
});

// Single Page App fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Fisk Pay iniciado na porta ${PORT} (Turso/SQLite)`);
  });
}).catch(err => {
  console.error('[DB] Falha ao iniciar o banco:', err.message);
  process.exitCode = 1;
});
