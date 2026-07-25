const path = require('node:path');

const DB_PATH = process.env.DIGEST_DB_PATH || path.join(__dirname, '..', 'data', 'digest.sqlite');
const PORT = Number(process.env.PORT) || 3000;

module.exports = { DB_PATH, PORT };
