const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// This suite always creates a separate database; it never reads project .env values.
const directory = mkdtempSync(join(tmpdir(), 'fisk-pay-regression-'));
process.env.TURSO_DATABASE_URL = `file:${join(directory, 'isolated.sqlite')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.FISK_USE_NATIVE_SQLITE = '1';
process.env.JWT_SECRET = 'isolated-regression-test-secret-2026';
process.env.COORDENACAO_PASSWORD = 'Isolated2026!';
const db = require('../src/db');

test('Fisk Pay: timezone boundaries, additive migrations, account history and store persistence', async t => {
  await db.initialize();
  const coord = await db.getUserByUsername('coordenacao');
  const student = await db.createUser('aluno.test', 'Aluno Teste', 'aluno', 'Isolated2026!');
  const recipient = await db.createUser('outro.test', 'Outro Aluno', 'aluno', 'Isolated2026!');

  await t.test('local day includes 23:59 and excludes midnight of the following day', async () => {
    const write = db.db.prepare(`INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, note, created_at)
      VALUES (?, 'pix', ?, ?, ?, 'Boundary test', ?)`);
    await write.run('BOUNDARY-BEFORE', student.id, recipient.id, 9000, Date.parse('2026-10-18T02:59:59.999Z'));
    await write.run('BOUNDARY-AFTER', student.id, recipient.id, 200, Date.parse('2026-10-18T03:00:00.000Z'));
    const before = await db.getPixLimit(student.id, db.db, Date.parse('2026-10-18T02:59:59.999Z'));
    const after = await db.getPixLimit(student.id, db.db, Date.parse('2026-10-18T03:00:00.000Z'));
    assert.equal(before.date, '2026-10-17');
    assert.equal(before.used, 9000);
    assert.equal(after.date, '2026-10-18');
    assert.equal(after.used, 200);
    const report = await db.getReports('2026-10-17', '2026-10-17');
    assert.equal(report.summary.pixVolume, 9000);
    assert.equal(report.transactions.length, 1);
  });

  await t.test('historical daylight saving transition uses the actual first local instant', async () => {
    await db.db.prepare(`INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, created_at)
      VALUES ('DST-BEFORE', 'pix', ?, ?, 123, ?)`).run(student.id, recipient.id, Date.parse('2018-11-04T02:59:59.999Z'));
    await db.db.prepare(`INSERT INTO transactions (code, type, from_user_id, to_user_id, amount, created_at)
      VALUES ('DST-AFTER', 'pix', ?, ?, 456, ?)`).run(student.id, recipient.id, Date.parse('2018-11-04T03:00:00.000Z'));
    const limit = await db.getPixLimit(student.id, db.db, Date.parse('2018-11-04T03:00:00.000Z'));
    assert.equal(limit.date, '2018-11-04');
    assert.equal(limit.used, 456);
  });

  await t.test('repeated startup preserves themes, balances, inventory and renamed coordinator', async () => {
    await db.adminAdjustBalance('set', coord.id, student.id, 500, 'Saldo isolado');
    await db.buyStoreItem(student.id, 'theme-midnight', 'Tema escolhido');
    await db.editUser(coord.id, coord.id, { username: 'coord.nova' });
    const before = await db.getUserById(student.id);
    await db.initialize();
    const after = await db.getUserById(student.id);
    assert.equal(after.balance, before.balance);
    assert.equal(after.active_theme, 'theme-midnight');
    assert.equal(await db.getUserByUsername('coordenacao'), undefined);
    assert.equal((await db.getUserByUsername('coord.nova')).id, coord.id);
    const items = await db.getStoreItems(student.id);
    assert.ok(items.find(item => item.id === 'theme-midnight').owned);
    const maxFrame = Math.max(...items.filter(item => item.category === 'frame').map(item => item.price));
    assert.ok(items.filter(item => item.category === 'theme').every(item => item.price > maxFrame));
  });

  await t.test('deactivation keeps historical records and reactivation restores access data', async () => {
    const before = await db.getTransactions(student.id);
    await db.editUser(coord.id, student.id, { active: false, note: 'Pausa temporária' });
    assert.equal((await db.getAllUsers(null, 'aluno')).some(user => user.id === student.id), false);
    assert.equal((await db.getTransactions(student.id)).length, before.length);
    await db.editUser(coord.id, student.id, { active: true });
    assert.equal((await db.getUserById(student.id)).active_theme, 'theme-midnight');
  });

  await t.test('a repeated bulk attendance request neither toggles nor pays twice', async () => {
    const first = await db.markAllPresent('2026-10-17', coord.id, 'Aula de conversação');
    const balance = (await db.getUserById(student.id)).balance;
    const second = await db.markAllPresent('2026-10-17', coord.id, 'Aula de conversação');
    assert.equal(first.affected, 2);
    assert.equal(second.affected, 0);
    assert.equal((await db.getUserById(student.id)).balance, balance);
    assert.equal(second.records.find(row => row.user_id === student.id).note, 'Aula de conversação');
  });

  await t.test('legacy role migration preserves wallets, attendance, inventory and audit history', async () => {
    const tables = ['users', 'wallets', 'transactions', 'attendance', 'user_inventory', 'audit_logs'];
    const snapshots = {};
    for (const table of tables) snapshots[table] = await db.db.prepare(`SELECT * FROM ${table}`).all();
    const schema = (await db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get()).sql;
    const constrained = schema.replace(/^CREATE TABLE ["`]?users["`]?/i, 'CREATE TABLE users_legacy_fixture')
      .replace('role TEXT NOT NULL', "role TEXT NOT NULL CHECK(role IN ('aluno','teacher','coordenacao','admin'))");
    await db.db.migrate([
      constrained,
      'INSERT INTO users_legacy_fixture SELECT * FROM users',
      'DROP TABLE users',
      'ALTER TABLE users_legacy_fixture RENAME TO users',
      'CREATE INDEX idx_legacy_username ON users(username)'
    ]);
    await db.initialize();
    for (const table of tables) assert.deepEqual(await db.db.prepare(`SELECT * FROM ${table}`).all(), snapshots[table], `${table} must survive migration`);
    assert.deepEqual(await db.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(await db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_legacy_username'").get());
    assert.equal((await db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get()).sql.includes('CHECK'), false);
  });
});
