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

// CORS & No-Cache for development (ensure browser always gets latest JS/CSS)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
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
const configRouter = require('./src/backend/routes/config');
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
app.use('/audio_cache', express.static(process.env.AUDIO_CACHE_DIR || path.join(__dirname, 'audio_cache')));
app.use('/cloned_voices', (req, res, next) => express.static(voiceCloner.getClonedVoicesDir())(req, res, next));
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

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});
