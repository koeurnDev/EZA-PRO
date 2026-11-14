# ⚡ EZA PRO Ecosystem Guide (Studio + Downloader + Cloud Admin)

ឯកសារនេះបង្ហាញពីតម្រូវការ និងរបៀបប្រើប្រាស់ប្រព័ន្ធទាំងមូលរបស់ **EZA PRO**។

## ១. ផ្នែកទាំង ៣ នៃគម្រោង
1. **EZA PRO Studio (`D:\EZARG`)**: AI Video Transcription (STT), ការបកប្រែភាសាខ្មែរតាមវចនានុក្រមជួនណាត (`ឲ្យ`), Edge-TTS / AI Voice Clone Dubbing, និង Export វីដេអូ 1080p។ *(GitHub: `https://github.com/koeurnDev/EZA-PRO.git`)*
2. **EZA PRO Downloader (`D:\EZA_PRO`)**: ទាញយករឿងភាគពី HongGuo, DramaBox, ReelShort, Hema, Xifan និង Social Link (TikTok, YouTube...) + ផ្គុំរឿងពេញដោយ FFmpeg។ *(GitHub: `https://github.com/koeurnDev/RG.git`)*
3. **Cloudflare Worker + D1 Admin (`D:\EZARG\cloudflare-license-worker`)**: Web Admin គ្រប់គ្រង License Key, ម៉ាស៊ីនភ្ញៀវ (HWID), App Scope (`All / Studio / Downloader`), Maintenance Lock, Router Lock, និង Audit Logs។ *(GitHub: `https://github.com/koeurnDev/EZA-PRO.git`)*

## ២. ត្រូវការអ្វីខ្លះ? (Requirements)
- **អ្នកប្រើទូទៅ (`.exe`)**:
  - Windows 10/11 (x64)
  - អ៊ីនធឺណិតសម្រាប់ផ្ទៀងផ្ទាត់ Key ដំបូង និងការងារអនឡាញ (Offline Grace ១២ ម៉ោង)
  - **License Key (`EZAPRO-...`)** ពី Admin
  - **Gemini API Key** (ដាក់ក្នុង Settings/Router នៃ Studio សម្រាប់ STT/បកប្រែ; ស្រេចចិត្តក្នុង Downloader)
  - `ffmpeg.exe`, `ffprobe.exe`, `aria2c.exe`, `yt-dlp.exe`, `N_m3u8DL-RE.exe` ត្រូវបានខ្ចប់ជាមួយ `.exe` រួចជាស្រេច
- **អ្នកអភិវឌ្ឍ / Admin**:
  - Node.js v20+ (`v22.12+` supported), npm, Git, Cloudflare Wrangler (`npx wrangler`)
  - Binary files ក្នុង `D:\EZARG\tools\bin\ffmpeg.exe` និង `D:\EZA_PRO\bin\*.exe`

## ៣. របៀបប្រើ និងពាក្យបញ្ជាសំខាន់ៗ

### ការគ្រប់គ្រង Admin Web
- **URL**: `https://eza-pro-license-admin.koeurnseab630.workers.dev/admin`
- **Password**: មើលក្នុង `D:\EZARG\cloudflare-license-worker\.admin-credentials.local.txt` *(ឯកសារសម្ងាត់ក្នុងម៉ាស៊ីន)*
- Admin អាចបង្កើត Key ដោយរើស **App Scope**: `🌟 ទាំងពីរ App`, `🎙️ Studio`, ឬ `🎬 Downloader`។

### EZA PRO Studio (`D:\EZARG`)
```bash
npm start
node --test test-fixes.js test-speech-route.js
npm run build:win
```
- លទ្ធផល Build: `D:\EZARG\dist\EZA PRO-1.0.0-x64.exe` និង `EZA PRO-1.0.0-Portable.exe`

### EZA PRO Downloader (`D:\EZA_PRO`)
```bash
npm start          # បើក Electron Desktop
npm run start:web  # បើក Web UI localhost:3000
npm test           # តេស្តប្រព័ន្ធ License & Security Gate
npm run build:win  # បង្កើត .exe ក្នុង dist/
```
- លទ្ធផល Build: `D:\EZA_PRO\dist\EZA PRO Downloader-1.0.0-x64.exe` និង `EZA PRO Downloader-1.0.0-Portable.exe`

### Cloudflare Worker (`D:\EZARG\cloudflare-license-worker`)
```bash
npx wrangler deploy
```
