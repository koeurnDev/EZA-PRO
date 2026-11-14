# ⚡ EZA PRO - API Routes Documentation

## Router Structure (Express Router Pattern)

Routes are organized by feature for better maintainability:

```
src/backend/routes/
├── index.js          # Main router setup
├── config.js         # Configuration management
├── translation.js    # Chinese → Khmer translation
├── tts.js            # Text-to-Speech generation
└── draft.js          # Draft save/load
```

---

## API Endpoints

### 🏥 Health Check

**GET** `/api/health`

Check if backend is running.

**Response:**
```json
{
  "status": "ok",
  "message": "⚡ EZA PRO Backend is running",
  "version": "1.0.0",
  "timestamp": "2024-11-12T..."
}
```

---

### ⚙️ Configuration

**GET** `/api/config`

Get current configuration (without sensitive data).

**Response:**
```json
{
  "success": true,
  "config": {
    "DOWNLOAD_DIR": "D:\\HDRG",
    "hasApiKey": true
  }
}
```

---

**POST** `/api/config`

Save non-secret configuration only. API keys are managed through the desktop Router Management sidebar and Electron secure storage.

**Body:**
```json
{
  "DOWNLOAD_DIR": "D:\\HDRG"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration saved"
}
```

Requests containing `GEMINI_API_KEY` are rejected with status `400`.

---

### 📝 SRT parsing

**POST** `/api/parse-srt-raw`

Parse raw SRT text and return subtitle cues for the editor.

**Body:**
```json
{
  "raw": "1\\n00:00:01,000 --> 00:00:02,000\\n你好"
}
```

Returns `{ "success": true, "cues": [...] }`, or status `400` with a JSON error when the input has no valid cues.

---

### 🌏 Translation

**POST** `/api/translation/translate-cues`

Translate subtitle cues with a three-stage Gemini workflow: extract names/titles/relationships, translate with neighboring dialogue context, then reflect and polish the draft.

**Body:**
```json
{
  "cues": [
    {
      "index": 1,
      "text": "你好世界",
      "translated": ""
    }
  ],
  "targetLang": "km",
  "useCache": true
}
```

**Response:**
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
    "apiCalls": 3,
    "cacheHitRate": "0%"
  }
}
```

---

**POST** `/api/translation/ocr-frames`

Recognize hardcoded Chinese subtitles from sampled video frames using Gemini Vision. The frontend samples the video at a selectable interval and sends at most six JPEG/PNG/WebP frames per request.

**Body:**
```json
{
  "frames": [
    {
      "timeSec": 1.0,
      "mimeType": "image/jpeg",
      "imageBase64": "..."
    }
  ]
}
```

The response contains the recognized text for each frame and its supplied timestamp. The frontend groups consecutive identical OCR results into subtitle cues. Cue boundaries are estimates based on the sampling interval, not frame-accurate timestamps; users should review the generated cues.

---

**POST** `/api/translation/auto-detect-speech`

Extract speech audio from a selected video and ask Gemini to transcribe spoken dialogue with estimated start/end times. Returns source-language cues for review; translation remains a separate step.

**Body:**
```json
{
  "videoPath": "D:\\HDRG\\episode.mp4"
}
```

The audio is sent to Gemini and may incur API charges. The desktop app asks for confirmation before submitting it. The endpoint requires FFmpeg and rejects audio larger than 12 MiB; split longer videos into shorter parts.

---

**POST** `/api/translation/clear-cache`

Clear translation cache.

**Response:**
```json
{
  "success": true,
  "message": "Translation cache cleared"
}
```

---

### 🎤 Text-to-Speech (TTS)

**POST** `/api/tts/generate`

Generate Khmer TTS audio from text.

**Body:**
```json
{
  "text": "សួស្តី",
  "voice": "km-KH-PisethNeural"
}
```

**Response:**
```json
{
  "success": true,
  "audioUrl": "/audio_cache/abc123def456.mp3",
  "cached": false
}
```

---

**POST** `/api/tts/batch-generate`

Generate multiple TTS audio files at once.

**Body:**
```json
{
  "items": [
    {
      "index": 1,
      "text": "សួស្តី",
      "voice": "km-KH-SreymomNeural"
    },
    {
      "index": 2,
      "text": "អរុណសួស្តី",
      "voice": "km-KH-PisethNeural"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "index": 1,
      "success": true,
      "audioUrl": "/audio_cache/abc123.mp3"
    },
    {
      "index": 2,
      "success": true,
      "audioUrl": "/audio_cache/def456.mp3"
    }
  ],
  "stats": {
    "total": 2,
    "success": 2,
    "errors": 0
  }
}
```

---

**GET** `/api/tts/voices`

Get available Khmer voices.

**Response:**
```json
{
  "success": true,
  "voices": [
    {
      "name": "km-KH-PisethNeural",
      "gender": "Male",
      "language": "Khmer (Cambodia)",
      "description": "ភាសារបស់បុរស"
    },
    {
      "name": "km-KH-SreymomNeural",
      "gender": "Female",
      "language": "Khmer (Cambodia)",
      "description": "ភាសារបស់ស្រី"
    }
  ]
}
```

---

**DELETE** `/api/tts/cache`

Clear TTS audio cache (delete all generated audio files).

**Response:**
```json
{
  "success": true,
  "message": "Deleted 42 audio files",
  "deletedCount": 42
}
```

---

### 💾 Draft Management

**POST** `/api/drafts/save`

Save current work as draft.

**Body:**
```json
{
  "cues": [...],
  "videoPath": "D:\\Videos\\Episode01.mp4",
  "videoName": "Episode01.mp4",
  "timestamp": 1699876543210
}
```

**Response:**
```json
{
  "success": true,
  "message": "Draft saved successfully",
  "draftKey": "abc123def456",
  "savedPath": "D:\\EZARG\\drafts\\abc123def456.json",
  "cueCount": 150
}
```

---

**POST** `/api/drafts/load`

Load draft by video path or draft key.

**Body:**
```json
{
  "videoPath": "D:\\Videos\\Episode01.mp4"
}
```

**OR**

```json
{
  "draftKey": "abc123def456"
}
```

**Response:**
```json
{
  "success": true,
  "draft": {
    "cues": [...],
    "videoPath": "D:\\Videos\\Episode01.mp4",
    "videoName": "Episode01.mp4",
    "cueCount": 150,
    "translatedCount": 120,
    "timestamp": 1699876543210,
    "lastModified": "2024-11-12T10:30:00Z"
  },
  "draftKey": "abc123def456",
  "found": true
}
```

---

**GET** `/api/drafts/list`

List all saved drafts.

**Response:**
```json
{
  "success": true,
  "drafts": [
    {
      "key": "abc123def456",
      "fileName": "abc123def456.json",
      "videoPath": "D:\\Videos\\Episode01.mp4",
      "videoName": "Episode01.mp4",
      "cueCount": 150,
      "translatedCount": 120,
      "timestamp": 1699876543210,
      "lastModified": "2024-11-12T10:30:00Z",
      "size": 25600,
      "sizeReadable": "25.0 KB"
    }
  ],
  "total": 1
}
```

---

**DELETE** `/api/drafts/:key`

Delete a specific draft by key.

**Example:** `DELETE /api/drafts/abc123def456`

**Response:**
```json
{
  "success": true,
  "message": "Draft deleted successfully"
}
```

---

**DELETE** `/api/drafts/clear/all`

Delete ALL drafts.

**Response:**
```json
{
  "success": true,
  "message": "Deleted 5 drafts",
  "deletedCount": 5
}
```

---

## Benefits of Router Pattern

✅ **Better Organization** - Each feature has its own file  
✅ **Easier Maintenance** - Find and edit specific endpoints quickly  
✅ **Reusable** - Import router functions across modules  
✅ **Scalable** - Add new features without modifying main file  
✅ **Testable** - Test individual routers independently  

---

## How to Add New Routes

1. Create new router file: `src/backend/routes/myfeature.js`
2. Define routes using Express Router:

```javascript
const express = require('express');
const router = express.Router();

router.get('/endpoint', (req, res) => {
  res.json({ success: true });
});

module.exports = router;
```

3. Register in `index.js`:

```javascript
const myFeatureRouter = require('./myfeature');
app.use('/api/myfeature', myFeatureRouter);
```

Done! ✅

---

**⚡ EZA PRO** - Clean, organized, professional API structure!
