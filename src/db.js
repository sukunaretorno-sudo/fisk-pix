const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { hashPassword } = require('./auth');

const DB_PATH = path.join(__dirname, '..', 'database.sqlite');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high performance and concurrency
db.exec('PRAGMA journal_mode = WAL;');

// Initialize tables
db.exec(`
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
`);

// Handle migrations
function applyMigrations() {
  db.exec('PRAGMA foreign_keys = OFF;');

  // Check classes table for teacher_id
  const classCols = db.prepare(`PRAGMA table_info(classes)`).all().map(c => c.name);
  if (!classCols.includes('teacher_id')) {
    db.exec(`ALTER TABLE classes ADD COLUMN teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
  }

  // Remove perks from store_items as requested (store now only has Profile Frames)
  db.exec(`DELETE FROM store_items WHERE category != 'frame';`);

  // Migrate users table to remove strict CHECK constraint on role if present
  try {
    const userSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get().sql;
    if (userSql && userSql.includes(`'admin')`)) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users_temp (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL COLLATE NOCASE,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          class_id INTEGER,
          active_frame TEXT DEFAULT 'none',
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO users_temp (id, username, name, role, password_hash, class_id, active_frame, created_at)
          SELECT id, username, name, role, password_hash, class_id, active_frame, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_temp RENAME TO users;
      `);
    }
  } catch (e) {}

  db.exec('PRAGMA foreign_keys = ON;');
}

applyMigrations();

// Seed initial classes, users, frames, and coordination account
function seed() {
  const now = Date.now();

  // Seed Coordenação user (login: Coordenação or coordenacao, senha: Coordenação26@)
  const coordExists = db.prepare(`SELECT id FROM users WHERE username = 'coordenacao' OR username = 'coordenação'`).get();
  if (!coordExists) {
    console.log('[DB] Criando conta da Coordenação Pedagógica...');
    db.prepare(`
      INSERT INTO users (username, name, role, password_hash, class_id, active_frame, created_at)
      VALUES (?, ?, ?, ?, NULL, 'none', ?)
    `).run('coordenacao', 'Coordenação Pedagógica', 'coordenacao', hashPassword('Coordenação26@'), now);
  }

  // Seed initial classes
  const classCount = db.prepare('SELECT COUNT(*) as c FROM classes').get().c;
  if (classCount === 0) {
    const insertClass = db.prepare('INSERT INTO classes (name, level, teacher_id, created_at) VALUES (?, ?, ?, ?)');
    insertClass.run('Teens 1', 'Intermediário', 2, now); // teacher_id = 2 (teacher)
    insertClass.run('Adults 2', 'Avançado', 2, now);
    insertClass.run('Kids 3', 'Iniciante', 2, now);
  } else {
    // Ensure classes have teacher_id linked to teacher if null
    const teacherUser = db.prepare(`SELECT id FROM users WHERE role = 'teacher'`).get();
    if (teacherUser) {
      db.prepare(`UPDATE classes SET teacher_id = ? WHERE teacher_id IS NULL`).run(teacherUser.id);
    }
  }

  // Seed Store Profile Frames (Only Frames!)
  const storeCount = db.prepare('SELECT COUNT(*) as c FROM store_items').get().c;
  if (storeCount === 0) {
    const insertItem = db.prepare(`
      INSERT INTO store_items (id, name, description, category, price, icon, frame_css, created_at)
      VALUES (?, ?, ?, 'frame', ?, ?, ?, ?)
    `);

    insertItem.run('frame-gold', 'Moldura Dourada VIP', 'Borda dourada reluzente com efeito Shimmer VIP.', 30, '🥇', 'frame-gold', now);
    insertItem.run('frame-fire', 'Moldura On Fire 🔥', 'Chamas pulsantes para os alunos com maior ofensiva de presenças.', 45, '🔥', 'frame-fire', now);
    insertItem.run('frame-neon', 'Moldura Cyber Neon ⚡', 'Brilho neon futurista ciano e magenta.', 50, '⚡', 'frame-neon', now);
    insertItem.run('frame-diamond', 'Moldura Diamante Fisk 💎', 'Prisma de diamante ultra-raro com reflexo cristalino.', 100, '💎', 'frame-diamond', now);
    insertItem.run('frame-stars', 'Moldura Stars & Stripes ⭐', 'Estrelas comemorativas Fisk & bandeira americana.', 35, '⭐', 'frame-stars', now);
    insertItem.run('frame-crown', 'Coroa Real English Master 👑', 'Coroa dourada flutuante para os mestres de conversação.', 75, '👑', 'frame-crown', now);
  }
}

seed();

/* ========================================================
   Audit Logging (Coordenação Tracking)
   ======================================================== */
function logAudit(teacherId, action, targetUserId, details) {
  const teacher = getUserById(teacherId);
  const teacherName = teacher ? teacher.name : `ID #${teacherId}`;
  let targetName = null;
  if (targetUserId) {
    const target = getUserById(targetUserId);
    targetName = target ? target.name : `ID #${targetUserId}`;
  }

  db.prepare(`
    INSERT INTO audit_logs (teacher_id, teacher_name, action, target_user_id, target_name, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(teacherId, teacherName, action, targetUserId || null, targetName || null, details, Date.now());
}

function getAuditLogs(limit = 100) {
  return db.prepare(`
    SELECT a.*, u.username as teacher_username, t.username as target_username
    FROM audit_logs a
    LEFT JOIN users u ON a.teacher_id = u.id
    LEFT JOIN users t ON a.target_user_id = t.id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
}

/* ========================================================
   Classes Operations
   ======================================================== */
function getAllClasses(teacherId = null) {
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
  return db.prepare(query).all(...params);
}

function createClass(name, level, teacherId = null) {
  const now = Date.now();
  const res = db.prepare(`INSERT INTO classes (name, level, teacher_id, created_at) VALUES (?, ?, ?, ?)`).run(name.trim(), level ? level.trim() : '', teacherId || null, now);
  return { id: res.lastInsertRowid, name, level, teacherId };
}

function updateClassTeacher(classId, teacherId) {
  return db.prepare(`UPDATE classes SET teacher_id = ? WHERE id = ?`).run(teacherId || null, classId);
}

function assignStudentClass(userId, classId) {
  return db.prepare(`UPDATE users SET class_id = ? WHERE id = ?`).run(classId || null, userId);
}

/* ========================================================
   User & Auth Operations
   ======================================================== */
function normalizeUsername(u) {
  if (!u) return '';
  return u.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function getUserByUsername(username) {
  const raw = String(username).trim();
  const clean = normalizeUsername(raw);

  return db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.password_hash, u.class_id, u.active_frame, u.created_at, w.balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.username = ? OR u.username = ?
  `).get(raw, clean);
}

function getUserById(id) {
  return db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.class_id, u.active_frame, u.created_at, w.balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.id = ?
  `).get(id);
}

function getAllUsers(classId = null, role = null) {
  let query = `
    SELECT u.id, u.username, u.name, u.role, u.class_id, u.active_frame, u.created_at, 
           COALESCE(w.balance, 0) as balance, c.name as class_name
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  if (role) {
    query += ` AND u.role = ?`;
    params.push(role);
  }
  query += ` ORDER BY u.name ASC`;
  return db.prepare(query).all(...params);
}

function createUser(username, name, role, password, classId = null) {
  const now = Date.now();
  db.exec('BEGIN TRANSACTION;');
  try {
    const cleanUsername = normalizeUsername(username);
    const res = db.prepare(`
      INSERT INTO users (username, name, role, password_hash, class_id, active_frame, created_at)
      VALUES (?, ?, ?, ?, ?, 'none', ?)
    `).run(cleanUsername, name.trim(), role, hashPassword(password), classId || null, now);

    const userId = res.lastInsertRowid;

    // Wallets are only for students (aluno) or admin
    if (role === 'aluno' || role === 'admin') {
      db.prepare(`
        INSERT INTO wallets (user_id, balance, updated_at)
        VALUES (?, 0, ?)
      `).run(userId, now);
    }

    db.exec('COMMIT;');
    return getUserById(userId);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function updatePassword(userId, newPassword) {
  return db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), userId);
}

/* ========================================================
   Login Security / Brute Force Protection
   ======================================================== */
function checkLoginLock(username) {
  const clean = normalizeUsername(username);
  const row = db.prepare('SELECT attempts, locked_until FROM login_security WHERE username = ?').get(clean);
  if (!row) return { locked: false };
  const now = Date.now();
  if (row.locked_until > now) {
    const remainingSeconds = Math.ceil((row.locked_until - now) / 1000);
    return { locked: true, remainingSeconds };
  }
  return { locked: false };
}

function recordLoginFailure(username) {
  const clean = normalizeUsername(username);
  const now = Date.now();
  const row = db.prepare('SELECT attempts FROM login_security WHERE username = ?').get(clean);
  const attempts = (row ? row.attempts : 0) + 1;
  let lockedUntil = 0;
  if (attempts >= 5) {
    lockedUntil = now + 5 * 60 * 1000;
  }
  db.prepare(`
    INSERT INTO login_security (username, attempts, locked_until)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET attempts = ?, locked_until = ?
  `).run(clean, attempts, lockedUntil, attempts, lockedUntil);
}

function clearLoginFailures(username) {
  db.prepare('DELETE FROM login_security WHERE username = ?').run(normalizeUsername(username));
}

/* ========================================================
   Pix Transfer & Transactions (Strictly Students/Admin)
   ======================================================== */
function generatePixCode() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `P${t}${r}`;
}

function transferPix(fromUserId, toUserId, rawAmount, rawNote) {
  const amount = Math.floor(Number(rawAmount));
  if (isNaN(amount) || amount <= 0) {
    throw new Error('O valor do Pix deve ser um número inteiro positivo.');
  }

  if (fromUserId === toUserId) {
    throw new Error('Você não pode enviar um Pix para si mesmo.');
  }

  const sender = getUserById(fromUserId);
  const recipient = getUserById(toUserId);

  if (!sender || !recipient) {
    throw new Error('Conta de remetente ou destinatário não encontrada.');
  }

  // Teachers and coordination DO NOT participate in student peer-to-peer pix!
  if (sender.role === 'teacher' || sender.role === 'coordenacao') {
    throw new Error('Professores e Coordenação realizam apenas premiações pedagógicas através do Painel.');
  }
  if (recipient.role === 'teacher' || recipient.role === 'coordenacao') {
    throw new Error('Contas de professores e coordenação não recebem transferências Pix.');
  }

  const note = rawNote ? String(rawNote).trim().slice(0, 100) : '';
  const now = Date.now();
  const code = generatePixCode();

  db.exec('BEGIN TRANSACTION;');
  try {
    const senderWallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(fromUserId);
    if (!senderWallet || senderWallet.balance < amount) {
      throw new Error('Saldo insuficiente para realizar esta transferência.');
    }

    db.prepare('UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ?').run(amount, now, fromUserId);
    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, toUserId);

    const newSenderWallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(fromUserId);

    db.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'pix', ?, ?, ?, ?, ?, ?)
    `).run(code, fromUserId, toUserId, amount, newSenderWallet.balance, note, now);

    db.exec('COMMIT;');

    return {
      code,
      from: { id: fromUserId, name: sender.name },
      to: { id: toUserId, name: recipient.name },
      amount,
      note,
      created_at: now,
      new_balance: newSenderWallet.balance
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getTransactions(userId = null, filter = 'all', limit = 50) {
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

  return db.prepare(query).all(...params);
}

/* ========================================================
   Attendance & Streaks
   ======================================================== */
function getAttendanceForDate(date, classId = null) {
  let query = `
    SELECT a.date, a.user_id, a.status, u.name, u.username, u.class_id, c.name as class_name
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.role = 'aluno'
  `;
  const params = [date];
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  query += ` ORDER BY u.name ASC`;
  return db.prepare(query).all(...params);
}

function calculateStreaks(userId) {
  const records = db.prepare(`
    SELECT date, status FROM attendance
    WHERE user_id = ?
    ORDER BY date ASC
  `).all(userId);

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

function markAttendance(date, userId, newStatus, teacherId) {
  const now = Date.now();
  db.exec('BEGIN TRANSACTION;');
  try {
    const existing = db.prepare('SELECT status FROM attendance WHERE date = ? AND user_id = ?')
      .get(date, userId);

    const oldStatus = existing ? existing.status : null;
    let balanceDelta = 0;
    let finalStatus = null;

    if (oldStatus === newStatus) {
      db.prepare('DELETE FROM attendance WHERE date = ? AND user_id = ?').run(date, userId);
      if (oldStatus === 'p') balanceDelta = -3;
    } else {
      db.prepare(`
        INSERT INTO attendance (date, user_id, status, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date, user_id) DO UPDATE SET status = ?
      `).run(date, userId, newStatus, now, newStatus);

      finalStatus = newStatus;
      if (newStatus === 'p' && oldStatus !== 'p') balanceDelta = 3;
      if (newStatus === 'f' && oldStatus === 'p') balanceDelta = -3;
    }

    if (balanceDelta !== 0) {
      const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
      let newBalance = wallet.balance + balanceDelta;
      if (newBalance < 0) newBalance = 0;

      db.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?').run(newBalance, now, userId);

      const code = generatePixCode();
      const dateFmt = date.split('-').reverse().slice(0, 2).join('/');
      const note = balanceDelta > 0 ? `Presença em aula (${dateFmt})` : `Estorno de presença (${dateFmt})`;

      db.prepare(`
        INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
        VALUES (?, 'att', ?, ?, ?, ?, ?, ?)
      `).run(code, teacherId, userId, balanceDelta, newBalance, note, now);
    }

    db.exec('COMMIT;');

    const student = getUserById(userId);
    const streaks = calculateStreaks(userId);

    // Audit log
    const dateFmt = date.split('-').reverse().join('/');
    logAudit(teacherId, 'attendance', userId, `Marcação de ${finalStatus === 'p' ? 'Presença (+F$ 3)' : finalStatus === 'f' ? 'Falta' : 'Desmarcado'} em ${dateFmt}`);

    return {
      date,
      userId,
      status: finalStatus,
      new_balance: student.balance,
      streaks
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/* ========================================================
   Teacher Merit Awards & Admin Balance Adjustments
   ======================================================== */
function teacherAwardMerit(teacherId, studentId, rawAmount, rawReason) {
  const amount = Math.floor(Number(rawAmount));
  if (isNaN(amount) || amount <= 0) throw new Error('Informe um valor válido em Fisk Dollars.');
  const reason = rawReason ? String(rawReason).trim().slice(0, 100) : 'Mérito em aula de inglês';
  const now = Date.now();

  db.exec('BEGIN TRANSACTION;');
  try {
    const student = getUserById(studentId);
    if (!student || student.role !== 'aluno') throw new Error('Aluno não encontrado.');

    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, studentId);
    const newBal = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(studentId).balance;

    const code = generatePixCode();
    db.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'mint', ?, ?, ?, ?, ?, ?)
    `).run(code, teacherId, studentId, amount, newBal, `Mérito: ${reason}`, now);

    db.exec('COMMIT;');

    logAudit(teacherId, 'merit', studentId, `Premiou F$ ${amount} (${reason})`);
    return { studentId, studentName: student.name, amount, newBalance: newBal };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function adminAdjustBalance(kind, adminId, toUserId, rawAmount, rawNote) {
  const amount = Math.floor(Number(rawAmount));
  const note = rawNote ? String(rawNote).trim().slice(0, 100) : '';
  const now = Date.now();

  db.exec('BEGIN TRANSACTION;');
  try {
    const targetWallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(toUserId);
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

    db.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?').run(newBalance, now, toUserId);

    const code = generatePixCode();
    db.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, kind, adminId, toUserId, delta, newBalance, note, now);

    db.exec('COMMIT;');

    logAudit(adminId, kind, toUserId, `${kind === 'mint' ? 'Emitiu' : kind === 'set' ? 'Definiu saldo' : 'Retirou'} F$ ${amount}. ${note}`);
    return { toUserId, newBalance, delta };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function adminBulkReward(adminId, rawAmount, rawNote, classId = null) {
  const amount = Math.floor(Number(rawAmount));
  if (isNaN(amount) || amount <= 0) throw new Error('Informe um valor válido maior que zero.');
  const note = rawNote ? String(rawNote).trim().slice(0, 100) : 'Bônus coletivo Fisk';
  const now = Date.now();

  let query = `SELECT id, name FROM users WHERE role = 'aluno'`;
  const params = [];
  if (classId) {
    query += ` AND class_id = ?`;
    params.push(classId);
  }

  const students = db.prepare(query).all(...params);
  if (students.length === 0) return { affected: 0 };

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const s of students) {
      db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, s.id);
      const bal = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(s.id).balance;
      const code = generatePixCode();
      db.prepare(`
        INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
        VALUES (?, 'bulk', ?, ?, ?, ?, ?, ?)
      `).run(code, adminId, s.id, amount, bal, note, now);
    }
    db.exec('COMMIT;');

    const targetDesc = classId ? `turma ID #${classId}` : 'todos os alunos da escola';
    logAudit(adminId, 'bulk_reward', null, `Bônus coletivo de F$ ${amount} para ${students.length} alunos (${targetDesc}). Motivo: ${note}`);
    return { affected: students.length, amount };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getLeaderboard(classId = null) {
  let query = `
    SELECT u.id, u.username, u.name, u.active_frame, u.class_id, c.name as class_name, COALESCE(w.balance, 0) as balance
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN classes c ON u.class_id = c.id
    WHERE u.role = 'aluno'
  `;
  const params = [];
  if (classId) {
    query += ` AND u.class_id = ?`;
    params.push(classId);
  }
  query += ` ORDER BY balance DESC, u.name ASC`;
  const students = db.prepare(query).all(...params);

  return students.map(s => {
    const sInfo = calculateStreaks(s.id);
    return {
      ...s,
      streak: sInfo.current,
      best_streak: sInfo.best
    };
  });
}

function getSystemStats() {
  const totalInCirculation = db.prepare('SELECT SUM(balance) as total FROM wallets').get().total || 0;
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = \'aluno\'').get().count;
  const totalTeachers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = \'teacher\'').get().count;
  const totalTransactions = db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
  const totalClasses = db.prepare('SELECT COUNT(*) as count FROM classes').get().count;

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
function getStoreItems(userId) {
  const items = db.prepare(`SELECT * FROM store_items WHERE category = 'frame' ORDER BY price ASC`).all();
  const inventory = db.prepare(`SELECT item_id FROM user_inventory WHERE user_id = ?`).all(userId).map(i => i.item_id);
  const user = getUserById(userId);

  return items.map(it => ({
    ...it,
    owned: inventory.includes(it.id),
    equipped: user && user.active_frame === it.id
  }));
}

function buyStoreItem(userId, itemId) {
  const now = Date.now();
  db.exec('BEGIN TRANSACTION;');
  try {
    const item = db.prepare(`SELECT * FROM store_items WHERE id = ?`).get(itemId);
    if (!item) throw new Error('Moldura não encontrada na loja.');

    const wallet = db.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).get(userId);
    if (!wallet || wallet.balance < item.price) {
      throw new Error(`Saldo insuficiente! Você tem F$ ${wallet.balance}, mas a moldura custa F$ ${item.price}.`);
    }

    const alreadyOwned = db.prepare(`SELECT 1 FROM user_inventory WHERE user_id = ? AND item_id = ?`).get(userId, itemId);
    if (alreadyOwned) {
      throw new Error('Você já possui esta moldura em seu inventário.');
    }

    // Deduct balance
    db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ?`).run(item.price, now, userId);

    // Add to inventory
    db.prepare(`INSERT INTO user_inventory (user_id, item_id, purchased_at) VALUES (?, ?, ?)`).run(userId, itemId, now);

    // Auto-equip
    db.prepare(`UPDATE users SET active_frame = ? WHERE id = ?`).run(item.frame_css, userId);

    const newBalance = wallet.balance - item.price;
    const code = generatePixCode();

    db.prepare(`
      INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, balance_after, note, created_at)
      VALUES (?, 'withdraw', ?, ?, ?, ?, ?, ?)
    `).run(code, userId, userId, -item.price, newBalance, `Loja: ${item.name}`, now);

    db.exec('COMMIT;');

    return {
      success: true,
      item,
      newBalance,
      equipped: true
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function equipFrame(userId, frameId) {
  if (frameId !== 'none') {
    const owned = db.prepare(`
      SELECT 1 FROM user_inventory ui
      JOIN store_items si ON ui.item_id = si.id
      WHERE ui.user_id = ? AND si.frame_css = ?
    `).get(userId, frameId);
    if (!owned) throw new Error('Você não possui esta moldura.');
  }

  db.prepare(`UPDATE users SET active_frame = ? WHERE id = ?`).run(frameId, userId);
  return { success: true, active_frame: frameId };
}

/* ========================================================
   CSV / Excel Export Helpers
   ======================================================== */
function exportAttendanceCSV(classId = null) {
  let query = `
    SELECT a.date, u.name, u.username, COALESCE(c.name, 'Sem Turma') as class_name, 
           CASE WHEN a.status = 'p' THEN 'Presente (+F$ 3)' WHEN a.status = 'f' THEN 'Falta' ELSE 'Sem Registro' END as status_label
    FROM attendance a
    JOIN users u ON a.user_id = u.id
    LEFT JOIN classes c ON u.class_id = c.id
  `;
  const params = [];
  if (classId) {
    query += ` WHERE u.class_id = ?`;
    params.push(classId);
  }
  query += ` ORDER BY a.date DESC, u.name ASC`;
  const rows = db.prepare(query).all(...params);

  let csv = '\uFEFFData;Nome do Aluno;Usuário;Turma;Status da Chamada\r\n';
  for (const r of rows) {
    const d = r.date.split('-').reverse().join('/');
    csv += `"${d}";"${r.name}";"${r.username}";"${r.class_name}";"${r.status_label}"\r\n`;
  }
  return csv;
}

function exportTransactionsCSV() {
  const query = `
    SELECT t.code, t.created_at, t.type, 
           COALESCE(u_from.name, 'Sistema Fisk') as from_name, 
           u_to.name as to_name, t.amount, t.balance_after, t.note
    FROM transactions t
    LEFT JOIN users u_from ON t.from_user_id = u_from.id
    LEFT JOIN users u_to ON t.to_user_id = u_to.id
    ORDER BY t.created_at DESC
  `;
  const rows = db.prepare(query).all();

  let csv = '\uFEFFCódigo;Data e Hora;Tipo;Origem;Destino;Valor (F$);Saldo Após;Mensagem / Motivo\r\n';
  for (const r of rows) {
    const dt = new Date(r.created_at).toLocaleString('pt-BR');
    csv += `"${r.code}";"${dt}";"${r.type}";"${r.from_name}";"${r.to_name}";${r.amount};${r.balance_after || ''};"${r.note || ''}"\r\n`;
  }
  return csv;
}

module.exports = {
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
  checkLoginLock,
  recordLoginFailure,
  clearLoginFailures,
  transferPix,
  getTransactions,
  getAttendanceForDate,
  calculateStreaks,
  markAttendance,
  teacherAwardMerit,
  adminAdjustBalance,
  adminBulkReward,
  getLeaderboard,
  getSystemStats,
  getStoreItems,
  buyStoreItem,
  equipFrame,
  exportAttendanceCSV,
  exportTransactionsCSV,
  logAudit,
  getAuditLogs
};
