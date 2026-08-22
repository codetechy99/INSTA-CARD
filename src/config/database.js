const { Sequelize } = require('sequelize');
const config = require('./config');

const sequelize = new Sequelize(
  config.db.name, config.db.user, config.db.pass,
  {
    host: config.db.host, port: config.db.port, dialect: 'postgres',
    logging: config.nodeEnv === 'development' ? console.log : false,
    pool: { max: 20, min: 5, acquire: 30000, idle: 10000 },
    define: { timestamps: true, underscored: true },
  }
);

module.exports = sequelize;
