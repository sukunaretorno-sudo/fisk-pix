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
    let transactionTail = Promise.resolve();
    async function acquire() {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise(resolve => { release = resolve; });
      await previous;
      return release;
    }
    function nativeDb(inTransaction = false) {
      return {
        prepare(sql) {
          const execute = async (method, args) => {
            const release = inTransaction ? null : await acquire();
            try { return sqlite.prepare(sql)[method](...args); }
            finally { release?.(); }
          };
          return {
            get: async (...args) => execute('get', args),
            all: async (...args) => execute('all', args),
            run: async (...args) => execute('run', args),
          };
        },
        exec: async sql => {
          const release = inTransaction ? null : await acquire();
          try { return sqlite.exec(sql); }
          finally { release?.(); }
        },
        async migrate(statements) {
          if (inTransaction) throw new Error('Migração não pode iniciar dentro de outra transação.');
          const release = await acquire();
          try {
            sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
            for (const sql of statements) sqlite.exec(sql);
            sqlite.exec('COMMIT;');
          } catch (err) {
            try { sqlite.exec('ROLLBACK;'); } catch {}
            throw err;
          } finally {
            sqlite.exec('PRAGMA foreign_keys = ON;');
            release();
          }
        },
        async transaction() {
          if (inTransaction) throw new Error('Transações aninhadas não são suportadas.');
          const release = await acquire();
          try { sqlite.exec('BEGIN IMMEDIATE;'); }
          catch (err) { release(); throw err; }
          let done = false;
          return {
            ...nativeDb(true),
            async commit() {
              if (!done) {
                try { sqlite.exec('COMMIT;'); }
                catch (err) { sqlite.exec('ROLLBACK;'); throw err; }
                finally { done = true; release(); }
              }
            },
            async rollback() {
              if (!done) { try { sqlite.exec('ROLLBACK;'); } finally { done = true; release(); } }
            },
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
    migrate: statements => client.migrate(statements),
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
