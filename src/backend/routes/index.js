/**
 * ⚡ EZA PRO - Main Router Index
 * Centralized route management
 */

const express = require('express');
const configRouter = require('./config');
const srtRouter = require('./srt');
const { loadSrtFileHandler, saveSrtFileHandler } = srtRouter;
const mediaHandlers = require('./media');
const translationRouter = require('./translation');
const ttsRouter = require('./tts');
const { checkAudioCacheHandler } = ttsRouter;
const draftRouter = require('./draft');
const exportRouter = require('./export');
const audioRouter = require('./audio');
const cloudLicense = require('../utils/cloud-license');

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
  
  // Mount routers
  app.use('/api/config', configRouter);
  app.use('/api/parse-srt-raw', srtRouter);
  app.post('/api/load-srt-file', loadSrtFileHandler);
  app.post('/api/save-srt', requireActiveCloudLicense, saveSrtFileHandler);
  app.get('/api/list-hdrg-dramas', mediaHandlers.listHdrgDramasHandler);
  app.get('/api/browse-folder', mediaHandlers.browseFolderHandler);
  app.get('/api/browse-file', mediaHandlers.browseFileHandler);
  app.get('/api/browse-files', mediaHandlers.browseFilesHandler);
  app.post('/api/inspect-videos', mediaHandlers.inspectVideosHandler);
  app.post('/api/scan-folder', mediaHandlers.scanFolderHandler);
  app.get('/api/video-stream', mediaHandlers.videoStreamHandler);
  app.post('/api/upload-video', mediaHandlers.uploadVideoHandler);
  app.use('/api/translation', requireActiveCloudLicense, translationRouter);
  app.use('/api/tts', requireActiveCloudLicense, ttsRouter);
  app.post('/api/check-audio-cache', checkAudioCacheHandler);
  app.use('/api/drafts', draftRouter);
  app.use('/api/export', requireActiveCloudLicense, exportRouter);
  app.use('/api/audio', requireActiveCloudLicense, audioRouter);
  app.use('/bgm_cache', (req, res, next) => {
    express.static(audioRouter.getBgmCacheDir())(req, res, next);
  });
  
  console.log('✅ All API routes configured with Express Router');
}

module.exports = { setupRoutes };
