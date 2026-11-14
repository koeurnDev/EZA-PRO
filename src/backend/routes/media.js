/**
 * EZA PRO - Media, Drama Library, Folder Scan, and Video Streaming Routes
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { loadConfig } = require('./config');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

function extractEpisodeNumber(fileName) {
  const stem = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const match = stem.match(/(?:ep|第|ភាគ)[\s_]*(\d+)/i) || stem.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function scanDramaFolder(folderPath) {
  const normalized = path.normalize(folderPath);
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    return {
      folder: normalized,
      name: path.basename(normalized),
      dramaName: path.basename(normalized),
      episodes: []
    };
  }

  const files = fs.readdirSync(normalized).sort((a, b) => a.localeCompare(b));
  const videoFiles = files.filter(file => {
    if (!VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
    try {
      const st = fs.statSync(path.join(normalized, file));
      return st.isFile() && st.size > 0;
    } catch (_) {
      return false;
    }
  });
  const srtFiles = files.filter(file => path.extname(file).toLowerCase() === '.srt');

  const episodeMap = new Map();
  const byStem = new Map();

  const numberedVideos = [];
  const unnumberedVideos = [];
  for (const video of videoFiles) {
    const epNum = extractEpisodeNumber(video);
    if (epNum !== null) numberedVideos.push({ video, epNum });
    else unnumberedVideos.push({ video, epNum: 1 });
  }

  for (const entry of [...numberedVideos, ...unnumberedVideos]) {
    let epNum = entry.epNum;
    while (episodeMap.has(epNum) && episodeMap.get(epNum).video) {
      epNum += 1;
    }
    const item = {
      ep: epNum,
      name: `ភាគ ${epNum}`,
      video: entry.video,
      videoPath: path.join(normalized, entry.video),
      srt: '',
      srtPath: ''
    };
    episodeMap.set(epNum, item);
    const stem = path.basename(entry.video, path.extname(entry.video)).toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, item);
  }

  for (const srt of srtFiles) {
    const stem = path.basename(srt, path.extname(srt)).toLowerCase();
    const stemMatch = byStem.get(stem);
    if (stemMatch && !stemMatch.srt) {
      stemMatch.srt = srt;
      stemMatch.srtPath = path.join(normalized, srt);
      continue;
    }

    const epNum = extractEpisodeNumber(srt) ?? 1;
    if (episodeMap.has(epNum)) {
      const existing = episodeMap.get(epNum);
      if (!existing.srt) {
        existing.srt = srt;
        existing.srtPath = path.join(normalized, srt);
      }
    } else {
      episodeMap.set(epNum, {
        ep: epNum,
        name: `ភាគ ${epNum}`,
        video: '',
        videoPath: '',
        srt,
        srtPath: path.join(normalized, srt)
      });
    }
  }

  const episodes = Array.from(episodeMap.values()).sort((a, b) => a.ep - b.ep);
  const baseName = path.basename(normalized);
  return { folder: normalized, name: baseName, dramaName: baseName, episodes };
}

function listAllHdrgDramas(req = null) {
  const cfg = loadConfig(req);
  const rawDirs = [cfg.DOWNLOAD_DIR, 'D:\\HDRG', 'C:\\Users\\ASUS\\Downloads\\vd'].filter(Boolean);
  const searchDirs = [];
  const seenDirs = new Set();

  for (const dir of rawDirs) {
    const normalized = path.normalize(dir);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!seenDirs.has(key)) {
      seenDirs.add(key);
      searchDirs.push(normalized);
    }
  }

  const dramas = [];
  const dramaNames = new Set();

  for (const baseDir of searchDirs) {
    try {
      if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'hongguo-drama' ||
          entry.name === 'Exported'
        ) {
          continue;
        }
        const dramaFolder = path.join(baseDir, entry.name);
        const scan = scanDramaFolder(dramaFolder);
        if (scan.episodes.length > 0 && !dramaNames.has(entry.name)) {
          dramaNames.add(entry.name);
          dramas.push({
            name: entry.name,
            folder: dramaFolder,
            episodeCount: scan.episodes.length,
            srtCount: scan.episodes.filter(ep => ep.srt).length,
            episodes: scan.episodes
          });
        }
      }
    } catch (_) {}
  }

  return dramas.sort((a, b) => b.srtCount - a.srtCount);
}

function listHdrgDramasHandler(req, res) {
  try {
    const dramas = listAllHdrgDramas(req);
    return res.json({ dramas });
  } catch (err) {
    return res.status(500).json({ dramas: [], error: err.message });
  }
}

function openNativeFolderDialog() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Native browser fallback folder dialog is only supported on Windows.'));
    }

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select Drama Folder"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.SelectedPath
}
$owner.Dispose()
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const selected = stdout.trim();
      resolve(selected || null);
    });
  });
}

function openNativeFileDialog(type = 'video') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Native browser fallback file dialog is only supported on Windows.'));
    }

    let filter = 'Videos (*.mp4;*.mkv;*.mov;*.webm;*.m4v)|*.mp4;*.mkv;*.mov;*.webm;*.m4v|All Files (*.*)|*.*';
    let title = 'Select Video File';
    if (type === 'srt') {
      filter = 'Subtitles (*.srt;*.txt)|*.srt;*.txt|All Files (*.*)|*.*';
      title = 'Select Subtitle File (.SRT)';
    } else if (type === 'sponsor') {
      filter = 'Logo / Sponsor Media (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.mov;*.webm;*.mkv;*.m4v)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.mov;*.webm;*.mkv;*.m4v|Image Logo (*.png;*.jpg;*.jpeg;*.webp;*.gif)|*.png;*.jpg;*.jpeg;*.webp;*.gif|Sponsor Video (*.mp4;*.mov;*.webm;*.mkv;*.m4v)|*.mp4;*.mov;*.webm;*.mkv;*.m4v|All Files (*.*)|*.*';
      title = 'Select Logo Image or Sponsor Video';
    }

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "${title}"
$dialog.Filter = "${filter}"
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.FileName
}
$owner.Dispose()
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const selected = stdout.trim();
      resolve(selected || null);
    });
  });
}

async function browseFolderHandler(req, res) {
  try {
    const selected = await openNativeFolderDialog();
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({ success: false, selected: null, error: err.message });
  }
}

async function browseFileHandler(req, res) {
  try {
    const rawType = req.query && typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : 'video';
    const type = rawType === 'srt' ? 'srt' : (rawType === 'sponsor' ? 'sponsor' : 'video');
    const selected = await openNativeFileDialog(type);
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({ success: false, selected: null, error: err.message });
  }
}

function openNativeMultiFileDialog(type = 'video') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Native browser fallback file dialog is only supported on Windows.'));
    }

    const filter = type === 'srt'
      ? 'Subtitles (*.srt;*.txt)|*.srt;*.txt|All Files (*.*)|*.*'
      : 'Videos (*.mp4;*.mkv;*.mov;*.webm;*.m4v)|*.mp4;*.mkv;*.mov;*.webm;*.m4v|All Files (*.*)|*.*';
    const title = type === 'srt' ? 'Select Subtitle Files (.SRT)' : 'Select Multiple Video Files';

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Title = "${title}"
$dialog.Filter = "${filter}"
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $dialog.FileNames | ForEach-Object { Write-Output $_ }
}
$owner.Dispose()
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = String(stdout || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
      resolve(lines);
    });
  });
}

async function browseFilesHandler(req, res) {
  try {
    const type = req.query && req.query.type === 'srt' ? 'srt' : 'video';
    const selected = await openNativeMultiFileDialog(type);
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({ success: false, selected: [], error: err.message });
  }
}

function inspectVideosHandler(req, res) {
  try {
    const crypto = require('crypto');
    const draftsDir = process.env.DRAFTS_DIR || path.join(__dirname, '..', '..', '..', 'drafts');
    const rawPaths = Array.isArray(req.body && req.body.filePaths) ? req.body.filePaths : [];
    const items = [];
    for (const raw of rawPaths) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const videoPath = path.normalize(raw.trim());
      if (!path.isAbsolute(videoPath) || !fs.existsSync(videoPath)) continue;
      const dir = path.dirname(videoPath);
      const stem = path.basename(videoPath, path.extname(videoPath));
      const candidateSrt = path.join(dir, `${stem}.srt`);
      const srtPath = fs.existsSync(candidateSrt) ? candidateSrt : '';
      let draftInfo = null;
      try {
        const draftKey = crypto.createHash('md5').update(videoPath).digest('hex');
        const draftFile = path.join(draftsDir, `${draftKey}.json`);
        if (fs.existsSync(draftFile)) {
          const parsed = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
          if (parsed && Array.isArray(parsed.cues)) {
            draftInfo = {
              draftKey,
              cueCount: parsed.cues.length,
              translatedCount: parsed.cues.filter(c => c && c.translated).length
            };
          }
        }
      } catch (_) {}
      items.push({
        videoPath,
        videoName: path.basename(videoPath),
        srtPath,
        draftInfo
      });
    }
    return res.json({ success: true, items });
  } catch (err) {
    return res.status(500).json({ success: false, items: [], error: err.message });
  }
}

function scanFolderHandler(req, res) {
  const { folder } = req.body || {};
  const targetFolder = typeof folder === 'string' && folder.trim()
    ? folder.trim()
    : (loadConfig(req).DOWNLOAD_DIR || 'D:\\HDRG');

  if (!path.isAbsolute(targetFolder)) {
    return res.status(400).json({ episodes: [], error: 'Folder path must be absolute.' });
  }

  const normalized = path.normalize(targetFolder);
  try {
    const stats = fs.statSync(normalized);
    if (!stats.isDirectory()) {
      return res.status(400).json({ episodes: [], error: 'Selected path is not a folder.' });
    }
    return res.json(scanDramaFolder(normalized));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ episodes: [], error: 'Folder not found.' });
    }
    return res.status(500).json({ episodes: [], error: err.message });
  }
}

function videoStreamHandler(req, res) {
  const filePath = req.query && req.query.file;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return res.status(400).json({ success: false, error: 'Missing video file parameter.' });
  }
  if (!path.isAbsolute(filePath)) {
    return res.status(400).json({ success: false, error: 'Video path must be absolute.' });
  }

  const normalized = path.normalize(filePath);
  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).end();
    }
    return res.status(500).end();
  }

  if (!stat.isFile()) {
    return res.status(400).end();
  }

  const fileSize = stat.size;
  const contentType = VIDEO_MIME_TYPES[path.extname(normalized).toLowerCase()] || 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || fileSize === 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const startStr = match[1];
    const endStr = match[2];
    let start;
    let end;

    if (startStr === '' && endStr !== '') {
      const suffixLength = parseInt(endStr, 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else if (startStr !== '') {
      start = parseInt(startStr, 10);
      end = endStr !== '' ? Math.min(parseInt(endStr, 10), fileSize - 1) : fileSize - 1;
    } else {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(normalized, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    req.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    return stream.pipe(res);
  }

  const stream = fs.createReadStream(normalized);
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': fileSize,
    'Content-Type': contentType
  });
  req.on('close', () => stream.destroy());
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  return stream.pipe(res);
}

function getUploadsDir() {
  const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function uploadVideoHandler(req, res) {
  try {
    const rawName = (req.query && req.query.name) ? String(req.query.name) : `video_${Date.now()}.mp4`;
    const ext = path.extname(rawName).toLowerCase();
    const safeExt = (VIDEO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) ? ext : '.mp4';
    const base = path.basename(rawName, path.extname(rawName))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .slice(0, 80) || 'video';
    const fileName = `${base}${safeExt}`;
    const filePath = path.join(getUploadsDir(), fileName);

    const writeStream = fs.createWriteStream(filePath);
    let settled = false;
    const finishError = (err) => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    };

    req.on('error', finishError);
    writeStream.on('error', finishError);
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      res.json({
        success: true,
        filePath,
        fileName
      });
    });

    req.pipe(writeStream);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  scanDramaFolder,
  listAllHdrgDramas,
  listHdrgDramasHandler,
  browseFolderHandler,
  browseFileHandler,
  browseFilesHandler,
  inspectVideosHandler,
  scanFolderHandler,
  videoStreamHandler,
  uploadVideoHandler
};
