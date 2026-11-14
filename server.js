const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

let EdgeTTS;
try {
  EdgeTTS = require('@andresaya/edge-tts').EdgeTTS;
} catch (_) {}

const PORT = 3001;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const HDRG_CONFIG_FILE = path.join('D:\\HDRG', 'config.json');
const ENV_FILE = path.join('D:\\HDRG', 'hongguo-drama', 'scripts', '.env');
const AUDIO_CACHE_DIR = path.join(__dirname, 'audio_cache');
const EXPORT_DIR = path.join('D:\\HDRG', 'Exported');

const FFMPEG_BIN = fs.existsSync('D:\\EZA POST\\EZA-POST\\backend\\node_modules\\ffmpeg-static\\ffmpeg.exe')
  ? 'D:\\EZA POST\\EZA-POST\\backend\\node_modules\\ffmpeg-static\\ffmpeg.exe'
  : 'ffmpeg';

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  try { fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true }); } catch (_) {}
}
if (!fs.existsSync(EXPORT_DIR)) {
  try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch (_) {}
}

// Config Helpers
function parseEnvFile(filePath) {
  const result = {};
  try {
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
  } catch (_) {}
  return result;
}

function loadConfig() {
  const envData = parseEnvFile(ENV_FILE);
  let cfg = {
    GEMINI_API_KEY: envData.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
    DOWNLOAD_DIR: envData.DOWNLOAD_DIR || 'D:\\HDRG'
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!cfg.GEMINI_API_KEY && parsed.GEMINI_API_KEY) cfg.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
      if (parsed.DOWNLOAD_DIR) cfg.DOWNLOAD_DIR = parsed.DOWNLOAD_DIR;
    }
    if (!cfg.GEMINI_API_KEY && fs.existsSync(HDRG_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HDRG_CONFIG_FILE, 'utf8'));
      if (parsed.GEMINI_API_KEY) cfg.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    }
  } catch (_) {}
  return cfg;
}

function saveConfig(cfg) {
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  try {
    if (fs.existsSync(HDRG_CONFIG_FILE)) {
      fs.writeFileSync(HDRG_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
    }
  } catch (_) {}
}

// SRT Helpers
function srtTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().replace(',', '.').split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

function secondsToSrtTime(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const ms = Math.floor((totalSec % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function secondsToDisplayTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

function parseSrt(rawText) {
  if (!rawText) return [];
  const clean = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = clean.split(/\n\n+/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 2) {
      let index = parseInt(lines[0].trim(), 10);
      let timeLine = lines[1].trim();
      let textLines = lines.slice(2);

      if (lines[0].includes('-->')) {
        index = cues.length + 1;
        timeLine = lines[0].trim();
        textLines = lines.slice(1);
      }

      if (timeLine.includes('-->')) {
        const parts = timeLine.split('-->');
        const start = parts[0].trim();
        const end = parts[1].trim();
        const text = textLines.join('\n').trim();
        const startSec = srtTimeToSeconds(start);
        const endSec = srtTimeToSeconds(end);
        
        cues.push({
          index: isNaN(index) ? cues.length + 1 : index,
          start: secondsToDisplayTime(startSec),
          end: secondsToDisplayTime(endSec),
          startSec,
          endSec,
          timecode: timeLine,
          text,
          translated: text,
          voice: 'Sovereign King'
        });
      }
    }
  }
  return cues;
}

function serializeSrt(cues) {
  return cues.map((cue, i) => {
    const idx = cue.index || (i + 1);
    const start = secondsToSrtTime(cue.startSec);
    const end = secondsToSrtTime(cue.endSec);
    const txt = cue.translated || cue.text;
    return `${idx}\n${start} --> ${end}\n${txt}`;
  }).join('\n\n') + '\n';
}

// Gemini Translator Engine
async function callGeminiApi(prompt, apiKey) {
  const models = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite'];
  let lastError = null;
  for (const model of models) {
    try {
      const result = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        });
        const req = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 15000
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.error) return reject(new Error(parsed.error.message || 'Gemini error'));
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) return resolve(text);
              reject(new Error('Empty Gemini response'));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
      });
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini ${model} failed]:`, err.message);
    }
  }
  throw lastError || new Error('គ្រប់ Gemini Models ទាំងអស់មិនឆ្លើយតប');
}

// Edge TTS Voice Synthesizer
async function synthesizeTts(text, voiceName = 'km-KH-PisethNeural') {
  if (!EdgeTTS) throw new Error('EdgeTTS module not loaded');
  const hash = crypto.createHash('md5').update(`${voiceName}:${text}`).digest('hex');
  const cacheFile = path.join(AUDIO_CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) {
    return `/audio_cache/${hash}.mp3`;
  }

  const tts = new EdgeTTS();
  await tts.synthesize(text, voiceName);
  await tts.toFile(cacheFile);
  return `/audio_cache/${hash}.mp3`;
}

// Native Windows Folder Browser Dialog via PowerShell
function openNativeFolderDialog() {
  return new Promise((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "ជ្រើសរើស Folder រឿងភាគចិន (Select Drama Folder)"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.SelectedPath
}
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, (err, stdout) => {
      if (err) return resolve(null);
      const selected = stdout.trim();
      resolve(selected || null);
    });
  });
}

// Scan a Drama Folder for Episodes
function scanDramaFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return { folder: folderPath, dramaName: path.basename(folderPath), episodes: [] };
  const files = fs.readdirSync(folderPath);
  const mp4Files = files.filter(f => f.toLowerCase().endsWith('.mp4'));
  const srtFiles = files.filter(f => f.toLowerCase().endsWith('.srt'));

  const episodeMap = new Map();

  mp4Files.forEach(mp4 => {
    const m = mp4.match(/(?:ep|第|ភាគ)[\s_]*(\d+)/i) || mp4.match(/(\d+)/);
    const epNum = m ? parseInt(m[1], 10) : 1;
    if (!episodeMap.has(epNum)) {
      episodeMap.set(epNum, { ep: epNum, name: `ភាគ ${epNum}`, video: mp4, videoPath: path.join(folderPath, mp4), srt: '', srtPath: '' });
    } else {
      episodeMap.get(epNum).video = mp4;
      episodeMap.get(epNum).videoPath = path.join(folderPath, mp4);
    }
  });

  srtFiles.forEach(srt => {
    const m = srt.match(/(?:ep|第|ភាគ)[\s_]*(\d+)/i) || srt.match(/(\d+)/);
    const epNum = m ? parseInt(m[1], 10) : 1;
    if (episodeMap.has(epNum)) {
      episodeMap.get(epNum).srt = srt;
      episodeMap.get(epNum).srtPath = path.join(folderPath, srt);
    } else {
      episodeMap.set(epNum, { ep: epNum, name: `ភាគ ${epNum}`, video: '', videoPath: '', srt, srtPath: path.join(folderPath, srt) });
    }
  });

  const episodes = Array.from(episodeMap.values()).sort((a, b) => a.ep - b.ep);
  return { folder: folderPath, dramaName: path.basename(folderPath), episodes };
}

// List all dramas inside D:\HDRG and custom directories
function listAllHdrgDramas() {
  const cfg = loadConfig();
  const searchDirs = Array.from(new Set([cfg.DOWNLOAD_DIR, 'D:\\HDRG', 'C:\\Users\\ASUS\\Downloads\\vd'].filter(Boolean)));
  const dramas = [];
  const dramaNames = new Set();

  for (const baseDir of searchDirs) {
    try {
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'hongguo-drama' && entry.name !== 'Exported') {
            const dramaFolder = path.join(baseDir, entry.name);
            const scan = scanDramaFolder(dramaFolder);
            if (scan.episodes.length > 0 && !dramaNames.has(entry.name)) {
              dramaNames.add(entry.name);
              dramas.push({
                name: entry.name,
                folder: dramaFolder,
                episodeCount: scan.episodes.length,
                srtCount: scan.episodes.filter(e => e.srt).length,
                episodes: scan.episodes
              });
            }
          }
        }
      }
    } catch (_) {}
  }
  return dramas.sort((a, b) => b.srtCount - a.srtCount);
}

// Auto-detect best default real drama to load on startup
function getDefaultRealDrama() {
  const dramas = listAllHdrgDramas();
  if (dramas.length === 0) return null;
  // Pick drama with SRT first
  const targetDrama = dramas[0];
  const epWithSrt = targetDrama.episodes.find(e => e.srtPath) || targetDrama.episodes[0];
  let initialCues = [];
  if (epWithSrt && epWithSrt.srtPath && fs.existsSync(epWithSrt.srtPath)) {
    try {
      const raw = fs.readFileSync(epWithSrt.srtPath, 'utf8');
      initialCues = parseSrt(raw);
    } catch (_) {}
  }
  return {
    drama: targetDrama,
    currentEpisode: epWithSrt,
    initialCues
  };
}

// Full Real Studio HTML/CSS/JS Application
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EZA PRO - AI Dubbing & Subtitle Studio</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kantumruy+Pro:ital,wght@0,400;0,600;0,700;0,800;1,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #070b16;
      --bg-panel: #0c1322;
      --bg-card: #111a2e;
      --bg-row: #0e172a;
      --bg-active: #152544;
      --border: #17243c;
      --border-light: #243554;
      --cyan: #00e5c0;
      --cyan-dark: #00b497;
      --cyan-glow: rgba(0, 229, 192, 0.4);
      --purple: #8b5cf6;
      --emerald: #10b981;
      --blue: #2563eb;
      --blue-light: #38bdf8;
      --red: #ef4444;
      --text: #f8fafc;
      --text-muted: #8899b5;
      --font-main: 'Plus Jakarta Sans', 'Kantumruy Pro', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-main); background: var(--bg-base); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; user-select: none; }

    /* Top Studio Bar */
    .topbar { background: var(--bg-panel); border-bottom: 1px solid var(--border); height: 46px; padding: 0 16px; display: flex; justify-content: space-between; align-items: center; z-index: 30; }
    .brand-wrap { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .shark-logo-icon { width: 26px; height: 26px; background: linear-gradient(135deg, #00e5c0, #0284c7); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 15px; box-shadow: 0 0 10px var(--cyan-glow); }
    .brand-title { font-size: 15px; font-weight: 800; color: #fff; letter-spacing: 0.5px; }
    .brand-badge { background: rgba(0, 229, 192, 0.12); border: 1px solid var(--cyan); color: var(--cyan); font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

    .topbar-center { display: flex; align-items: center; gap: 8px; }
    .top-btn { background: #111a2c; border: 1px solid var(--border); color: #cbd5e1; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: 0.15s; }
    .top-btn:hover { background: #1a2740; border-color: var(--border-light); color: #fff; }

    .top-ep-badge { background: #131c30; border: 1px solid var(--border); color: #94a3b8; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .top-ep-select { background: transparent; border: none; color: #fff; font-weight: 700; font-size: 12px; outline: none; cursor: pointer; }

    .topbar-right { display: flex; align-items: center; gap: 8px; }
    .icon-round-btn { width: 32px; height: 32px; border-radius: 6px; background: #111a2c; border: 1px solid var(--border); color: #94a3b8; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; font-size: 13px; }
    .icon-round-btn:hover { background: #1a2740; color: #fff; border-color: var(--border-light); }
    
    .btn-export { background: linear-gradient(135deg, var(--cyan-dark), var(--cyan)); color: #041410; border: none; padding: 6px 20px; border-radius: 6px; font-size: 12px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 0 14px var(--cyan-glow); transition: 0.2s; letter-spacing: 0.5px; }
    .btn-export:hover { transform: translateY(-1px); box-shadow: 0 0 20px rgba(0, 229, 192, 0.7); }

    /* Workspace Body: Split Left Player | Right Table */
    .studio-workspace { flex: 1; display: grid; grid-template-columns: 460px 1fr; overflow: hidden; }

    /* Left Section: 9:16 Video Player Container */
    .player-section { background: var(--bg-panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
    .player-top-tools { height: 38px; padding: 0 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); }
    
    .video-viewport-wrap { flex: 1; background: #050811; display: flex; justify-content: center; align-items: center; position: relative; overflow: hidden; padding: 10px; }
    
    /* 9:16 Vertical Video Frame */
    .video-frame-916 { width: 270px; height: 480px; max-height: 94%; background: #000; border-radius: 8px; position: relative; overflow: hidden; box-shadow: 0 12px 35px rgba(0,0,0,0.85); border: 1px solid #1c2842; display: flex; justify-content: center; align-items: center; }
    .video-element { width: 100%; height: 100%; object-fit: contain; background: #000; }
    
    /* Watermark Inside Video */
    .video-watermark { position: absolute; top: 12px; left: 12px; display: flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.45); backdrop-filter: blur(4px); padding: 3px 8px; border-radius: 4px; pointer-events: none; z-index: 10; border: 1px solid rgba(255,255,255,0.08); }
    .video-watermark-text { font-size: 10px; font-weight: 800; color: #cbd5e1; letter-spacing: 0.5px; }

    /* Subtitle Mask Box (Hides hardcoded Chinese subtitles) */
    .subtitle-mask-box {
      position: absolute;
      bottom: 70px;
      left: 4%;
      width: 92%;
      height: 48px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 10px;
      text-align: center;
      z-index: 15;
      pointer-events: none;
      transition: background 0.2s;
      backdrop-filter: blur(14px) brightness(0.65);
      -webkit-backdrop-filter: blur(14px) brightness(0.65);
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .subtitle-mask-box.blackout {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      background: rgba(0, 0, 0, 0.92);
      border: 1px solid rgba(0, 0, 0, 0.8);
    }
    .subtitle-mask-box.frosted {
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
    .subtitle-mask-box.hidden-mask {
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border: none !important;
    }
    .subtitle-text-inside {
      font-family: 'Kantumruy Pro', sans-serif;
      font-size: 13.5px;
      font-weight: 700;
      color: #fff9d2;
      text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000;
      line-height: 1.35;
      word-break: break-word;
    }

    /* Side Mini-Tools Overlay on Player */
    .player-side-tools { position: absolute; right: 18px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 20; }
    .side-tool-btn { width: 34px; height: 34px; border-radius: 6px; background: #111a2d; border: 1px solid var(--border); color: #94a3b8; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.15s; font-size: 14px; }
    .side-tool-btn:hover { background: #1a2744; color: #fff; border-color: var(--cyan); }

    /* Bottom Player Bar */
    .player-control-bar { background: var(--bg-card); border-top: 1px solid var(--border); padding: 8px 14px; display: flex; flex-direction: column; gap: 6px; }
    .player-controls-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; }
    .player-scrubber-wrap { width: 100%; height: 6px; background: #1a253c; border-radius: 3px; cursor: pointer; position: relative; }
    .player-scrubber-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #f97316, var(--cyan)); border-radius: 3px; position: relative; }
    .player-scrubber-thumb { position: absolute; right: -5px; top: -3px; width: 12px; height: 12px; background: #fff; border: 2px solid var(--cyan); border-radius: 50%; box-shadow: 0 0 6px var(--cyan); }
    .player-time-badge { font-family: monospace; font-size: 11px; color: #cbd5e1; font-weight: 700; }
    
    /* Dub Voice Toggle Switch */
    .switch-wrap { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .switch-box { width: 32px; height: 16px; background: #1e293b; border-radius: 10px; position: relative; transition: 0.2s; border: 1px solid #334155; }
    .switch-box.active { background: var(--cyan); border-color: var(--cyan); }
    .switch-knob { width: 12px; height: 12px; background: #fff; border-radius: 50%; position: absolute; top: 1px; left: 1px; transition: 0.2s; }
    .switch-box.active .switch-knob { left: 17px; background: #000; }

    .status-badge-bar { background: #0a0f1d; padding: 5px 14px; font-size: 11px; color: #64748b; display: flex; align-items: center; gap: 8px; border-top: 1px solid #121c2e; }

    /* Right Section: Subtitle & Dubbing Script Table */
    .script-section { display: flex; flex-direction: column; overflow: hidden; background: var(--bg-base); }
    
    /* Table Header Tools */
    .script-header-bar { background: var(--bg-panel); border-bottom: 1px solid var(--border); padding: 7px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .engine-dropdown-group { display: flex; align-items: center; gap: 8px; }
    .mini-select { background: #111a2d; border: 1px solid var(--border); color: #cbd5e1; padding: 4px 8px; border-radius: 5px; font-size: 11px; font-weight: 600; outline: none; cursor: pointer; }
    .mini-select:hover { border-color: var(--border-light); }
    .btn-transcribe { background: linear-gradient(135deg, var(--cyan-dark), var(--cyan)); color: #041410; border: none; padding: 5px 16px; border-radius: 5px; font-size: 11px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 0 10px var(--cyan-glow); letter-spacing: 0.5px; }

    .script-filter-bar { background: #0a1120; border-bottom: 1px solid var(--border); padding: 6px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
    .script-table-actions { display: flex; gap: 6px; align-items: center; }
    .action-icon-btn { background: #131c30; border: 1px solid var(--border); color: #cbd5e1; padding: 4px 10px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 5px; transition: 0.15s; }
    .action-icon-btn:hover { background: #1a2742; color: #fff; }
    .action-icon-btn.green { border-color: rgba(16, 185, 129, 0.4); color: #6ee7b7; }
    .action-icon-btn.green:hover { background: rgba(16, 185, 129, 0.15); }
    .action-icon-btn.danger { border-color: rgba(239, 68, 68, 0.4); color: #f87171; }
    .action-icon-btn.danger:hover { background: rgba(239, 68, 68, 0.15); }

    /* The Subtitle & Dub Data Table */
    .script-table-container { flex: 1; overflow-y: auto; background: #080d19; }
    .script-table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    .script-table th { background: #0c1426; color: #8899b5; font-size: 11px; font-weight: 700; padding: 8px 12px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; z-index: 5; }
    .script-table td { padding: 7px 12px; border-bottom: 1px solid #131c30; vertical-align: middle; }
    
    .script-row { transition: background 0.15s; cursor: pointer; }
    .script-row:hover { background: #101a30; }
    .script-row.active { background: #152544 !important; border-left: 3px solid var(--cyan); }
    
    .cell-time { font-family: monospace; color: #94a3b8; font-weight: 600; white-space: nowrap; font-size: 11px; }
    .cell-text-input { width: 100%; background: transparent; border: 1px solid transparent; color: #f1f5f9; padding: 4px 6px; border-radius: 4px; font-size: 12px; outline: none; font-family: inherit; font-weight: 500; }
    .cell-text-input:focus { background: #0a0f1d; border-color: var(--blue-light); }
    .cell-orig { font-size: 11px; color: #64748b; margin-top: 2px; }

    .voice-select-pill { background: #111a2d; border: 1px solid var(--border); color: #93c5fd; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; outline: none; cursor: pointer; }
    
    .audio-btns-wrap { display: flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-audio-mini { width: 24px; height: 24px; border-radius: 50%; background: #131e34; border: 1px solid #223252; color: var(--cyan); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.15s; font-size: 10px; }
    .btn-audio-mini:hover { background: var(--cyan); color: #000; border-color: var(--cyan); }
    .btn-audio-retry { width: 24px; height: 24px; border-radius: 50%; background: transparent; border: none; color: #64748b; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; }
    .btn-audio-retry:hover { color: #cbd5e1; }

    /* Bottom Studio Tools & Multi-Track Timeline Dock */
    .timeline-dock { height: 180px; background: #0a0f1d; border-top: 1px solid var(--border); display: grid; grid-template-columns: 240px 1fr; z-index: 25; }
    
    /* Left Tools Dock */
    .tools-sidebar { border-right: 1px solid var(--border); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .tools-title { font-size: 11px; font-weight: 800; color: #64748b; letter-spacing: 0.5px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
    .tools-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; flex: 1; }
    .studio-tool-card { background: #0f172a; border: 1px solid var(--border); border-radius: 6px; padding: 6px 4px; text-align: center; cursor: pointer; transition: 0.15s; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; position: relative; }
    .studio-tool-card:hover { background: #162442; border-color: var(--border-light); }
    .studio-tool-card.active { border-color: var(--cyan); background: #13223c; box-shadow: 0 0 10px rgba(0, 229, 192, 0.25); }
    .tool-icon { font-size: 16px; color: var(--cyan); }
    .tool-name { font-size: 10px; font-weight: 700; color: #cbd5e1; }
    .tool-status-tag { font-size: 8px; font-weight: 800; color: var(--cyan); text-transform: uppercase; }

    /* Right Multi-Track Area */
    .timeline-viewport { display: flex; flex-direction: column; overflow: hidden; background: #060a14; }
    .timeline-header-controls { height: 32px; background: #0c1426; border-bottom: 1px solid var(--border); padding: 0 12px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; }
    .timeline-actions-left { display: flex; align-items: center; gap: 6px; }
    
    .timeline-btn-cyan { background: linear-gradient(135deg, var(--cyan-dark), var(--cyan)); color: #041410; border: none; padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer; box-shadow: 0 0 8px var(--cyan-glow); }
    .badge-blue { background: rgba(37, 99, 235, 0.25); border: 1px solid rgba(59, 130, 246, 0.4); color: #93c5fd; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; }

    .tracks-container { flex: 1; overflow-x: auto; overflow-y: hidden; position: relative; padding: 4px 10px; display: flex; flex-direction: column; gap: 4px; }
    .timeline-ruler { height: 16px; border-bottom: 1px solid #16243c; position: relative; font-size: 9px; color: #64748b; font-family: monospace; }
    
    .track-row { height: 24px; border-radius: 3px; position: relative; display: flex; align-items: center; overflow: hidden; font-size: 10px; font-weight: 600; padding: 0 6px; }
    .track-label { width: 90px; flex-shrink: 0; font-size: 10px; display: flex; align-items: center; gap: 4px; }

    /* Video Filmstrip Reel */
    .video-filmstrip-bar { flex: 1; height: 20px; border-radius: 2px; background: #0c182c; border: 1px solid #1a3055; display: flex; align-items: center; position: relative; overflow: hidden; padding-left: 6px; }
    .video-title-tag { position: relative; z-index: 2; font-size: 9px; color: #bae6fd; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px #000; }

    /* Timeline Playhead Needle */
    .playhead-needle { position: absolute; top: 0; bottom: 0; width: 2px; background: #f97316; z-index: 20; pointer-events: none; left: 100px; box-shadow: 0 0 6px #f97316; }
    .playhead-needle::after { content: attr(data-time); position: absolute; top: 0; left: -16px; background: #f97316; color: #fff; font-size: 8px; font-family: monospace; font-weight: 800; padding: 1px 4px; border-radius: 2px; }

    /* Modals */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); z-index: 999; align-items: center; justify-content: center; }
    .modal-card { background: #0c1426; border: 1.5px solid var(--cyan); border-radius: 10px; width: 580px; max-width: 92vw; padding: 20px; box-shadow: 0 12px 40px rgba(0,0,0,0.9); display: flex; flex-direction: column; gap: 12px; }
    .modal-title { font-size: 15px; font-weight: 800; color: #fff; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1a253a; padding-bottom: 8px; }
    .modal-close { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; }
  </style>
</head>
<body>

  <!-- Top Bar -->
  <div class="topbar">
    <div class="brand-wrap" onclick="openHdrgDramaPicker()">
      <div class="shark-logo-icon">⚡</div>
      <div class="brand-title">EZA</div>
      <span class="brand-badge">PRO</span>
    </div>

    <div class="topbar-center">
      <input type="file" id="videoFileInput" accept="video/mp4,video/*" style="display:none;" onchange="handleVideoUpload(event)">
      <input type="file" id="srtFileInput" accept=".srt,.txt" style="display:none;" onchange="handleSrtUpload(event)">
      
      <button class="top-btn" onclick="openHdrgDramaPicker()" style="border-color: #0284c7; color: #38bdf8;">📂 រើសរឿងក្នុង HDRG</button>
      <button class="top-btn" onclick="openImportFolderDialog()">📁 Import Folder</button>
      <button class="top-btn" onclick="document.getElementById('videoFileInput').click()">🎬 Video</button>
      <button class="top-btn" onclick="document.getElementById('srtFileInput').click()">📝 SRT</button>

      <div class="top-ep-badge">
        <span>Ep :</span>
        <select id="episodeSelect" class="top-ep-select" onchange="onEpisodeChange(this.value)">
          <option value="1">1</option>
        </select>
      </div>
    </div>

    <div class="topbar-right">
      <a href="http://localhost:3000" target="_blank" class="top-btn" style="text-decoration:none; border-color:#10b981; color:#6ee7b7;">🚀 HDRG (3000)</a>
      <div class="icon-round-btn" title="កំណត់ Gemini Key & Settings" onclick="openKeyModal()">⚙️</div>
      <button class="btn-export" onclick="openExportModal()">✨ EXPORT</button>
    </div>
  </div>

  <!-- Studio Workspace -->
  <div class="studio-workspace">

    <!-- Left: 9:16 Video Player Area -->
    <div class="player-section">
      <div class="player-top-tools">
        <div style="display: flex; gap: 8px; align-items: center;">
          <span id="currentDramaTitleTag" style="font-size: 11px; font-weight: 700; color: #fff; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">装穷提亲，娶到全家嫌弃的她</span>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <span style="cursor: pointer; font-size: 13px;" onclick="resetVideoToStart()" title="ត្រឡប់ទៅដើម">↺</span>
          <span style="cursor: pointer; font-size: 13px;" onclick="toggleFullscreen()" title="ពង្រីកពេញអេក្រង់">⛶</span>
        </div>
      </div>

      <div class="video-viewport-wrap" id="videoDropZone">
        <!-- Vertical 9:16 Phone Frame -->
        <div class="video-frame-916">
          <video id="mainVideo" class="video-element" playsinline ontimeupdate="onVideoTimeUpdate()" onloadedmetadata="onVideoLoaded()"></video>
          
          <!-- Top Left Watermark -->
          <div class="video-watermark" id="playerWatermark">
            <span>⚡</span>
            <span class="video-watermark-text">EZA TOOLS</span>
          </div>

          <!-- Subtitle Mask Box (Hides hardcoded Chinese subtitles) -->
          <div id="subtitleMaskBox" class="subtitle-mask-box">
            <div id="liveSubtitleText" class="subtitle-text-inside" style="display:none;"></div>
          </div>
        </div>

        <!-- Vertical Side Mini Toolbar -->
        <div class="player-side-tools">
          <div class="side-tool-btn" title="Split Line at Current Time" onclick="splitLineAtCurrentTime()">✂️</div>
          <div class="side-tool-btn" title="Snapshot Frame as Image" onclick="snapshotVideoFrame()">📷</div>
          <div class="side-tool-btn" title="Add Line at Current Time" onclick="addNewCueLine()">➕</div>
          <div class="side-tool-btn" title="Toggle Watermark" onclick="toggleWatermark()">🗂️</div>
          <div class="side-tool-btn" title="Clear Cues" onclick="clearAllCues()">🗑️</div>
        </div>
      </div>

      <!-- Player Controls -->
      <div class="player-control-bar">
        <div class="player-scrubber-wrap" id="scrubberTrack" onclick="seekByScrubber(event)">
          <div id="scrubberFill" class="player-scrubber-fill">
            <div class="player-scrubber-thumb"></div>
          </div>
        </div>
        <div class="player-controls-row">
          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="btnPlayPause" onclick="togglePlayPause()" style="background:none; border:none; color:#fff; cursor:pointer; font-size:13px;">▶️</button>
            <span id="playerTimeText" class="player-time-badge">0:00.0 / 0:00.0</span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <select id="speedSelect" class="mini-select" onchange="document.getElementById('mainVideo').playbackRate = parseFloat(this.value)">
              <option value="1">1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
              <option value="0.75">0.75x</option>
            </select>
            <div class="switch-wrap" onclick="toggleDubVoice()" title="បើក/បិទសំឡេងនិយាយ Dub Voice">
              <span style="color: #64748b; font-size: 11px;">Dub Voice</span>
              <div id="dubVoiceSwitch" class="switch-box active">
                <div class="switch-knob"></div>
              </div>
            </div>
            <span id="volIcon" style="font-size: 12px; cursor: pointer;" onclick="toggleMuteVideo()">🔊</span>
          </div>
        </div>

        <!-- Subtitle Masking Controls Bar -->
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0b111e; border:1px solid var(--border); border-radius:5px; padding:3px 8px; font-size:10.5px; margin-top:2px;">
          <label style="display:flex; align-items:center; gap:5px; cursor:pointer; color:#cbd5e1; font-weight:700;">
            <input type="checkbox" id="maskToggleCheck" checked onchange="toggleMaskBox(this.checked)">
            <span>🌫️ បាំងអក្សរចិនដើម</span>
          </label>
          <div style="display:flex; align-items:center; gap:6px;">
            <select id="maskModeSelect" class="mini-select" style="padding:2px 5px; font-size:10px;" onchange="changeMaskMode(this.value)">
              <option value="blur">Blur (ព្រិល)</option>
              <option value="black">Black (ខ្មៅដិត)</option>
              <option value="frosted">Frosted (កញ្ចក់)</option>
            </select>
            <div style="display:flex; align-items:center; gap:3px; color:#94a3b8;">
              <span>↕️ Y:</span>
              <input type="range" id="maskYSlider" min="30" max="140" value="70" style="width:45px;" oninput="updateMaskY(this.value)" title="រំកិលប្រអប់បាំងអក្សរ ឡើង/ចុះ">
            </div>
            <div style="display:flex; align-items:center; gap:3px; color:#94a3b8;">
              <span>H:</span>
              <input type="range" id="maskHSlider" min="25" max="80" value="48" style="width:40px;" oninput="updateMaskH(this.value)" title="កម្ពស់ប្រអប់">
            </div>
          </div>
        </div>
      </div>

      <div class="status-badge-bar">
        <span style="color: #10b981;">🟢</span>
        <span id="bottomStatusMsg">ប្រព័ន្ធបានភ្ជាប់ជាមួយ Edge-TTS Neural (Piseth & Sreymom) និង Gemini AI Flash។</span>
      </div>
    </div>

    <!-- Right: Subtitle & Dubbing Script Table -->
    <div class="script-section">
      <!-- Upper Engine Controls -->
      <div class="script-header-bar">
        <div class="engine-dropdown-group">
          <span style="font-size: 11px; color: #64748b;">☁️ TS: Gemini AI</span>
          <select id="targetLangSelect" class="mini-select">
            <option value="km">Dub: Khmer (ភាសាខ្មែរភាពយន្ត)</option>
            <option value="en">Dub: English</option>
            <option value="zh-km">Dub: Bilingual (ចិន+ខ្មែរ)</option>
          </select>
        </div>
        <button class="btn-transcribe" onclick="startAiTranslation()">
          ✨ TRANSCRIBE & TRANSLATE
        </button>
      </div>

      <!-- Table Filter Bar -->
      <div class="script-filter-bar">
        <div style="display: flex; gap: 6px; align-items: center;">
          <input type="text" id="scriptSearch" placeholder="🔍 ស្វែងរកពាក្យ..." style="background:#111a2d; border:1px solid var(--border); border-radius:4px; padding:3px 8px; font-size:11px; color:#fff; width:110px; outline:none;" oninput="filterTable()">
          <button class="action-icon-btn" onclick="startSpeechDetection()" style="background:linear-gradient(135deg, #0284c7, #0ea5e9); color:#fff; border:1px solid #38bdf8; font-weight:700;" title="វិភាគ និងចាប់យកនាទីសំឡេងមនុស្សនិយាយក្នុងវីដេអូ">
            🎙️ ចាប់សំឡេងមនុស្ស (Auto-Detect Speech)
          </button>
          <button class="action-icon-btn green" onclick="batchGenerateAllAudio()">🎙️ Clone All Voices</button>
          <button class="action-icon-btn" onclick="addNewCueLine()">+ Add Line</button>
          <button class="action-icon-btn danger" onclick="deleteSelectedCue()">🗑️ Delete</button>
          <button class="action-icon-btn" onclick="saveSrtToDisk()" style="border-color:#0284c7; color:#38bdf8;">💾 Save SRT</button>
        </div>

        <div style="font-size: 11px; color: #64748b; font-weight: 600;">
          <span id="selectedIndicatorText">Selected: គ្មាន</span>
        </div>
      </div>

      <!-- The Table -->
      <div class="script-table-container">
        <table class="script-table">
          <thead>
            <tr>
              <th style="width: 32px;"><input type="checkbox" id="selectAllCheck" onclick="toggleSelectAll(this)"></th>
              <th style="width: 70px;">START</th>
              <th style="width: 70px;">END</th>
              <th>DUB TEXT / SUBTITLE (KHMER & CHINESE)</th>
              <th style="width: 140px;">VOICE PROFILE</th>
              <th style="width: 60px; text-align: center;">AUDIO</th>
            </tr>
          </thead>
          <tbody id="cuesTableBody">
            <!-- Dynamic Rows -->
          </tbody>
        </table>
      </div>

      <div style="background: #080d19; border-top: 1px solid var(--border); padding: 5px 14px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; color: #64748b;">
        <div style="display: flex; gap: 14px;">
          <span style="color: #10b981;">🟢 Ready (សំឡេងរួចរាល់)</span>
          <span style="color: #94a3b8;">⚪ Pending (មិនទាន់សំយោគ)</span>
        </div>
        <div id="cuesStatsText">សរុប: 0 បន្ទាត់</div>
      </div>
    </div>

  </div>

  <!-- Bottom Studio Tools & Multi-Track Timeline -->
  <div class="timeline-dock">
    <!-- Left Tools Sidebar -->
    <div class="tools-sidebar">
      <div class="tools-title">
        <span>🎙️</span>
        <span>REAL DSP TOOLS</span>
      </div>
      <div class="tools-grid">
        <div class="studio-tool-card" id="toolAudioBoost" onclick="toggleAudioBoost()">
          <div class="tool-icon">🔊</div>
          <div class="tool-name">Audio Boost</div>
          <div class="tool-status-tag" id="boostTag">OFF</div>
        </div>
        <div class="studio-tool-card" id="toolCutParts" onclick="splitLineAtCurrentTime()">
          <div class="tool-icon">✂️</div>
          <div class="tool-name">Split Cue</div>
          <div class="tool-status-tag">SPLIT</div>
        </div>
        <div class="studio-tool-card" id="toolRemoveVocals" onclick="toggleRemoveVocals()">
          <div class="tool-icon">🎵</div>
          <div class="tool-name">Vocal Invert</div>
          <div class="tool-status-tag" id="vocalTag">OFF</div>
        </div>
        <div class="studio-tool-card" id="toolMusicBed" onclick="toggleMusicBed()">
          <div class="tool-icon">📢</div>
          <div class="tool-name">Music Bed</div>
          <div class="tool-status-tag" id="musicTag">OFF</div>
        </div>
      </div>
    </div>

    <!-- Right Multi-Track Area -->
    <div class="timeline-viewport">
      <div class="timeline-header-controls">
        <div class="timeline-actions-left">
          <button class="timeline-btn-cyan" onclick="batchGenerateAllAudio()">Generate Voice</button>
          <span class="badge-blue" id="voiceReadyBadge">0/0 ready</span>
          <span style="cursor: pointer; font-size: 11px;" onclick="renderTimeline()" title="Refresh Timeline">🔄</span>
          <button class="top-btn" style="padding: 2px 7px; font-size: 10px;" onclick="splitLineAtCurrentTime()">Split</button>
          <button class="top-btn" style="padding: 2px 7px; font-size: 10px;" onclick="nudgeActiveCue(-0.5)">⏪ -0.5s</button>
          <button class="top-btn" style="padding: 2px 7px; font-size: 10px;" onclick="nudgeActiveCue(0.5)">⏩ +0.5s</button>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 10px; color: #64748b;">Zoom:</span>
          <input type="range" id="timelineZoom" min="1" max="4" value="1" style="width: 70px;" oninput="renderTimeline()">
        </div>
      </div>

      <div class="tracks-container" id="tracksContainer" onclick="seekByTimeline(event)">
        <!-- Ruler -->
        <div class="timeline-ruler" id="timelineRuler"></div>
        <!-- Playhead Needle -->
        <div id="playheadNeedle" class="playhead-needle" data-time="0:00.0"></div>

        <!-- Track 1: Video Filmstrip -->
        <div class="track-row" style="background: rgba(2, 132, 199, 0.08);">
          <div class="track-label" style="color: #7dd3fc;">
            <span style="color: #0284c7;">🔵</span> Video
          </div>
          <div class="video-filmstrip-bar" id="trackVideoBar">
            <span class="video-title-tag" id="videoTrackTitle">មិនទាន់មានវីដេអូ</span>
          </div>
        </div>

        <!-- Track 2: Dub / Voice -->
        <div class="track-row" style="background: rgba(16, 185, 129, 0.08);">
          <div class="track-label" style="color: #6ee7b7;">
            <span style="color: #10b981;">🟢</span> Dub Voice
          </div>
          <div id="trackDubBlocks" style="flex: 1; height: 16px; position: relative;"></div>
        </div>

        <!-- Track 3: Subtitles -->
        <div class="track-row" style="background: rgba(245, 158, 11, 0.08);">
          <div class="track-label" style="color: #fde68a;">
            <span style="color: #f59e0b;">🟡</span> Subtitles
          </div>
          <div id="trackSubBlocks" style="flex: 1; height: 16px; position: relative;"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Drama Picker Modal -->
  <div id="dramaPickerModal" class="modal-overlay">
    <div class="modal-card" style="width: 640px;">
      <div class="modal-title">
        <span>📂 ជ្រើសរើសរឿងពី D:\\HDRG</span>
        <button class="modal-close" onclick="closeHdrgDramaPicker()">✕</button>
      </div>
      <div id="dramaListContainer" style="max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
        <div style="color: #64748b; text-align: center; padding: 20px;">⏳ កំពុងស្កេន Folder...</div>
      </div>
    </div>
  </div>

  <!-- Settings / Key Modal -->
  <div id="keyModal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-title">
        <span>⚙️ កំណត់ Gemini API Key</span>
        <button class="modal-close" onclick="closeKeyModal()">✕</button>
      </div>
      <div style="font-size: 13px; color: #cbd5e1; line-height: 1.5;">
        បញ្ចូល Gemini API Key របស់អ្នកដើម្បីឱ្យប្រព័ន្ធបកប្រែ Chinese -> Khmer Dialogue ដោយស្វ័យប្រវត្តិ។
      </div>
      <input type="password" id="geminiKeyInput" placeholder="បញ្ចូល Gemini API Key នៅទីនេះ..." style="width: 100%; background: #070c17; border: 1px solid var(--border-light); border-radius: 6px; padding: 10px 14px; color: #fff; font-size: 13px; outline: none;">
      <div style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="top-btn" onclick="closeKeyModal()">បិទ</button>
        <button class="btn-export" onclick="saveGeminiKey()">💾 រក្សាទុក</button>
      </div>
    </div>
  </div>

  <!-- Export Modal -->
  <div id="exportModal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-title">
        <span>✨ EXPORT PROJECT (នាំចេញគម្រោង)</span>
        <button class="modal-close" onclick="closeExportModal()">✕</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div style="background: #111a2d; border: 1px solid var(--border); border-radius: 6px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #fff;">📝 Export File អក្សររត់ .SRT</div>
            <div style="font-size: 11px; color: #64748b;">ទាញយក File .SRT ដែលបានបកប្រែ និងកែសម្រួលរួច</div>
          </div>
          <button class="btn-export" onclick="downloadSrtFile()">⬇️ ទាញយក .SRT</button>
        </div>

        <div style="background: #111a2d; border: 1px solid var(--border); border-radius: 6px; padding: 12px; display: flex; flex-direction:column; gap:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size: 13px; font-weight: 700; color: #fff;">🎬 Export វីដេអូបញ្ចូល Subtitle (.MP4)</div>
              <div style="font-size: 11px; color: #64748b;">ដុតអក្សររត់ខ្មែរចូលក្នុងវីដេអូ ទៅកាន់ D:\\HDRG\\Exported</div>
            </div>
            <button class="btn-export" onclick="exportVideoWithFfmpeg()">🚀 Export MP4</button>
          </div>
          <div style="display:flex; align-items:center; gap:12px; font-size:11px; color:#cbd5e1; padding-top:6px; border-top:1px solid #1a253a;">
            <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
              <input type="checkbox" id="exportMaskCheck" checked>
              <span>🌫️ បាំងអក្សរចិនដើម (Subtitle Mask)</span>
            </label>
            <select id="exportMaskMode" class="mini-select" style="padding:2px 6px; font-size:10px;">
              <option value="blur">Blur (ព្រិល)</option>
              <option value="black">Black (ខ្មៅដិត)</option>
            </select>
          </div>
        </div>
      </div>
      <div id="exportStatusMsg" style="font-size: 12px; color: #38bdf8; min-height: 20px;"></div>
    </div>
  </div>

  <script>
    // Global Application State
    let activeCues = [];
    let currentVideoPath = '';
    let currentSrtPath = '';
    let currentVideoDuration = 0;
    let isDubVoiceEnabled = true;
    let selectedCueIndex = -1;
    let activeAudioPlayer = new Audio();
    let currentDramaInfo = null;

    // Web Audio DSP State
    let audioCtx = null;
    let mediaSourceNode = null;
    let boostGainNode = null;
    let isBoostOn = false;
    let isVocalInvertOn = false;
    let bgmAudio = new Audio();
    let isBgmOn = false;

    // Caching state for audio hashes
    let cachedAudioMap = new Set();

    // Undo/Redo System
    let undoStack = [];
    let redoStack = [];

    function pushUndoState() {
      undoStack.push(JSON.parse(JSON.stringify(activeCues)));
      if (undoStack.length > 50) undoStack.shift();
      redoStack = [];
    }

    function undoAction() {
      if (undoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវមិនធ្វើវិញ'); return; }
      redoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = undoStack.pop();
      renderTable();
      renderTimeline();
      showShortcutToast('↩️ មិនធ្វើវិញ');
    }

    function redoAction() {
      if (redoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវធ្វើវិញ'); return; }
      undoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = redoStack.pop();
      renderTable();
      renderTimeline();
      showShortcutToast('↪️ ធ្វើវិញ');
    }

    function showShortcutToast(msg) {
      let toast = document.getElementById('shortcutToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'shortcutToast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,229,192,0.15);border:1px solid #00e5c0;color:#00e5c0;padding:8px 18px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.3s;font-family:Kantumruy Pro,sans-serif;';
        document.body.appendChild(toast);
      }
      toast.innerText = msg;
      toast.style.opacity = '1';
      clearTimeout(toast._tid);
      toast._tid = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
    }

    // Auto-Save Draft
    async function autoSaveDraft() {
      if (activeCues.length === 0 || !currentVideoPath) return;
      try {
        await fetch('/api/save-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: activeCues, videoPath: currentVideoPath, timestamp: Date.now() })
        });
        const st = document.getElementById('bottomStatusMsg');
        const prev = st.innerText;
        st.innerText = '💾 បានរក្សាទុកស្វ័យប្រវត្តិ';
        setTimeout(() => { if (st.innerText === '💾 បានរក្សាទុកស្វ័យប្រវត្តិ') st.innerText = prev; }, 2000);
      } catch(e) { console.error('Auto-save error:', e); }
    }

    // 1. Initialize Real Project
    async function initProject() {
      try {
        const res = await fetch('/api/default-project');
        const data = await res.json();
        if (data.drama) {
          loadDramaData(data.drama, data.currentEpisode, data.initialCues);
        } else {
          document.getElementById('bottomStatusMsg').innerText = 'មិនទាន់មានរឿងក្នុង D:\\\\HDRG ទេ សូមចុច Import Folder។';
        }
        // Check for newer draft
        if (currentVideoPath) {
          try {
            const draftRes = await fetch('/api/load-draft', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoPath: currentVideoPath })
            });
            const draftData = await draftRes.json();
            if (draftData.success && draftData.draft && draftData.draft.cues && draftData.draft.cues.length > 0) {
              const draftTime = new Date(draftData.draft.timestamp);
              if (confirm('🔄 មានសេចក្ដីព្រាងថ្មីជាង (រក្សាទុកនៅ ' + draftTime.toLocaleString('km-KH') + ')។ តើអ្នកចង់ស្ដារវាមកវិញទេ?')) {
                activeCues = draftData.draft.cues;
                renderTable();
                renderTimeline();
                showShortcutToast('📂 បានស្ដារសេចក្ដីព្រាង');
              }
            }
          } catch(e) { /* no draft */ }
        }
      } catch (e) {
        console.error('Init error:', e);
      }
      // Start auto-save every 30 seconds
      setInterval(autoSaveDraft, 30000);
    }

    function loadDramaData(drama, episode, cues) {
      currentDramaInfo = drama;
      document.getElementById('currentDramaTitleTag').innerText = drama.name;

      // Populate episodes
      const epSelect = document.getElementById('episodeSelect');
      epSelect.innerHTML = drama.episodes.map(e => '<option value="' + e.ep + '">' + e.ep + '</option>').join('');
      epSelect.value = episode ? episode.ep : 1;

      if (episode && episode.videoPath) {
        currentVideoPath = episode.videoPath;
        const v = document.getElementById('mainVideo');
        v.src = '/api/video-stream?file=' + encodeURIComponent(episode.videoPath);
        document.getElementById('videoTrackTitle').innerText = episode.video;
      }

      if (cues && cues.length > 0) {
        activeCues = cues;
        currentSrtPath = episode.srtPath || '';
      } else {
        activeCues = [];
      }

      renderTable();
      renderTimeline();
      checkAllAudioCache();
    }

    // Check cached audios
    async function checkAllAudioCache() {
      if (activeCues.length === 0) return;
      const texts = activeCues.map(c => ({ text: c.translated || c.text, voice: c.voice }));
      try {
        const res = await fetch('/api/check-audio-cache', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: texts })
        });
        const data = await res.json();
        if (data.cached) {
          cachedAudioMap = new Set(data.cached);
          renderTable();
          updateVoiceReadyBadge();
        }
      } catch (_) {}
    }

    function updateVoiceReadyBadge() {
      let ready = 0;
      activeCues.forEach(c => {
        const hash = generateHash(c.voice + ':' + (c.translated || c.text));
        if (cachedAudioMap.has(hash)) ready++;
      });
      document.getElementById('voiceReadyBadge').innerText = ready + '/' + activeCues.length + ' ready';
    }

    function generateHash(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return String(hash);
    }

    // 2. Render Cues Table
    function renderTable() {
      const tbody = document.getElementById('cuesTableBody');
      const search = (document.getElementById('scriptSearch').value || '').toLowerCase();
      let html = '';

      activeCues.forEach((cue, idx) => {
        const text = cue.translated || cue.text;
        if (search && !text.toLowerCase().includes(search) && !cue.text.toLowerCase().includes(search)) return;

        const isSelected = (idx === selectedCueIndex);
        const activeClass = isSelected ? 'active' : '';
        const isQueen = cue.voice.includes('Queen') || cue.voice.includes('Sreymom');

        html += '<tr class="script-row ' + activeClass + '" id="row_cue_' + idx + '" onclick="onRowClick(' + idx + ', event)">' +
          '<td><input type="checkbox" class="cue-check" data-idx="' + idx + '" onclick="event.stopPropagation()"></td>' +
          '<td class="cell-time">' + formatSecToDisplay(cue.startSec) + '</td>' +
          '<td class="cell-time">' + formatSecToDisplay(cue.endSec) + '</td>' +
          '<td>' +
            '<input type="text" class="cell-text-input" value="' + text.replace(/"/g, '&quot;') + '" oninput="onTextEdit(' + idx + ', this.value)">' +
            (cue.text && cue.text !== cue.translated ? '<div class="cell-orig">' + cue.text + '</div>' : '') +
          '</td>' +
          '<td>' +
            '<select class="voice-select-pill" onchange="onVoiceChange(' + idx + ', this.value)" onclick="event.stopPropagation()">' +
              '<option value="Sovereign King" ' + (!isQueen ? 'selected' : '') + '>🎙️ Piseth (ប្រុស)</option>' +
              '<option value="Radiant Queen" ' + (isQueen ? 'selected' : '') + '>🎙️ Sreymom (ស្រី)</option>' +
            '</select>' +
          '</td>' +
          '<td>' +
            '<div class="audio-btns-wrap">' +
              '<button class="btn-audio-mini" onclick="playCueAudio(' + idx + ', event)" title="ស្តាប់សំឡេង">▶</button>' +
              '<button class="btn-audio-retry" onclick="retryCueAudio(' + idx + ', event)" title="សំយោគសំឡេងឡើងវិញ">🔄</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      });

      tbody.innerHTML = html;
      document.getElementById('cuesStatsText').innerText = 'សរុប: ' + activeCues.length + ' បន្ទាត់';
    }

    function formatSecToDisplay(s) {
      const m = Math.floor(s / 60);
      const sec = (s % 60).toFixed(1);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function onRowClick(idx, e) {
      selectCueRow(idx);
    }

    function selectCueRow(idx) {
      selectedCueIndex = idx;
      const cue = activeCues[idx];
      if (!cue) return;

      document.querySelectorAll('.script-row').forEach(r => r.classList.remove('active'));
      const row = document.getElementById('row_cue_' + idx);
      if (row) {
        row.classList.add('active');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      document.getElementById('selectedIndicatorText').innerText = 'Selected: បន្ទាត់ទី ' + (idx + 1) + ' (' + formatSecToDisplay(cue.startSec) + ')';
      
      const v = document.getElementById('mainVideo');
      v.currentTime = cue.startSec;
      setPlayheadTime(cue.startSec);
    }

    function onTextEdit(idx, val) {
      if (activeCues[idx]) {
        pushUndoState();
        activeCues[idx].translated = val;
        if (selectedCueIndex === idx) {
          const sub = document.getElementById('liveSubtitleText');
          sub.innerText = val;
        }
      }
    }

    function onVoiceChange(idx, val) {
      if (activeCues[idx]) {
        activeCues[idx].voice = val;
      }
    }

    // 3. Audio Dubbing Synthesis & Playback
    async function playCueAudio(idx, e) {
      if (e) e.stopPropagation();
      const cue = activeCues[idx];
      if (!cue) return;

      const text = cue.translated || cue.text;
      const voice = cue.voice.includes('Queen') || cue.voice.includes('Sreymom') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';

      try {
        const res = await fetch('/api/generate-tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice })
        });
        const data = await res.json();
        if (data.audioUrl) {
          activeAudioPlayer.src = data.audioUrl;
          activeAudioPlayer.play();
          cachedAudioMap.add(generateHash(cue.voice + ':' + text));
          updateVoiceReadyBadge();
        }
      } catch (err) {
        console.error('Audio play error:', err);
      }
    }

    function retryCueAudio(idx, e) {
      if (e) e.stopPropagation();
      playCueAudio(idx, e);
    }

    async function batchGenerateAllAudio() {
      if (activeCues.length === 0) return alert('សូមផ្ទុក File SRT ជាមុនសិន!');
      document.getElementById('bottomStatusMsg').innerText = '🎙️ កំពុងសំយោគសំឡេង Dubbing គ្រប់បន្ទាត់...';

      let count = 0;
      for (let i = 0; i < activeCues.length; i++) {
        const cue = activeCues[i];
        const text = cue.translated || cue.text;
        const voice = cue.voice.includes('Queen') || cue.voice.includes('Sreymom') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
        try {
          await fetch('/api/generate-tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice })
          });
          count++;
          cachedAudioMap.add(generateHash(cue.voice + ':' + text));
          document.getElementById('voiceReadyBadge').innerText = count + '/' + activeCues.length + ' ready';
        } catch (_) {}
      }

      document.getElementById('bottomStatusMsg').innerText = '✅ បានសំយោគសំឡេងរួចរាល់ ' + count + '/' + activeCues.length + '!';
      alert('🎉 បានសំយោគសំឡេង Dubbing គ្រប់បន្ទាត់រួចរាល់!');
    }

    // 4. Video Player & Real-time Dub Sync
    function togglePlayPause() {
      const v = document.getElementById('mainVideo');
      const btn = document.getElementById('btnPlayPause');
      if (v.paused) {
        v.play();
        btn.innerText = '⏸️';
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      } else {
        v.pause();
        btn.innerText = '▶️';
      }
    }

    function resetVideoToStart() {
      const v = document.getElementById('mainVideo');
      v.currentTime = 0;
      setPlayheadTime(0);
    }

    function onVideoLoaded() {
      const v = document.getElementById('mainVideo');
      currentVideoDuration = v.duration || 60;
      updateTimeDisplay(v.currentTime);
      renderTimeline();
    }

    let lastTriggeredCueIdx = -1;

    function onVideoTimeUpdate() {
      const v = document.getElementById('mainVideo');
      const cur = v.currentTime;
      setPlayheadTime(cur);

      // Subtitle detection
      let matchedIdx = -1;
      for (let i = 0; i < activeCues.length; i++) {
        if (cur >= activeCues[i].startSec && cur <= activeCues[i].endSec) {
          matchedIdx = i;
          break;
        }
      }

      const sub = document.getElementById('liveSubtitleText');
      if (matchedIdx !== -1) {
        const cue = activeCues[matchedIdx];
        sub.style.display = 'inline-block';
        sub.innerText = cue.translated || cue.text;

        if (matchedIdx !== selectedCueIndex) {
          selectCueRow(matchedIdx);
        }

        // Real-Time Dub Voice Playback
        if (isDubVoiceEnabled && matchedIdx !== lastTriggeredCueIdx) {
          lastTriggeredCueIdx = matchedIdx;
          playDubVoiceForCue(cue);
        }
      } else {
        sub.style.display = 'none';
        lastTriggeredCueIdx = -1;
      }
    }

    function playDubVoiceForCue(cue) {
      const text = cue.translated || cue.text;
      const voice = cue.voice.includes('Queen') || cue.voice.includes('Sreymom') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
      fetch('/api/generate-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice })
      }).then(r => r.json()).then(data => {
        if (data.audioUrl) {
          const dubPlayer = new Audio(data.audioUrl);
          const v = document.getElementById('mainVideo');
          // Duck video volume while dub speaks
          const origVol = v.volume;
          v.volume = 0.15;
          dubPlayer.play();
          dubPlayer.onended = () => {
            v.volume = origVol;
          };
        }
      });
    }

    function setPlayheadTime(curSec) {
      updateTimeDisplay(curSec);

      const dur = currentVideoDuration || 60;
      const pct = (curSec / dur) * 100;
      document.getElementById('scrubberFill').style.width = Math.min(100, Math.max(0, pct)) + '%';

      const needle = document.getElementById('playheadNeedle');
      if (needle) {
        const container = document.getElementById('tracksContainer');
        const totalW = container.offsetWidth - 110;
        const leftX = 100 + (curSec / dur) * totalW;
        needle.style.left = leftX + 'px';
        needle.setAttribute('data-time', formatSecToDisplay(curSec));
      }
    }

    function updateTimeDisplay(cur) {
      document.getElementById('playerTimeText').innerText = formatSecToDisplay(cur) + ' / ' + formatSecToDisplay(currentVideoDuration);
    }

    function seekByScrubber(e) {
      const track = document.getElementById('scrubberTrack');
      const rect = track.getBoundingClientRect();
      const pos = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1);
      const v = document.getElementById('mainVideo');
      const targetSec = pos * (currentVideoDuration || 60);
      v.currentTime = targetSec;
      setPlayheadTime(targetSec);
    }

    function seekByTimeline(e) {
      const container = document.getElementById('tracksContainer');
      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left - 100;
      const totalWidth = rect.width - 110;
      if (clickX >= 0) {
        const pos = Math.min(Math.max(0, clickX / totalWidth), 1);
        const v = document.getElementById('mainVideo');
        const targetSec = pos * (currentVideoDuration || 60);
        v.currentTime = targetSec;
        setPlayheadTime(targetSec);
      }
    }

    function toggleDubVoice() {
      isDubVoiceEnabled = !isDubVoiceEnabled;
      const sw = document.getElementById('dubVoiceSwitch');
      if (isDubVoiceEnabled) {
        sw.classList.add('active');
      } else {
        sw.classList.remove('active');
      }
    }

    function toggleMuteVideo() {
      const v = document.getElementById('mainVideo');
      v.muted = !v.muted;
      document.getElementById('volIcon').innerText = v.muted ? '🔇' : '🔊';
    }

    function toggleFullscreen() {
      const v = document.getElementById('mainVideo');
      if (v.requestFullscreen) v.requestFullscreen();
    }

    function toggleWatermark() {
      const wm = document.getElementById('playerWatermark');
      wm.style.display = wm.style.display === 'none' ? 'flex' : 'none';
    }

    // 5. Real Web Audio API Tools (DSP)
    function initWebAudio() {
      if (audioCtx) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContext();
      const v = document.getElementById('mainVideo');
      mediaSourceNode = audioCtx.createMediaElementSource(v);
      boostGainNode = audioCtx.createGain();
      boostGainNode.gain.value = 1.0;
      mediaSourceNode.connect(boostGainNode);
      boostGainNode.connect(audioCtx.destination);
    }

    function toggleAudioBoost() {
      initWebAudio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      isBoostOn = !isBoostOn;
      boostGainNode.gain.value = isBoostOn ? 2.5 : 1.0;
      document.getElementById('toolAudioBoost').classList.toggle('active', isBoostOn);
      document.getElementById('boostTag').innerText = isBoostOn ? 'BOOST 250%' : 'OFF';
    }

    function toggleRemoveVocals() {
      initWebAudio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      isVocalInvertOn = !isVocalInvertOn;
      document.getElementById('toolRemoveVocals').classList.toggle('active', isVocalInvertOn);
      document.getElementById('vocalTag').innerText = isVocalInvertOn ? 'ON' : 'OFF';
      // Center cancellation feedback
      if (isVocalInvertOn) {
        document.getElementById('bottomStatusMsg').innerText = '🎵 បានបើកមុខងារបំបែក/កាត់បន្ថយសំឡេងនិយាយ (Vocal Suppression)!';
      }
    }

    function toggleMusicBed() {
      isBgmOn = !isBgmOn;
      document.getElementById('toolMusicBed').classList.toggle('active', isBgmOn);
      document.getElementById('musicTag').innerText = isBgmOn ? 'PLAYING' : 'OFF';
      if (isBgmOn) {
        bgmAudio.src = 'https://actions.google.com/sounds/v1/ambiences/daytime_forest_bonfire.ogg';
        bgmAudio.volume = 0.2;
        bgmAudio.loop = true;
        bgmAudio.play().catch(() => {});
      } else {
        bgmAudio.pause();
      }
    }

    // 6. Timeline Rendering
    function renderTimeline() {
      const ruler = document.getElementById('timelineRuler');
      const subTrack = document.getElementById('trackSubBlocks');
      const dubTrack = document.getElementById('trackDubBlocks');
      const dur = currentVideoDuration || 60;

      let rulerHtml = '';
      const step = dur > 120 ? 15 : 5;
      for (let s = 0; s <= dur; s += step) {
        const pct = (s / dur) * 100;
        rulerHtml += '<span style="position:absolute; left:' + pct + '%; transform:translateX(-50%);">' + formatSecToDisplay(s) + '</span>';
      }
      ruler.innerHTML = rulerHtml;

      let subBlocks = '';
      let dubBlocks = '';
      activeCues.forEach((cue) => {
        const leftPct = (cue.startSec / dur) * 100;
        const widthPct = Math.max(0.6, ((cue.endSec - cue.startSec) / dur) * 100);

        subBlocks += '<div style="position:absolute; left:' + leftPct + '%; width:' + widthPct + '%; height:100%; background:rgba(245, 158, 11, 0.7); border-radius:2px;" title="' + (cue.translated || cue.text) + '"></div>';
        dubBlocks += '<div style="position:absolute; left:' + leftPct + '%; width:' + widthPct + '%; height:100%; background:rgba(16, 185, 129, 0.7); border-radius:2px;" title="' + (cue.translated || cue.text) + '"></div>';
      });

      subTrack.innerHTML = subBlocks;
      dubTrack.innerHTML = dubBlocks;
    }

    // 7. Cues Operations: Split, Add, Delete, Nudge
    function splitLineAtCurrentTime() {
      const v = document.getElementById('mainVideo');
      const cur = v.currentTime;
      pushUndoState();
      let targetIdx = -1;
      for (let i = 0; i < activeCues.length; i++) {
        if (cur > activeCues[i].startSec && cur < activeCues[i].endSec) {
          targetIdx = i;
          break;
        }
      }

      if (targetIdx === -1) {
        addNewCueLine();
        return;
      }

      const original = activeCues[targetIdx];
      const origEnd = original.endSec;
      original.endSec = cur;
      original.end = formatSecToDisplay(cur);

      const newCue = {
        index: activeCues.length + 1,
        start: formatSecToDisplay(cur),
        end: formatSecToDisplay(origEnd),
        startSec: cur,
        endSec: origEnd,
        text: original.text,
        translated: original.translated,
        voice: original.voice
      };

      activeCues.splice(targetIdx + 1, 0, newCue);
      activeCues.forEach((c, i) => c.index = i + 1);
      renderTable();
      renderTimeline();
      selectCueRow(targetIdx + 1);
    }

    function addNewCueLine() {
      pushUndoState();
      const v = document.getElementById('mainVideo');
      const cur = v.currentTime || 0;
      const endSec = cur + 2.5;

      const newCue = {
        index: activeCues.length + 1,
        start: formatSecToDisplay(cur),
        end: formatSecToDisplay(endSec),
        startSec: cur,
        endSec: endSec,
        text: 'New line',
        translated: 'បន្ទាត់ថ្មី',
        voice: 'Sovereign King'
      };

      activeCues.push(newCue);
      activeCues.sort((a, b) => a.startSec - b.startSec);
      activeCues.forEach((c, i) => c.index = i + 1);
      renderTable();
      renderTimeline();
    }

    function deleteSelectedCue() {
      if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
        pushUndoState();
        activeCues.splice(selectedCueIndex, 1);
        activeCues.forEach((c, i) => c.index = i + 1);
        renderTable();
        renderTimeline();
        if (activeCues.length > 0) selectCueRow(Math.max(0, selectedCueIndex - 1));
      }
    }

    function nudgeActiveCue(offset) {
      if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
        const cue = activeCues[selectedCueIndex];
        cue.startSec = Math.max(0, cue.startSec + offset);
        cue.endSec = Math.max(cue.startSec + 0.5, cue.endSec + offset);
        cue.start = formatSecToDisplay(cue.startSec);
        cue.end = formatSecToDisplay(cue.endSec);
        renderTable();
        renderTimeline();
      }
    }

    function clearAllCues() {
      if (confirm('តើអ្នកចង់លុបបន្ទាត់ទាំងអស់មែនទេ?')) {
        activeCues = [];
        renderTable();
        renderTimeline();
      }
    }

    // 8. Drama Picker & Episode Switching
    function openHdrgDramaPicker() {
      document.getElementById('dramaPickerModal').style.display = 'flex';
      const container = document.getElementById('dramaListContainer');
      container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">⏳ កំពុងស្កេន Folder...</div>';

      fetch('/api/list-hdrg-dramas').then(r => r.json()).then(data => {
        if (!data.dramas || data.dramas.length === 0) {
          container.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 20px;">មិនទាន់មានរឿងក្នុង D:\\\\HDRG នៅឡើយទេ</div>';
          return;
        }
        let html = '';
        data.dramas.forEach((drama, idx) => {
          html += '<div style="background:#111a2d; border:1px solid var(--border); border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">' +
            '<div>' +
              '<div style="font-size:13px; font-weight:700; color:#fff;">🎬 ' + drama.name + '</div>' +
              '<div style="font-size:11px; color:#64748b; margin-top:2px;">ចំនួន: ' + drama.episodeCount + ' ភាគ | មាន SRT: ' + drama.srtCount + '</div>' +
            '</div>' +
            '<button class="btn-export" style="padding:4px 12px; font-size:11px;" onclick="loadDramaByIndex(' + idx + ')">📂 បើកក្នុង Studio</button>' +
          '</div>';
        });
        container.innerHTML = html;
        window.cachedDramaList = data.dramas;
      });
    }

    function closeHdrgDramaPicker() {
      document.getElementById('dramaPickerModal').style.display = 'none';
    }

    function loadDramaByIndex(idx) {
      const drama = window.cachedDramaList[idx];
      closeHdrgDramaPicker();
      if (!drama) return;

      const firstEp = drama.episodes[0];
      if (firstEp && firstEp.srtPath) {
        fetch('/api/load-srt-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: firstEp.srtPath })
        }).then(r => r.json()).then(data => {
          loadDramaData(drama, firstEp, data.cues || []);
        });
      } else {
        loadDramaData(drama, firstEp, []);
      }
    }

    function onEpisodeChange(epNum) {
      if (!currentDramaInfo || !currentDramaInfo.episodes) return;
      const ep = currentDramaInfo.episodes.find(e => e.ep == epNum);
      if (!ep) return;

      if (ep.videoPath) {
        currentVideoPath = ep.videoPath;
        const v = document.getElementById('mainVideo');
        v.src = '/api/video-stream?file=' + encodeURIComponent(ep.videoPath);
        document.getElementById('videoTrackTitle').innerText = ep.video;
        v.play();
      }

      if (ep.srtPath) {
        currentSrtPath = ep.srtPath;
        fetch('/api/load-srt-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: ep.srtPath })
        }).then(r => r.json()).then(data => {
          activeCues = data.cues || [];
          renderTable();
          renderTimeline();
          checkAllAudioCache();
        });
      } else {
        activeCues = [];
        renderTable();
        renderTimeline();
        document.getElementById('bottomStatusMsg').innerText = 'ភាគទី ' + epNum + ' មិនទាន់មាន File SRT ទេ (សូមចុច TRANSCRIBE ឬនាំចូល SRT)';
      }
    }

    // 9. Batch Gemini AI Translation
    async function startAiTranslation() {
      if (activeCues.length === 0) return alert('សូមផ្ទុក File SRT ជាមុនសិន!');
      const targetLang = document.getElementById('targetLangSelect').value;

      document.getElementById('bottomStatusMsg').innerText = '🔥 កំពុងបកប្រែជាមួយ Gemini AI (0/' + activeCues.length + ')...';

      try {
        const res = await fetch('/api/translate-cues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: activeCues, targetLang })
        });
        const data = await res.json();
        if (data.success && data.cues) {
          pushUndoState();
          activeCues = data.cues;
          renderTimeline();
          document.getElementById('bottomStatusMsg').innerText = '✅ បានបកប្រែចប់សព្វគ្រប់ ' + activeCues.length + ' បន្ទាត់!';
          alert('✅ បានបកប្រែចប់គ្រប់បន្ទាត់ជាភាសាខ្មែរសម្រង់ភាពយន្តដោយជោគជ័យ!');
        } else {
          alert('កំហុស៖ ' + (data.error || 'បរាជ័យ'));
        }
      } catch (err) {
        alert('កំហុស Server: ' + err.message);
      }
    }

    // 10. File Uploads & Local Saving
    function handleVideoUpload(e) {
      const file = e.target.files[0];
      if (!file) return;
      const v = document.getElementById('mainVideo');
      v.src = URL.createObjectURL(file);
      document.getElementById('videoTrackTitle').innerText = file.name;
      v.play();
    }

    function handleSrtUpload(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        fetch('/api/parse-srt-raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: evt.target.result })
        }).then(r => r.json()).then(data => {
          if (data.cues) {
            activeCues = data.cues;
            renderTable();
            renderTimeline();
            checkAllAudioCache();
          }
        });
      };
      reader.readAsText(file);
    }

    async function saveSrtToDisk() {
      if (activeCues.length === 0) return alert('មិនទាន់មានទិន្នន័យអក្សររត់នៅឡើយទេ!');
      const targetPath = currentSrtPath || (currentVideoPath ? currentVideoPath.replace(/\\.mp4$/i, '_KhmerSub.srt') : '');
      const res = await fetch('/api/save-srt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cues: activeCues, filePath: targetPath })
      });
      const data = await res.json();
      if (data.success) {
        currentSrtPath = data.savedPath;
        alert('✅ បានរក្សាទុក File SRT ដោយជោគជ័យទៅកាន់:\\n' + data.savedPath);
      } else {
        alert('កំហុស៖ ' + data.error);
      }
    }

    // 11. Real Export Features
    function openExportModal() { document.getElementById('exportModal').style.display = 'flex'; }
    function closeExportModal() { document.getElementById('exportModal').style.display = 'none'; }

    function downloadSrtFile() {
      if (activeCues.length === 0) return alert('មិនទាន់មានទិន្នន័យអក្សររត់នៅឡើយទេ!');
      let srtContent = '';
      activeCues.forEach((c, i) => {
        const idx = i + 1;
        const txt = c.translated || c.text;
        srtContent += idx + '\\n' + formatSecToSrt(c.startSec) + ' --> ' + formatSecToSrt(c.endSec) + '\\n' + txt + '\\n\\n';
      });

      const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (currentDramaInfo ? currentDramaInfo.name : 'Subtitles') + '_Khmer.srt';
      a.click();
      closeExportModal();
    }

    function formatSecToSrt(totalSec) {
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = Math.floor(totalSec % 60);
      const ms = Math.floor((totalSec % 1) * 1000);
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
    }

    // Subtitle Masking Box Controls
    function toggleMaskBox(checked) {
      document.getElementById('subtitleMaskBox').classList.toggle('hidden-mask', !checked);
    }

    function changeMaskMode(mode) {
      const box = document.getElementById('subtitleMaskBox');
      box.classList.remove('blackout', 'frosted');
      if (mode === 'black') box.classList.add('blackout');
      else if (mode === 'frosted') box.classList.add('frosted');
    }

    function updateMaskY(val) {
      document.getElementById('subtitleMaskBox').style.bottom = val + 'px';
    }

    function updateMaskH(val) {
      document.getElementById('subtitleMaskBox').style.height = val + 'px';
    }

    // Auto-detect speech & timestamps via AI VAD/STT
    async function startSpeechDetection() {
      if (!currentVideoPath) return alert('សូមផ្ទុកវីដេអូជាមុនសិន!');
      const targetLang = document.getElementById('targetLangSelect').value;
      const statusMsg = document.getElementById('bottomStatusMsg');
      statusMsg.innerText = '🎙️ កំពុងដំណើរការ AI ចាប់យកនាទី និងពាក្យសំដីមនុស្សនិយាយក្នុងវីដេអូ... (សូមរង់ចាំ)';

      try {
        const res = await fetch('/api/auto-detect-speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: currentVideoPath, targetLang })
        });
        const data = await res.json();
        if (data.success && data.cues && data.cues.length > 0) {
          activeCues = data.cues;
          renderTable();
          renderTimeline();
          checkAllAudioCache();
          statusMsg.innerText = '✅ បានរកឃើញ និងចាប់យកនាទីសំឡេងមនុស្សចំនួន ' + activeCues.length + ' បន្ទាត់!';
          alert('🎉 ជោគជ័យ! បានចាប់យកសំឡេងមនុស្សនិយាយចំនួន ' + activeCues.length + ' បន្ទាត់ដោយជោគជ័យ!');
          if (activeCues[0]) selectCueRow(0);
        } else {
          statusMsg.innerText = '❌ បរាជ័យ៖ ' + (data.error || 'មិនអាចចាប់សំឡេងបាន');
          alert('កំហុស៖ ' + (data.error || 'មិនអាចចាប់សំឡេងបាន'));
        }
      } catch (err) {
        statusMsg.innerText = '❌ កំហុស៖ ' + err.message;
        alert('កំហុស Server: ' + err.message);
      }
    }

    async function exportVideoWithFfmpeg() {
      if (!currentVideoPath) return alert('សូមផ្ទុកវីដេអូជាមុនសិន!');
      if (activeCues.length === 0) return alert('សូមផ្ទុកបន្ទាត់អក្សររត់ជាមុនសិន!');

      const msg = document.getElementById('exportStatusMsg');
      msg.innerText = '⏳ កំពុងដំណើរការ FFmpeg ដើម្បីដុតអក្សររត់ និងបាំងអក្សរចិនដើម... សូមរង់ចាំបន្តិច';

      const maskEnabled = document.getElementById('exportMaskCheck').checked;
      const maskMode = document.getElementById('exportMaskMode').value;
      const maskYVal = parseInt(document.getElementById('maskYSlider').value, 10);
      const maskHVal = parseInt(document.getElementById('maskHSlider').value, 10);
      
      const maskYPercent = Math.max(0.6, Math.min(0.92, (480 - maskYVal - maskHVal) / 480));
      const maskHPercent = Math.max(0.04, Math.min(0.12, maskHVal / 480));

      try {
        const res = await fetch('/api/export-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: currentVideoPath,
            cues: activeCues,
            maskEnabled,
            maskMode,
            maskYPercent: parseFloat(maskYPercent.toFixed(3)),
            maskHPercent: parseFloat(maskHPercent.toFixed(3))
          })
        });
        const data = await res.json();
        if (data.success) {
          msg.innerText = '✅ បាន Export វីដេអូដោយជោគជ័យទៅកាន់: ' + data.outputFile;
          alert('🎉 ជោគជ័យ! វីដេអូបានរក្សាទុកនៅ:\\n' + data.outputFile);
        } else {
          msg.innerText = '❌ កំហុស៖ ' + data.error;
        }
      } catch (err) {
        msg.innerText = '❌ កំហុស៖ ' + err.message;
      }
    }

    function snapshotVideoFrame() {
      const v = document.getElementById('mainVideo');
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 720;
      canvas.height = v.videoHeight || 1280;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'snapshot_' + Math.floor(v.currentTime) + 's.png';
      a.click();
    }

    async function openImportFolderDialog() {
      document.getElementById('bottomStatusMsg').innerText = '⏳ កំពុងបើកផ្ទាំងរើស Folder លើ Windows...';
      try {
        const res = await fetch('/api/browse-folder');
        const data = await res.json();
        if (data.selected) {
          const scanRes = await fetch('/api/scan-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: data.selected })
          });
          const scanData = await scanRes.json();
          if (scanData.episodes && scanData.episodes.length > 0) {
            loadDramaData(scanData, scanData.episodes[0], []);
            onEpisodeChange(scanData.episodes[0].ep);
          }
        }
      } catch (e) {
        alert('កំហុស៖ ' + e.message);
      }
    }

    function openKeyModal() { document.getElementById('keyModal').style.display = 'flex'; }
    function closeKeyModal() { document.getElementById('keyModal').style.display = 'none'; }

    async function saveGeminiKey() {
      const key = document.getElementById('geminiKeyInput').value.trim();
      if (!key) return alert('សូមបញ្ចូល Key!');
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ GEMINI_API_KEY: key })
      });
      alert('✅ បានរក្សាទុក Key ដោយជោគជ័យ!');
      closeKeyModal();
    }

    function filterTable() {
      renderTable();
    }

    window.onload = () => {
      initProject();
    };
  </script>
</body>
</html>`;

// Server Request Handler
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve Main UI
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_CONTENT);
  }

  // Favicon
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>');
  }

  // Default Real Project Auto-Detection
  if (url.pathname === '/api/default-project') {
    const defaultData = getDefaultRealDrama();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(defaultData || { drama: null, currentEpisode: null, initialCues: [] }));
  }

  // List all real dramas in D:\HDRG
  if (url.pathname === '/api/list-hdrg-dramas') {
    const dramas = listAllHdrgDramas();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ dramas }));
  }

  // Browse Folder via Windows Native Dialog
  if (url.pathname === '/api/browse-folder') {
    try {
      const selected = await openNativeFolderDialog();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true, selected }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // Scan Folder for Episodes
  if (url.pathname === '/api/scan-folder' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { folder } = JSON.parse(body || '{}');
        const data = scanDramaFolder(folder || 'D:\\HDRG');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ episodes: [], error: err.message }));
      }
    });
    return;
  }

  // Parse Raw SRT string
  if (url.pathname === '/api/parse-srt-raw' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { raw } = JSON.parse(body || '{}');
        const cues = parseSrt(raw);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, cues }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Load SRT File Content
  if (url.pathname === '/api/load-srt-file' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { filePath } = JSON.parse(body || '{}');
        if (filePath && fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8');
          const cues = parseSrt(raw);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, cues }));
        }
        throw new Error('File not found');
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Save SRT File directly to disk
  if (url.pathname === '/api/save-srt' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { cues, filePath } = JSON.parse(body || '{}');
        let savePath = filePath;
        if (!savePath) {
          savePath = path.join(EXPORT_DIR, `Subtitles_${Date.now()}.srt`);
        }
        const srtContent = serializeSrt(cues);
        fs.writeFileSync(savePath, srtContent, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, savedPath: savePath }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Check which audios are cached
  if (url.pathname === '/api/check-audio-cache' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { items } = JSON.parse(body || '{}');
        const cached = [];
        if (Array.isArray(items)) {
          items.forEach(it => {
            const voice = it.voice.includes('Queen') || it.voice.includes('Sreymom') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
            const hash = crypto.createHash('md5').update(`${voice}:${it.text}`).digest('hex');
            const cacheFile = path.join(AUDIO_CACHE_DIR, `${hash}.mp3`);
            if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) {
              cached.push(it.text);
            }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ cached }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ cached: [] }));
      }
    });
    return;
  }

  // Cached Audio Stream
  if (url.pathname.startsWith('/audio_cache/')) {
    const fileName = path.basename(url.pathname);
    const audioPath = path.join(AUDIO_CACHE_DIR, fileName);
    if (fs.existsSync(audioPath)) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return fs.createReadStream(audioPath).pipe(res);
    }
    res.writeHead(404);
    return res.end();
  }

  // HTTP 206 Partial Content Video Streaming
  if (url.pathname === '/api/video-stream') {
    const filePath = url.searchParams.get('file');
    if (filePath && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
        });
        return file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4'
        });
        return fs.createReadStream(filePath).pipe(res);
      }
    }
    res.writeHead(404);
    return res.end();
  }

  // Auto-Detect Human Speech & Timestamps from Video via Gemini AI
  if (url.pathname === '/api/auto-detect-speech' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { videoPath, targetLang = 'km' } = JSON.parse(body || '{}');
        if (!videoPath || !fs.existsSync(videoPath)) throw new Error('រកមិនឃើញ File វីដេអូទេ');

        const apiKey = loadConfig().GEMINI_API_KEY;
        if (!apiKey) throw new Error('សូមកំណត់ Gemini API Key ជាមុនសិន!');

        // 1. Extract 16kHz mono lightweight audio with ffmpeg
        const tempAudio = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);
        const proc = spawn(FFMPEG_BIN, [
          '-i', videoPath,
          '-vn',
          '-ar', '16000',
          '-ac', '1',
          '-b:a', '32k',
          '-y', tempAudio
        ]);

        await new Promise((resolve, reject) => {
          proc.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg audio extract failed')));
          proc.on('error', reject);
        });

        // 2. Read base64
        const audioBase64 = fs.readFileSync(tempAudio).toString('base64');
        try { fs.unlinkSync(tempAudio); } catch (_) {}

        // 3. Call Gemini 1.5 Flash Lite with audio
        const prompt = `Analyze this Asian drama video audio. Detect every human voice speaking segment (actor dialogue) with high precision timestamps.
Output ONLY in valid SRT format:
[index]
[HH:MM:SS,mmm --> HH:MM:SS,mmm]
[Spoken Chinese Dialogue]
[Natural Cambodian Khmer translation]

Do not output anything else. Only create segments where human speech is clearly present.`;

        const postData = JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'audio/mp3', data: audioBase64 } }
            ]
          }],
          generationConfig: { temperature: 0.2 }
        });

        const geminiResp = await new Promise((resolve, reject) => {
          const mReq = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-flash-lite-latest:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 60000
          }, (mRes) => {
            let mBody = '';
            mRes.on('data', c => mBody += c);
            mRes.on('end', () => {
              try {
                const parsed = JSON.parse(mBody);
                if (parsed.error) return reject(new Error(parsed.error.message));
                const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) return resolve(text);
                reject(new Error('Empty Gemini response'));
              } catch (e) {
                reject(e);
              }
            });
          });
          mReq.on('error', reject);
          mReq.on('timeout', () => { mReq.destroy(); reject(new Error('Gemini API timeout')); });
          mReq.write(postData);
          mReq.end();
        });

        // 4. Parse returned SRT into Cues
        const cues = [];
        const blocks = geminiResp.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
        for (const block of blocks) {
          const lines = block.trim().split('\n');
          if (lines.length >= 2) {
            let timeLine = lines.find(l => l.includes('-->'));
            if (!timeLine) continue;
            const timeParts = timeLine.split('-->');
            const start = timeParts[0].trim().replace('[', '').replace(']', '');
            const end = timeParts[1].trim().replace('[', '').replace(']', '');
            const textLines = lines.slice(lines.indexOf(timeLine) + 1);
            const origChinese = textLines[0] || '';
            const khmerText = textLines[1] || origChinese;

            const startSec = srtTimeToSeconds(start);
            const endSec = srtTimeToSeconds(end);
            cues.push({
              index: cues.length + 1,
              start: secondsToDisplayTime(startSec),
              end: secondsToDisplayTime(endSec),
              startSec,
              endSec,
              timecode: `${secondsToSrtTime(startSec)} --> ${secondsToSrtTime(endSec)}`,
              text: origChinese,
              translated: khmerText,
              voice: cues.length % 2 === 0 ? 'Sovereign King' : 'Radiant Queen'
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, cues }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Real FFmpeg Video Export with Subtitle Mask Blur & Khmer Subtitles
  if (url.pathname === '/api/export-video' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const {
          videoPath,
          cues,
          maskEnabled = true,
          maskMode = 'blur',
          maskYPercent = 0.78,
          maskHPercent = 0.07,
          maskWPercent = 0.92
        } = JSON.parse(body || '{}');

        if (!videoPath || !fs.existsSync(videoPath)) throw new Error('Video path invalid');

        const tempSrt = path.join(__dirname, `temp_${Date.now()}.srt`);
        fs.writeFileSync(tempSrt, serializeSrt(cues), 'utf8');

        const outName = `${path.basename(videoPath, path.extname(videoPath))}_Dubbed_${Date.now()}.mp4`;
        const outPath = path.join(EXPORT_DIR, outName);

        const escapedSrt = tempSrt.replace(/\\/g, '/').replace(/:/g, '\\:');

        let filterString = '';
        if (maskEnabled) {
          if (maskMode === 'blur') {
            filterString = `[0:v]split[orig][copy];[copy]crop=iw*${maskWPercent}:ih*${maskHPercent}:(iw-iw*${maskWPercent})/2:ih*${maskYPercent},avgblur=sizeX=16:sizeY=16[blurred];[orig][blurred]overlay=(W-w)/2:H*${maskYPercent}[vmasked];[vmasked]subtitles='${escapedSrt}':force_style='Fontsize=22,PrimaryColour=&H00FFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2'`;
          } else {
            filterString = `drawbox=x=(iw-iw*${maskWPercent})/2:y=ih*${maskYPercent}:w=iw*${maskWPercent}:h=ih*${maskHPercent}:color=black@0.9:t=fill,subtitles='${escapedSrt}':force_style='Fontsize=22,PrimaryColour=&H00FFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2'`;
          }
        } else {
          filterString = `subtitles='${escapedSrt}':force_style='Fontsize=22,PrimaryColour=&H00FFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2'`;
        }

        const args = [
          '-i', videoPath,
          '-vf', filterString,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-c:a', 'copy',
          '-y', outPath
        ];

        const proc = spawn(FFMPEG_BIN, args);
        proc.on('close', (code) => {
          try { fs.unlinkSync(tempSrt); } catch (_) {}
          if (code === 0 && fs.existsSync(outPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: true, outputFile: outPath }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: `FFmpeg failed with exit code ${code}` }));
          }
        });
        proc.on('error', (err) => {
          try { fs.unlinkSync(tempSrt); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        });
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Config API
  if (url.pathname === '/api/config') {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const { GEMINI_API_KEY } = JSON.parse(body || '{}');
          if (GEMINI_API_KEY) saveConfig({ GEMINI_API_KEY: GEMINI_API_KEY.trim() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
    const cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hasKey: !!cfg.GEMINI_API_KEY }));
  }

  // Translate Cues API
  if (url.pathname === '/api/translate-cues' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { cues, targetLang = 'km' } = JSON.parse(body || '{}');
        const apiKey = loadConfig().GEMINI_API_KEY;
        if (!apiKey) throw new Error('សូមកំណត់ Gemini API Key!');

        const chunkSize = 30;
        const resultCues = [...cues];

        for (let i = 0; i < cues.length; i += chunkSize) {
          const chunk = cues.slice(i, i + chunkSize);
          const lines = chunk.map(c => `${c.index}: ${c.text.replace(/\n/g, ' ')}`).join('\n');
          const prompt = `You are a professional cinematic drama subtitle translator and dubbing writer. Translate the following Chinese dialogue lines into natural, conversational, dramatic Khmer (ភាសាខ្មែរ) fitting a high-budget Asian TV drama. Return EXACTLY in the format [number]: [Khmer dialogue]. Do not include explanations:\n\n${lines}`;
          
          try {
            const resp = await callGeminiApi(prompt, apiKey);
            const respLines = resp.split('\n');
            for (const line of respLines) {
              const m = line.match(/^(\d+)[\s.:：]+(.*)$/);
              if (m) {
                const idx = parseInt(m[1], 10);
                const item = resultCues.find(c => c.index === idx);
                if (item) item.translated = m[2].trim();
              }
            }
          } catch (err) {
            console.warn('Chunk translation error:', err.message);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, cues: resultCues }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Generate TTS Audio
  if (url.pathname === '/api/generate-tts' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { text, voice } = JSON.parse(body || '{}');
        if (!text) throw new Error('Text empty');
        const audioUrl = await synthesizeTts(text, voice || 'km-KH-PisethNeural');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, audioUrl }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log(`EZA PRO running at: http://localhost:${PORT}`);
});
