require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { sequelize } = require('./models');
const config = require('./config/config');

// Routes
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');

const app = express();

// Security
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));

// Webhooks need raw body for signature verification
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    console.log(`${req.method} ${req.path} | ${req.ip}`);
  }
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'InstaCard API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start
async function start() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    if (config.nodeEnv === 'production') {
      // Never auto-alter a production schema — run `npm run db:migrate` on deploys
      await sequelize.sync();
      console.warn('Production: schema synced (no alter). Run `npm run db:migrate` on schema changes.');
    } else {
      await sequelize.sync({ alter: true });
    }
    console.log('Database synced');

    // Seed default fee configs
    const FeeEngine = require('./services/feeEngine');
    await FeeEngine.seedDefaults();
    console.log('Fee configs seeded');

    // Initialize providers
    const { providers } = require('./providers/registry');
    console.log('Providers initialized:', Object.keys(providers).join(', '));

    app.listen(config.port, () => {
      console.log(`InstaCard API running on port ${config.port}`);
      console.log(`Health: http://localhost:${config.port}/api/health`);
    });

    // Poll providers for transactions whose webhooks never arrived
    const ReconciliationJob = require('./services/reconciliationJob');
    ReconciliationJob.start();
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
