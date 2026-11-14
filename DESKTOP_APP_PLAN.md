# 🦈 SHARK STUDIO PRO - Desktop & Mobile App Plan

## 🎯 Goal
បង្កើត Desktop App (Windows/Mac/Linux) និង Mobile App (Android/iOS) ដែល:
- ✅ ដំណើរការ 100% offline (មិនត្រូវការ internet លើកលែង Gemini API)
- ✅ មិនត្រូវការ server hosting
- ✅ រត់លឿន native performance
- ✅ ងាយស្រួលលក់ និង distribute

---

## 📱 **Architecture Overview**

```
┌─────────────────────────────────────────────────┐
│           SHARK STUDIO PRO                      │
├─────────────────────────────────────────────────┤
│                                                 │
│  Desktop (Electron)          Mobile (Capacitor) │
│  ├── Windows .exe           ├── Android .apk   │
│  ├── macOS .dmg             └── iOS .ipa       │
│  └── Linux .AppImage                            │
│                                                 │
│  Shared Core Logic (Node.js + React)           │
│  ├── Gemini Translation Service                │
│  ├── Edge TTS Audio Generation                 │
│  ├── FFmpeg Video Processing                   │
│  ├── SRT/ASS Subtitle Engine                   │
│  └── Draft Management System                   │
│                                                 │
│  Local Storage (No Cloud!)                     │
│  ├── SQLite Database (drafts, cache)           │
│  ├── Audio Cache (MP3 files)                   │
│  └── Translation Cache (offline reuse)         │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 🚀 **Phase 1: Desktop App with Electron** (Week 1-2)

### Step 1: Setup Electron

```bash
npm install electron electron-builder --save-dev
npm install express better-sqlite3
```

### Step 2: Project Structure

```
shark-studio-desktop/
├── package.json
├── main.js                    # Electron main process
├── preload.js                 # Security bridge
├── src/
│   ├── backend/              # Your existing server code
│   │   ├── services/
│   │   │   ├── gemini.service.js
│   │   │   ├── tts.service.js
│   │   │   ├── ffmpeg.service.js
│   │   │   └── translation.cache.js
│   │   └── routes/
│   │       ├── translate.routes.js
│   │       ├── draft.routes.js
│   │       └── export.routes.js
│   │
│   └── frontend/             # React UI (or keep HTML)
│       ├── index.html
│       ├── css/
│       ├── js/
│       └── assets/
│
├── build/                    # Build configuration
│   ├── icon.png             # App icon
│   └── entitlements.mac.plist
│
└── dist/                     # Output (.exe, .dmg, .AppImage)
```

### Step 3: main.js (Electron Entry Point)

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const backend = express();

// Import your existing routes
const translateRoutes = require('./src/backend/routes/translate.routes');
const draftRoutes = require('./src/backend/routes/draft.routes');

// Setup backend server (embedded)
backend.use(express.json());
backend.use('/api', translateRoutes);
backend.use('/api', draftRoutes);

let mainWindow;
let backendServer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'build/icon.png'),
    title: '🦈 SHARK STUDIO PRO'
  });

  // Start embedded backend on random port
  backendServer = backend.listen(0, () => {
    const port = backendServer.address().port;
    console.log(`Backend running on port ${port}`);
    
    // Load frontend with backend URL
    mainWindow.loadFile('src/frontend/index.html');
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (backendServer) backendServer.close();
  if (process.platform !== 'darwin') app.quit();
});
```

### Step 4: package.json (Build Config)

```json
{
  "name": "shark-studio-pro",
  "version": "1.0.0",
  "description": "Professional AI Dubbing & Subtitle Studio",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac",
    "build:linux": "electron-builder --linux"
  },
  "build": {
    "appId": "com.sharkstudio.pro",
    "productName": "SHARK STUDIO PRO",
    "directories": {
      "output": "dist"
    },
    "files": [
      "src/**/*",
      "main.js",
      "preload.js",
      "node_modules/**/*"
    ],
    "extraResources": [
      {
        "from": "ffmpeg/",
        "to": "ffmpeg/",
        "filter": ["**/*"]
      }
    ],
    "win": {
      "target": ["nsis", "portable"],
      "icon": "build/icon.png"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "build/icon.png",
      "category": "public.app-category.video"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "icon": "build/icon.png",
      "category": "Video"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

### Step 5: Build Desktop Apps

```bash
# Build for Windows
npm run build:win
# Output: dist/SHARK STUDIO PRO Setup 1.0.0.exe

# Build for Mac (need Mac machine)
npm run build:mac
# Output: dist/SHARK STUDIO PRO-1.0.0.dmg

# Build for Linux
npm run build:linux
# Output: dist/SHARK STUDIO PRO-1.0.0.AppImage
```

**Size Estimate:**
- Windows .exe: ~150-200 MB (includes Node.js + Chromium)
- Mac .dmg: ~180-220 MB
- Linux .AppImage: ~160-200 MB

---

## 📱 **Phase 2: Mobile App with Capacitor** (Week 3-4)

### Why Capacitor?
- ✅ Reuse your existing HTML/CSS/JS code
- ✅ Access native features (camera, files, etc)
- ✅ Smaller than React Native
- ✅ Can use same backend logic

### Step 1: Setup Capacitor

```bash
npm install @capacitor/core @capacitor/cli
npm install @capacitor/android @capacitor/ios
npx cap init "SHARK STUDIO" "com.sharkstudio.pro"
```

### Step 2: Mobile-Optimized UI

```
shark-studio-mobile/
├── src/
│   ├── mobile-ui/           # Touch-optimized interface
│   │   ├── index.html
│   │   ├── css/
│   │   │   └── mobile.css   # Responsive mobile styles
│   │   └── js/
│   │       └── mobile.js    # Touch gestures, mobile APIs
│   │
│   └── backend-embedded/    # Embedded Node.js (Capacitor NodeJS plugin)
│       └── Same services as desktop
│
├── android/                 # Android project (auto-generated)
└── ios/                     # iOS project (auto-generated)
```

### Step 3: Build Mobile Apps

```bash
# Build Android APK
npx cap add android
npx cap sync
npx cap open android
# Then: Build -> Generate Signed APK in Android Studio

# Build iOS App
npx cap add ios
npx cap sync
npx cap open ios
# Then: Build in Xcode
```

**Mobile Challenges:**
- ⚠️ FFmpeg on mobile = large app size (50-100MB)
- ⚠️ iOS restrictions on background processing
- ⚠️ Edge TTS might need different implementation

**Solution:**
- Use cloud API for TTS on mobile (optional)
- Or embed lightweight TTS library
- Simplify features for mobile (focus on subtitle editing)

---

## 🎨 **Phase 3: Alternative - Tauri (Lightweight)** ⭐ NEW!

### Why Tauri?
- ✅ **10x តូចជាង Electron** (5-15 MB vs 150 MB!)
- ✅ ប្រើ system WebView (no bundled Chromium)
- ✅ Security by default
- ✅ Rust-based (fast!)

### Setup Tauri

```bash
npm install -D @tauri-apps/cli
npm install @tauri-apps/api
npx tauri init
```

**Size Comparison:**
- Electron: 150-200 MB 😰
- Tauri: 5-15 MB 🚀 (10x smaller!)

---

## 💰 **Distribution & Sales Strategy**

### Option 1: Direct Sales (Keep 100% profit)
```
Your Website → Download Links
├── Windows: $49 USD (lifetime)
├── Mac: $49 USD
├── Linux: Free (community)
└── Payment: Stripe / PayPal
```

**License System:**
```javascript
// Simple license check
const crypto = require('crypto');

function validateLicense(email, licenseKey) {
  const hash = crypto.createHash('sha256')
    .update(`${email}:SHARK_SECRET_2024`)
    .digest('hex')
    .substring(0, 16);
  return hash === licenseKey;
}
```

### Option 2: App Stores
```
Microsoft Store (Windows)
- Fee: 15-30%
- Distribution: Easy
- Updates: Automatic

Mac App Store
- Fee: 15-30%
- Requires: Apple Developer ($99/year)
- Sandboxed (FFmpeg might be restricted)

Google Play (Android)
- Fee: 15-30%
- One-time: $25 registration

Apple App Store (iOS)
- Fee: 15-30%
- Yearly: $99 Developer fee
```

### Option 3: Subscription Model
```
Free Tier:
- 10 translations/month
- Watermark on exports
- Standard subtitle styles

Pro ($9.99/month):
- Unlimited translations
- No watermark
- All styles + custom
- Priority support
```

---

## 🔒 **Security & Anti-Piracy**

### Basic Protection
```javascript
// 1. Hardware ID fingerprint
const hwid = require('node-machine-id');
const machineId = hwid.machineIdSync();

// 2. License server check (optional)
async function verifyLicense() {
  const response = await fetch('https://license.sharkstudio.com/verify', {
    method: 'POST',
    body: JSON.stringify({ licenseKey, machineId })
  });
  return response.json();
}

// 3. Code obfuscation
// Use: javascript-obfuscator
```

---

## 📊 **Timeline & Cost Estimate**

| Phase | Duration | Description |
|-------|----------|-------------|
| **Week 1-2** | 10 days | Convert to Electron Desktop |
| **Week 3** | 5 days | Polish UI, add auto-updates |
| **Week 4-5** | 10 days | Mobile app (Capacitor) |
| **Week 6** | 5 days | Testing, bug fixes |
| **Week 7** | 3 days | Distribution setup, license system |
| **Week 8** | 2 days | Marketing materials, docs |

**Total:** ~8 weeks for full cross-platform release

---

## 🎯 **Recommendation for SHARK STUDIO**

### **Best Path:**

1. **Start: Electron Desktop** (Windows first - biggest market)
   - Week 1-2: Build Windows .exe
   - Test with real users
   - Get feedback

2. **Then: Mac Desktop**
   - Week 3: Build Mac version
   - Submit to Mac App Store (optional)

3. **Finally: Mobile** (if demand exists)
   - Week 4-6: Android app
   - Week 7-8: iOS app (if worth $99/year fee)

### **Pricing Strategy:**

```
Desktop (Windows/Mac):
- Standard: $49 (one-time)
- Pro: $99 (lifetime updates)

Mobile (Android/iOS):
- Freemium: Free with in-app purchase
- Pro Unlock: $29.99

Bundle:
- Desktop + Mobile: $79 (save $20)
```

---

## ✅ **Next Steps**

តើអ្នកចង់:

1. **🚀 ចាប់ផ្តើមភ្លាមៗ** - ខ្ញុំ convert SHARK STUDIO ទៅ Electron ឥឡូវនេះ? (2-3 hours)
2. **📋 Setup skeleton** - បង្កើត project structure ជាមុនសិន?
3. **🎨 Design mobile UI** - រចនា mobile-friendly interface?

សូមប្រាប់ខ្ញុំ! 💪
