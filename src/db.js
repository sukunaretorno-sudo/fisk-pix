const { createDatabase } = require('./db-driver');
const { hashPassword } = require('./auth');
const db = createDatabase();

async function initialize() {
  await db.exec(SCHEMA);
  await applyMigrations();
  await seed();
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    level TEXT,
    teacher_id INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    class_id INTEGER,
    active_frame TEXT DEFAULT 'none',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallets (
    user_id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    from_user_id INTEGER,
    to_user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance (
    date TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('p', 'f')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(date, user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_security (
    username TEXT PRIMARY KEY COLLATE NOCASE,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS store_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK(price > 0),
    icon TEXT,
    frame_css TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES store_items(id) ON DELETE CASCADE,
    purchased_at INTEGER NOT NULL,
    UNIQUE(user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    teacher_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    target_name TEXT,
    details TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tx_to_from ON transactions(to_user_id, from_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
`;

// Handle migrations
async function applyMigrations() {
  // No PRAGMA changes needed for a fresh Turso database.

  // Check classes table for teacher_id
  const classCols = (await db.prepare(`PRAGMA table_info(classes)`).all()).map(c => c.name);
  if (!classCols.includes('teacher_id')) {
    await db.exec(`ALTER TABLE classes ADD COLUMN teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
  }

  // Older installations restricted roles to aluno/admin. Use the adapter's atomic
  // migration so replacing users cannot cascade-delete wallets or historical rows.
  const userSql = (await db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get()).sql;
  const roleCheck = /CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i;
  if (userSql && roleCheck.test(userSql)) {
    const tableRoleCheck = /,\s*CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/gi;
    const replacementSql = userSql.replace(tableRoleCheck, '').replace(roleCheck, '')
      .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"users"|`users`|\[users\]|users)/i, 'CREATE TABLE users_role_migration');
    const dependents = await db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();
    await db.migrate([
      replacementSql,
      'INSERT INTO users_role_migration SELECT * FROM users',
      'DROP TABLE users',
      'ALTER TABLE users_role_migration RENAME TO users',
      ...dependents.map(row => row.sql)
    ]);
  }
  const userCols = (await db.prepare('PRAGMA table_info(users)').all()).map(c => c.name);
  for (const [column, definition] of Object.entries({
    mascot: "TEXT NOT NULL DEFAULT 'buddy'",
    active_theme: "TEXT NOT NULL DEFAULT 'default'",
    is_active: 'INTEGER NOT NULL DEFAULT 1',
    token_version: 'INTEGER NOT NULL DEFAULT 0'
  })) {
    if (!userCols.includes(column)) await db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
  const attendanceCols = (await db.prepare('PRAGMA table_info(attendance)').all()).map(c => c.name);
  if (!attendanceCols.includes('note')) await db.exec("ALTER TABLE attendance ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  await db.exec('CREATE INDEX IF NOT EXISTS idx_pix_daily ON transactions(from_user_id, type, created_at)');
}

// Seed initial classes, users, frames, and coordination account
async function seed() {
  const now = Date.now();

  // First login: coordenacao; initial password comes from COORDENACAO_PASSWORD env
  const coordExists = (await db.prepare(`SELECT id FROM users WHERE role IN ('coordenacao', 'admin') LIMIT 1`).get());
  if (!coordExists) {
    if (!process.env.COORDENACAO_PASSWORD || process.env.COORDENACAO_PASSWORD.length < 8 || process.env.COORDENACAO_PASSWORD.startsWith('DEFINA_')) {
      throw new Error('Defina COORDENACAO_PASSWORD (8+ caracteres) no .env ou nas variáveis do Render antes do primeiro deploy.');
    }
    console.log('[DB] Criando conta da Coordenação Pedagógica...');
    (await db.prepare(`
      INSERT INTO users (username, name, role, password_hash, class_id, active_frame, created_at)
      VALUES (?, ?, ?, ?, NULL, 'none', ?)
    `).run('coordenacao', 'Coordenação Pedagógica', 'coordenacao', hashPassword(process.env.COORDENACAO_PASSWORD), now));
  }

  // Seed initial classes
  const classCount = (await db.prepare('SELECT COUNT(*) as c FROM classes').get()).c;
  if (classCount === 0) {
    const insertClass = db.prepare('INSERT INTO classes (name, level, teacher_id, created_at) VALUES (?, ?, ?, ?)');
    await insertClass.run('Teens 1', 'Intermediário', null, now); // teacher is assigned when registered
    await insertClass.run('Adults 2', 'Avançado', null, now);
    await insertClass.run('Kids 3', 'Iniciante', null, now);
  } else {
    // Ensure classes have teacher_id linked to teacher if null
    const teacherUser = (await db.prepare(`SELECT id FROM users WHERE role = 'teacher'`).get());
    if (teacherUser) {
      (await db.prepare(`UPDATE classes SET teacher_id = ? WHERE teacher_id IS NULL`).run(teacherUser.id));
    }
  }

  // Seed Store Profile Frames (Only Frames!)
  const storeCount = (await db.prepare('SELECT COUNT(*) as c FROM store_items').get()).c;
  if (storeCount === 0) {
    const insertItem = db.prepare(`
      INSERT INTO store_items (id, name, description, category, price, icon, frame_css, created_at)
      VALUES (?, ?, ?, 'frame', ?, ?, ?, ?)
    `);

    await insertItem.run('frame-gold', 'Moldura Dourada VIP', 'Borda dourada reluzente com efeito Shimmer VIP.', 30, '🥇', 'frame-gold', now);
    await insertItem.run('frame-fire', 'Moldura On Fire 🔥', 'Chamas pulsantes para os alunos com maior ofensiva de presenças.', 45, '🔥', 'frame-fire', now);
    await insertItem.run('frame-neon', 'Moldura Cyber Neon ⚡', 'Brilho neon futurista ciano e magenta.', 50, '⚡', 'frame-neon', now);
    await insertItem.run('frame-diamond', 'Moldura Diamante Fisk 💎', 'Prisma de diamante ultra-raro com reflexo cristalino.', 100, '💎', 'frame-diamond', now);
    await insertItem.run('frame-stars', 'Moldura Stars & Stripes ⭐', 'Estrelas comemorativas Fisk & bandeira americana.', 35, '⭐', 'frame-stars', now);
    await insertItem.run('frame-crown', 'Coroa Real English Master 👑', 'Coroa dourada flutuante para os mestres de conversação.', 75, '👑', 'frame-crown', now);
  }
  const catalog = [
    ['frame-ruby', 'Moldura Rubi Fisk', 'O vermelho Fisk com acabamento de rubi.', 'frame', 65, '❤️'],
    ['frame-ocean', 'Moldura Ocean', 'Azul profundo para acompanhar suas conquistas.', 'frame', 80, '🌊'],
    ['frame-violet', 'Moldura Violet', 'Um brilho violeta para o seu Buddy.', 'frame', 95, '💜'],
    ['frame-mint', 'Moldura Mint', 'Uma moldura verde com toque leve e fresco.', 'frame', 120, '🌿'],
    ['theme-midnight', 'Tema Midnight', 'Uma experiência noturna com a assinatura Fisk.', 'theme', 200, '🌙'],
    ['theme-ocean', 'Tema Ocean', 'Azul oceano em toda a sua experiência Fisk Pay.', 'theme', 250, '🌊'],
    ['theme-ruby', 'Tema Ruby', 'O vermelho Fisk em uma composição especial.', 'theme', 300, '❤️']
  ];
  for (const [id, name, description, category, price, icon] of catalog) {
    await db.prepare(`INSERT OR IGNORE INTO store_items (id, name, description, category, price, icon, frame_css, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, description, category, price, icon, id, now);
  }
}

/* ========================================================
   Audit Logging (Coordenação Tracking)
   ======================================================== */
async function logAudit(teacherId, action, targetUserId, details, connection = db) {
  const teacher = await connection.prepare('SELECT name FROM users WHERE id = ?').get(teacherId);
  const teacherName = teacher ? teacher.name : `ID #${teacherId}`;
  let targetName = null;
  if (targetUserId) {
    const target = await connection.prepare('SELECT name FROM users WHERE id = ?').get(targetUserId);
    targetName = target ? target.name : `ID #${targetUserId}`;
  }

  (await connection.prepare(`
    INSERT INTO audit_logs (teacher_id, teacher_name, action, target_user_id, target_name, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(teacherId, teacherName, action, targetUserId || null, targetName || null, details, Date.now()));
}

async function getAuditLogs(limit = 100) {
  return (await db.prepare(`
    SELECT a.*, u.username as teacher_username, t.username as target_username
    FROM audit_logs a
    LEFT JOIN users u ON a.teacher_id = u.id
    LEFT JOIN users t ON a.target_user_id = t.id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit));
}

/* ========================================================
   Classes Operations
   ======================================================== */
async function getAllClasses(teacherId = null) {
  let query = `
    SELECT c.id, c.name, c.level, c.teacher_id, u_teach.name as teacher_name, u_teach.username as teacher_username,
           COUNT(DISTINCT u_stud.id) as student_count
    FROM classes c
    LEFT JOIN users u_teach ON c.teacher_id = u_teach.id
    LEFT JOIN users u_stud ON c.id = u_stud.class_id AND u_stud.role = 'aluno'
  `;
  const params = [];
  if (teacherId) {
    query += ` WHERE c.teacher_id = ?`;
    params.push(teacherId);
  }
  query += ` GROUP BY c.id ORDER BY c.name ASC`;
  return (await db.prepare(query).all(...params));
}

async function createClass(name, level, teacherId = null) {
  const now = Date.now();
  const res = (await db.prepare(`INSERT INTO classes (name, level, teacher_id, created_at) VALUES (?, ?, ?, ?)`).run(name.trim(), level ? level.trim() : '', teacherId || null, now));
  return { id: res.lastInsertRowid, name, level, teacherId };
}

async function updateClassTeacher(classId, teacherId) {
  return (await db.prepare(`UPDATE classes SET teacher_id = ? WHERE id = ?`).run(teacherId || null, classId));
}

async function assignStudentClass(userId, classId) {
  return (await db.prepare(`UPDATE users SET class_id = ? WHERE id = ?`).run(classId || null, userId));
}

/* ========================================================
   User & Auth Operations
   ======================================================== */
function normalizeUsername(u) {
  if (!u) return '';
  return u.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

async function getUserByUsername(username) {
  const raw = String(username).trim();
  const clean = normalizeUsername(raw);

  return (await db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.password_hash, u.class_id, u.active_frame, u.mascot, u.active_theme, u.is_active, u.token_version, u.created_at, w.balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.username = ? OR u.username = ?
  `).get(raw, clean));
}

async function getUserById(id) {
  return (await db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.class_id, u.active_frame, u.mascot, u.active_theme, u.is_active, u.token_version, u.created_at, w.balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.id = ?
  `).get(id));
}

async function getAllUsers(classId = null, role = null, includeInactive = false) {
  let query = `
    SELECT u.id, u.username, u.name, u.role, u.class_id, u.active_frame, u.mascot, u.active_theme, u.is_active, u.created_at, 
           COALESCE(w.balance, 0) as balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (!includeInactive) query += ' AND u.is_active = 1';
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  if (role) {
    query += ` AND u.role = ?`;
    params.push(role);
  }
  query += ` ORDER BY u.name ASC`;
  return (await db.prepare(query).all(...params));
}

async function createUser(username, name, role, password, classId = null) {
  validateName(name);
  validateUsername(username);
  validatePassword(password);
  if (!['aluno', 'teacher', 'coordenacao', 'admin'].includes(role)) throw new Error('Perfil inválido.');
  const now = Date.now();
  const tx = await db.transaction();
  try {
    const cleanUsername = normalizeUsername(username);
    const res = (await tx.prepare(`
      INSERT INTO users (username, name, role, password_hash, class_id, active_frame, created_at)
      VALUES (?, ?, ?, ?, ?, 'none', ?)
    `).run(cleanUsername, name.trim(), role, hashPassword(password), classId || null, now));

    const userId = res.lastInsertRowid;

    // Wallets are only for students (aluno) or admin
    if (role === 'aluno' || role === 'admin') {
      (await tx.prepare(`
        INSERT INTO wallets (user_id, balance, updated_at)
        VALUES (?, 0, ?)
      `).run(userId, now));
    }

    await tx.commit();
    return await getUserById(userId);
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function updatePassword(userId, newPassword) {
  validatePassword(newPassword);
  return (await db.prepare(`UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`).run(hashPassword(newPassword), userId));
}

function cleanNote(note) {
  return typeof note === 'string' ? note.trim().slice(0, 500) : '';
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Informe um nome com até 80 caracteres.');
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-z0-9._-]{2,40}$/.test(normalizeUsername(username))) {
    throw new Error('Use de 2 a 40 letras, números, pontos, traços ou sublinhados no usuário.');
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new Error('A senha deve ter entre 6 e 128 caracteres.');
}

async function updateProfile(userId, { name, mascot, note }) {
  const user = await getUserById(userId);
  if (!user) throw new Error('Usuário não encontrado.');
  const nextName = name === undefined ? user.name : name;
  const nextMascot = mascot === undefined ? user.mascot : mascot;
  validateName(nextName);
  if (!['buddy', 'buddy-celebrate', 'buddy-study'].includes(nextMascot)) throw new Error('Escolha um dos mascotes Fisk disponíveis.');
  const tx = await db.transaction();
  try {
    await tx.prepare('UPDATE users SET name = ?, mascot = ? WHERE id = ?').run(nextName.trim(), nextMascot, userId);
    await logAudit(userId, 'profile_update', userId, `Atualizou nome e mascote. ${cleanNote(note)}`, tx);
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
  return getUserById(userId);
}

async function editUser(actorId, userId, changes) {
  const tx = await db.transaction();
  try {
    const user = await tx.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('Usuário não encontrado.');
    const name = changes.name === undefined ? user.name : changes.name;
    const username = changes.username === undefined ? user.username : changes.username;
    const role = changes.role === undefined ? user.role : changes.role;
    if (changes.active !== undefined && typeof changes.active !== 'boolean') throw new Error('O estado da conta deve ser ativo ou inativo.');
    const active = changes.active === undefined ? user.is_active : Number(changes.active);
    validateName(name);
    validateUsername(username);
    if (!['aluno', 'teacher', 'coordenacao', 'admin'].includes(role) || (role === 'admin' && user.role !== 'admin')) throw new Error('Perfil inválido.');
    if (actorId === userId && !active) throw new Error('Você não pode desativar sua própria conta.');
    if (user.is_active && ['coordenacao', 'admin'].includes(user.role) && (!active || !['coordenacao', 'admin'].includes(role))) {
      const coords = await tx.prepare("SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND role IN ('coordenacao', 'admin')").get();
      if (coords.count <= 1) throw new Error('Mantenha pelo menos uma conta de coordenação ativa.');
    }
    const invalidate = role !== user.role || active !== user.is_active || normalizeUsername(username) !== user.username;
    await tx.prepare(`UPDATE users SET name = ?, username = ?, role = ?, is_active = ?, token_version = token_version + ? WHERE id = ?`)
      .run(name.trim(), normalizeUsername(username), role, active, Number(invalidate), userId);
    if (role === 'aluno') await tx.prepare('INSERT OR IGNORE INTO wallets (user_id, balance, updated_at) VALUES (?, 0, ?)').run(userId, Date.now());
    await logAudit(actorId, 'update_user', userId, `Atualizou @${user.username} para @${normalizeUsername(username)}, perfil ${role}, conta ${active ? 'ativa' : 'inativa'}. ${cleanNote(changes.note)}`, tx);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    if (err.message.includes('UNIQUE')) throw new Error('Este nome de usuário já está em uso.');
    throw err;
  }
  return getUserById(userId);
}

async function resetUserPassword(actorId, userId, newPassword, note) {
  validatePassword(newPassword);
  const tx = await db.transaction();
  try {
    const user = await tx.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('Usuário não encontrado.');
    await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(newPassword), userId);
    await tx.prepare('DELETE FROM login_security WHERE username = ?').run(normalizeUsername(user.username));
    await logAudit(actorId, 'reset_password', userId, `Redefiniu a senha de acesso. ${cleanNote(note)}`, tx);
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
  return getUserById(userId);
}

/* ========================================================
   Login Security / Brute Force Protection
   ======================================================== */
async function checkLoginLock(username) {
  const clean = normalizeUsername(username);
  const row = (await db.prepare('SELECT attempts, locked_until FROM login_security WHERE username = ?').get(clean));
  if (!row) return { locked: false };
  const now = Date.now();
  if (row.locked_until > now) {
    const remainingSeconds = Math.ceil((row.locked_until - now) / 1000);
    return { locked: true, remainingSeconds };
  }
  return { locked: false };
}

async function recordLoginFailure(username) {
  const clean = normalizeUsername(username);
  const now = Date.now();
  const row = (await db.prepare('SELECT attempts FROM login_security WHERE username = ?').get(clean));
  const attempts = (row ? row.attempts : 0) + 1;
  let lockedUntil = 0;
  if (attempts >= 5) {
    lockedUntil = now + 5 * 60 * 1000;
  }
  (await db.prepare(`
    INSERT INTO login_security (username, attempts, locked_until)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET attempts = ?, locked_until = ?
  `).run(clean, attempts, lockedUntil, attempts, lockedUntil));
}

async function clearLoginFailures(username) {
  (await db.prepare('DELETE FROM login_security WHERE username = ?').run(normalizeUsername(username)));
}

/* ========================================================
   Pix Transfer & Transactions (Strictly Students/Admin)
   ======================================================== */
function generatePixCode() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `P${t}${r}`;
}

const PIX_DAILY_LIMIT = 10000;
const SAO_PAULO = 'America/Sao_Paulo';
const localDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: SAO_PAULO, year: 'numeric', month: '2-digit', day: '2-digit' });
function localDate(timestamp = Date.now()) {
  const parts = localDateFormatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Informe uma data válida no formato ano-mês-dia.');
  }
  return date;
}

function nextDate(date) {
  return new Date(Date.parse(`${validateDate(date)}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

// First instant of the local date, including historical days that skipped midnight.
function zonedMidnight(date) {
  const target = Date.parse(`${validateDate(date)}T00:00:00Z`);
  let low = target - 18 * 3600000;
  let high = target + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function getPixLimit(userId, connection = db, now = Date.now()) {
  const date = localDate(now);
  const row = await connection.prepare(`SELECT COALESCE(SUM(amount), 0) AS used FROM transactions
    WHERE type = 'pix' AND from_user_id = ? AND created_at >= ? AND created_at < ?`)
    .get(userId, zonedMidnight(date), zonedMidnight(nextDate(date)));
  return { limit: PIX_DAILY_LIMIT, used: row.used, remaining: Math.max(0, PIX_DAILY_LIMIT - row.used), date, timezone: SAO_PAULO };
}

async function transferPix(fromUserId, toUserId, rawAmount, rawNote) {
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('O valor do Pix deve ser um número inteiro positivo.');
  }

  if (fromUserId === toUserId) {
    throw new Error('Você não pode enviar um Pix para si mesmo.');
  }

  const sender = await getUserById(fromUserId);
  const recipient = await getUserById(toUserId);

  if (!sender || !recipient || !sender.is_active || !recipient.is_active) {
    throw new Error('Conta de remetente ou destinatário não encontrada.');
  }

  // Teachers and coordination DO NOT participate in student peer-to-peer pix!
  if (sender.role !== 'aluno') {
    throw new Error('Professores e Coordenação realizam apenas premiações pedagógicas através do Painel.');
  }
  if (recipient.role !== 'aluno') {
    throw new Error('Contas de professores e coordenação não recebem transferências Pix.');
  }

  const note = cleanNote(rawNote);
  const now = Date.now();
  const code = generatePixCode();

  const tx = await db.transaction();
  try {
    const activeAccounts = await tx.prepare("SELECT COUNT(*) AS count FROM users WHERE id IN (?, ?) AND role = 'aluno' AND is_active = 1").get(fromUserId, toUserId);
    if (activeAccounts.count !== 2) throw new Error('Uma das contas não está disponível para receber ou enviar Pix.');
    const daily = await getPixLimit(fromUserId, tx, now);
    if (amount > daily.remaining) throw new Error(`Limite diário de F$ 10.000. Você ainda pode enviar F$ ${daily.remaining} hoje.`);
    const senderWallet = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(fromUserId));
    if (!senderWallet || senderWallet.balance < amount) {
      throw new Error('Saldo insuficiente para realizar esta transferência.');
    }

    (await tx.prepare('UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ?').run(amount, now, fromUserId));
    (await tx.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, toUserId));

    const newSenderWallet = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(fromUserId));

    (await tx.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'pix', ?, ?, ?, ?, ?, ?)
    `).run(code, fromUserId, toUserId, amount, newSenderWallet.balance, note, now));

    await tx.commit();

    return {
      code,
      from: { id: fromUserId, name: sender.name },
      to: { id: toUserId, name: recipient.name },
      amount,
      note,
      created_at: now,
      new_balance: newSenderWallet.balance,
      pixLimit: { ...daily, used: daily.used + amount, remaining: daily.remaining - amount }
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function getTransactions(userId = null, filter = 'all', limit = 50) {
  let query = `
    SELECT 
      t.id, t.code, t.type, t.amount, t.note, t.created_at,
      t.from_user_id, u_from.name as from_name, u_from.username as from_username,
      t.to_user_id, u_to.name as to_name, u_to.username as to_username
    FROM transactions t
    LEFT JOIN users u_from ON t.from_user_id = u_from.id
    LEFT JOIN users u_to ON t.to_user_id = u_to.id
  `;

  const params = [];

  if (userId) {
    if (filter === 'in') {
      query += ` WHERE t.to_user_id = ? AND (t.from_user_id != ? OR t.from_user_id IS NULL)`;
      params.push(userId, userId);
    } else if (filter === 'out') {
      query += ` WHERE t.from_user_id = ?`;
      params.push(userId);
    } else {
      query += ` WHERE t.to_user_id = ? OR t.from_user_id = ?`;
      params.push(userId, userId);
    }
  }

  query += ` ORDER BY t.created_at DESC LIMIT ?`;
  params.push(limit);

  return (await db.prepare(query).all(...params));
}

/* ========================================================
   Attendance & Streaks
   ======================================================== */
async function getAttendanceForDate(date, classId = null) {
  validateDate(date);
  let query = `
    SELECT COALESCE(a.date, ?) AS date, u.id AS user_id, a.status, COALESCE(a.note, '') AS note, u.name, u.username, u.mascot, u.class_id, c.name as class_name
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.role = 'aluno' AND u.is_active = 1
  `;
  const params = [date, date];
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  query += ` ORDER BY u.name ASC`;
  return (await db.prepare(query).all(...params));
}

async function calculateStreaks(userId) {
  const records = (await db.prepare(`
    SELECT date, status FROM attendance
    WHERE user_id = ?
    ORDER BY date ASC
  `).all(userId));

  let currentStreak = 0;
  let bestStreak = 0;
  let running = 0;

  for (const r of records) {
    if (r.status === 'p') {
      running++;
      if (running > bestStreak) bestStreak = running;
    } else {
      running = 0;
    }
  }

  currentStreak = running;
  const recent = records.slice(-7).map(r => r.status);

  return {
    current: currentStreak,
    best: bestStreak,
    recent
  };
}

async function setAttendance(tx, date, userId, newStatus, teacherId, rawNote, toggle = false) {
  const now = Date.now();
  const student = await tx.prepare("SELECT id FROM users WHERE id = ? AND role = 'aluno' AND is_active = 1").get(userId);
  if (!student) throw new Error('Aluno ativo não encontrado.');
    const existing = (await tx.prepare('SELECT status FROM attendance WHERE date = ? AND user_id = ?')
      .get(date, userId));

    const oldStatus = existing ? existing.status : null;
    let balanceDelta = 0;
    let finalStatus = null;
    if (!toggle && oldStatus === newStatus) return { userId, status: oldStatus, changed: false };

    if (oldStatus === newStatus) {
      (await tx.prepare('DELETE FROM attendance WHERE date = ? AND user_id = ?').run(date, userId));
      if (oldStatus === 'p') balanceDelta = -3;
    } else {
      (await tx.prepare(`
        INSERT INTO attendance (date, user_id, status, created_at, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, user_id) DO UPDATE SET status = excluded.status, note = excluded.note
      `).run(date, userId, newStatus, now, cleanNote(rawNote)));

      finalStatus = newStatus;
      if (newStatus === 'p' && oldStatus !== 'p') balanceDelta = 3;
      if (newStatus === 'f' && oldStatus === 'p') balanceDelta = -3;
    }

    if (balanceDelta !== 0) {
      const wallet = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId));
      if (!wallet) throw new Error('Carteira do aluno não encontrada.');
      let newBalance = wallet.balance + balanceDelta;
      if (newBalance < 0) newBalance = 0;
      const appliedDelta = newBalance - wallet.balance;

      (await tx.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?').run(newBalance, now, userId));

      const code = generatePixCode();
      const dateFmt = date.split('-').reverse().slice(0, 2).join('/');
      const note = (balanceDelta > 0 ? `Presença em aula (${dateFmt})` : `Estorno de presença (${dateFmt})`) + (cleanNote(rawNote) ? ` — ${cleanNote(rawNote)}` : '');

      (await tx.prepare(`
        INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
        VALUES (?, 'att', ?, ?, ?, ?, ?, ?)
      `).run(code, teacherId, userId, appliedDelta, newBalance, note, now));
    }
    const dateFmt = date.split('-').reverse().join('/');
    await logAudit(teacherId, 'attendance', userId, `Marcação de ${finalStatus === 'p' ? 'Presença (+F$ 3)' : finalStatus === 'f' ? 'Falta' : 'Desmarcado'} em ${dateFmt}. ${cleanNote(rawNote)}`, tx);
    return { date, userId, status: finalStatus, changed: true };
}

async function markAttendance(date, userId, newStatus, teacherId, note = '') {
  validateDate(date);
  if (!['p', 'f'].includes(newStatus)) throw new Error('Status de presença inválido.');
  const tx = await db.transaction();
  let result;
  try {
    result = await setAttendance(tx, date, userId, newStatus, teacherId, note, true);
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
  const student = await getUserById(userId);
  return { ...result, note: cleanNote(note), new_balance: student.balance, streaks: await calculateStreaks(userId) };
}

async function markAllPresent(date, teacherId, note = '') {
  validateDate(date);
  const tx = await db.transaction();
  let affected = 0;
  let students;
  try {
    students = await tx.prepare("SELECT id FROM users WHERE role = 'aluno' AND is_active = 1 ORDER BY id").all();
    for (const student of students) {
      const result = await setAttendance(tx, date, student.id, 'p', teacherId, note);
      if (result.changed) affected++;
    }
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
  return { affected, unchanged: students.length - affected, total: students.length, records: await getAttendanceForDate(date) };
}

/* ========================================================
   Teacher Merit Awards & Admin Balance Adjustments
   ======================================================== */
async function teacherAwardMerit(teacherId, studentId, rawAmount, rawReason) {
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Informe um valor inteiro válido em Fisk Dollars.');
  const reason = cleanNote(rawReason) || 'Mérito em aula de inglês';
  const now = Date.now();

  const student = await getUserById(studentId);
  if (!student || student.role !== 'aluno' || !student.is_active) throw new Error('Aluno ativo não encontrado.');
  const tx = await db.transaction();
  try {
    (await tx.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, studentId));
    const newBal = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(studentId)).balance;

    const code = generatePixCode();
    (await tx.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'mint', ?, ?, ?, ?, ?, ?)
    `).run(code, teacherId, studentId, amount, newBal, `Mérito: ${reason}`, now));

    await tx.commit();

    await logAudit(teacherId, 'merit', studentId, `Premiou F$ ${amount} (${reason})`);
    return { studentId, studentName: student.name, amount, newBalance: newBal };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function adminAdjustBalance(kind, adminId, toUserId, rawAmount, rawNote) {
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount)) throw new Error('Informe um valor inteiro válido.');
  const note = cleanNote(rawNote);
  const now = Date.now();

  const tx = await db.transaction();
  try {
    const targetWallet = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(toUserId));
    if (!targetWallet) throw new Error('Conta de destino não encontrada.');

    let newBalance = targetWallet.balance;
    let delta = 0;

    if (kind === 'mint') {
      if (isNaN(amount) || amount <= 0) throw new Error('Valor inválido para emissão.');
      delta = amount;
      newBalance += amount;
    } else if (kind === 'set') {
      if (isNaN(amount) || amount < 0) throw new Error('Valor inválido para definição de saldo.');
      delta = amount - targetWallet.balance;
      newBalance = amount;
    } else if (kind === 'withdraw') {
      if (isNaN(amount) || amount <= 0) throw new Error('Valor inválido para retirada.');
      if (amount > targetWallet.balance) throw new Error('A retirada excede o saldo da conta.');
      delta = -amount;
      newBalance -= amount;
    } else {
      throw new Error('Operação administrativa inválida.');
    }

    (await tx.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?').run(newBalance, now, toUserId));

    const code = generatePixCode();
    (await tx.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, kind, adminId, toUserId, delta, newBalance, note, now));

    await tx.commit();

    await logAudit(adminId, kind, toUserId, `${kind === 'mint' ? 'Emitiu' : kind === 'set' ? 'Definiu saldo' : 'Retirou'} F$ ${amount}. ${note}`);
    return { toUserId, newBalance, delta };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function adminBulkReward(adminId, rawAmount, rawNote, classId = null) {
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Informe um valor inteiro válido maior que zero.');
  const note = cleanNote(rawNote) || 'Bônus coletivo Fisk';
  const now = Date.now();

  let query = `SELECT id, name FROM users WHERE role = 'aluno' AND is_active = 1`;
  const params = [];
  if (classId) {
    query += ` AND class_id = ?`;
    params.push(classId);
  }

  const students = (await db.prepare(query).all(...params));
  if (students.length === 0) return { affected: 0 };

  const tx = await db.transaction();
  try {
    for (const s of students) {
      (await tx.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, s.id));
      const bal = (await tx.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(s.id)).balance;
      const code = generatePixCode();
      (await tx.prepare(`
        INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
        VALUES (?, 'bulk', ?, ?, ?, ?, ?, ?)
      `).run(code, adminId, s.id, amount, bal, note, now));
    }
    await tx.commit();

    const targetDesc = classId ? `turma ID #${classId}` : 'todos os alunos da escola';
    await logAudit(adminId, 'bulk_reward', null, `Bônus coletivo de F$ ${amount} para ${students.length} alunos (${targetDesc}). Motivo: ${note}`);
    return { affected: students.length, amount };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function getLeaderboard(classId = null) {
  let query = `
    SELECT u.id, u.username, u.name, u.active_frame, u.mascot, u.class_id, c.name as class_name, COALESCE(w.balance, 0) as balance
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.role = 'aluno' AND u.is_active = 1
  `;
  const params = [];
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  query += ` ORDER BY balance DESC, u.name ASC`;
  const students = (await db.prepare(query).all(...params));

  return Promise.all(students.map(async s => {
    const sInfo = await calculateStreaks(s.id);
    return {
      ...s,
      streak: sInfo.current,
      best_streak: sInfo.best
    };
  }));
}

async function getSystemStats() {
  const totalInCirculation = (await db.prepare('SELECT SUM(balance) as total FROM wallets').get()).total || 0;
  const totalUsers = (await db.prepare('SELECT COUNT(*) as count FROM users WHERE role = \'aluno\'').get()).count;
  const totalTeachers = (await db.prepare('SELECT COUNT(*) as count FROM users WHERE role = \'teacher\'').get()).count;
  const totalTransactions = (await db.prepare('SELECT COUNT(*) as count FROM transactions').get()).count;
  const totalClasses = (await db.prepare('SELECT COUNT(*) as count FROM classes').get()).count;

  return {
    totalInCirculation,
    totalUsers,
    totalTeachers,
    totalTransactions,
    totalClasses
  };
}

/* ========================================================
   Fisk Store & Profile Frames
   ======================================================== */
async function getStoreItems(userId) {
  const items = (await db.prepare(`SELECT * FROM store_items WHERE category IN ('frame', 'theme') ORDER BY price ASC`).all());
  const inventory = (await db.prepare(`SELECT item_id FROM user_inventory WHERE user_id = ?`).all(userId)).map(i => i.item_id);
  const user = await getUserById(userId);

  return items.map(it => ({
    ...it,
    owned: inventory.includes(it.id),
    equipped: Boolean(user && (it.category === 'theme' ? user.active_theme === it.id : user.active_frame === it.id))
  }));
}

async function buyStoreItem(userId, itemId, rawNote = '') {
  const now = Date.now();
  const tx = await db.transaction();
  try {
    const item = (await tx.prepare(`SELECT * FROM store_items WHERE id = ?`).get(itemId));
    if (!item || !['frame', 'theme'].includes(item.category)) throw new Error('Item não encontrado na loja.');
    const buyer = await tx.prepare("SELECT id FROM users WHERE id = ? AND role = 'aluno' AND is_active = 1").get(userId);
    if (!buyer) throw new Error('A loja está disponível para alunos ativos.');

    const wallet = (await tx.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).get(userId));
    if (!wallet || wallet.balance < item.price) {
      throw new Error(`Saldo insuficiente! Você tem F$ ${wallet?.balance || 0}, mas o item custa F$ ${item.price}.`);
    }

    const alreadyOwned = (await tx.prepare(`SELECT 1 FROM user_inventory WHERE user_id = ? AND item_id = ?`).get(userId, itemId));
    if (alreadyOwned) {
      throw new Error('Você já possui este item em seu inventário.');
    }

    // Deduct balance
    (await tx.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ?`).run(item.price, now, userId));

    // Add to inventory
    (await tx.prepare(`INSERT INTO user_inventory (user_id, item_id, purchased_at) VALUES (?, ?, ?)`).run(userId, itemId, now));

    // Auto-equip
    const field = item.category === 'theme' ? 'active_theme' : 'active_frame';
    (await tx.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(item.id, userId));

    const newBalance = wallet.balance - item.price;
    const code = generatePixCode();

    (await tx.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'withdraw', ?, ?, ?, ?, ?, ?)
    `).run(code, userId, userId, -item.price, newBalance, `Loja: ${item.name}${cleanNote(rawNote) ? ` — ${cleanNote(rawNote)}` : ''}`, now));

    await tx.commit();

    return {
      success: true,
      item,
      newBalance,
      equipped: true,
      [field]: item.id
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function equipFrame(userId, frameId, note = '') {
  if (frameId !== 'none') {
    const owned = (await db.prepare(`
      SELECT 1 FROM user_inventory ui
      JOIN store_items si ON ui.item_id = si.id
      WHERE ui.user_id = ? AND si.frame_css = ? AND si.category = 'frame'
    `).get(userId, frameId));
    if (!owned) throw new Error('Você não possui esta moldura.');
  }

  (await db.prepare(`UPDATE users SET active_frame = ? WHERE id = ?`).run(frameId, userId));
  if (cleanNote(note)) await logAudit(userId, 'equip_frame', userId, `Equipou ${frameId}. ${cleanNote(note)}`);
  return { success: true, active_frame: frameId };
}

async function equipTheme(userId, themeId, note = '') {
  if (themeId !== 'default') {
    const owned = await db.prepare(`SELECT 1 FROM user_inventory ui JOIN store_items si ON ui.item_id = si.id
      WHERE ui.user_id = ? AND si.id = ? AND si.category = 'theme'`).get(userId, themeId);
    if (!owned) throw new Error('Você não possui este tema.');
  }
  await db.prepare('UPDATE users SET active_theme = ? WHERE id = ?').run(themeId, userId);
  if (cleanNote(note)) await logAudit(userId, 'equip_theme', userId, `Equipou ${themeId}. ${cleanNote(note)}`);
  return { success: true, active_theme: themeId };
}

/* ========================================================
   CSV / Excel Export Helpers
   ======================================================== */
function reportRange(rawFrom, rawTo) {
  const to = validateDate(rawTo || localDate());
  const from = validateDate(rawFrom || new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10));
  if (from > to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 365) throw new Error('Selecione um período de até 366 dias.');
  return { from, to, start: zonedMidnight(from), end: zonedMidnight(nextDate(to)) };
}

async function reportRows(range) {
  const transactions = await db.prepare(`SELECT t.*, uf.name AS from_name, uf.username AS from_username,
    ut.name AS to_name, ut.username AS to_username FROM transactions t
    LEFT JOIN users uf ON uf.id = t.from_user_id LEFT JOIN users ut ON ut.id = t.to_user_id
    WHERE t.created_at >= ? AND t.created_at < ? ORDER BY t.created_at DESC, t.id DESC`).all(range.start, range.end);
  const attendance = await db.prepare(`SELECT a.*, u.name, u.username FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.date >= ? AND a.date <= ? ORDER BY a.date DESC, u.name`).all(range.from, range.to);
  return { transactions, attendance };
}

async function getReports(rawFrom, rawTo) {
  const range = reportRange(rawFrom, rawTo);
  const { transactions, attendance } = await reportRows(range);
  const users = await getAllUsers(null, null, true);
  const students = users.filter(u => u.role === 'aluno').map(u => ({
    id: u.id, name: u.name, username: u.username, is_active: u.is_active, balance: u.balance,
    present: 0, absent: 0, attendanceRate: 0, rewards: 0, pixSent: 0, pixReceived: 0, spent: 0
  }));
  const studentById = new Map(students.map(s => [s.id, s]));
  const days = new Map();
  for (let date = range.from; date <= range.to; date = nextDate(date)) {
    days.set(date, { date, transactions: 0, pixVolume: 0, rewards: 0, withdrawals: 0, present: 0, absent: 0 });
  }
  const typeMap = new Map();
  const summary = {
    totalTransactions: transactions.length, pixVolume: 0, rewards: 0, withdrawals: 0, netIssued: 0,
    totalInCirculation: users.reduce((total, u) => total + Number(u.balance || 0), 0),
    activeStudents: students.filter(s => s.is_active).length,
    activeTeachers: users.filter(u => u.role === 'teacher' && u.is_active).length,
    present: 0, absent: 0, attendanceRate: 0
  };
  for (const tx of transactions) {
    const day = days.get(localDate(tx.created_at));
    if (day) day.transactions++;
    if (!typeMap.has(tx.type)) typeMap.set(tx.type, { type: tx.type, count: 0, total: 0 });
    const type = typeMap.get(tx.type);
    type.count++;
    type.total += tx.amount;
    const sender = studentById.get(tx.from_user_id);
    const recipient = studentById.get(tx.to_user_id);
    if (tx.type === 'pix') {
      summary.pixVolume += tx.amount;
      if (day) day.pixVolume += tx.amount;
      if (sender) sender.pixSent += tx.amount;
      if (recipient) recipient.pixReceived += tx.amount;
    } else {
      summary.netIssued += tx.amount;
      if (tx.amount > 0) {
        summary.rewards += tx.amount;
        if (day) day.rewards += tx.amount;
        if (recipient) recipient.rewards += tx.amount;
      } else {
        summary.withdrawals += -tx.amount;
        if (day) day.withdrawals += -tx.amount;
        if (recipient && tx.from_user_id === tx.to_user_id) recipient.spent += -tx.amount;
      }
    }
  }
  for (const row of attendance) {
    const field = row.status === 'p' ? 'present' : 'absent';
    summary[field]++;
    const day = days.get(row.date);
    if (day) day[field]++;
    const student = studentById.get(row.user_id);
    if (student) student[field]++;
  }
  const attendanceRate = record => record.present + record.absent ? Math.round(1000 * record.present / (record.present + record.absent)) / 10 : 0;
  summary.attendanceRate = attendanceRate(summary);
  students.forEach(student => { student.attendanceRate = attendanceRate(student); });
  return {
    from: range.from, to: range.to, timezone: SAO_PAULO, summary,
    byDay: [...days.values()], byType: [...typeMap.values()], students,
    transactions: transactions.slice(0, 500), transactionCount: transactions.length, truncated: transactions.length > 500
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvDocument(headers, rows) {
  return '\uFEFF' + [headers, ...rows].map(row => row.map(value => typeof value === 'number' ? String(value) : csvCell(value)).join(';')).join('\r\n') + '\r\n';
}

async function exportAttendanceCSV(rawFrom, rawTo) {
  const { attendance } = await reportRows(reportRange(rawFrom, rawTo));
  return csvDocument(['Data', 'Nome do Aluno', 'Usuário', 'Status da Chamada', 'Descrição'], attendance.map(row => [
    row.date.split('-').reverse().join('/'), row.name, row.username, row.status === 'p' ? 'Presente' : 'Falta', row.note
  ]));
}

async function exportTransactionsCSV(rawFrom, rawTo) {
  const { transactions } = await reportRows(reportRange(rawFrom, rawTo));
  return csvDocument(['Código', 'Data e Hora', 'Tipo', 'Origem', 'Destino', 'Valor (F$)', 'Saldo Após', 'Descrição'], transactions.map(row => [
    row.code, new Date(row.created_at).toLocaleString('pt-BR', { timeZone: SAO_PAULO }), row.type,
    row.from_name || 'Sistema Fisk', row.to_name, row.amount, row.balance_after, row.note
  ]));
}

module.exports = {
  initialize,
  db,
  getAllClasses,
  createClass,
  updateClassTeacher,
  assignStudentClass,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  updatePassword,
  updateProfile,
  editUser,
  resetUserPassword,
  cleanNote,
  localDate,
  validateDate,
  getPixLimit,
  checkLoginLock,
  recordLoginFailure,
  clearLoginFailures,
  transferPix,
  getTransactions,
  getAttendanceForDate,
  calculateStreaks,
  markAttendance,
  markAllPresent,
  teacherAwardMerit,
  adminAdjustBalance,
  adminBulkReward,
  getLeaderboard,
  getSystemStats,
  getStoreItems,
  buyStoreItem,
  equipFrame,
  equipTheme,
  getReports,
  exportAttendanceCSV,
  exportTransactionsCSV,
  logAudit,
  getAuditLogs
};
