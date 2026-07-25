const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createLogger } = require('./logger');

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-logger-test-'));
}

function readLogLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

async function waitForLines(dir, timeoutMs = 2000) {
  const start = Date.now();
  let lines = readLogLines(dir);
  while (lines.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    lines = readLogLines(dir);
  }
  return lines;
}

test('writes structured JSON lines to the configured directory', async () => {
  const dir = tmpLogDir();
  const logger = createLogger({ dir, level: 'info', console: false });

  logger.info('test_event', { foo: 1 });

  const lines = await waitForLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'test_event');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].foo, 1);
  assert.ok(lines[0].timestamp);
});

test('LOG_LEVEL filtering: a debug call is dropped when level is info', async () => {
  const dir = tmpLogDir();
  const logger = createLogger({ dir, level: 'info', console: false });

  logger.debug('debug_event', {});
  logger.info('info_event', {});

  const lines = await waitForLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'info_event');
});
