import pg from 'pg';

const { Pool } = pg;

const numbered = sql => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};

export function createPostgresDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });
  const query = (sql, params = [], client = pool) => client.query(numbered(sql), params);
  const prepare = sql => ({
    async get(...params) {
      const result = await query(sql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await query(sql, params);
      return result.rows;
    },
    async run(...params) {
      const result = await query(sql, params);
      return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },
  });
  return {
    prepare,
    async exec(sql) { await pool.query(sql); },
    async transaction(callback) {
      const client = await pool.connect();
      const transactionDb = { prepare: statement => ({
        async get(...params) { const result = await query(statement, params, client); return result.rows[0]; },
        async all(...params) { const result = await query(statement, params, client); return result.rows; },
        async run(...params) { const result = await query(statement, params, client); return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id }; },
      }) };
      try {
        await client.query('BEGIN');
        const result = await callback(transactionDb);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
