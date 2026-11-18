/**
 * ⚡ EZA PRO - Development Server (Browser Testing)
 * Run backend without Electron for faster development
 * 
 * Usage: node server-dev.js
 * Then open: http://localhost:3001
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Load .env file

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const configRouter = require('./src/backend/routes/config');

function isAllowedDevOrigin(origin, req) {
  if (!origin) return true;
  if (origin === 'null') {
    return typeof configRouter.isLoopbackNonForwardedRequest === 'function'
      ? configRouter.isLoopbackNonForwardedRequest(req)
      : false;
  }
  try {
    const parsed = new URL(origin);
    const reqHost = String((req && req.get && req.get('host')) || '').trim().toLowerCase();
    if (reqHost && parsed.host.toLowerCase() === reqHost) return true;
    const h = parsed.hostname.toLowerCase();
    let activeTunnelHost = '';
    try {
      const activeUrl = typeof configRouter.getActivePublicTunnelUrl === 'function' ? configRouter.getActivePublicTunnelUrl() : '';
      if (activeUrl) activeTunnelHost = new URL(activeUrl).hostname.toLowerCase();
    } catch (_) {}
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '[::1]' ||
      h === '::1' ||
      (activeTunnelHost && h === activeTunnelHost) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)
    ) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
  } catch (_) {}
  return false;
}

// CORS & No-Cache for development (ensure browser always gets latest JS/CSS)
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin) {
    if (!isAllowedDevOrigin(origin, req)) {
      return res.sendStatus(403);
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, x-eza-access-token');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Get Gemini API key from Router Management store or environment
app.use((req, res, next) => {
  req.getGeminiApiKey = () => {
    const activeKey = typeof configRouter.getActiveGeminiApiKey === 'function'
      ? configRouter.getActiveGeminiApiKey()
      : '';
    return activeKey || process.env.GEMINI_API_KEY || '';
  };
  next();
});

// Serve static files
const voiceCloner = require('./src/backend/utils/voice-cloner');
function requireDevCallerAuth(req, res, next) {
  if (typeof configRouter.isCallerAuthorized === 'function' && !configRouter.isCallerAuthorized(req)) {
    return res.status(401).json({ success: false, authRequired: true, error: 'សូមបញ្ចូលលេខកូដសុវត្ថិភាពជាមុនសិន។' });
  }
  next();
}
app.use('/audio_cache', requireDevCallerAuth, express.static(process.env.AUDIO_CACHE_DIR || path.join(__dirname, 'audio_cache')));
let cachedCloneStaticDir = '';
let cachedCloneStaticMw = null;
app.use('/cloned_voices', requireDevCallerAuth, (req, res, next) => {
  const dir = voiceCloner.getClonedVoicesDir();
  if (!cachedCloneStaticMw || cachedCloneStaticDir !== dir) {
    cachedCloneStaticDir = dir;
    cachedCloneStaticMw = express.static(dir);
  }
  return cachedCloneStaticMw(req, res, next);
});
app.use(express.static(path.join(__dirname, 'src', 'frontend')));

// API Routes
const { setupRoutes } = require('./src/backend/routes');
setupRoutes(app);

// Serve frontend (for browser testing)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'frontend', 'index.html'));
});

// Serve test page
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-frontend.html'));
});

// Start server
const server = app.listen(PORT, () => {
  const netInfo = typeof configRouter.detectLanAddresses === 'function'
    ? configRouter.detectLanAddresses(PORT)
    : { phoneUrl: `http://127.0.0.1:${PORT}` };
  console.log(`
⚡ EZA PRO - Desktop & Phone Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🌐 Server running at:
   - Desktop:     http://localhost:${PORT}
   - Phone Wi-Fi: ${netInfo.phoneUrl}
   - Test Page:   http://localhost:${PORT}/test

📡 Backend API: http://localhost:${PORT}/api/*

🔑 API Key loaded: ${process.env.GEMINI_API_KEY ? '✅ Yes' : '❌ No (.env file)'}

💡 Tips:
   - Open ${netInfo.phoneUrl} on your phone (same Wi-Fi)
   - Edit files and refresh browser (no restart needed)
   - Press Ctrl+C to stop server

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});
server.requestTimeout = 0;
server.on('error', (err) => {
  console.error('❌ Server failed:', err);
  process.exit(1);
});

function shutdownDevServer() {
  try {
    const exportRouter = require('./src/backend/routes/export');
    if (typeof exportRouter.cancelActiveExportProcesses === 'function') {
      exportRouter.cancelActiveExportProcesses();
    }
  } catch (_) {}
  try {
    const audioRouter = require('./src/backend/routes/audio');
    if (typeof audioRouter.cancelActiveBgmProcesses === 'function') {
      audioRouter.cancelActiveBgmProcesses();
    }
  } catch (_) {}
  try {
    if (typeof configRouter.stopPublicInternetTunnel === 'function') {
      configRouter.stopPublicInternetTunnel();
    }
  } catch (_) {}
  try {
    server.close();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {}
}
process.once('SIGINT', () => { shutdownDevServer(); process.exit(0); });
process.once('SIGTERM', () => { shutdownDevServer(); process.exit(0); });

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  shutdownDevServer();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});
