# 🦈 SHARK STUDIO PRO - Desktop App

Professional AI Dubbing & Subtitle Studio for Windows, Mac, and Linux

## 🚀 Quick Start

### Development Mode
```bash
npm start
```

### Build Desktop Apps

#### Windows (.exe installer)
```bash
npm run build:win
```
Output: `dist/SHARK STUDIO PRO-1.0.0-x64.exe`

#### Portable Windows (no install)
```bash
npm run build:win
```
Output: `dist/SHARK STUDIO PRO-1.0.0-Portable.exe`

#### Mac (.dmg)
```bash
npm run build:mac
```
Output: `dist/SHARK STUDIO PRO-1.0.0.dmg`

#### Linux (AppImage)
```bash
npm run build:linux
```
Output: `dist/SHARK STUDIO PRO-1.0.0.AppImage`

#### All Platforms
```bash
npm run build:all
```

## 📁 Project Structure

```
SHARK-STUDIO-PRO/
├── main.js                   # Electron main process
├── preload.js                # Security bridge
├── package.json              # Project config
├── .env                      # Environment variables
│
├── src/
│   ├── frontend/            # Web UI
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
│   │
│   └── backend/             # Node.js server
│       └── server-logic.js
│
├── build/                   # Build resources
│   └── icon.png            # App icon (add yours!)
│
├── dist/                    # Built apps (generated)
│   ├── win-unpacked/
│   ├── mac/
│   └── linux-unpacked/
│
├── audio_cache/            # TTS audio files
├── drafts/                 # Saved drafts
└── translation_cache/      # Translation cache

```

## 🔧 Configuration

### Environment Variables (.env)
```env
GEMINI_API_KEY=your_api_key_here
DOWNLOAD_DIR=C:\Users\ASUS\Downloads\vd
PORT=3001
```

## 📦 Distribution

### File Sizes (Estimated)
- Windows Installer: ~150-200 MB
- Mac DMG: ~180-220 MB
- Linux AppImage: ~160-200 MB
- Portable EXE: ~150-180 MB

### Installation
- **Windows**: Double-click `.exe` installer
- **Mac**: Drag `.app` to Applications folder
- **Linux**: `chmod +x *.AppImage && ./SHARK*.AppImage`

## 🎯 Next Steps

### Phase 1: ✅ Basic Structure (COMPLETED)
- [x] Electron setup
- [x] Frontend/Backend split
- [x] Build configuration

### Phase 2: 🔄 Migrate Features (IN PROGRESS)
- [ ] Migrate translation API from server.js
- [ ] Migrate TTS API
- [ ] Migrate draft management
- [ ] Migrate video export
- [ ] Migrate full UI from server.js

### Phase 3: 📱 Enhance
- [ ] Add auto-updater
- [ ] Add license validation
- [ ] Optimize build size
- [ ] Add code signing

## 🐛 Troubleshooting

### App won't start
```bash
# Clear cache and reinstall
rm -rf node_modules dist
npm install
npm start
```

### Build fails
```bash
# Update electron-builder
npm install --save-dev electron-builder@latest

# Clean build
npm run build:win -- --config.directories.output=dist-clean
```

### Icon not showing
- Ensure `build/icon.png` exists and is 512x512px
- Rebuild: `npm run build:win`

## 📝 Notes

### Current Status
- ✅ Electron app runs
- ✅ Frontend/backend split
- ✅ Native file dialogs work
- ⚠️  Need to migrate full features from server.js
- ⚠️  Need proper app icon (currently placeholder)

### TODO
1. Copy full HTML/CSS from server.js to frontend
2. Migrate all API routes to server-logic.js
3. Test all features in Electron
4. Create proper app icon (512x512px PNG)
5. Build and test installers

## 💡 Tips

- Use `npm start` for development (faster reload)
- Use `NODE_ENV=development npm start` for DevTools
- Build often to catch packaging issues early
- Test on real machines, not just dev environment

---

🦈 **SHARK STUDIO PRO** - Professional AI Dubbing & Subtitle Studio
