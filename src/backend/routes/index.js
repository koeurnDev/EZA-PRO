/**
 * ⚡ EZA PRO - Main Router Index
 * Centralized route management
 */

const os = require('os');
const path = require('path');
const express = require('express');
const configRouter = require('./config');
const srtRouter = require('./srt');
const { loadSrtFileHandler, saveSrtFileHandler, findCompanionSrtHandler } = srtRouter;
const mediaHandlers = require('./media');
const translationRouter = require('./translation');
const ttsRouter = require('./tts');
const { checkAudioCacheHandler } = ttsRouter;
const draftRouter = require('./draft');
const exportRouter = require('./export');
const audioRouter = require('./audio');
const cloudLicense = require('../utils/cloud-license');
const logger = require('../utils/logger');
const janitor = require('../utils/janitor');

function requireActiveCloudLicense(req, res, next) {
  if (!cloudLicense.isCloudLicenseEnforced()) return next();
  const machineId = typeof configRouter.getMachineHardwareId === 'function'
    ? configRouter.getMachineHardwareId()
    : '';
  if (cloudLicense.hasActiveLocalLease(machineId)) return next();
  return res.status(403).json({
    success: false,
    licenseRequired: true,
    error: 'សូមផ្ទៀងផ្ទាត់ License Key ជាមុនសិន ដើម្បីប្រើមុខងារនេះ។'
  });
}

function requireAuthorizedCaller(req, res, next) {
  if (typeof configRouter.isCallerAuthorized === 'function' && !configRouter.isCallerAuthorized(req)) {
    return res.status(401).json({
      success: false,
      authRequired: true,
      error: 'សូមបញ្ចូលលេខកូដសុវត្ថិភាពជាមុនសិន។'
    });
  }
  return next();
}

/**
 * Setup all API routes
 * @param {Express.Application} app - Express app instance
 */
function setupRoutes(app) {
  
  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      message: '⚡ EZA PRO Backend is running',
      version: require('../../../package.json').version,
      timestamp: new Date().toISOString()
    });
  });
  
  // Diagnostics & Warranty Support Bundle (accessible even when license gate is locked)
  const buildDiagnosticsPayload = () => {
    const pkgVersion = require('../../../package.json').version;
    const machineId = typeof configRouter.getMachineHardwareId === 'function'
      ? configRouter.getMachineHardwareId()
      : '';
    const licState = typeof cloudLicense.getLocalLicenseSnapshot === 'function'
      ? cloudLicense.getLocalLicenseSnapshot(machineId)
      : {};
    const logsText = logger.getRecentLogsText(300);
    return {
      success: true,
      appVersion: pkgVersion,
      packaged: process.env.EZA_PACKAGED === '1',
      platform: `${process.platform} ${os.release()} (${process.arch})`,
      nodeVersion: process.version,
      logFile: logger.getLogFilePath(),
      machineId,
      license: {
        valid: Boolean(licState.valid),
        planId: licState.planId || '',
        customerName: licState.customerName || '',
        expiresAt: licState.expiresAt || null,
        maxMachines: licState.maxMachines || 1,
        boundCount: licState.boundCount || 0,
        lastError: licState.lastError || ''
      },
      logsText,
      timestamp: new Date().toISOString()
    };
  };

  app.get('/api/diagnostics/logs', requireAuthorizedCaller, (req, res) => {
    try {
      return res.json(buildDiagnosticsPayload());
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/diagnostics/bundle', requireAuthorizedCaller, (req, res) => {
    try {
      const diag = buildDiagnosticsPayload();
      const header = [
        '=== EZA PRO SUPPORT DIAGNOSTICS ===',
        `Timestamp: ${diag.timestamp}`,
        `Version: ${diag.appVersion} (packaged=${diag.packaged})`,
        `OS: ${diag.platform} | Node ${diag.nodeVersion}`,
        `Machine ID: ${diag.machineId}`,
        `License: valid=${diag.license.valid} plan=${diag.license.planId || 'none'} expiresAt=${diag.license.expiresAt || 'none'}`,
        `Last Error: ${diag.license.lastError || 'none'}`,
        `Log File: ${diag.logFile}`,
        '===================================',
        ''
      ].join('\n');
      const body = `${header}${diag.logsText || '(No log entries yet)'}\n`;
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="eza-pro-support-${stamp}.txt"`);
      return res.send(body);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Mount routers
  app.use('/api/config', configRouter);
  app.use('/api/parse-srt-raw', requireAuthorizedCaller, requireActiveCloudLicense, srtRouter);
  app.post('/api/load-srt-file', requireAuthorizedCaller, requireActiveCloudLicense, loadSrtFileHandler);
  app.post('/api/find-companion-srt', requireAuthorizedCaller, requireActiveCloudLicense, findCompanionSrtHandler);
  app.post('/api/save-srt', requireAuthorizedCaller, requireActiveCloudLicense, saveSrtFileHandler);
  app.get('/api/list-hdrg-dramas', requireAuthorizedCaller, requireActiveCloudLicense, mediaHandlers.listHdrgDramasHandler);
  app.get('/api/browse-folder', requireAuthorizedCaller, mediaHandlers.browseFolderHandler);
  app.get('/api/browse-file', requireAuthorizedCaller, mediaHandlers.browseFileHandler);
  app.get('/api/browse-files', requireAuthorizedCaller, mediaHandlers.browseFilesHandler);
  app.post('/api/resolve-picked-folder', requireAuthorizedCaller, mediaHandlers.resolvePickedFolderHandler);
  app.post('/api/resolve-local-files', requireAuthorizedCaller, mediaHandlers.resolveLocalFilesHandler);
  app.post('/api/list-directories', requireAuthorizedCaller, mediaHandlers.listDirectoriesHandler);
  app.post('/api/inspect-videos', requireAuthorizedCaller, requireActiveCloudLicense, mediaHandlers.inspectVideosHandler);
  app.post('/api/scan-folder', requireAuthorizedCaller, requireActiveCloudLicense, mediaHandlers.scanFolderHandler);
  app.get('/api/video-stream', requireAuthorizedCaller, requireActiveCloudLicense, mediaHandlers.videoStreamHandler);
  app.post('/api/upload-video', requireAuthorizedCaller, requireActiveCloudLicense, mediaHandlers.uploadVideoHandler);
  app.use('/api/translation', requireAuthorizedCaller, requireActiveCloudLicense, translationRouter);
  app.use('/api/tts', requireAuthorizedCaller, requireActiveCloudLicense, ttsRouter);
  app.post('/api/check-audio-cache', requireAuthorizedCaller, requireActiveCloudLicense, checkAudioCacheHandler);
  app.use('/api/drafts', requireAuthorizedCaller, requireActiveCloudLicense, draftRouter);
  app.use('/api/export', requireAuthorizedCaller, requireActiveCloudLicense, exportRouter);
  app.use('/api/audio', requireAuthorizedCaller, requireActiveCloudLicense, audioRouter);
  const staticBgm = express.static(audioRouter.getBgmCacheDir());
  app.use('/bgm_cache', requireAuthorizedCaller, requireActiveCloudLicense, staticBgm);

  // Express JSON error boundary (prevents HTML 500 pages leaking to desktop/web fetch callers)
  app.use('/api', (err, req, res, _next) => {
    logger.logError('Express:api', `${req.method} ${req.originalUrl}: ${(err && err.message) || err}`);
    if (res.headersSent) return;
    const status = Number(err && (err.statusCode || err.status)) || 500;
    res.status(status).json({
      success: false,
      error: (err && err.message) || 'Internal server error'
    });
  });

  // Schedule non-blocking storage cleanup on startup
  janitor.scheduleStartupStorageCleanup({
    uploadsDir: process.env.UPLOAD_DIR || path.resolve(__dirname, '../../../uploads'),
    bgmCacheDir: audioRouter.getBgmCacheDir(),
    audioCacheDir: typeof ttsRouter.getAudioCacheDir === 'function' ? ttsRouter.getAudioCacheDir() : null,
    translationCacheDir: process.env.TRANSLATION_CACHE_DIR || path.resolve(__dirname, '../../../translation_cache')
  }, logger);

  console.log('✅ All API routes configured with Express Router');
}

module.exports = { setupRoutes };
