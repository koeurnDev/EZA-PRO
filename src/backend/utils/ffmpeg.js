/**
 * Shared FFmpeg binary resolution helper
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const packagedBin = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(packagedBin)) return packagedBin;
  }
  const stagedBin = path.join(__dirname, '..', '..', '..', 'tools', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(stagedBin)) return stagedBin;
  return 'ffmpeg';
}

const FFMPEG_BIN = resolveFfmpegBin();

const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000];
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function parseMpegFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
    return null;
  }

  let sampleRate = 0;
  if (versionBits === 3) sampleRate = MPEG1_SAMPLE_RATES[srIdx];
  else if (versionBits === 2) sampleRate = MPEG2_SAMPLE_RATES[srIdx];
  else sampleRate = MPEG25_SAMPLE_RATES[srIdx];

  let kbps = 0;
  if (versionBits === 3) {
    kbps = layerBits === 3 ? BITRATES_V1_L1[bitrateIdx] : (layerBits === 2 ? BITRATES_V1_L2[bitrateIdx] : BITRATES_V1_L3[bitrateIdx]);
  } else {
    kbps = layerBits === 3 ? BITRATES_V2_L1[bitrateIdx] : BITRATES_V2_L23[bitrateIdx];
  }

  const samplesPerFrame = layerBits === 3 ? 384 : (layerBits === 2 || versionBits === 3 ? 1152 : 576);
  const bitrate = kbps * 1000;
  const frameSize = layerBits === 3
    ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
    : Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding;

  if (!sampleRate || frameSize < 24 || offset + frameSize > buf.length) return null;
  return { frameSize, sampleRate, samplesPerFrame };
}

/**
 * Compute exact MP3 duration in pure JS by walking valid MPEG frames (~0.05ms vs spawning FFmpeg).
 * Returns 0 cleanly for invalid/corrupt files so callers fall back to probeMediaInfo().
 */
function parseMp3DurationFast(filePath) {
  try {
    if (!filePath || typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.mp3')) return 0;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 64 || stat.size > 25 * 1024 * 1024) return 0;
    const buf = fs.readFileSync(filePath);
    let offset = 0;
    if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      const footerSize = (buf[5] & 0x10) ? 10 : 0;
      offset = Math.min(buf.length, 10 + tagSize + footerSize);
    }

    const scanLimit = Math.min(buf.length - 4, offset + 4096);
    while (offset <= scanLimit) {
      const first = parseMpegFrameHeader(buf, offset);
      if (first) {
        const nextOffset = offset + first.frameSize;
        if (nextOffset >= buf.length - 16 || parseMpegFrameHeader(buf, nextOffset)) {
          break;
        }
      }
      offset++;
    }

    let totalSamples = 0;
    let firstSampleRate = 0;
    let frames = 0;
    while (offset + 4 <= buf.length) {
      const frame = parseMpegFrameHeader(buf, offset);
      if (!frame) break;
      if (!firstSampleRate) firstSampleRate = frame.sampleRate;
      totalSamples += frame.samplesPerFrame;
      frames++;
      offset += frame.frameSize;
    }

    if (frames < 1 || !firstSampleRate || totalSamples <= 0) return 0;
    const remaining = buf.length - offset;
    const hasTrailerTag = remaining >= 3 && (
      (buf[offset] === 0x54 && buf[offset + 1] === 0x41 && buf[offset + 2] === 0x47) || // TAG
      (remaining >= 8 && buf.toString('ascii', offset, offset + 8) === 'APETAGEX')
    );
    if (remaining > 512 && !hasTrailerTag) return 0;
    return Number((totalSamples / firstSampleRate).toFixed(4));
  } catch (_) {
    return 0;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }));
  return results;
}

let swapFileCounter = 0;

async function renameWithWindowsRetry(fromPath, toPath) {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.promises.rename(fromPath, toPath);
      return;
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && i < 4) {
        await new Promise(r => setTimeout(r, 35 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function renameFileSafe(srcPath, destPath) {
  try {
    await renameWithWindowsRetry(srcPath, destPath);
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') {
      throw err;
    }
  }
  swapFileCounter = (swapFileCounter + 1) % 1000000;
  const swapPath = `${destPath}.${process.pid}.${Date.now()}.${swapFileCounter}.swap`;
  try {
    await fs.promises.copyFile(srcPath, swapPath);
    await renameWithWindowsRetry(swapPath, destPath);
    try { await fs.promises.unlink(srcPath); } catch (_) {}
  } finally {
    try { if (fs.existsSync(swapPath)) await fs.promises.unlink(swapPath); } catch (_) {}
  }
}

/**
 * Lower heavy child process CPU scheduling priority to BELOW_NORMAL so background
 * FFmpeg rendering or local AI work keeps desktop UI responsive without freezing.
 */
function lowerProcessPriority(proc) {
  try {
    const pid = proc && typeof proc === 'object' ? proc.pid : Number(proc);
    const prio = os.constants && os.constants.priority && os.constants.priority.PRIORITY_BELOW_NORMAL;
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(prio)) {
      os.setPriority(pid, prio);
      return true;
    }
  } catch (_) {}
  return false;
}

module.exports = {
  FFMPEG_BIN,
  resolveFfmpegBin,
  parseMp3DurationFast,
  mapWithConcurrency,
  renameFileSafe,
  lowerProcessPriority
};

