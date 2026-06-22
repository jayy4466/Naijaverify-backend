// server.js
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { initSchema } = require('./src/db/schema');
const app = require('./src/app');

initSchema()
  .then(() => {
    app.listen(env.PORT, () => {
      logger.info(`NaijaVerify backend running on port ${env.PORT}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, 'Failed to set up database schema');
    process.exit(1);
  });
