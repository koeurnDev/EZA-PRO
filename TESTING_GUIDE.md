# ⚡ EZA PRO - Testing Guide

## ✅ App អាច launch បានហើយ!

App ឥឡូវ running ជោគជ័យ។ សូម follow steps ខាងក្រោមដើម្បី test features នីមួយៗ។

---

## 📋 Testing Checklist

### ✅ Task #4: Video Player (Already Working)
- [x] App opens without errors
- [x] Backend API connected
- [x] UI loads correctly

### 🔄 Task #5: Translation API (Ready to Test)

**Test Steps:**
1. Open EZA PRO window (should already be open)
2. Click **"📁 Open Video"** button
3. Select a video file (.mp4)
4. Click **"📄 Import SRT"** button  
5. Select subtitle file with Chinese text
6. Click **"🌏 Translate All"** button
7. Wait for translation to complete

**Expected Results:**
- ✅ Subtitles load in table
- ✅ Chinese text appears in left column
- ✅ After clicking Translate, Khmer text appears in right column
- ✅ Progress shown: "កំពុងបកប្រែ... 1/20" etc
- ✅ Translation cache saves results (faster next time)

**API Endpoint Used:**
```
POST /api/translate-cues
Body: { texts: ["中文句子1", "中文句子2", ...] }
Response: { translations: ["ប្រែជាខ្មែរ ១", "ប្រែជាខ្មែរ ២", ...] }
```

**How to Check:**
- Press `Ctrl+Shift+I` to open DevTools
- Go to "Console" tab
- Watch for API calls and responses
- Check for errors (red text)

---

### 🔄 Task #6: TTS Audio Generation (Ready to Test)

**Test Steps:**
1. After translating subtitles (from Task #5)
2. Click on a subtitle row in the table
3. Click **"🎤 Generate Voice"** button
4. Wait for audio generation
5. Audio should play automatically

**Expected Results:**
- ✅ Shows "កំពុងបង្កើតសំឡេង..."
- ✅ MP3 file saved to `audio_cache/` folder
- ✅ Audio plays in browser
- ✅ Cache reused if generating same text again

**API Endpoint Used:**
```
POST /api/generate-tts
Body: { 
  text: "ខ្មែរអក្សរត្រូវនិយាយ", 
  voice: "km-KH-SreymomNeural" 
}
Response: { 
  success: true, 
  audioPath: "/audio_cache/abc123.mp3" 
}
```

**File Output:**
```
d:\EZARG\audio_cache\<hash>.mp3
```

---

### 🔄 Task #7: Draft Save/Load (Ready to Test)

**Test Steps:**
1. Load video + subtitles + translate some lines
2. Click **"💾 Save Draft"** button
3. Close the app completely
4. Reopen: `npm start`
5. Click **"📋 Drafts"** button (or similar)
6. Select your previous draft
7. Click "Load"

**Expected Results:**
- ✅ Draft saved to `drafts/` folder as JSON
- ✅ Draft includes: video path, subtitle cues, translations, timestamps
- ✅ Can list all saved drafts
- ✅ Can reload and continue working

**API Endpoints Used:**
```
POST /api/save-draft
Body: { videoPath: "...", cues: [...] }

GET /api/list-drafts
Response: { drafts: [{name, timestamp, ...}] }

POST /api/load-draft
Body: { draftId: "abc123" }
Response: { success: true, draft: {...} }
```

**File Output:**
```
d:\EZARG\drafts\<hash>.json
```

---

### ⚠️ Task #8: Video Export (FFmpeg Integration)

**Status:** Routes created but FFmpeg logic needs migration from server.js

**Test Steps (when ready):**
1. Complete video + translated subs + TTS audio
2. Click **"✨ EXPORT"** button
3. Select export style:
   - TikTok (9:16 vertical)
   - Cinema (16:9 wide)
   - Square (1:1)
4. Click **"Export MP4"**
5. Wait for FFmpeg processing
6. Output video in `Exported/` folder

**Expected Results:**
- ✅ FFmpeg burns subtitles into video
- ✅ Embeds TTS audio tracks
- ✅ Progress bar shows: 0% → 25% → 50% → 100%
- ✅ Can cancel export mid-process
- ✅ Final MP4 ready to upload

**API Endpoints:**
```
POST /api/export-video
Body: { 
  videoPath: "...", 
  cues: [...], 
  style: "tiktok" 
}

GET /api/export-progress
Response: { 
  progress: 45, 
  status: "Processing..." 
}

POST /api/cancel-export
```

**⚠️ Not Implemented Yet** - Need to migrate FFmpeg code from server.js

---

### 🔄 Task #9: Full Integration Test

**Complete Workflow (End-to-End):**

1. **Open App**
   ```bash
   npm start
   ```

2. **Import Chinese Drama**
   - Click "📁 Open Video"
   - Select: `D:\ChineseDramas\Episode01.mp4`
   - Click "📄 Import SRT"
   - Select: `D:\ChineseDramas\Episode01_zh.srt`

3. **Translate to Khmer**
   - Click "🌏 Translate All"
   - Wait for Gemini API translation
   - Verify all lines translated

4. **Generate Voices**
   - Select character lines (Queen → Female voice, King → Male voice)
   - Click "🎤 Generate Voice" for each
   - Test playback

5. **Adjust Timings**
   - Edit subtitle timecode if needed
   - Use 9:16 video preview to check alignment
   - Adjust voice selection

6. **Save Work**
   - Click "💾 Save Draft"
   - Name: "Episode01_v1"

7. **Export Final Video**
   - Click "✨ EXPORT"
   - Choose TikTok style (9:16)
   - Export MP4
   - Wait ~5-10 minutes for FFmpeg

8. **Test Output**
   - Open `Exported/Episode01_final.mp4`
   - Verify:
     - Video plays correctly
     - Khmer subtitles burned-in
     - TTS audio synchronized
     - 9:16 aspect ratio correct

---

## 🐛 Known Issues

### Issue #1: Default Project API Missing
**Error:** `/api/default-project` endpoint doesn't exist yet  
**Workaround:** Start with empty state, user manually opens files  
**Fix:** Commented out in `initProject()` function  

### Issue #2: FFmpeg Export Not Migrated
**Error:** Video export won't work yet  
**Workaround:** Use original server.js for exports (temporary)  
**Fix:** Need to migrate FFmpeg logic from server.js → routes.js  

### Issue #3: Drama Folder Scanning Not Migrated
**Error:** Can't scan `D:\HDRG` folder for batch processing  
**Workaround:** Import files manually  
**Fix:** Need to migrate folder scanning routes  

---

## 🔍 Debugging Tools

### 1. DevTools Console
```
Press: Ctrl+Shift+I
Tab: Console
Watch: API calls, errors, warnings
```

### 2. Network Tab
```
Press: Ctrl+Shift+I
Tab: Network
Filter: Fetch/XHR
Check: API requests/responses
```

### 3. Backend Logs
```
Terminal where you ran: npm start
Watch: Server-side logs, API endpoint hits
```

### 4. Check Backend Health
```powershell
# Get current port from terminal output (e.g., 63380)
curl http://127.0.0.1:63380/api/health
# Should return: {"status":"ok","message":"⚡ EZA PRO Backend is running"}
```

### 5. Test Translation API Directly
```powershell
$body = @{
    texts = @("你好", "世界")
} | ConvertTo-Json

curl -Method POST `
  -Uri "http://127.0.0.1:63380/api/translate-cues" `
  -ContentType "application/json" `
  -Body $body
```

---

## 📊 Progress Tracking

| Task | Status | Tested? | Notes |
|------|--------|---------|-------|
| #1 Extract UI | ✅ | ✅ | Complete |
| #2 Extract JS | ✅ | ✅ | Complete |
| #3 API Routes | ✅ | ✅ | Complete |
| #4 Video Player | ✅ | ✅ | Launching successfully |
| #5 Translation | 🔄 | ⏳ | **Ready to test manually** |
| #6 TTS Audio | 🔄 | ⏳ | **Ready to test manually** |
| #7 Drafts | 🔄 | ⏳ | **Ready to test manually** |
| #8 FFmpeg Export | ⚠️ | ⏳ | Not migrated yet |
| #9 Full Test | ⏳ | ⏳ | After #8 done |

---

## 🎯 Next Steps

1. **You test manually** in the Electron window:
   - Test translation (Task #5)
   - Test TTS (Task #6)
   - Test drafts (Task #7)

2. **Report results:**
   - ✅ What works
   - ❌ What's broken
   - 🐛 Any errors you see

3. **I will fix bugs** based on your feedback

4. **After Tasks 5-7 working:**
   - I'll migrate FFmpeg export (Task #8)
   - Complete final integration test (Task #9)
   - Build Windows .exe: `npm run build:win`

---

**⚡ EZA PRO** - Ready to test! 🚀
