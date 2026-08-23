require('dotenv').config();
const { sequelize } = require('../models');

// Applies the schema to the database (creates missing tables/columns only).
// Safe to re-run; does NOT destructive-alter existing columns.
async function migrate() {
  try {
    await sequelize.authenticate();
    console.log('[migrate] database connected');

    await sequelize.sync();
    console.log('[migrate] schema synced');

    process.exit(0);
  } catch (err) {
    console.error('[migrate] failed:', err);
    process.exit(1);
  }
}

migrate();
