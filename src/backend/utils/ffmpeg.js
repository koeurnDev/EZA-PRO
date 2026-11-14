/**
 * Shared FFmpeg binary resolution helper
 */

const fs = require('fs');
const path = require('path');

const LEGACY_FFMPEG_BIN = 'D:\\EZA POST\\EZA-POST\\backend\\node_modules\\ffmpeg-static\\ffmpeg.exe';

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const packagedBin = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(packagedBin)) return packagedBin;
  }
  const stagedBin = path.join(__dirname, '..', '..', '..', 'tools', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(stagedBin)) return stagedBin;
  if (fs.existsSync(LEGACY_FFMPEG_BIN)) return LEGACY_FFMPEG_BIN;
  return 'ffmpeg';
}

const FFMPEG_BIN = resolveFfmpegBin();

module.exports = { FFMPEG_BIN, resolveFfmpegBin };

