/**
 * Turso/libSQL adapter. Async on both local and cloud databases.
 * The file: fallback uses Node's SQLite only for local development/tests.
 * Render must have TURSO_DATABASE_URL and TURSO_AUTH_TOKEN configured.
 */
function createDatabase() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || url.includes('SEU_BANCO')) {
    throw new Error('Configure TURSO_DATABASE_URL no .env (local) ou em Render > Environment (produção).');
  }
  if (!url.startsWith('file:') && (!authToken || authToken.includes('COLE_'))) {
    throw new Error('Configure TURSO_AUTH_TOKEN no .env (local) ou em Render > Environment (produção).');
  }

  // For local/offline tests, no external Turso connection is necessary.
  // In production the official @libsql/client SDK is used.
  if (url.startsWith('file:') && process.env.FISK_USE_NATIVE_SQLITE === '1') {
    const { DatabaseSync } = require('node:sqlite');
    const file = url.substring(5);
    const sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    function nativeDb() {
      return {
        prepare(sql) {
          const statement = sqlite.prepare(sql);
          return {
            get: async (...args) => statement.get(...args),
            all: async (...args) => statement.all(...args),
            run: async (...args) => statement.run(...args),
          };
        },
        exec: async sql => sqlite.exec(sql),
        async transaction() {
          sqlite.exec('BEGIN IMMEDIATE;');
          let done = false;
          return {
            ...nativeDb(),
            async commit() { if (!done) { sqlite.exec('COMMIT;'); done = true; } },
            async rollback() { if (!done) { sqlite.exec('ROLLBACK;'); done = true; } },
          };
        },
      };
    }
    return nativeDb();
  }

  const { createClient } = require('@libsql/client');
  const client = createClient({ url, ...(url.startsWith('file:') ? {} : { authToken }) });

  const fromLibsql = (value) => typeof value === 'bigint' ? Number(value) : value;
  const formatRows = (result) => result.rows.map(row =>
    Object.fromEntries(result.columns.map(col => [col, fromLibsql(row[col])]))
  );
  function wrap(connection) {
    return {
      prepare(sql) {
        const execute = async args => connection.execute({ sql, args: args.map(a => a === undefined ? null : a) });
        return {
          async get(...args) { return formatRows(await execute(args))[0]; },
          async all(...args) { return formatRows(await execute(args)); },
          async run(...args) {
            const result = await execute(args);
            return { lastInsertRowid: result.lastInsertRowid === undefined ? null : fromLibsql(result.lastInsertRowid), changes: result.rowsAffected };
          },
        };
      },
      async exec(sql) { await connection.executeMultiple(sql); },
    };
  }
  return {
    ...wrap(client),
    async transaction() {
      const tx = await client.transaction('write');
      let done = false;
      return {
        ...wrap(tx),
        async commit() { if (!done) { await tx.commit(); done = true; tx.close(); } },
        async rollback() { if (!done) { done = true; await tx.rollback(); tx.close(); } },
      };
    },
  };
}

module.exports = { createDatabase };
