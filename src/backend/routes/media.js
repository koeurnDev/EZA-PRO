/**
 * EZA PRO - Media, Drama Library, Folder Scan, and Video Streaming Routes
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { loadConfig } = require('./config');
const { resolveExistingDraftPath } = require('./draft');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const ALLOWED_STREAM_EXTENSIONS = new Set([
  ...VIDEO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS
]);
let uploadWriteSeq = 0;
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
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
  const tagged = stem.match(/(?:ep|episode|e|ភាគ|第)[\s._-]*(\d{1,4})/i);
  if (tagged) return parseInt(tagged[1], 10);
  // Strip resolution tokens (1080p, 720p, 2160p, 4k) and standalone 4-digit years (19xx/20xx) before fallback match
  const cleaned = stem
    .replace(/\b(?:480|720|1080|1440|2160|4320)p\b/gi, ' ')
    .replace(/\b[248]k\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const trailing = cleaned.match(/[._\s-](\d{1,4})\s*$/);
  if (trailing) return parseInt(trailing[1], 10);
  const match = cleaned.match(/(\d+)/);
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
  const rawDirs = [cfg.DOWNLOAD_DIR].filter(Boolean);
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
    } catch (_) { }
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

const os = require('os');

const SKIP_SCAN_DIRS = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'appdata', '.gemini', 'dist', 'build', 'recovery', 'perflogs'
]);

function getSearchCandidateRoots() {
  const home = os.homedir();
  const roots = [
    process.cwd(),
    path.dirname(process.cwd()),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Videos'),
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', 'Documents'),
    home
  ];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      try {
        if (fs.existsSync(drive)) roots.push(drive);
      } catch (_) {}
    }
  }
  const unique = [];
  const seen = new Set();
  for (const r of roots) {
    if (!r) continue;
    try {
      const norm = path.resolve(r);
      const key = norm.toLowerCase();
      if (!seen.has(key) && fs.existsSync(norm)) {
        seen.add(key);
        unique.push(norm);
      }
    } catch (_) {}
  }
  return unique;
}

function runWinFormsPsDialog(innerScript, multiLine = false) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Native browser fallback dialog is only supported on Windows.'));
    }
    const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class EzaWinHelper {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int dwThreadId);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static string GetDesktopName() {
    var sb = new StringBuilder(256);
    int len;
    GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), 2, sb, 512, out len);
    return sb.ToString();
  }
  public static void ForceForeground(IntPtr hWnd) {
    try {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hWnd);
    } catch {}
  }
}
"@
if ([EzaWinHelper]::GetDesktopName() -ne 'Default') {
  Write-Output "__NON_INTERACTIVE_DESKTOP__"
  exit 0
}
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $true; Opacity = 0.01; Width = 1; Height = 1; StartPosition = 'CenterScreen' }
$owner.Show()
[EzaWinHelper]::ForceForeground($owner.Handle)
$owner.Activate()
try {
${innerScript}
} finally {
  $owner.Dispose()
}
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -NonInteractive -InputFormat None -STA -EncodedCommand ${b64}`, { windowsHide: true, timeout: 60000 }, (err, stdout) => {
      if (err) return resolve(multiLine ? [] : null);
      const lines = String(stdout || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
      if (lines.includes('__NON_INTERACTIVE_DESKTOP__')) {
        const nonInteractiveErr = new Error('NON_INTERACTIVE_DESKTOP');
        nonInteractiveErr.code = 'NON_INTERACTIVE_DESKTOP';
        return reject(nonInteractiveErr);
      }
      resolve(multiLine ? lines : (lines[0] || null));
    });
  });
}

function openNativeFolderDialog() {
  return runWinFormsPsDialog(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select Folder"
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.FileName = "Select Folder"
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output ([System.IO.Path]::GetDirectoryName($dialog.FileName))
}`, false);
}

function openNativeFileDialog(type = 'video') {
  let filter = 'Videos (*.mp4;*.mkv;*.mov;*.webm;*.m4v)|*.mp4;*.mkv;*.mov;*.webm;*.m4v|All Files (*.*)|*.*';
  let title = 'Select Video File';
  if (type === 'srt') {
    filter = 'Subtitles (*.srt;*.txt)|*.srt;*.txt|All Files (*.*)|*.*';
    title = 'Select Subtitle File (.SRT)';
  } else if (type === 'sponsor') {
    filter = 'Logo / Sponsor Media (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.mov;*.webm;*.mkv;*.m4v)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.mov;*.webm;*.mkv;*.m4v|Image Logo (*.png;*.jpg;*.jpeg;*.webp;*.gif)|*.png;*.jpg;*.jpeg;*.webp;*.gif|Sponsor Video (*.mp4;*.mov;*.webm;*.mkv;*.m4v)|*.mp4;*.mov;*.webm;*.mkv;*.m4v|All Files (*.*)|*.*';
    title = 'Select Logo Image or Sponsor Video';
  }
  return runWinFormsPsDialog(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "${title}"
$dialog.Filter = "${filter}"
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.FileName
}`, false);
}

async function browseFolderHandler(req, res) {
  try {
    const selected = await openNativeFolderDialog();
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({
      success: false,
      selected: null,
      nonInteractive: err && err.code === 'NON_INTERACTIVE_DESKTOP',
      error: err.message
    });
  }
}

async function browseFileHandler(req, res) {
  try {
    const rawType = req.query && typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : 'video';
    const type = rawType === 'srt' ? 'srt' : (rawType === 'sponsor' ? 'sponsor' : 'video');
    const selected = await openNativeFileDialog(type);
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({
      success: false,
      selected: null,
      nonInteractive: err && err.code === 'NON_INTERACTIVE_DESKTOP',
      error: err.message
    });
  }
}

function openNativeMultiFileDialog(type = 'video') {
  const filter = type === 'srt'
    ? 'Subtitles (*.srt;*.txt)|*.srt;*.txt|All Files (*.*)|*.*'
    : 'Videos (*.mp4;*.mkv;*.mov;*.webm;*.m4v)|*.mp4;*.mkv;*.mov;*.webm;*.m4v|All Files (*.*)|*.*';
  const title = type === 'srt' ? 'Select Subtitle Files (.SRT)' : 'Select Multiple Video Files';
  return runWinFormsPsDialog(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Title = "${title}"
$dialog.Filter = "${filter}"
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $dialog.FileNames | ForEach-Object { Write-Output $_ }
}`, true);
}

async function browseFilesHandler(req, res) {
  try {
    const type = req.query && req.query.type === 'srt' ? 'srt' : 'video';
    const selected = await openNativeMultiFileDialog(type);
    return res.json({ success: true, selected });
  } catch (err) {
    return res.status(501).json({
      success: false,
      selected: [],
      nonInteractive: err && err.code === 'NON_INTERACTIVE_DESKTOP',
      error: err.message
    });
  }
}

function resolvePickedFolderHandler(req, res) {
  try {
    const body = req.body || {};
    const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : '';
    const markerName = typeof body.markerName === 'string' && /^\.eza_probe_[a-zA-Z0-9_-]+\.tmp$/.test(body.markerName.trim())
      ? body.markerName.trim()
      : '';
    const childNames = Array.isArray(body.childNames)
      ? body.childNames.map(c => String(c || '').trim()).filter(Boolean).slice(0, 8)
      : [];

    const roots = getSearchCandidateRoots();
    const visited = new Set();
    const queue = [];

    const checkMatch = (dirPath) => {
      try {
        if (markerName) {
          const markerFull = path.join(dirPath, markerName);
          if (fs.existsSync(markerFull)) {
            try { fs.unlinkSync(markerFull); } catch (_) {}
            return true;
          }
          return false;
        }
        if (!folderName) return false;
        if (path.basename(dirPath).toLowerCase() !== folderName.toLowerCase()) return false;
        if (childNames.length > 0) {
          return childNames.every(cn => fs.existsSync(path.join(dirPath, cn)));
        }
        return true;
      } catch (_) {
        return false;
      }
    };

    for (const r of roots) {
      if (checkMatch(r)) {
        return res.json({ success: true, folderPath: r });
      }
      if (folderName) {
        const direct = path.join(r, folderName);
        if (checkMatch(direct)) {
          return res.json({ success: true, folderPath: direct });
        }
      }
      queue.push({ dir: r, depth: 0 });
    }

    let fallbackByName = '';
    while (queue.length > 0) {
      const { dir, depth } = queue.shift();
      const key = dir.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);

      if (checkMatch(dir)) {
        return res.json({ success: true, folderPath: dir });
      }
      if (!fallbackByName && folderName && path.basename(dir).toLowerCase() === folderName.toLowerCase()) {
        fallbackByName = dir;
      }
      if (depth >= 5) continue;

      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const lowerName = ent.name.toLowerCase();
        if (SKIP_SCAN_DIRS.has(lowerName) || ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (checkMatch(full)) {
          return res.json({ success: true, folderPath: full });
        }
        if (!fallbackByName && folderName && lowerName === folderName.toLowerCase()) {
          fallbackByName = full;
        }
        queue.push({ dir: full, depth: depth + 1 });
      }
    }

    if (fallbackByName) {
      return res.json({ success: true, folderPath: fallbackByName });
    }
    return res.status(404).json({ success: false, folderPath: null, error: 'Could not resolve folder path on local disk' });
  } catch (err) {
    return res.status(500).json({ success: false, folderPath: null, error: err.message });
  }
}

function resolveLocalFilesHandler(req, res) {
  try {
    const rawFiles = Array.isArray(req.body && req.body.files) ? req.body.files : [];
    const wanted = [];
    for (const f of rawFiles) {
      if (!f || typeof f.name !== 'string' || !f.name.trim()) continue;
      const name = path.basename(f.name.trim());
      const size = Number(f.size) || 0;
      wanted.push({ name, lowerName: name.toLowerCase(), size, key: `${name.toLowerCase()}|${size}` });
    }
    if (wanted.length === 0) {
      return res.json({ success: true, resolvedPaths: {} });
    }

    const resolvedPaths = {};
    const checkDirForWanted = (dirPath) => {
      let matchedAny = false;
      for (const w of wanted) {
        if (resolvedPaths[w.key]) continue;
        const candidate = path.join(dirPath, w.name);
        try {
          if (fs.existsSync(candidate)) {
            const st = fs.statSync(candidate);
            if (st.isFile() && (w.size <= 0 || st.size === w.size)) {
              resolvedPaths[w.key] = candidate;
              matchedAny = true;
            }
          }
        } catch (_) {}
      }
      return matchedAny;
    };

    const roots = getSearchCandidateRoots();
    const visited = new Set();
    const queue = [];
    for (const r of roots) {
      checkDirForWanted(r);
      queue.push({ dir: r, depth: 0 });
    }

    while (queue.length > 0 && Object.keys(resolvedPaths).length < wanted.length) {
      const { dir, depth } = queue.shift();
      const key = dir.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);

      checkDirForWanted(dir);
      if (Object.keys(resolvedPaths).length >= wanted.length) break;
      if (depth >= 4) continue;

      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const lowerName = ent.name.toLowerCase();
        if (SKIP_SCAN_DIRS.has(lowerName) || ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        checkDirForWanted(full);
        if (Object.keys(resolvedPaths).length >= wanted.length) break;
        queue.push({ dir: full, depth: depth + 1 });
      }
    }

    return res.json({ success: true, resolvedPaths });
  } catch (err) {
    return res.status(500).json({ success: false, resolvedPaths: {}, error: err.message });
  }
}

function listDirectoriesHandler(req, res) {
  try {
    const body = req.body || {};
    const home = os.homedir();
    const defaultExport = process.env.EXPORT_DIR || path.join(__dirname, '..', '..', '..', 'Exported');
    let targetDir = typeof body.currentPath === 'string' && body.currentPath.trim()
      ? path.resolve(body.currentPath.trim())
      : path.resolve(defaultExport);

    if (!fs.existsSync(targetDir)) {
      const parent = path.dirname(targetDir);
      if (fs.existsSync(parent)) {
        targetDir = parent;
      } else {
        targetDir = process.cwd();
      }
    }

    const createName = typeof body.createFolderName === 'string' ? body.createFolderName.trim().replace(/[<>:"/\\|?*]/g, '') : '';
    if (createName) {
      const newFolderPath = path.join(targetDir, createName);
      if (!fs.existsSync(newFolderPath)) {
        fs.mkdirSync(newFolderPath, { recursive: true });
      }
      targetDir = newFolderPath;
    }

    const drives = [];
    if (process.platform === 'win32') {
      for (let code = 67; code <= 90; code++) {
        const d = String.fromCharCode(code) + ':\\';
        try {
          if (fs.existsSync(d)) drives.push(d);
        } catch (_) {}
      }
    }

    const shortcuts = [
      { label: '📁 Exported (លំនាំដើម)', path: path.resolve(defaultExport) },
      { label: '🖥️ Desktop', path: path.join(home, 'Desktop') },
      { label: '⬇️ Downloads', path: path.join(home, 'Downloads') },
      { label: '🎬 Videos', path: path.join(home, 'Videos') },
      { label: '📂 Workspace', path: process.cwd() }
    ].filter(s => {
      try { return fs.existsSync(s.path) || s.label.includes('Exported'); } catch (_) { return false; }
    });

    const folders = [];
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('$') || ent.name === 'System Volume Information') continue;
        folders.push({
          name: ent.name,
          path: path.join(targetDir, ent.name)
        });
      }
      folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (_) {}

    const parentDir = path.dirname(targetDir);
    const parentPath = parentDir && parentDir !== targetDir ? parentDir : '';

    return res.json({
      success: true,
      currentPath: targetDir,
      parentPath,
      drives,
      shortcuts,
      folders
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

function inspectVideosHandler(req, res) {
  try {
    const draftsDir = process.env.DRAFTS_DIR || path.join(__dirname, '..', '..', '..', 'drafts');
    const rawPaths = Array.isArray(req.body && req.body.filePaths) ? req.body.filePaths : [];
    const items = [];
    for (const raw of rawPaths) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const videoPath = path.normalize(raw.trim());
      if (
        !path.isAbsolute(videoPath) ||
        videoPath.startsWith('\\\\') ||
        videoPath.startsWith('//') ||
        videoPath.slice(2).includes(':') ||
        !fs.existsSync(videoPath)
      ) continue;
      const dir = path.dirname(videoPath);
      const stem = path.basename(videoPath, path.extname(videoPath));
      const candidateSrt = path.join(dir, `${stem}.srt`);
      const srtPath = fs.existsSync(candidateSrt) ? candidateSrt : '';
      let draftInfo = null;
      try {
        const resolved = resolveExistingDraftPath(draftsDir, videoPath);
        if (resolved.draftPath && fs.existsSync(resolved.draftPath)) {
          const parsed = JSON.parse(fs.readFileSync(resolved.draftPath, 'utf8'));
          if (parsed && Array.isArray(parsed.cues)) {
            draftInfo = {
              draftKey: resolved.key,
              cueCount: parsed.cues.length,
              translatedCount: parsed.cues.filter(c => c && c.translated).length
            };
          }
        }
      } catch (_) { }
      const epNum = extractEpisodeNumber(videoPath);
      items.push({
        videoPath,
        videoName: path.basename(videoPath),
        ep: epNum !== null ? String(epNum) : '',
        epNum,
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
    : (loadConfig(req).DOWNLOAD_DIR || '');

  if (!targetFolder) {
    return res.status(400).json({ episodes: [], error: 'សូមជ្រើសរើសទីតាំង Folder វីដេអូជាមុនសិន។' });
  }

  if (!path.isAbsolute(targetFolder)) {
    return res.status(400).json({ episodes: [], error: 'Folder path must be absolute.' });
  }

  const normalized = path.normalize(targetFolder);
  if (normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
    return res.status(403).json({ episodes: [], error: 'Invalid or forbidden folder path.' });
  }
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
  const rawTrimmed = filePath.trim();
  if (!path.isAbsolute(rawTrimmed)) {
    return res.status(400).json({ success: false, error: 'Video path must be absolute.' });
  }

  const normalized = path.normalize(rawTrimmed);
  // Reject UNC network shares, NTFS Alternate Data Streams (::$DATA), trailing dots/spaces, dotfiles, and non-media types
  if (normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
    return res.status(403).json({ success: false, error: 'Invalid or forbidden media path.' });
  }
  const baseName = path.basename(normalized);
  if (!baseName || baseName.startsWith('.') || /[.\s]+$/.test(baseName)) {
    return res.status(403).json({ success: false, error: 'File type is not allowed for media streaming.' });
  }
  const streamExt = path.extname(normalized).toLowerCase();
  if (!ALLOWED_STREAM_EXTENSIONS.has(streamExt)) {
    return res.status(403).json({ success: false, error: 'File type is not allowed for media streaming.' });
  }
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
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB safety limit
    const contentLength = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ success: false, error: 'Upload exceeds 4 GB safety limit.' });
    }

    const rawName = (req.query && req.query.name) ? String(req.query.name) : `video_${Date.now()}.mp4`;
    const ext = path.extname(rawName).toLowerCase();
    const safeExt = (VIDEO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) ? ext : '.mp4';
    const base = path.basename(rawName, path.extname(rawName))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .slice(0, 80) || 'video';
    const uploadsDir = getUploadsDir();
    uploadWriteSeq = (uploadWriteSeq + 1) % 1000000;
    let fileName = `${base}${safeExt}`;
    let filePath = path.join(uploadsDir, fileName);
    let fd = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fd = fs.openSync(filePath, 'wx');
        break;
      } catch (openErr) {
        if (openErr && openErr.code === 'EEXIST') {
          fileName = `${base}_${Date.now().toString(36)}_${uploadWriteSeq}_${attempt}${safeExt}`;
          filePath = path.join(uploadsDir, fileName);
          continue;
        }
        throw openErr;
      }
    }
    if (fd === null) {
      return res.status(409).json({ success: false, error: 'Could not reserve unique upload filename.' });
    }

    const writeStream = fs.createWriteStream(filePath, { fd });
    let receivedBytes = 0;
    let settled = false;
    const cleanupIncomplete = () => {
      const unlinkAfterClose = () => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
      };
      if (writeStream.closed || writeStream.destroyed) {
        unlinkAfterClose();
      } else {
        writeStream.once('close', unlinkAfterClose);
        try { writeStream.destroy(); } catch (_) { unlinkAfterClose(); }
      }
    };
    const finishError = (err, status = 500) => {
      if (settled) return;
      settled = true;
      cleanupIncomplete();
      if (!res.headersSent) {
        res.status(status).json({ success: false, error: err.message });
      }
    };

    req.on('data', (chunk) => {
      receivedBytes += chunk ? chunk.length : 0;
      if (receivedBytes > MAX_UPLOAD_BYTES) {
        req.unpipe(writeStream);
        try { req.destroy(); } catch (_) {}
        finishError(new Error('Upload exceeds 4 GB safety limit.'), 413);
      }
    });
    req.on('error', finishError);
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      cleanupIncomplete();
    });
    res.on('close', () => {
      if (!settled && !res.writableFinished) {
        settled = true;
        cleanupIncomplete();
      }
    });
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
  resolvePickedFolderHandler,
  resolveLocalFilesHandler,
  listDirectoriesHandler,
  inspectVideosHandler,
  scanFolderHandler,
  videoStreamHandler,
  uploadVideoHandler
};
