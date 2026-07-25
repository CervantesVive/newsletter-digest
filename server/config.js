const path = require('node:path');

const DB_PATH = process.env.DIGEST_DB_PATH || path.join(__dirname, '..', 'data', 'digest.sqlite');
const PORT = Number(process.env.PORT) || 3000;

// LLM provider port: any OpenAI-compatible endpoint (the user points this at a LiteLLM
// gateway) — never hardcode a specific provider/SDK here.
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';

const ENRICHMENT_INTERVAL_MS = Math.max(1000, Number(process.env.ENRICHMENT_INTERVAL_MS) || 30000);
const ENRICHMENT_CONCURRENCY = Math.max(1, Number(process.env.ENRICHMENT_CONCURRENCY) || 3);
const ENRICHMENT_MAX_ATTEMPTS = Math.max(1, Number(process.env.ENRICHMENT_MAX_ATTEMPTS) || 5);

module.exports = {
  DB_PATH,
  PORT,
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
  ENRICHMENT_INTERVAL_MS,
  ENRICHMENT_CONCURRENCY,
  ENRICHMENT_MAX_ATTEMPTS,
};
