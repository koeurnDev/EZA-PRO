/**
 * EZA PRO - Rotating File Logger & Secret Scrubber
 * Captures runtime diagnostics for warranty/maintenance support without exposing API keys or tokens.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;
const MAX_RING_ENTRIES = 300;

const ringBuffer = [];

/**
 * Resolve a resource path across ASAR packaging boundaries (app.asar -> app.asar.unpacked).
 */
function resolveUnpackedPath(candidatePath) {
  const target = String(candidatePath || '');
  if (!target) return target;
  if (target.includes('app.asar') && !target.includes('app.asar.unpacked')) {
    const unpacked = target.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
  }
  return target;
}

/**
 * Scrub API keys, Bearer tokens, license secrets, and query credentials from log output.
 */
function scrubSensitiveText(input) {
  let text = String(input ?? '');
  if (!text) return '';
  text = text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GEMINI_KEY]');
  text = text.replace(/([?&](?:key|apiKey|token|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  text = text.replace(/("(?:apiKey|geminiApiKey|adminSecret|accessToken|leaseToken|licenseKey|password|secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
  text = text.replace(/\bEZA(?:PRO)?-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,4}\b/g, 'EZA-[REDACTED]');
  return text;
}

/**
 * Determine a writable directory for application logs.
 */
function getLogDir() {
  const candidates = [
    process.env.EZA_LOG_DIR,
    process.env.EZA_USER_DATA_DIR ? path.join(process.env.EZA_USER_DATA_DIR, 'logs') : '',
    path.resolve(__dirname, '..', '..', '..', 'logs'),
    path.join(os.tmpdir(), 'eza-pro-logs')
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    } catch (_) {
      // Fall through to next writable directory when running inside read-only Program Files
    }
  }
  return os.tmpdir();
}

function getLogFilePath() {
  return path.join(getLogDir(), 'eza-pro.log');
}

function rotateLogIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_LOG_FILE_BYTES) return;
    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
      const older = `${filePath}.${i}`;
      const prev = i === 1 ? filePath : `${filePath}.${i - 1}`;
      try {
        if (i === MAX_ROTATED_FILES && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        if (fs.existsSync(prev)) {
          fs.renameSync(prev, older);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) {
    return ` | ${scrubSensitiveText(meta.stack || meta.message)}`;
  }
  if (typeof meta === 'string') {
    return meta ? ` | ${scrubSensitiveText(meta)}` : '';
  }
  try {
    return ` | ${scrubSensitiveText(JSON.stringify(meta))}`;
  } catch (_) {
    return ` | ${scrubSensitiveText(String(meta))}`;
  }
}

function writeLogEntry(level, tag, message, meta) {
  const ts = new Date().toISOString();
  const cleanTag = String(tag || 'App').trim();
  const cleanMsg = scrubSensitiveText(message instanceof Error ? (message.stack || message.message) : message);
  const line = `[${ts}] [${level}] [${cleanTag}] ${cleanMsg}${formatMeta(meta)}`;

  ringBuffer.push(line);
  if (ringBuffer.length > MAX_RING_ENTRIES) {
    ringBuffer.shift();
  }

  try {
    const filePath = getLogFilePath();
    rotateLogIfNeeded(filePath);
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (_) {}

  return line;
}

function logInfo(tag, message, meta) {
  return writeLogEntry('INFO', tag, message, meta);
}

function logWarn(tag, message, meta) {
  return writeLogEntry('WARN', tag, message, meta);
}

function logError(tag, message, meta) {
  return writeLogEntry('ERROR', tag, message, meta);
}

/**
 * Return recent log lines from disk (falling back to in-memory ring buffer).
 */
function getRecentLogsText(maxLines = 250) {
  const limit = Math.max(10, Math.min(2000, Number(maxLines) || 250));
  try {
    const filePath = getLogFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).join('\n');
    }
  } catch (_) {}
  return ringBuffer.slice(-limit).join('\n');
}

module.exports = {
  resolveUnpackedPath,
  scrubSensitiveText,
  getLogDir,
  getLogFilePath,
  logInfo,
  logWarn,
  logError,
  getRecentLogsText
};
