# ⚡ EZA PRO - Final Integration Test

**Date:** 2024-11-12  
**Status:** Ready for Testing  
**Progress:** 8/9 Tasks Complete (89%)

---

## 🎯 Test Objective

Verify complete end-to-end workflow from video import to final export.

---

## 📋 Full Workflow Test

### Step 1: Start Application ✅
```bash
# Browser Mode (Easier for testing)
npm run dev
# Opens: http://localhost:3001

# OR Electron Mode (Full features)
npm start
```

**Expected:**
- ✅ App launches without errors
- ✅ UI loads correctly
- ✅ Backend API responds

---

### Step 2: Import Video & Subtitles

**Actions:**
1. Click **"📁 Open Video"** button
2. Select a Chinese drama video file (.mp4)
3. Click **"📄 Import SRT"** button
4. Select Chinese subtitle file (.srt)

**Expected Results:**
- ✅ Video loads in 9:16 preview player
- ✅ Subtitles appear in table
- ✅ Chinese text visible in "Original" column
- ✅ Status message shows file names

**Browser Test Alternative:**
- Manual file loading won't work in browser
- But API endpoints can be tested directly
- Use test page: http://localhost:3001/test

---

### Step 3: Translate to Khmer 🌏

**Actions:**
1. Click **"🌏 Translate All"** button
2. Wait for translation to complete

**Expected Results:**
- ✅ Progress shows: "កំពុងបកប្រែ... 1/50", "2/50", etc.
- ✅ Khmer text appears in "Translation" column
- ✅ Translation cache saves results
- ✅ Status: "បានបកប្រែរួចរាល់ X/Y អក្សររត់"

**API Test:**
```bash
curl -X POST http://localhost:3001/api/translation/translate-cues \
  -H "Content-Type: application/json" \
  -d '{"cues":[{"index":1,"text":"你好世界","translated":""}]}'
```

**Expected Response:**
```json
{
  "success": true,
  "cues": [
    {
      "index": 1,
      "text": "你好世界",
      "translated": "សួស្តីពិភពលោក"
    }
  ],
  "stats": {
    "translatedCount": 1,
    "totalCount": 1,
    "cacheHits": 0,
    "apiCalls": 1
  }
}
```

---

### Step 4: Generate TTS Audio 🎤

**Actions:**
1. Select subtitle lines (click on rows)
2. Assign voices:
   - Female characters → "👸 Queen" voice
   - Male characters → "🤴 King" voice
3. Click **"🎤 Generate Voice"** for selected lines
4. Or click **"🎤 Generate All Voices"** for batch

**Expected Results:**
- ✅ Shows: "កំពុងបង្កើតសំឡេង..."
- ✅ Audio files saved to `audio_cache/`
- ✅ Audio player appears with playback
- ✅ Click to preview each audio
- ✅ Second generation uses cache (instant)

**API Test:**
```bash
curl -X POST http://localhost:3001/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"សួស្តីអ្នកទាំងអស់គ្នា","voice":"km-KH-SreymomNeural"}'
```

**Expected Response:**
```json
{
  "success": true,
  "audioUrl": "/audio_cache/abc123def456.mp3",
  "cached": false
}
```

---

### Step 5: Preview & Adjust ▶️

**Actions:**
1. Click video player play button
2. Watch subtitles sync with video
3. Adjust timings if needed:
   - Edit "Start" and "End" times
   - Click "Apply" to save changes
4. Test audio playback for each line

**Expected Results:**
- ✅ Video plays smoothly
- ✅ Subtitles appear at correct times
- ✅ Khmer text readable and formatted
- ✅ TTS audio plays on cue
- ✅ Timeline scrubber works

---

### Step 6: Save Draft 💾

**Actions:**
1. Click **"💾 Save Draft"** button
2. (Optional) Enter draft name
3. Confirm save

**Expected Results:**
- ✅ Draft saved to `drafts/` folder
- ✅ Success message shown
- ✅ Draft includes:
  - Video path
  - All subtitle cues
  - Translations
  - Voice assignments
  - Timestamps

**API Test:**
```bash
curl -X POST http://localhost:3001/api/drafts/save \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"D:\\Test\\video.mp4","cues":[{"index":1,"text":"test","translated":"តេស្ត"}]}'
```

**Verify:**
```bash
curl http://localhost:3001/api/drafts/list
```

---

### Step 7: Load Draft (Optional Test) 📂

**Actions:**
1. Close and reopen app
2. Click **"📋 Drafts"** button
3. Select previous draft
4. Click "Load"

**Expected Results:**
- ✅ All work restored
- ✅ Video path remembered
- ✅ Subtitles reload
- ✅ Translations intact
- ✅ Continue where left off

---

### Step 8: Export Video 🎬

**Actions:**
1. Click **"✨ EXPORT"** button
2. Configure export options:
   - **Subtitle Style:** TikTok / Cinema / Pill / Neon
   - **Font Size:** 48-72
   - **Mask:** Enabled/Disabled
   - **Mask Mode:** Feathered / Black / Cinema Bar
3. Click **"🚀 Export MP4"**
4. Wait for FFmpeg processing

**Expected Results:**
- ✅ Progress modal appears
- ✅ Real-time progress: 0% → 100%
- ✅ Shows: time, speed (e.g., "2.5x")
- ✅ Can cancel mid-process
- ✅ Output file created in `Exported/` folder
- ✅ Success notification with file path

**API Test:**
```bash
# Check FFmpeg is available
ffmpeg -version

# Test export endpoint (requires real video file)
curl -X POST http://localhost:3001/api/export/video \
  -H "Content-Type: application/json" \
  -d '{
    "videoPath": "D:\\path\\to\\video.mp4",
    "cues": [{"index":1,"text":"test","translated":"តេស្ត","startSec":0,"endSec":2}],
    "duration": 120,
    "subStyle": "tiktok"
  }'
```

**Check Progress:**
```bash
curl http://localhost:3001/api/export/progress
```

---

### Step 9: Verify Output ✅

**Actions:**
1. Open exported video file
2. Play in video player (VLC, Windows Media Player)
3. Verify:
   - Subtitles burned into video
   - Khmer text readable
   - Styling applied correctly
   - Video quality good
   - Audio intact

**Expected Results:**
- ✅ Video plays without errors
- ✅ Khmer subtitles visible
- ✅ Text positioning correct (bottom center)
- ✅ Background mask applied (if enabled)
- ✅ Original audio preserved
- ✅ File size reasonable

---

## 🧪 Automated Testing

### Run Full API Test Suite
```bash
npm test
```

**Expected:**
```
✓ GET /api/health returns 200
✓ GET /api/config returns config
✓ POST /api/config saves config
✓ POST /api/translation/translate-cues (validation)
✓ POST /api/translation/translate-cues (with API key)
✓ POST /api/tts/generate (validation)
✓ POST /api/tts/generate (accepts valid text)
✓ GET /api/tts/voices returns voice list
✓ POST /api/tts/batch-generate
✓ POST /api/drafts/save (validation)
✓ POST /api/drafts/save (creates draft)
✓ GET /api/drafts/list returns drafts
✓ POST /api/drafts/load
✓ Error handling tests

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Test Summary
Total: 18+
Passed: All
Failed: 0
Success Rate: 100%
```

---

## 📊 Feature Checklist

### Core Features
- [x] Video player (9:16 vertical preview)
- [x] SRT subtitle import
- [x] Subtitle editor table
- [x] Chinese → Khmer translation (Gemini API)
- [x] Text-to-Speech audio (Edge TTS)
- [x] Draft save/load system
- [x] FFmpeg video export with burned subs
- [x] Multiple subtitle styles
- [x] Mask modes for readability
- [x] Progress tracking
- [x] Cancel export

### Backend APIs
- [x] `/api/health` - Health check
- [x] `/api/config` - Configuration
- [x] `/api/translation/translate-cues` - Translation
- [x] `/api/tts/generate` - Single TTS
- [x] `/api/tts/batch-generate` - Batch TTS
- [x] `/api/tts/voices` - Voice list
- [x] `/api/drafts/save` - Save draft
- [x] `/api/drafts/load` - Load draft
- [x] `/api/drafts/list` - List all drafts
- [x] `/api/export/video` - Export video
- [x] `/api/export/progress` - Export progress
- [x] `/api/export/cancel` - Cancel export

### UI Components
- [x] Top toolbar with buttons
- [x] Video preview (9:16)
- [x] Subtitle table editor
- [x] Timeline scrubber
- [x] Settings modal
- [x] Export modal
- [x] Progress modal
- [x] Draft picker modal
- [x] Toast notifications

---

## 🐛 Known Limitations

### Browser Mode
- ❌ Native file dialogs don't work
- ❌ Direct file system access limited
- ✅ API endpoints work perfectly
- ✅ Good for backend testing

### Electron Mode
- ✅ Full file system access
- ✅ Native dialogs work
- ✅ Complete feature set
- ❌ Slower to restart for testing

### FFmpeg Export
- ⚠️ Requires FFmpeg installed
- ⚠️ Video encoding takes time (5-10 min)
- ⚠️ Output file size can be large
- ✅ Can cancel mid-process

---

## ✅ Success Criteria

### All Features Must:
1. ✅ Launch without errors
2. ✅ Load files correctly
3. ✅ Translate Chinese to Khmer
4. ✅ Generate Khmer TTS audio
5. ✅ Save/load drafts
6. ✅ Export video with subtitles
7. ✅ Handle errors gracefully
8. ✅ Show progress feedback
9. ✅ Cache results properly
10. ✅ Produce valid output files

---

## 🎯 Next Steps After Testing

### If All Tests Pass:
```bash
# Build Windows installer
npm run build:win

# Output: dist/EZA-PRO-Setup-1.0.0.exe
```

### If Issues Found:
1. Note which feature fails
2. Check browser console (F12)
3. Check server terminal logs
4. Report error messages
5. Fix and retest

---

## 📝 Test Report Template

```
# EZA PRO - Integration Test Results
Date: __________
Tester: __________

## Test Results
[ ] Step 1: App Launch
[ ] Step 2: Import Files
[ ] Step 3: Translation
[ ] Step 4: TTS Generation
[ ] Step 5: Preview
[ ] Step 6: Save Draft
[ ] Step 7: Load Draft
[ ] Step 8: Export Video
[ ] Step 9: Verify Output

## Issues Found
1. _______________
2. _______________

## Overall Status
[ ] Ready for Production
[ ] Needs Fixes
[ ] Major Issues

## Notes
_______________
```

---

**⚡ EZA PRO** - Ready for Final Testing! 🚀
