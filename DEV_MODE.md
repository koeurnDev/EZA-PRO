# 🚀 EZA PRO - Development Mode

## Browser Development (Faster Testing!)

### Why Browser Mode?
- ✅ **Faster reload** - Just refresh browser (no Electron restart)
- ✅ **Better DevTools** - Full browser debugging
- ✅ **Easier testing** - Test API calls directly
- ✅ **Same code** - Uses same backend routes

---

## 🎯 Quick Start

### 1. Start Development Server
```bash
npm run dev
```

This starts backend on **http://localhost:3001** without Electron.

### 2. Open in Browser
- **Main App:** http://localhost:3001
- **Test Page:** http://localhost:3001/test

### 3. Make Changes
- Edit files in `src/frontend/` or `src/backend/`
- Refresh browser to see changes
- Backend changes require server restart

---

## 📋 Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Browser development (backend only) |
| `npm start` | Full Electron app |
| `npm run dev:electron` | Electron with DevTools |
| `npm test` | Run automated API tests |

---

## 🔄 Development Workflow

### Option A: Browser Development (Recommended)
```bash
# 1. Start dev server
npm run dev

# 2. Open browser
http://localhost:3001

# 3. Edit code → Refresh browser
# 4. Backend changes → Restart server (Ctrl+C, npm run dev)
```

### Option B: Electron Development
```bash
# 1. Start Electron
npm start

# 2. Edit code
# 3. Restart app to see changes
```

---

## 🌐 URLs

### Development Server (npm run dev)
- Main App: `http://localhost:3001`
- Test Page: `http://localhost:3001/test`
- API Health: `http://localhost:3001/api/health`
- Static Files: `http://localhost:3001/audio_cache/`

### Electron App (npm start)
- Backend: `http://127.0.0.1:<random-port>`
- Injected to frontend via `window.BACKEND_URL`

---

## 🔧 Configuration

### API Key (.env file)
```env
GEMINI_API_KEY=your_api_key_here
PORT=3001
```

### CORS Settings
- **Dev Server:** CORS enabled (allows browser access)
- **Electron:** CORS disabled (security)

---

## 🐛 Debugging

### Browser DevTools (F12)
```
Console → Check for errors
Network → See API calls
Application → Check storage
```

### Backend Logs
```bash
# Server terminal shows:
- API requests
- Errors
- Console.log outputs
```

### Common Issues

**Issue:** "Backend not reachable"  
**Fix:** Make sure `npm run dev` is running

**Issue:** "API Key not configured"  
**Fix:** Add `GEMINI_API_KEY` to `.env` file

**Issue:** "CORS error"  
**Fix:** Make sure using dev server, not Electron backend

---

## 📂 File Structure

```
Development Files:
├── server-dev.js          → Browser dev server
├── test-frontend.html     → Test page
├── .env                   → API keys (gitignored)
└── src/
    ├── frontend/          → UI files (hot reload)
    │   ├── index.html
    │   ├── styles.css
    │   └── app.js
    └── backend/           → API routes
        └── routes/
            ├── index.js
            ├── config.js
            ├── translation.js
            ├── tts.js
            └── draft.js

Production Files:
├── main.js                → Electron entry
├── preload.js             → IPC bridge
└── package.json           → Build config
```

---

## 🎨 Frontend Development

### Auto-Reload Setup
```javascript
// app.js automatically detects backend
const BACKEND_URL = window.BACKEND_URL || 'http://localhost:3001';
```

### Making API Calls
```javascript
// All API calls use BACKEND_URL
fetch(`${BACKEND_URL}/api/translation/translate-cues`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cues })
});
```

---

## 🔌 Backend Development

### Adding New Route
1. Create router: `src/backend/routes/myfeature.js`
2. Register in `src/backend/routes/index.js`
3. Restart dev server
4. Test in browser

### Example:
```javascript
// src/backend/routes/myfeature.js
const express = require('express');
const router = express.Router();

router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Hello!' });
});

module.exports = router;

// src/backend/routes/index.js
const myFeatureRouter = require('./myfeature');
app.use('/api/myfeature', myFeatureRouter);
```

---

## ✅ Testing Workflow

### 1. Test API Endpoints
```bash
# Automated tests
npm test

# Or manually
curl http://localhost:3001/api/health
```

### 2. Test in Browser
- Open http://localhost:3001/test
- Click buttons to test each API
- Check browser console for errors

### 3. Test Full UI
- Open http://localhost:3001
- Load video, import SRT, translate, etc.
- Same as production but easier to debug!

---

## 🚀 Going to Production

### When Ready:
```bash
# 1. Test everything in browser
npm run dev
# → Test all features

# 2. Test in Electron
npm start
# → Make sure Electron works

# 3. Build distributable
npm run build:win
# → Creates .exe installer

# 4. Test installer
dist/EZA-PRO-Setup-1.0.0.exe
```

---

## 💡 Pro Tips

### Hot Reload
- Frontend changes: Just refresh browser
- Backend changes: `Ctrl+C` → `npm run dev`
- Consider using `nodemon` for auto-restart

### Multiple Terminals
```
Terminal 1: npm run dev    (backend server)
Terminal 2: npm test       (run tests)
Terminal 3: git status     (version control)
```

### Browser Extensions
- React DevTools (if using React later)
- Redux DevTools (if using Redux later)
- JSON Viewer (prettier API responses)

---

## 🎯 Summary

**Development Mode:**
```bash
npm run dev → Browser testing → Fast iteration
```

**Production Mode:**
```bash
npm start → Electron app → Full features
```

**Testing:**
```bash
npm test → Automated → Quick validation
```

**Building:**
```bash
npm run build:win → Installer → Distribution
```

---

**⚡ EZA PRO** - Develop Fast, Build Once! 🚀
