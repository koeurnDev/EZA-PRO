# ⚡ EZA PRO - Architecture Overview

## 🏗️ Application Structure

```
EZA PRO Desktop App
│
├── 🖥️ ELECTRON (Main Process)
│   └── main.js
│       ├── Creates app window
│       ├── Starts Express backend
│       ├── Handles native dialogs
│       └── Injects backend URL to frontend
│
├── 🌐 FRONTEND (Renderer Process)
│   └── src/frontend/
│       ├── index.html (UI structure)
│       ├── styles.css (Styling)
│       └── app.js (Business logic)
│           ├── Video player control
│           ├── Subtitle editor
│           ├── API calls to backend
│           └── UI interactions
│
└── 🔧 BACKEND (Express Server)
    └── src/backend/
        ├── routes/ (Express Router)
        │   ├── index.js          # Main router
        │   ├── config.js         # Settings API
        │   ├── translation.js    # Gemini API
        │   ├── tts.js            # Edge TTS
        │   └── draft.js          # Draft management
        │
        └── services/
            └── (future: shared services)
```

---

## 📡 Request Flow

```
User Action (Frontend)
    ↓
Fetch API Call
    ↓
Backend Express Server (127.0.0.1:random-port)
    ↓
Router Routes Request
    ↓
Controller Handles Logic
    ↓
External APIs (Gemini, Edge TTS)
    ↓
Cache/File System
    ↓
JSON Response
    ↓
Frontend Updates UI
```

---

## 🗺️ Router Mapping

```
/api/health
    → index.js (Health check)

/api/config
    ├── GET  → config.js (Get settings)
    └── POST → config.js (Save settings)

/api/translation
    ├── POST /translate-cues  → translation.js (Batch translate)
    └── POST /clear-cache     → translation.js (Clear cache)

/api/tts
    ├── POST   /generate       → tts.js (Single audio)
    ├── POST   /batch-generate → tts.js (Multiple audio)
    ├── GET    /voices         → tts.js (List voices)
    └── DELETE /cache          → tts.js (Clear cache)

/api/drafts
    ├── POST   /save      → draft.js (Save draft)
    ├── POST   /load      → draft.js (Load draft)
    ├── GET    /list      → draft.js (List all)
    ├── DELETE /:key      → draft.js (Delete one)
    └── DELETE /clear/all → draft.js (Delete all)
```

---

## 📊 Data Flow Examples

### Example 1: Translation Workflow

```
1. User clicks "🌏 Translate All"
   ↓
2. Frontend: fetch('/api/translation/translate-cues')
   ↓
3. Backend: translation.js receives request
   ↓
4. Check translation_cache.js for existing translations
   ↓
5. Call Gemini API for untranslated text
   ↓
6. Save new translations to cache
   ↓
7. Return translated cues to frontend
   ↓
8. Frontend: Updates UI table with Khmer text
```

### Example 2: TTS Generation

```
1. User clicks "🎤 Generate Voice"
   ↓
2. Frontend: fetch('/api/tts/generate')
   ↓
3. Backend: tts.js receives request
   ↓
4. Generate MD5 hash of text+voice
   ↓
5. Check if audio_cache/<hash>.mp3 exists
   ├─ YES → Return cached URL
   └─ NO  → Generate new audio via Edge TTS
   ↓
6. Save MP3 to audio_cache/
   ↓
7. Return audio URL to frontend
   ↓
8. Frontend: Play audio in <audio> element
```

### Example 3: Draft Save/Load

```
1. User clicks "💾 Save Draft"
   ↓
2. Frontend: fetch('/api/drafts/save')
   ↓
3. Backend: draft.js receives cues + videoPath
   ↓
4. Generate MD5 hash from videoPath
   ↓
5. Save JSON to drafts/<hash>.json
   ↓
6. Return success + draftKey
   ↓
7. Frontend: Show "Draft saved!" toast
   
Later...

8. User reopens app → Click "📋 Load Draft"
   ↓
9. Frontend: fetch('/api/drafts/load')
   ↓
10. Backend: Read drafts/<hash>.json
   ↓
11. Return draft data (cues, videoPath, etc)
   ↓
12. Frontend: Restore work state
```

---

## 🔐 Security Architecture

### API Key Storage
```
User enters Gemini API Key
    ↓
Electron safeStorage.encryptString()
    ↓
Save to: userData/gemini-api-key.bin (encrypted)
    ↓
When needed: safeStorage.decryptString()
    ↓
Use in backend API calls
    ↓
Never exposed to frontend!
```

### File Access Control
```
Backend: Full file system access ✅
Frontend: NO file system access ❌
    ↓
All file operations via IPC:
    - electron.openFile()
    - electron.saveFile()
    - electron.openFolder()
```

---

## 📦 Directory Structure

```
d:\EZARG\
├── main.js                    # Electron entry point
├── preload.js                 # IPC bridge
├── package.json               # Dependencies
├── .env                       # API keys (gitignored)
│
├── src/
│   ├── frontend/              # UI code
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── app.js
│   │
│   └── backend/               # Server code
│       └── routes/            # Express routers
│           ├── index.js
│           ├── config.js
│           ├── translation.js
│           ├── tts.js
│           └── draft.js
│
├── audio_cache/               # Generated TTS audio
├── drafts/                    # Saved work
├── Exported/                  # Final videos (future)
│
└── node_modules/              # Dependencies
```

---

## 🎨 Frontend Architecture

### Components
```
Video Player (9:16 vertical preview)
    ├── Video element
    ├── Timeline scrubber
    └── Playback controls

Subtitle Editor Table
    ├── Index column
    ├── Time column
    ├── Chinese text column
    ├── Khmer translation column
    ├── Voice selector
    └── Audio preview buttons

Top Bar
    ├── Open Video button
    ├── Import SRT button
    ├── Settings button
    └── Export button

Modals
    ├── Settings Modal (API key)
    ├── Export Modal (FFmpeg options)
    └── Draft Picker Modal
```

---

## 🧩 Technology Stack

| Layer | Technology |
|-------|-----------|
| **Desktop Framework** | Electron 33+ |
| **Backend Server** | Express.js 4.x |
| **UI** | HTML5 + CSS3 + Vanilla JS |
| **Translation API** | Google Gemini 1.5 Flash |
| **Text-to-Speech** | Microsoft Edge TTS (km-KH) |
| **Video Processing** | FFmpeg (future) |
| **Storage** | Local file system (JSON) |
| **Cache** | SQLite (translation_cache.js) |

---

## 🚀 Deployment Architecture

```
Development
    npm start
    ↓
    Electron Dev Mode
    ↓
    Hot reload possible

Production Build
    npm run build:win
    ↓
    electron-builder
    ↓
    EZA-PRO-Setup-1.0.0.exe
    ↓
    Installs to: C:\Program Files\EZA PRO\
    ↓
    Creates desktop shortcut
    ↓
    Auto-updater ready (future)
```

---

## 📈 Future Enhancements

### Phase 2: Video Export
- Migrate FFmpeg routes from server.js
- Burn subtitles into video
- Export with TTS audio tracks
- Progress tracking

### Phase 3: Folder Scanning
- Scan D:\HDRG for drama episodes
- Batch process multiple files
- Auto-detect matching SRT files

### Phase 4: Mobile Apps
- Use Capacitor.js
- Share backend logic
- iOS + Android versions

---

**⚡ EZA PRO** - Professional desktop app architecture! 🏗️
