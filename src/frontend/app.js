
    // Global Application State
    const BACKEND_URL = window.electronAPI?.backendUrl
      || window.BACKEND_URL
      || ((typeof window !== 'undefined' && window.location && /^https?:$/i.test(window.location.protocol) && window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://localhost:3001');

    function isMobileOrRemoteClient() {
      if (typeof window === 'undefined') return false;
      if (window.electronAPI) return false;
      try {
        const host = String((window.location && window.location.hostname) || '').toLowerCase();
        if (host && host !== 'localhost' && host !== '127.0.0.1') return true;
        if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator.userAgent || ''))) return true;
        if (Number(window.innerWidth) > 0 && Number(window.innerWidth) <= 860) return true;
      } catch (_) {}
      return false;
    }

    let activeCues = [];
    let currentVideoPath = '';
    let currentSrtPath = '';
    let currentVideoDuration = 0;
    let isDubVoiceEnabled = true;
    let selectedCueIndex = -1;
    let activeAudioPlayer = new Audio();
    let currentDramaInfo = null;
    let activeObjectUrl = '';
    let activeVideoUploadPromise = null;
    let lastSelectedVideoFile = null;
    let currentDubAudio = null;
    let dubVolumeBeforeDuck = null;
    let dubRequestToken = 0;
    let episodeRequestToken = 0;
    let activeSpeakingCueIdx = -1;
    let syncTimerId = null;
    let cachedAudioUrls = new Map();

    function parseDisplayTimeToSec(val) {
      if (typeof val === 'number' && Number.isFinite(val)) return val;
      const str = String(val == null ? '' : val).trim();
      if (!str) return null;
      const parts = str.split(':');
      if (parts.length === 2) {
        const m = parseFloat(parts[0]);
        const s = parseFloat(parts[1].replace(',', '.'));
        if (Number.isFinite(m) && Number.isFinite(s)) return m * 60 + s;
      } else if (parts.length === 3) {
        const h = parseFloat(parts[0]);
        const m = parseFloat(parts[1]);
        const s = parseFloat(parts[2].replace(',', '.'));
        if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) return h * 3600 + m * 60 + s;
      }
      const num = parseFloat(str);
      return Number.isFinite(num) ? num : null;
    }

    function normalizeCuesTiming(cues) {
      if (!Array.isArray(cues)) return [];
      const normalized = cues
        .filter(c => c && typeof c === 'object')
        .map((c, idx) => {
          const parsedStart = Number.isFinite(Number(c.startSec))
            ? Number(c.startSec)
            : (parseDisplayTimeToSec(c.start) ?? (idx * 2.5));
          const startSec = Math.max(0, Number(parsedStart.toFixed(3)));
          const parsedEnd = Number.isFinite(Number(c.endSec))
            ? Number(c.endSec)
            : (parseDisplayTimeToSec(c.end) ?? (startSec + 2.0));
          const rawText = String(c.text || c.translated || '').trim();
          const rawTrans = String(c.translated || c.text || '').trim();
          const minSlot = Math.max(1.1, Math.min(3.8, rawTrans.length * 0.045));
          const endSec = Math.max(startSec + 0.6, Number((parsedEnd > startSec ? parsedEnd : startSec + minSlot).toFixed(3)));
          return {
            ...c,
            startSec,
            endSec,
            start: formatSecToDisplay(startSec),
            end: formatSecToDisplay(endSec),
            text: rawText,
            translated: rawTrans,
            voice: c.voice || 'Sovereign King'
          };
        })
        .sort((a, b) => a.startSec - b.startSec);

      for (let i = 0; i < normalized.length; i++) {
        normalized[i].index = i + 1;
        const cur = normalized[i];
        const next = normalized[i + 1];
        const textLen = String(cur.translated || cur.text || '').length;
        const desiredMinEnd = cur.startSec + Math.max(1.2, Math.min(3.5, textLen * 0.045));
        if (cur.endSec < desiredMinEnd) {
          cur.endSec = next
            ? Math.max(cur.endSec, Math.min(desiredMinEnd, next.startSec - 0.04))
            : desiredMinEnd;
        }
        if (next && cur.endSec > next.startSec - 0.02) {
          cur.endSec = Math.max(cur.startSec + 0.3, Number((next.startSec - 0.02).toFixed(3)));
        }
        cur.start = formatSecToDisplay(cur.startSec);
        cur.end = formatSecToDisplay(cur.endSec);
      }
      return normalized;
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    let VOICE_PRESETS = [
      { id: 'Sovereign King', baseVoice: 'km-KH-PisethNeural', pitch: 0, rate: 0, label: '🎙️ ពិសិទ្ធ · បុរសធម្មតា (Piseth)' },
      { id: 'Radiant Queen', baseVoice: 'km-KH-SreymomNeural', pitch: 0, rate: 0, label: '🎙️ ស្រីមុំ · ស្ត្រីធម្មតា (Sreymom)' },
      { id: 'kh_narrator_fast', baseVoice: 'km-KH-PisethNeural', pitch: 4, rate: 18, label: '⚡ និទានរឿង TikTok (Piseth · លឿន)' },
      { id: 'kh_young_man', baseVoice: 'km-KH-PisethNeural', pitch: 14, rate: 6, label: '🧑 យុវជន (Piseth · ក្មេង ស្រស់ថ្លា)' },
      { id: 'kh_deep_boss', baseVoice: 'km-KH-PisethNeural', pitch: -16, rate: -8, label: '🧔 លោកប្រធាន / លោកតា (Piseth · ធ្ងន់)' },
      { id: 'kh_young_girl', baseVoice: 'km-KH-SreymomNeural', pitch: 16, rate: 8, label: '👧 យុវតី / ក្មេងស្រី (Sreymom · ស្រស់ស្រាយ)' },
      { id: 'kh_child', baseVoice: 'km-KH-SreymomNeural', pitch: 30, rate: 10, label: '🧒 កូនក្មេង (Sreymom · តូច គួរឲ្យស្រឡាញ់)' },
      { id: 'kh_elder_woman', baseVoice: 'km-KH-SreymomNeural', pitch: -12, rate: -8, label: '👵 ម្តាយ / លោកយាយ (Sreymom · ធ្ងន់ ស្ងប់)' }
    ];

    function normalizeEmotionId() {
      return 'auto';
    }

    function getActiveTtsEngine() {
      return 'edge';
    }

    const DEFAULT_VOICE_STORAGE_KEY = 'eza_default_voice';
    let singleVoiceUserChanged = false;

    function getSelectedSingleVoice() {
      const sel = typeof document !== 'undefined' && document.getElementById('defaultVoiceSelect');
      let saved = '';
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem) {
          saved = localStorage.getItem(DEFAULT_VOICE_STORAGE_KEY) || '';
        }
      } catch (_) {}

      if (sel && sel.value) {
        if (saved && !singleVoiceUserChanged && sel.value === 'Sovereign King') {
          return normalizeVoicePresetId(saved);
        }
        return normalizeVoicePresetId(sel.value);
      }
      if (saved) return normalizeVoicePresetId(saved);
      return 'Sovereign King';
    }

    function getVoiceLabelById(voiceId) {
      const norm = normalizeVoicePresetId(voiceId);
      const preset = VOICE_PRESETS.find(p => p.id === norm);
      return preset ? preset.label : norm;
    }

    function syncSingleVoiceSelects(voiceId) {
      const norm = normalizeVoicePresetId(voiceId);
      if (typeof document === 'undefined') return norm;
      for (const id of ['defaultVoiceSelect', 'vmDefaultVoiceSelect']) {
        const el = document.getElementById(id);
        if (el && el.value !== norm) {
          el.value = norm;
        }
      }
      return norm;
    }

    function onDefaultVoiceChange(nextVoice) {
      singleVoiceUserChanged = true;
      const chosen = syncSingleVoiceSelects(nextVoice || getSelectedSingleVoice());
      try {
        if (typeof localStorage !== 'undefined' && localStorage.setItem) {
          localStorage.setItem(DEFAULT_VOICE_STORAGE_KEY, chosen);
        }
      } catch (_) {}

      if (Array.isArray(activeCues) && activeCues.length > 0) {
        const changed = normalizeActiveCuesForCastMode(activeCues, 'single', chosen);
        if (changed) {
          renderTable();
          checkAllAudioCache();
        }
      }
      if (Array.isArray(vmQueue) && vmQueue.length > 0) {
        for (const vmItem of vmQueue) {
          if (vmItem && Array.isArray(vmItem.cues) && vmItem.cues.length > 0) {
            normalizeActiveCuesForCastMode(vmItem.cues, 'single', chosen);
          }
        }
      }
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(`🎙️ សំឡេងថេរទាំងអស់៖ ${getVoiceLabelById(chosen)}`);
      }
      return chosen;
    }

    function getCastModeGuidanceToast(engine = getActiveTtsEngine(), mode = getActiveCastMode()) {
      const voiceLabel = typeof getVoiceLabelById === 'function' ? getVoiceLabelById(getSelectedSingleVoice()) : getSelectedSingleVoice();
      return `🎙️ ១ សំឡេងថេរ (${voiceLabel})៖ ប្រើ Edge Neural សំឡេងតែមួយនេះគ្រប់បន្ទាត់ទាំងអស់ មិន Auto ដូរតួអង្គទេ`;
    }

    function syncCastModeControlForEngine() {
      return false;
    }

    function onTtsEngineChange() {
      const engine = getActiveTtsEngine();
      renderTable();
      checkAllAudioCache();
      showShortcutToast(getCastModeGuidanceToast(engine, 'single'));
    }

    function getActiveCastMode() {
      return 'single';
    }

    function isCustomCloneVoiceId(voice) {
      return typeof voice === 'string' && /^clone_[a-zA-Z0-9_-]{3,40}$/.test(voice.trim());
    }

    function isFemaleVoiceId(voice) {
      const str = typeof voice === 'string' ? voice.trim() : '';
      const preset = VOICE_PRESETS.find(p => p.id === str);
      if (preset && preset.gender) return preset.gender === 'Female';
      return str === 'Radiant Queen' ||
        str === 'kh_young_girl' ||
        str === 'kh_elder_woman' ||
        str === 'kh_child' ||
        str.includes('Queen') ||
        str.includes('Sreymom') ||
        str.includes('Female');
    }

    function collapseCueVoiceForMode(voice, castMode = getActiveCastMode(), fixedVoice = getSelectedSingleVoice()) {
      if (castMode === 'single') {
        return normalizeVoicePresetId(fixedVoice || voice);
      }
      const norm = normalizeVoicePresetId(voice);
      if (castMode === 'duo') {
        return isFemaleVoiceId(norm) ? 'Radiant Queen' : 'Sovereign King';
      }
      return norm;
    }

    function normalizeActiveCuesForCastMode(cues = activeCues, castMode = getActiveCastMode(), fixedVoice = getSelectedSingleVoice()) {
      if (!Array.isArray(cues)) return false;
      let changed = false;
      for (let i = 0; i < cues.length; i++) {
        if (!cues[i]) continue;
        const targetVoice = collapseCueVoiceForMode(cues[i].voice, castMode, fixedVoice);
        if (cues[i].voice !== targetVoice) {
          cues[i].voice = targetVoice;
          changed = true;
        }
        if (castMode === 'single' && cues[i].suggestedVoice !== targetVoice) {
          cues[i].suggestedVoice = targetVoice;
        }
      }
      return changed;
    }

    async function onCastModeChange() {
      const chosenVoice = getSelectedSingleVoice();
      if (Array.isArray(activeCues) && activeCues.length > 0) {
        const changed = normalizeActiveCuesForCastMode(activeCues, 'single', chosenVoice);
        if (changed) {
          renderTable();
          checkAllAudioCache();
        }
      }
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(`🎙️ ១ សំឡេងថេរ (${getVoiceLabelById(chosenVoice)})៖ គ្រប់បន្ទាត់ប្រើសំឡេងអ្នករើស`);
      }
    }

    function normalizeVoicePresetId(voice) {
      const str = typeof voice === 'string' ? voice.trim() : '';
      if (!str) return 'Sovereign King';
      if (VOICE_PRESETS.some(p => p.id === str)) return str;
      if (isCustomCloneVoiceId(str)) return str;
      if (str.includes('Queen') || str.includes('Sreymom')) return 'Radiant Queen';
      return 'Sovereign King';
    }

    function resolveVoiceName(voice) {
      const str = typeof voice === 'string' ? voice.trim() : '';
      if (!str) return 'km-KH-PisethNeural';
      const preset = VOICE_PRESETS.find(p => p.id === str);
      if (preset) return preset.baseVoice;
      if (str.includes('Queen') || str.includes('Sreymom')) return 'km-KH-SreymomNeural';
      if (str.includes('King') || str.includes('Piseth')) return 'km-KH-PisethNeural';
      if (/^[a-z]{2,3}-[a-z]{2}-.+neural$/i.test(str)) return str;
      return 'km-KH-PisethNeural';
    }

    function getVoiceSignature(voice, emotion = 'auto', engine = getActiveTtsEngine()) {
      const str = typeof voice === 'string' ? voice.trim() : '';
      const preset = VOICE_PRESETS.find(p => p.id === str);
      if (preset && preset.isClone) {
        return `clone:${preset.id}|b=${preset.baseVoice || 'km-KH-PisethNeural'}|r=${preset.revision || 1}`;
      }
      if (isCustomCloneVoiceId(str)) {
        return `clone:${str}`;
      }
      let sig;
      if (preset) {
        const pitchNum = Number(preset.pitchNum ?? preset.pitch) || 0;
        const rateNum = Number(preset.rateNum ?? preset.rate) || 0;
        if (pitchNum !== 0 || rateNum !== 0) {
          const pStr = pitchNum >= 0 ? `+${pitchNum}Hz` : `${pitchNum}Hz`;
          const rStr = rateNum >= 0 ? `+${rateNum}%` : `${rateNum}%`;
          sig = `${preset.baseVoice}|p=${pStr}|r=${rStr}`;
        } else {
          sig = preset.baseVoice;
        }
      } else {
        sig = resolveVoiceName(str);
      }
      const emo = normalizeEmotionId(emotion);
      if (emo && emo !== 'auto' && emo !== 'natural') {
        sig += `|e=${emo}`;
      }
      return sig;
    }

    function getAudioCacheKey(voice, text, emotion = 'auto', engine = getActiveTtsEngine()) {
      return `${getVoiceSignature(voice, emotion, engine)}:${String(text || '').trim()}`;
    }

    function renderVoiceOptionsHtml(selectedVoice) {
      const activeId = normalizeVoicePresetId(selectedVoice);
      return VOICE_PRESETS.map(p =>
        '<option value="' + escapeHtml(p.id) + '"' + (p.id === activeId ? ' selected' : '') + '>' + escapeHtml(p.label) + '</option>'
      ).join('');
    }

    function populateBulkVoiceSelect() {
      let savedDefault = 'Sovereign King';
      let hasSaved = false;
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem) {
          const rawSaved = localStorage.getItem(DEFAULT_VOICE_STORAGE_KEY);
          if (rawSaved) {
            savedDefault = normalizeVoicePresetId(rawSaved);
            hasSaved = true;
          }
        }
      } catch (_) {}

      const primarySel = typeof document !== 'undefined' && document.getElementById('defaultVoiceSelect');
      let masterChosen = (singleVoiceUserChanged && primarySel && primarySel.value)
        ? normalizeVoicePresetId(primarySel.value)
        : (hasSaved ? savedDefault : 'Sovereign King');
      if (!VOICE_PRESETS.some(p => p.id === masterChosen)) {
        masterChosen = 'Sovereign King';
      }

      const targets = ['defaultVoiceSelect', 'vmDefaultVoiceSelect'];
      for (const id of targets) {
        const sel = typeof document !== 'undefined' && document.getElementById(id);
        if (!sel) continue;
        sel.innerHTML = renderVoiceOptionsHtml(masterChosen);
        sel.value = masterChosen;
      }
      if (Array.isArray(activeCues) && activeCues.length > 0 && getActiveCastMode() === 'single') {
        normalizeActiveCuesForCastMode(activeCues, 'single', masterChosen);
      }
    }

    function applyBulkVoice() {
      const nextVoice = normalizeVoicePresetId(getSelectedSingleVoice());
      pushUndoState();
      onDefaultVoiceChange(nextVoice);
    }

    function resolveBackendUrl(assetUrl) {
      if (!assetUrl || typeof assetUrl !== 'string') return '';
      if (/^https?:\/\//i.test(assetUrl) || assetUrl.startsWith('blob:') || assetUrl.startsWith('data:')) {
        return assetUrl;
      }
      return assetUrl.startsWith('/') ? `${BACKEND_URL}${assetUrl}` : `${BACKEND_URL}/${assetUrl}`;
    }

    function stopDubAudio() {
      dubRequestToken++;
      activeSpeakingCueIdx = -1;
      if (currentDubAudio) {
        try {
          currentDubAudio.pause();
          currentDubAudio.currentTime = 0;
        } catch (_) {}
        currentDubAudio = null;
      }
      if (!isBgmOn && bgmAudio && !bgmAudio.paused) {
        try { bgmAudio.pause(); } catch (_) {}
      }
      const v = document.getElementById('mainVideo');
      if (v && !isDubVoiceEnabled && dubVolumeBeforeDuck !== null) {
        v.volume = dubVolumeBeforeDuck;
        dubVolumeBeforeDuck = null;
      }
    }

    function startSyncLoop() {
      if (syncTimerId) clearInterval(syncTimerId);
      syncTimerId = setInterval(() => {
        const v = document.getElementById('mainVideo');
        if (v && !v.paused && !v.ended) {
          onVideoTimeUpdate();
        }
      }, 50);
    }

    function stopSyncLoop() {
      if (syncTimerId) {
        clearInterval(syncTimerId);
        syncTimerId = null;
      }
    }

    function syncPlayPauseButton() {
      const v = document.getElementById('mainVideo');
      const btn = document.getElementById('btnPlayPause');
      if (v && btn) {
        btn.innerText = v.paused ? '▶️' : '⏸️';
      }
    }

    function setVideoSource(src, isObjectUrl = false) {
      currentIsolatedBgmUrl = null;
      currentIsolatedVocalsUrl = null;
      const emptyPrompt = typeof document !== 'undefined' && document.getElementById('videoEmptyUploadPrompt');
      if (emptyPrompt) {
        emptyPrompt.hidden = Boolean(src);
        if (emptyPrompt.style) emptyPrompt.style.display = src ? 'none' : 'flex';
      }
      const v = document.getElementById('mainVideo');
      if (!v) return;
      if (activeObjectUrl && activeObjectUrl !== src) {
        try { URL.revokeObjectURL(activeObjectUrl); } catch (_) {}
        activeObjectUrl = '';
      }
      v.crossOrigin = 'anonymous';
      if (src) {
        if (isObjectUrl) activeObjectUrl = src;
        v.src = src;
        v.load();
      } else {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
      syncPlayPauseButton();
    }

    function clearDubAndPlaybackState() {
      stopDubAudio();
      if (activeAudioPlayer) {
        try {
          activeAudioPlayer.pause();
          activeAudioPlayer.currentTime = 0;
        } catch (_) {}
      }
      lastTriggeredCueIdx = -1;
      selectedCueIndex = -1;
      const sub = document.getElementById('liveSubtitleText');
      if (sub) {
        sub.style.display = 'none';
        sub.innerText = '';
      }
    }

    console.log('⚡ EZA PRO Frontend initialized. Backend:', BACKEND_URL);

    // Web Audio DSP State
    let audioCtx = null;
    let mediaSourceNode = null;
    let boostGainNode = null;
    let isBoostOn = false;
    let isVocalInvertOn = false;
    let bgmAudio = new Audio();
    let isBgmOn = false;

    // Caching state for audio hashes
    let cachedAudioMap = new Set();

    async function saveDraftNow() {
      if (!currentVideoPath) {
        return alert('សូមបើករឿងពី Folder ឬ HDRG មុន។ Video ដែលជ្រើសដោយប៊ូតុង Video មិនមាន file path សម្រាប់ភ្ជាប់ Draft និង Export ទេ។');
      }
      try {
        const response = await fetch(`${BACKEND_URL}/api/drafts/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cues: activeCues,
            videoPath: currentVideoPath,
            videoName: document.getElementById('videoTrackTitle').innerText,
            timestamp: Date.now()
          })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'រក្សាទុក Draft មិនបានទេ។');
        showShortcutToast('💾 បានរក្សាទុក Draft');
        document.getElementById('bottomStatusMsg').innerText = '💾 បានរក្សាទុក Draft រួចរាល់';
      } catch (err) {
        alert('រក្សាទុក Draft បរាជ័យ៖ ' + err.message);
      }
    }

    function openDraftsModal() {
      const modal = document.getElementById('draftsModal');
      const list = document.getElementById('draftsListContainer');
      if (!list.dataset.actionsBound) {
        list.addEventListener('click', (event) => {
          const button = event.target.closest('button[data-draft-action]');
          if (!button) return;
          if (button.dataset.draftAction === 'load') loadSavedDraft(button.dataset.draftKey);
          if (button.dataset.draftAction === 'delete') deleteSavedDraft(button.dataset.draftKey);
        });
        list.dataset.actionsBound = 'true';
      }
      modal.style.display = 'flex';
      refreshDraftsList();
    }

    function closeDraftsModal() {
      document.getElementById('draftsModal').style.display = 'none';
    }

    async function refreshDraftsList() {
      const list = document.getElementById('draftsListContainer');
      list.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'drafts-empty';
      loading.innerText = '⏳ កំពុងផ្ទុក drafts...';
      list.appendChild(loading);

      try {
        const response = await fetch(`${BACKEND_URL}/api/drafts/list`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'មិនអាចផ្ទុក drafts បានទេ។');
        list.replaceChildren();
        if (!data.drafts || data.drafts.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'drafts-empty';
          empty.innerText = 'មិនទាន់មាន Draft ដែលបានរក្សាទុកទេ។';
          list.appendChild(empty);
          return;
        }

        data.drafts.forEach(draft => {
          const item = document.createElement('div');
          item.className = 'draft-item';
          const info = document.createElement('div');
          info.className = 'draft-item-info';
          const name = document.createElement('div');
          name.className = 'draft-item-name';
          name.textContent = draft.videoName || draft.videoPath || 'Video draft';
          const meta = document.createElement('div');
          meta.className = 'draft-item-meta';
          const savedAt = new Date(draft.timestamp);
          meta.textContent = `${draft.cueCount || 0} បន្ទាត់ · បកប្រែ ${draft.translatedCount || 0} · ${Number.isNaN(savedAt.getTime()) ? '' : savedAt.toLocaleString()}`;
          info.append(name, meta);

          const actions = document.createElement('div');
          actions.className = 'draft-item-actions';
          const loadButton = document.createElement('button');
          loadButton.className = 'top-btn';
          loadButton.textContent = '📂 បើក';
          loadButton.dataset.draftAction = 'load';
          loadButton.dataset.draftKey = draft.key;
          const deleteButton = document.createElement('button');
          deleteButton.className = 'top-btn';
          deleteButton.textContent = '🗑️';
          deleteButton.title = 'លុប Draft';
          deleteButton.dataset.draftAction = 'delete';
          deleteButton.dataset.draftKey = draft.key;
          actions.append(loadButton, deleteButton);
          item.append(info, actions);
          list.appendChild(item);
        });
      } catch (err) {
        list.replaceChildren();
        const error = document.createElement('div');
        error.className = 'drafts-empty';
        error.textContent = 'ផ្ទុក Draft បរាជ័យ៖ ' + err.message;
        list.appendChild(error);
      }
    }

    async function loadSavedDraft(draftKey) {
      try {
        const response = await fetch(`${BACKEND_URL}/api/drafts/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftKey })
        });
        const data = await response.json();
        if (!response.ok || !data.success || !data.draft) {
          throw new Error(data.error || 'មិនអាចបើក Draft បានទេ។');
        }
        const draft = data.draft;
        clearDubAndPlaybackState();
        cachedAudioMap.clear();
        undoStack = [];
        redoStack = [];
        activeCues = normalizeCuesTiming(draft.cues || []);
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode());
        currentVideoPath = draft.videoPath || '';
        currentSrtPath = '';
        currentDramaInfo = null;
        if (currentVideoPath) {
          setVideoSource(`${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(currentVideoPath)}`);
          document.getElementById('videoTrackTitle').innerText = draft.videoName || currentVideoPath;
        } else {
          setVideoSource('');
          document.getElementById('videoTrackTitle').innerText = 'មិនទាន់មានវីដេអូ';
        }
        renderTable();
        renderTimeline();
        checkAllAudioCache();
        updateTranslationState();
        closeDraftsModal();
        showShortcutToast('📂 បានស្ដារ Draft');
      } catch (err) {
        alert('បើក Draft បរាជ័យ៖ ' + err.message);
      }
    }

    async function deleteSavedDraft(draftKey) {
      if (!confirm('តើអ្នកចង់លុប Draft នេះមែនទេ?')) return;
      try {
        const response = await fetch(`${BACKEND_URL}/api/drafts/${encodeURIComponent(draftKey)}`, {
          method: 'DELETE'
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || data.message || 'លុប Draft មិនបានទេ។');
        await refreshDraftsList();
      } catch (err) {
        alert('លុប Draft បរាជ័យ៖ ' + err.message);
      }
    }

    // Undo/Redo System
    let undoStack = [];
    let redoStack = [];

    function pushUndoState() {
      undoStack.push(JSON.parse(JSON.stringify(activeCues)));
      if (undoStack.length > 50) undoStack.shift();
      redoStack = [];
    }

    function undoAction() {
      if (undoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវមិនធ្វើវិញ'); return; }
      redoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = undoStack.pop();
      renderTable();
      renderTimeline();
      showShortcutToast('↩️ មិនធ្វើវិញ');
    }

    function redoAction() {
      if (redoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវធ្វើវិញ'); return; }
      undoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = redoStack.pop();
      renderTable();
      renderTimeline();
      showShortcutToast('↪️ ធ្វើវិញ');
    }

    function showShortcutToast(msg) {
      let toast = document.getElementById('shortcutToast');
      if (!toast) {
        if (typeof document.createElement !== 'function' || !document.body || typeof document.body.appendChild !== 'function') {
          return;
        }
        toast = document.createElement('div');
        toast.id = 'shortcutToast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,229,192,0.15);border:1px solid #00e5c0;color:#00e5c0;padding:8px 18px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.3s;font-family:Kantumruy Pro,sans-serif;';
        document.body.appendChild(toast);
      }
      toast.innerText = msg;
      toast.style.opacity = '1';
      clearTimeout(toast._tid);
      toast._tid = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
    }

    // Auto-Save Draft
    async function autoSaveDraft() {
      if (activeCues.length === 0 || !currentVideoPath) return;
      try {
        await fetch(`${BACKEND_URL}/api/drafts/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: activeCues, videoPath: currentVideoPath, timestamp: Date.now(), isAutoSave: true })
        });
        const st = document.getElementById('bottomStatusMsg');
        const prev = st.innerText;
        st.innerText = '💾 បានរក្សាទុកស្វ័យប្រវត្តិ';
        setTimeout(() => { if (st.innerText === '💾 បានរក្សាទុកស្វ័យប្រវត្តិ') st.innerText = prev; }, 2000);
      } catch(e) { console.error('Auto-save error:', e); }
    }

    // 1. Initialize Real Project
    async function initProject() {
      try {
        const video = document.getElementById('mainVideo');
        if (video && !video.dataset.syncBound) {
          video.dataset.syncBound = 'true';
          video.addEventListener('play', () => {
            syncPlayPauseButton();
            startSyncLoop();
          });
          video.addEventListener('pause', () => {
            syncPlayPauseButton();
            stopSyncLoop();
            stopDubAudio();
          });
          video.addEventListener('ended', () => {
            syncPlayPauseButton();
            stopSyncLoop();
            stopDubAudio();
          });
        }

        if (!document.body.dataset.menusBound) {
          document.body.dataset.menusBound = 'true';
          document.addEventListener('click', (event) => {
            document.querySelectorAll('details.project-menu[open], details.secondary-tools-menu[open], details.timeline-edit-menu[open], details.script-edit-menu[open]').forEach((menu) => {
              const clickedInside = menu.contains(event.target);
              const clickedAction = event.target.closest('button, a');
              if (!clickedInside || (clickedInside && clickedAction)) {
                menu.open = false;
              }
            });
          });
        }

        populateBulkVoiceSelect();
        syncCastModeControlForEngine({ normalizeCues: false });
        if (typeof fetch === 'function') {
          refreshVoicesAndPresets().then(() => {
            if (activeCues.length > 0) checkAllAudioCache();
          });
        }

        renderTimeline();
        document.getElementById('bottomStatusMsg').innerText = '👋 សូមស្វាគមន៍មកកាន់ EZA PRO! សូមបើក Video ឬ Folder។';
        updateTranslationState();

        // Check for newer draft
        if (currentVideoPath) {
          try {
            const draftRes = await fetch(`${BACKEND_URL}/api/drafts/load`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoPath: currentVideoPath })
            });
            const draftData = await draftRes.json();
            if (draftData.success && draftData.draft && draftData.draft.cues && draftData.draft.cues.length > 0) {
              const draftTime = new Date(draftData.draft.timestamp);
              if (confirm('🔄 មានសេចក្ដីព្រាងថ្មីជាង (រក្សាទុកនៅ ' + draftTime.toLocaleString('km-KH') + ')។ តើអ្នកចង់ស្ដារវាមកវិញទេ?')) {
                activeCues = normalizeCuesTiming(draftData.draft.cues);
                normalizeActiveCuesForCastMode(activeCues, getActiveCastMode());
                renderTable();
                renderTimeline();
                checkAllAudioCache();
                updateTranslationState();
                showShortcutToast('📂 បានស្ដារសេចក្ដីព្រាង');
              }
            }
          } catch(e) { /* no draft */ }
        }
      } catch (e) {
        console.error('Init error:', e);
      }
      // Start auto-save every 30 seconds
      setInterval(autoSaveDraft, 30000);
    }

    function loadDramaData(drama, episode, cues) {
      clearDubAndPlaybackState();
      cachedAudioMap.clear();
      undoStack = [];
      redoStack = [];
      currentDramaInfo = drama;
      currentVideoPath = episode && episode.videoPath ? episode.videoPath : '';
      currentSrtPath = episode && episode.srtPath ? episode.srtPath : '';
      document.getElementById('currentDramaTitleTag').innerText = (drama && (drama.name || drama.dramaName)) || 'មើលវីដេអូជាមុន';

      // Populate episodes
      const epSelect = document.getElementById('episodeSelect');
      const episodes = (drama && Array.isArray(drama.episodes)) ? drama.episodes : [];
      epSelect.innerHTML = episodes.map(e => '<option value="' + escapeHtml(e.ep) + '">' + escapeHtml(e.ep) + '</option>').join('');
      if (episode) epSelect.value = episode.ep;

      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(episode.videoPath));
        document.getElementById('videoTrackTitle').innerText = episode.video || episode.videoPath;
      } else {
        setVideoSource('');
        document.getElementById('videoTrackTitle').innerText = 'មិនទាន់មានវីដេអូ';
      }

      if (cues && cues.length > 0) {
        activeCues = normalizeCuesTiming(cues);
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        currentSrtPath = (episode && episode.srtPath) || '';
      } else {
        activeCues = [];
      }

      renderTable();
      renderTimeline();
      checkAllAudioCache();
    }

    // Check cached audios
    async function checkAllAudioCache() {
      if (activeCues.length === 0) {
        cachedAudioMap.clear();
        updateVoiceReadyBadge();
        return;
      }
      const engine = getActiveTtsEngine();
      const castMode = getActiveCastMode();
      const lockedVoice = getSelectedSingleVoice();
      if (castMode === 'single') {
        normalizeActiveCuesForCastMode(activeCues, 'single', lockedVoice);
      }
      const items = activeCues
        .map(c => ({
          text: String(c.translated || c.text || '').trim(),
          voice: castMode === 'single' ? lockedVoice : normalizeVoicePresetId(c.voice),
          emotion: normalizeEmotionId(c.emotion),
          engine
        }))
        .filter(it => it.text.length > 0);
      if (items.length === 0) {
        cachedAudioMap.clear();
        updateVoiceReadyBadge();
        return;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/check-audio-cache`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        const data = await res.json();
        const keys = Array.isArray(data.cachedKeys) ? data.cachedKeys : [];
        cachedAudioMap = new Set(keys);
        if (data && data.urls && typeof data.urls === 'object') {
          Object.entries(data.urls).forEach(([k, u]) => {
            if (u) cachedAudioUrls.set(k, resolveBackendUrl(u));
          });
        }
        renderTable();
        updateVoiceReadyBadge();
      } catch (_) {}
    }

    function updateVoiceReadyBadge() {
      const engine = getActiveTtsEngine();
      const castMode = getActiveCastMode();
      const lockedVoice = getSelectedSingleVoice();
      let ready = 0;
      activeCues.forEach(c => {
        const v = castMode === 'single' ? lockedVoice : normalizeVoicePresetId(c.voice);
        const key = getAudioCacheKey(v, c.translated || c.text, c.emotion, engine);
        if (cachedAudioMap.has(key)) ready++;
      });
      const badge = document.getElementById('voiceReadyBadge');
      if (badge) badge.innerText = ready + '/' + activeCues.length + ' ready';
    }

    // 2. Render Cues Table
    function toggleSelectAll(checkbox) {
      document.querySelectorAll('.cue-check').forEach(item => {
        item.checked = checkbox.checked;
      });
    }

    function updateTranslationState() {
      const hasTranslations = activeCues.some(cue =>
        typeof cue.translated === 'string' && cue.translated.trim().length > 0 &&
        (Boolean(cue.translatedLang) || cue.translated !== cue.text));
      document.body.classList.toggle('has-translated-cues', hasTranslations);
    }

    function decodeEscapedUnicode(value) {
      return String(value || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }

    function renderTable() {
      const tbody = document.getElementById('cuesTableBody');
      if (!tbody) return;
      const searchEl = document.getElementById('scriptSearch');
      const search = (searchEl && searchEl.value ? searchEl.value : '').toLowerCase();
      const statusFilterEl = document.getElementById('scriptStatusFilter');
      const statusFilter = statusFilterEl ? statusFilterEl.value : 'all';
      let html = '';
      let visibleCount = 0;

      const engine = getActiveTtsEngine();
      const singleModeLocked = getActiveCastMode() === 'single';
      const lockedVoice = singleModeLocked ? getSelectedSingleVoice() : '';
      activeCues.forEach((cue, idx) => {
        const text = decodeEscapedUnicode(cue.translated || cue.text || '');
        const origText = decodeEscapedUnicode(cue.text || '');
        if (search && !text.toLowerCase().includes(search) && !origText.toLowerCase().includes(search)) return;

        const isSelected = (idx === selectedCueIndex);
        const activeClass = isSelected ? 'active' : '';
        const voiceStr = singleModeLocked ? lockedVoice : normalizeVoicePresetId(cue.voice);
        if (singleModeLocked && cue.voice !== lockedVoice) {
          cue.voice = lockedVoice;
        }
        const isReady = text.trim() && cachedAudioMap.has(getAudioCacheKey(voiceStr, text, 'auto', engine));
        const hasTranslated = Boolean(cue.translated && String(cue.translated).trim());
        const isUntranslated = !hasTranslated || (Boolean(origText.trim()) && decodeEscapedUnicode(cue.translated).trim() === origText.trim());

        if (statusFilter === 'unvoiced' && isReady) return;
        if (statusFilter === 'untranslated' && !isUntranslated) return;
        visibleCount++;

        const origTooltip = (origText && origText !== text) ? (' title="ដើម: ' + escapeHtml(origText) + '"') : '';

        html += '<tr class="script-row ' + activeClass + '" id="row_cue_' + idx + '" onclick="onRowClick(' + idx + ', event)">' +
          '<td data-label="✓"><input type="checkbox" class="cue-check" data-idx="' + idx + '" onclick="event.stopPropagation()"></td>' +
          '<td data-label="Start" class="cell-time">' + formatSecToDisplay(cue.startSec) + '</td>' +
          '<td data-label="End" class="cell-time">' + formatSecToDisplay(cue.endSec) + '</td>' +
          '<td data-label="Text">' +
            '<input type="text" class="cell-text-input" value="' + escapeHtml(text) + '"' + origTooltip + ' oninput="onTextEdit(' + idx + ', this.value)">' +
          '</td>' +
          '<td data-label="Voice">' +
            '<select class="voice-select-pill" onchange="onVoiceChange(' + idx + ', this.value)" onclick="event.stopPropagation()">' +
              renderVoiceOptionsHtml(voiceStr) +
            '</select>' +
          '</td>' +
          '<td data-label="Audio">' +
            '<div class="audio-btns-wrap">' +
              '<span title="' + (isReady ? 'មានសំឡេងរួចរាល់' : 'មិនទាន់បង្កើតសំឡេង') + '" style="font-size:10px; line-height:1;">' + (isReady ? '🟢' : '⚪') + '</span>' +
              '<button class="btn-audio-mini" onclick="playCueAudio(' + idx + ', event)" title="ស្តាប់សំឡេង">▶</button>' +
              '<button class="btn-audio-retry" onclick="retryCueAudio(' + idx + ', event)" title="សំយោគសំឡេងឡើងវិញ">🔄</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      });

      tbody.innerHTML = html;
      const statsEl = document.getElementById('cuesStatsText');
      if (statsEl) {
        statsEl.innerText = visibleCount === activeCues.length
          ? ('សរុប: ' + activeCues.length + ' បន្ទាត់')
          : ('បង្ហាញ ' + visibleCount + '/' + activeCues.length + ' បន្ទាត់');
      }
      updateTranslationState();
      updateVoiceReadyBadge();
    }

    function formatSecToDisplay(s) {
      const safe = Math.max(0, Number(s) || 0);
      const totalTenths = Math.round(safe * 10);
      const m = Math.floor(totalTenths / 600);
      const secTenths = totalTenths % 600;
      const secStr = (secTenths / 10).toFixed(1);
      return m + ':' + (secTenths < 100 ? '0' : '') + secStr;
    }

    function onRowClick(idx, e) {
      selectCueRow(idx, true);
    }

    function selectCueRow(idx, shouldSeek = true) {
      selectedCueIndex = idx;
      const cue = activeCues[idx];
      if (!cue) return;

      document.querySelectorAll('.script-row').forEach(r => r.classList.remove('active'));
      const row = document.getElementById('row_cue_' + idx);
      if (row) {
        row.classList.add('active');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      if (shouldSeek) {
        stopDubAudio();
        const v = document.getElementById('mainVideo');
        v.currentTime = cue.startSec;
        setPlayheadTime(cue.startSec);
      }
    }

    let lastTextUndoCueIdx = -1;
    let lastTextUndoTime = 0;

    function onTextEdit(idx, val) {
      const cue = activeCues[idx];
      if (cue) {
        const now = Date.now();
        if (lastTextUndoCueIdx !== idx || (now - lastTextUndoTime) > 1500) {
          pushUndoState();
        }
        lastTextUndoCueIdx = idx;
        lastTextUndoTime = now;
        const wasUntranslated = !cue.translatedLang && (!cue.translated || cue.translated === cue.text);
        if (wasUntranslated) {
          cue.text = val;
          cue.translated = val;
        } else {
          cue.translated = val;
        }
        updateTranslationState();
        updateVoiceReadyBadge();
        if (selectedCueIndex === idx) {
          const sub = document.getElementById('liveSubtitleText');
          const v = document.getElementById('mainVideo');
          if (sub) updateKaraokeSubtitleDOM(sub, cue, idx, v ? v.currentTime : (cue.startSec || 0));
        }
      }
    }

    function onVoiceChange(idx, val) {
      if (activeCues[idx]) {
        pushUndoState();
        if (getActiveCastMode() === 'single') {
          onDefaultVoiceChange(val);
        } else {
          activeCues[idx].voice = normalizeVoicePresetId(val);
          updateVoiceReadyBadge();
          renderTable();
          checkAllAudioCache();
        }
      }
    }

    // 3. Audio Dubbing Synthesis & Playback
    async function playCueAudio(idx, e, forceRegenerate = false) {
      if (e) e.stopPropagation();
      const cue = activeCues[idx];
      if (!cue) return;

      const text = String(cue.translated || cue.text || '').trim();
      if (!text) return;
      const castMode = getActiveCastMode();
      const voice = castMode === 'single' ? getSelectedSingleVoice() : normalizeVoicePresetId(cue.voice);
      if (castMode === 'single' && cue.voice !== voice) {
        cue.voice = voice;
      }
      const engine = getActiveTtsEngine();

      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, engine, strictVoice: true, force: Boolean(forceRegenerate) })
        });
        const data = await res.json();
        if (!res.ok || !data.success || !data.audioUrl) {
          if (data && data.needsCloneEngineInstall) {
            showShortcutToast('⚠️ សូមដំឡើង Seed-VC AI Model ក្នុង Voice Clone Studio ជាមុនសិន');
            if (typeof openVoiceCloneModal === 'function') openVoiceCloneModal();
          }
          throw new Error(data.error || 'Failed to generate audio');
        }
        stopDubAudio();
        activeAudioPlayer.pause();
        activeAudioPlayer.currentTime = 0;
        const resolvedUrl = resolveBackendUrl(data.audioUrl);
        activeAudioPlayer.src = resolvedUrl + (forceRegenerate ? `?t=${Date.now()}` : '');
        activeAudioPlayer.play().catch(err => console.warn('Audio play prevented:', err.message));
        const cacheKey = getAudioCacheKey(voice, text, 'auto', engine);
        cachedAudioMap.add(cacheKey);
        cachedAudioUrls.set(cacheKey, resolvedUrl);
        renderTable();
      } catch (err) {
        console.error('Audio play error:', err);
      }
    }

    function retryCueAudio(idx, e) {
      if (e) e.stopPropagation();
      playCueAudio(idx, e, true);
    }

    async function autoCastCharacterVoices(forceReassign = false) {
      if (!Array.isArray(activeCues) || activeCues.length === 0) {
        if (forceReassign) alert('មិនទាន់មាន Subtitle សម្រាប់អនុវត្តសំឡេងទេ!');
        return false;
      }
      const fixedVoice = getSelectedSingleVoice();
      const changed = normalizeActiveCuesForCastMode(activeCues, 'single', fixedVoice);
      if (changed) {
        renderTable();
        checkAllAudioCache();
      }
      if (forceReassign) {
        const msg = `🎙️ កំពុងប្រើ ១ សំឡេងថេរ (${getVoiceLabelById(fixedVoice)}) សម្រាប់គ្រប់បន្ទាត់`;
        showShortcutToast(msg);
        const bottomEl = document.getElementById('bottomStatusMsg');
        if (bottomEl) bottomEl.innerText = msg;
      }
      return changed;
    }

    async function batchGenerateAllAudio(options = {}) {
      if (activeCues.length === 0) {
        if (!currentVideoPath) {
          await ensureVideoReadyOnServer();
        }
        if (!currentVideoPath) {
          await openVideoFile();
        }
        if (currentVideoPath && activeCues.length === 0) {
          const ok = await startSpeechDetection({ skipConfirm: true, silentSuccess: true });
          if (ok && activeCues.length > 0) {
            await startAiTranslation({ silentSuccess: true, skipAutoChain: true });
          }
        }
        if (activeCues.length === 0) {
          return alert('សូមជ្រើសរើស Video រួចចុច TRANSCRIBE AI ឬនាំចូល File SRT ជាមុនសិន។');
        }
      }
      const batchCastMode = getActiveCastMode();
      const singleVoice = batchCastMode === 'single' ? getSelectedSingleVoice() : '';
      if (batchCastMode === 'single') {
        const changed = normalizeActiveCuesForCastMode(activeCues, 'single', singleVoice);
        if (changed) renderTable();
      } else {
        // Automatically cast male/female/character voices if all lines are still stuck on the single default voice
        await autoCastCharacterVoices(false);
      }

      const onlyMissing = Boolean(options && options.onlyMissing);
      const ttsEngine = getActiveTtsEngine();
      let count = 0;
      let failedCount = 0;
      let fallbackCount = 0;
      let skippedCount = 0;
      const queueIndices = [];
      for (let i = 0; i < activeCues.length; i++) {
        const cue = activeCues[i];
        const text = String(cue && (cue.translated || cue.text) || '').trim();
        if (!text) continue;
        if (onlyMissing) {
          const voice = normalizeVoicePresetId(cue.voice);
          if (cachedAudioMap.has(getAudioCacheKey(voice, text, 'auto', ttsEngine))) {
            skippedCount++;
            continue;
          }
        }
        queueIndices.push(i);
      }
      const validTotal = queueIndices.length;

      if (validTotal === 0) {
        const doneMsg = onlyMissing
          ? `✅ គ្រប់ ${activeCues.length} បន្ទាត់មានសំឡេងរួចរាល់អស់ហើយ!`
          : 'មិនមានអក្សរសម្រាប់បង្កើតសំឡេងទេ។';
        const bottomEl = document.getElementById('bottomStatusMsg');
        if (bottomEl) bottomEl.innerText = doneMsg;
        if (!options.silentSuccess && typeof showShortcutToast === 'function') {
          showShortcutToast(doneMsg);
        }
        return { count: 0, failedCount: 0, skippedCount, validTotal: 0 };
      }

      isBatchDubbingNow = true;
      const bottomStatusEl = document.getElementById('bottomStatusMsg');
      const workerCount = Math.min(8, validTotal || 1);
      if (bottomStatusEl) {
        bottomStatusEl.innerText = onlyMissing
          ? `🔄 កំពុងបង្កើតសំឡេងបន្ទាត់ដែលនៅខ្វះ (${validTotal} បន្ទាត់)...`
          : `🎙️ កំពុងសំយោគសំឡេង Dubbing គ្រប់បន្ទាត់ដោយស្វ័យប្រវត្តិ (ល្បឿនលឿន x${workerCount})...`;
      }

      let cloneInstallNeeded = false;
      let cursor = 0;
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < queueIndices.length) {
          const i = queueIndices[cursor++];
          const cue = activeCues[i];
          const text = String(cue.translated || cue.text || '').trim();
          const voice = batchCastMode === 'single' ? singleVoice : normalizeVoicePresetId(cue.voice);
          try {
            const response = await fetch(`${BACKEND_URL}/api/tts/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text, voice, engine: ttsEngine, strictVoice: true })
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
              if (result && result.needsCloneEngineInstall) cloneInstallNeeded = true;
              throw new Error((result && result.error) || `TTS request failed (${response.status}).`);
            }
            count++;
            if (result.fallback) fallbackCount++;
            const cacheKey = getAudioCacheKey(voice, text, 'auto', ttsEngine);
            cachedAudioMap.add(cacheKey);
            if (result.audioUrl) {
              cachedAudioUrls.set(cacheKey, resolveBackendUrl(result.audioUrl));
            }
            updateVoiceReadyBadge();
          } catch (err) {
            failedCount++;
            console.warn(`[TTS] Cue ${i + 1} failed:`, err.message);
          }
        }
      });

      await Promise.all(workers);
      isBatchDubbingNow = false;

      if (cloneInstallNeeded && count === 0) {
        if (!options.silentSuccess) {
          alert('🎭 សំឡេង Clone ត្រូវការដំឡើង Seed-VC AI Model (~3–4GB ចូល Drive D) ជាមុនសិន។');
        }
        if (typeof openVoiceCloneModal === 'function') openVoiceCloneModal();
        return { count, failedCount, skippedCount, validTotal };
      }

      renderTable();
      const allSucceeded = failedCount === 0 && count > 0;
      if (bottomStatusEl) {
        bottomStatusEl.innerText = allSucceeded
          ? '✅ បានសំយោគសំឡេងរួចរាល់ ' + count + '/' + validTotal + ' បន្ទាត់!'
          : `⚠️ សំយោគបាន ${count}/${validTotal} បន្ទាត់; មាន ${failedCount} បរាជ័យ។`;
      }
      if (allSucceeded) {
        showShortcutToast(`🎙️ សំឡេង Dubbing រួចរាល់ ${count}/${validTotal} បន្ទាត់!`);
      } else if (!options.silentSuccess) {
        alert(`⚠️ សំយោគបាន ${count}/${validTotal} បន្ទាត់។ សូមពិនិត្យបន្ទាត់ដែលមានបញ្ហា ហើយសាកល្បងម្ដងទៀត។`);
      }
      return { count, failedCount, skippedCount, validTotal };
    }

    // 4. Video Player & Real-time Dub Sync
    function togglePlayPause() {
      const v = document.getElementById('mainVideo');
      if (v.paused) {
        v.play().catch(err => console.warn('Video play prevented:', err.message));
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      } else {
        v.pause();
        stopDubAudio();
      }
      syncPlayPauseButton();
    }

    function resetVideoToStart() {
      stopDubAudio();
      const v = document.getElementById('mainVideo');
      v.currentTime = 0;
      lastTriggeredCueIdx = -1;
      setPlayheadTime(0);
    }

    function onVideoLoaded() {
      const v = document.getElementById('mainVideo');
      currentVideoDuration = v.duration || 60;
      updateTimeDisplay(v.currentTime);
      renderTimeline();
      syncPlayPauseButton();
    }

    let lastTriggeredCueIdx = -1;

    const _kmWordSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
      ? new Intl.Segmenter('km', { granularity: 'word' })
      : null;
    const _subtitleChunkCache = new Map();

    function escapeSubHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function normalizeKhmerSpacing(text) {
      let s = String(text || '')
        .replace(/([\u17B6-\u17C5])(\u17D2[\u1780-\u17B3])/g, '$2$1')
        .replace(/អោយ|ឱ្យ/g, 'ឲ្យ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[\u1780-\u17FF]/.test(s)) return s;
      const boundSuffixes = 'ពេក|ណាស់|ទេ|ហើយ|ដែរ|ផង|សោះ|ឡើយ|វិញ|នេះ|នោះ|ទៀត|អី|ហ្នឹង|មែនទេ|ទេអ្ហី|អ្ហ៎|ណា៎|ចុះ|ផងដែរ|ទាំងអស់|ប៉ុណ្ណោះ|ឯង';
      const suffixRe = new RegExp(`([\\u1780-\\u17FF])\\s+(${boundSuffixes})(?=[\\s។!?៖,，。！？]|$)`, 'g');
      s = s.replace(suffixRe, '$1$2').replace(suffixRe, '$1$2');

      const boundPrefixes = 'របស់|នៃ|ជា|គឺ|គឺជា|នៅ|ក្នុង|លើ|ក្រោម|ពី|ដោយ|សម្រាប់|ចំពោះ|មិន|អត់|កុំ|បាន|នឹង|កំពុង|ដ៏|ឲ្យ|ឱ្យ|អោយ|ថា';
      const prefixRe = new RegExp(`(^|[\\s\\u17D4-\\u17DA])(${boundPrefixes})\\s+([\\u1780-\\u17FF])`, 'g');
      s = s.replace(prefixRe, '$1$2$3').replace(prefixRe, '$1$2$3');

      s = s.replace(/\s+([។!?៖])/g, '$1');
      return s.replace(/\s{2,}/g, ' ').trim();
    }

    function getKhmerVisualLength(str) {
      const s = String(str || '')
        .replace(/\u17D2[\u1780-\u17A2]/g, '')
        .replace(/[\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u200B-\u200D]/g, '');
      return Array.from(s).length;
    }

    function segmentSubtitleIntoChunks(rawText, maxCharsPerChunk = 22, maxWordsPerChunk = 6) {
      const clean = normalizeKhmerSpacing(rawText);
      if (!clean) return { chunks: [], totalWeight: 0 };
      const cacheKey = `${clean}|${maxCharsPerChunk}|${maxWordsPerChunk}`;
      if (_subtitleChunkCache.has(cacheKey)) return _subtitleChunkCache.get(cacheKey);

      // 1. Split by natural whitespace first so we NEVER invent artificial spaces between Khmer words!
      const spaceGroups = clean.split(/\s+/).filter(Boolean);
      const mergedWords = [];

      for (let gIdx = 0; gIdx < spaceGroups.length; gIdx++) {
        const group = spaceGroups[gIdx];
        const isLastGroup = gIdx === spaceGroups.length - 1;
        const groupVisLen = getKhmerVisualLength(group);

        // Keep short/medium natural space-separated groups intact as 1 natural phrase unit
        if (!_kmWordSegmenter || groupVisLen <= 9 || !/[\u1780-\u17FF]/.test(group)) {
          mergedWords.push({
            text: group,
            spaceAfter: !isLastGroup,
            isSpacedUnit: true
          });
          continue;
        }

        // For a long unspaced Khmer clause, segment into balanced 6-11 visual-char phrase units WITHOUT adding spaces between them
        const subTokens = [];
        let curTok = '';
        for (const seg of _kmWordSegmenter.segment(group)) {
          const s = seg.segment;
          if (!s) continue;
          if (seg.isWordLike) {
            if (curTok) subTokens.push(curTok);
            curTok = s;
          } else {
            curTok += s;
          }
        }
        if (curTok) subTokens.push(curTok);

        const phraseUnits = [];
        let acc = '';
        for (let t = 0; t < subTokens.length; t++) {
          const piece = subTokens[t];
          const nextAcc = acc ? (acc + piece) : piece;
          const accVisLen = getKhmerVisualLength(acc);
          const nextVisLen = getKhmerVisualLength(nextAcc);
          const isBoundModifier = /^(?:ពេក|ណាស់|ទេ|ហើយ|ដែរ|ផង|សោះ|ឡើយ|វិញ|នេះ|នោះ|ជា|គឺ|របស់|នៃ|ក្នុង|នៅ|មិន|អត់|បាន|នឹង|ប៉ុណ្ណោះ|គ្រឿង|ដៃ)[។!?៖]*$/.test(piece);
          if (acc && accVisLen >= 5 && nextVisLen > 9 && !isBoundModifier) {
            phraseUnits.push(acc);
            acc = piece;
          } else {
            acc = nextAcc;
          }
        }
        if (acc) {
          if (phraseUnits.length > 0 && getKhmerVisualLength(acc) <= 4) {
            phraseUnits[phraseUnits.length - 1] += acc;
          } else {
            phraseUnits.push(acc);
          }
        }

        for (let u = 0; u < phraseUnits.length; u++) {
          const isLastInGroup = u === phraseUnits.length - 1;
          mergedWords.push({
            text: phraseUnits[u],
            spaceAfter: isLastInGroup && !isLastGroup,
            isSpacedUnit: phraseUnits.length === 1
          });
        }
      }

      // 2. Group into readable chunks, breaking ONLY at natural space boundaries (spaceAfter === true) or clause punctuation
      const chunks = [];
      let curWords = [];
      let curVisChars = 0;

      for (let i = 0; i < mergedWords.length; i++) {
        const item = mergedWords[i];
        const wVisLen = Math.max(1, getKhmerVisualLength(item.text));
        const endsClause = /[។!?៖,，。！？]$/.test(item.text);
        const prevEndedWithSpace = curWords.length > 0 && curWords[curWords.length - 1].spaceAfter;

        if (
          curWords.length > 0 &&
          prevEndedWithSpace &&
          (curVisChars + wVisLen > maxCharsPerChunk || curWords.length >= maxWordsPerChunk)
        ) {
          chunks.push({ words: curWords });
          curWords = [];
          curVisChars = 0;
        } else if (curWords.length > 0 && curVisChars + wVisLen > maxCharsPerChunk + 10) {
          chunks.push({ words: curWords });
          curWords = [];
          curVisChars = 0;
        }

        curWords.push({
          text: item.text,
          spaceAfter: item.spaceAfter,
          isSpacedUnit: item.isSpacedUnit,
          weight: Math.max(2, wVisLen)
        });
        curVisChars += wVisLen + (item.spaceAfter ? 1 : 0);

        if (endsClause && item.spaceAfter && curVisChars >= 6) {
          chunks.push({ words: curWords });
          curWords = [];
          curVisChars = 0;
        }
      }
      if (curWords.length > 0) {
        if (curWords.length === 1 && chunks.length > 0 && getKhmerVisualLength(curWords[0].text) <= 4) {
          chunks[chunks.length - 1].words.push(curWords[0]);
        } else {
          chunks.push({ words: curWords });
        }
      }

      // 3. Compute cumulative time ratios for each chunk and word
      let totalWeight = 0;
      for (const ch of chunks) {
        ch.weight = ch.words.reduce((acc, w) => acc + w.weight, 0);
        totalWeight += ch.weight;
      }
      totalWeight = Math.max(1, totalWeight);

      let accum = 0;
      for (const ch of chunks) {
        ch.startRatio = accum / totalWeight;
        let wordAccum = accum;
        for (const w of ch.words) {
          w.startRatio = wordAccum / totalWeight;
          wordAccum += w.weight;
          w.endRatio = wordAccum / totalWeight;
        }
        accum += ch.weight;
        ch.endRatio = accum / totalWeight;
      }

      const result = { chunks, totalWeight };
      if (_subtitleChunkCache.size > 300) _subtitleChunkCache.clear();
      _subtitleChunkCache.set(cacheKey, result);
      return result;
    }

    let isSubtitleVisible = true;
    let isWordPopEnabled = true;

    function updateKaraokeSubtitleDOM(subEl, cue, cueIdx, curVideoSec) {
      if (!subEl || !cue) return;
      if (!isSubtitleVisible) {
        subEl.style.display = 'none';
        return;
      }
      const displayText = String(cue.translated || cue.text || '').trim();
      if (!displayText) {
        subEl.style.display = 'none';
        return;
      }

      // Calculate speech progress [0..1] synced to Dub Voice audio if playing, otherwise video timeline.
      // Apply a slight onset lead (+80ms) and 88% effective speech span so word highlights pop AT syllable onset
      // instead of lagging behind the actor's voice.
      let progress = 0;
      if (
        currentDubAudio &&
        !currentDubAudio.paused &&
        Number.isFinite(currentDubAudio.duration) &&
        currentDubAudio.duration > 0.1 &&
        (activeSpeakingCueIdx === cueIdx || lastTriggeredCueIdx === cueIdx)
      ) {
        const audioRate = Number(currentDubAudio.playbackRate) || 1.0;
        const effectiveDur = Math.max(0.22, currentDubAudio.duration * 0.88);
        const leadSec = 0.085 * audioRate;
        progress = Math.max(0, Math.min(0.999, (currentDubAudio.currentTime + leadSec) / effectiveDur));
      } else {
        const s = Number(cue.startSec) || 0;
        const e = Number(cue.endSec) || (s + 1.8);
        const effectiveDur = Math.max(0.30, (e - s) * 0.86);
        progress = Math.max(0, Math.min(0.999, (curVideoSec - s + 0.10) / effectiveDur));
      }

      const { chunks } = segmentSubtitleIntoChunks(displayText, 22, 5);
      if (!chunks.length) {
        subEl.style.display = 'none';
        return;
      }

      // Find active short chunk
      let activeChunkIdx = chunks.length - 1;
      for (let c = 0; c < chunks.length; c++) {
        if (progress <= chunks[c].endRatio || c === chunks.length - 1) {
          activeChunkIdx = c;
          break;
        }
      }
      const chunk = chunks[activeChunkIdx];

      // Find active word inside this short chunk
      let activeWordIdx = chunk.words.length - 1;
      for (let w = 0; w < chunk.words.length; w++) {
        if (progress <= chunk.words[w].endRatio || w === chunk.words.length - 1) {
          activeWordIdx = w;
          break;
        }
      }

      const stateKey = `${cueIdx}:${activeChunkIdx}:${activeWordIdx}:${displayText}`;
      subEl.style.display = 'inline-block';
      if (subEl.dataset.karaokeKey === stateKey) return;
      subEl.dataset.karaokeKey = stateKey;

      const htmlParts = chunk.words.map((w, idx) => {
        const cls = idx === activeWordIdx
          ? ('sub-word active' + (w.isSpacedUnit && isWordPopEnabled ? ' pop-spaced' : ''))
          : (idx < activeWordIdx ? 'sub-word spoken' : 'sub-word');
        return `<span class="${cls}">${escapeSubHtml(w.text)}</span>${w.spaceAfter ? ' ' : ''}`;
      });
      subEl.innerHTML = htmlParts.join('').trim();
    }

    function syncLiveSourceAudioSuppression(v, matchedIdx) {
      if (!v) return;
      if (!isDubVoiceEnabled) {
        if (!isBgmOn && bgmAudio && !bgmAudio.paused) {
          try { bgmAudio.pause(); } catch (_) {}
        }
        if (dubVolumeBeforeDuck !== null) {
          v.volume = dubVolumeBeforeDuck;
          dubVolumeBeforeDuck = null;
        }
        return;
      }

      if (dubVolumeBeforeDuck === null) {
        dubVolumeBeforeDuck = v.volume > 0.2 ? v.volume : 1.0;
      }

      const isDubSpeaking = Boolean(currentDubAudio && !currentDubAudio.paused);
      const isInCueWindow = matchedIdx !== -1;

      // If isolated BGM stem is ready and playing, mute original vocal video stream completely
      if (isVocalInvertOn && currentIsolatedBgmUrl) {
        v.volume = 0.0;
        if (!v.paused) {
          if (bgmAudio.src !== currentIsolatedBgmUrl) {
            bgmAudio.src = currentIsolatedBgmUrl;
            bgmAudio.loop = false;
          }
          bgmAudio.volume = isDubSpeaking || isInCueWindow ? 0.22 : 0.42;
          if (Math.abs((bgmAudio.currentTime || 0) - (v.currentTime || 0)) > 0.35) {
            try { bgmAudio.currentTime = v.currentTime || 0; } catch (_) {}
          }
          if (bgmAudio.paused) {
            bgmAudio.play().catch(() => {});
          }
        } else if (!bgmAudio.paused) {
          bgmAudio.pause();
        }
        return;
      }

      // Suppress original video dialogue during any cue or active dubbing so original actors' voices never leak
      if (isDubSpeaking || isInCueWindow) {
        v.volume = 0.02;
      } else {
        // Between cues while Dub Voice is ON: keep original audio very low so untranscribed gasps/lines don't blast
        v.volume = isVocalInvertOn ? 0.06 : 0.10;
      }
    }

    let karaokeSyncTimer = null;

    function findCueIndexAtTime(cues, curSec) {
      if (!Array.isArray(cues) || !Number.isFinite(curSec)) return -1;
      // 120ms lookahead with tail capped cleanly before the next cue's onset so rapid turns never lag
      for (let i = 0; i < cues.length; i++) {
        const s = Number(cues[i].startSec) || 0;
        const e = Number(cues[i].endSec) || (s + 1.5);
        const nextS = (i + 1 < cues.length) ? (Number(cues[i + 1].startSec) || Infinity) : Infinity;
        const maxEnd = Math.max(s + 0.08, Math.min(e + 0.22, nextS - 0.06));
        if (curSec >= (s - 0.12) && curSec <= maxEnd) {
          return i;
        }
      }
      return -1;
    }

    function ensureKaraokeHighFreqSync() {
      if (karaokeSyncTimer || typeof setInterval !== 'function') return;
      karaokeSyncTimer = setInterval(() => {
        const v = document.getElementById('mainVideo');
        const dubActive = Boolean(currentDubAudio && !currentDubAudio.paused);
        const vidActive = Boolean(v && !v.paused);
        if (!dubActive && !vidActive) {
          clearInterval(karaokeSyncTimer);
          karaokeSyncTimer = null;
          return;
        }
        const sub = document.getElementById('liveSubtitleText');
        if (!sub) return;
        const cur = v ? v.currentTime : 0;
        const idx = activeSpeakingCueIdx >= 0 ? activeSpeakingCueIdx : findCueIndexAtTime(activeCues, cur);
        if (idx >= 0 && idx < activeCues.length) {
          updateKaraokeSubtitleDOM(sub, activeCues[idx], idx, cur);
        }
      }, 35);
    }

    function onVideoTimeUpdate() {
      const v = document.getElementById('mainVideo');
      if (!v) return;
      const cur = v.currentTime;
      setPlayheadTime(cur);
      if (!v.paused) ensureKaraokeHighFreqSync();

      const matchedIdx = findCueIndexAtTime(activeCues, cur);

      syncLiveSourceAudioSuppression(v, matchedIdx);

      const sub = document.getElementById('liveSubtitleText');
      if (matchedIdx !== -1) {
        const cue = activeCues[matchedIdx];
        updateKaraokeSubtitleDOM(sub, cue, matchedIdx, cur);

        if (matchedIdx !== selectedCueIndex) {
          selectCueRow(matchedIdx, false);
        }

        // Real-Time Dub Voice Playback (skip auto-triggering while translation is actively running)
        if (isDubVoiceEnabled && !v.paused && !isTranslatingNow && matchedIdx !== lastTriggeredCueIdx) {
          lastTriggeredCueIdx = matchedIdx;
          playDubVoiceForCue(cue, matchedIdx);
        }
      } else if (activeSpeakingCueIdx >= 0 && activeSpeakingCueIdx < activeCues.length && currentDubAudio && !currentDubAudio.paused) {
        // Keep subtitle visible and animating word-by-word while dub voice is still finishing the sentence!
        const speakingCue = activeCues[activeSpeakingCueIdx];
        updateKaraokeSubtitleDOM(sub, speakingCue, activeSpeakingCueIdx, cur);
      } else {
        if (sub) {
          sub.style.display = 'none';
          sub.dataset.karaokeKey = '';
        }
      }
    }

    function startDubAudioElement(audioUrl, cue, idx, reqId) {
      const v = document.getElementById('mainVideo');
      if (reqId !== dubRequestToken || !isDubVoiceEnabled || !v || v.paused) return;
      if (!audioUrl) return;

      const dubPlayer = new Audio(audioUrl);
      currentDubAudio = dubPlayer;
      activeSpeakingCueIdx = idx;
      ensureKaraokeHighFreqSync();

      const sub = document.getElementById('liveSubtitleText');
      if (sub) {
        updateKaraokeSubtitleDOM(sub, cue, idx, v.currentTime);
      }
      dubPlayer.addEventListener('timeupdate', () => {
        if (currentDubAudio === dubPlayer && sub) {
          updateKaraokeSubtitleDOM(sub, cue, idx, v ? v.currentTime : (cue.startSec || 0));
        }
      });

      syncLiveSourceAudioSuppression(v, idx);

      const nextCue = (Number.isInteger(idx) && activeCues[idx + 1]) ? activeCues[idx + 1] : null;
      const nextStartSec = nextCue ? Number(nextCue.startSec) : Infinity;

      dubPlayer.addEventListener('loadedmetadata', () => {
        if (currentDubAudio !== dubPlayer || !v) return;
        const clipDur = Number(dubPlayer.duration);
        if (!Number.isFinite(clipDur) || clipDur <= 0) return;
        const vidRate = Number(v.playbackRate) || 1.0;
        const curVideoSec = Number(v.currentTime) || Number(cue.startSec) || 0;
        const cueEnd = Number.isFinite(nextStartSec)
          ? Math.min(nextStartSec - 0.05, Math.max(Number(cue.endSec) || (curVideoSec + 1.5), curVideoSec + 0.8))
          : Math.max(Number(cue.endSec) || (curVideoSec + 1.5), curVideoSec + 1.0);
        const slotSec = Math.max(0.45, (cueEnd - curVideoSec) / vidRate);
        if (clipDur > slotSec * 1.04) {
          dubPlayer.playbackRate = Math.min(1.48, Math.max(vidRate, Number((clipDur / slotSec).toFixed(2))));
        } else {
          dubPlayer.playbackRate = vidRate;
        }
      });

      const restoreVolume = () => {
        if (currentDubAudio === dubPlayer) {
          currentDubAudio = null;
          activeSpeakingCueIdx = -1;
        }
        if (v) {
          syncLiveSourceAudioSuppression(v, -1);
        }
      };

      dubPlayer.addEventListener('ended', restoreVolume);
      dubPlayer.addEventListener('error', restoreVolume);
      dubPlayer.play().catch(() => restoreVolume());
    }

    function playDubVoiceForCue(cue, idx = -1) {
      const text = String(cue.translated || cue.text || '').trim();
      if (!text) return;
      const castMode = getActiveCastMode();
      const voice = castMode === 'single' ? getSelectedSingleVoice() : normalizeVoicePresetId(cue.voice);
      if (castMode === 'single' && cue.voice !== voice) {
        cue.voice = voice;
      }
      const engine = getActiveTtsEngine();
      const reqId = ++dubRequestToken;

      if (currentDubAudio) {
        try {
          currentDubAudio.pause();
          currentDubAudio.currentTime = 0;
        } catch (_) {}
        currentDubAudio = null;
      }
      activeSpeakingCueIdx = -1;

      const cacheKey = getAudioCacheKey(voice, text, 'auto', engine);
      const cachedUrl = cachedAudioUrls.get(cacheKey);
      if (cachedUrl) {
        startDubAudioElement(cachedUrl, cue, idx, reqId);
        return;
      }

      fetch(`${BACKEND_URL}/api/tts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, engine, strictVoice: true })
      }).then(r => r.json()).then(data => {
        if (!data || !data.audioUrl) return;
        const resolvedUrl = resolveBackendUrl(data.audioUrl);
        cachedAudioMap.add(cacheKey);
        cachedAudioUrls.set(cacheKey, resolvedUrl);
        startDubAudioElement(resolvedUrl, cue, idx, reqId);
      }).catch(err => console.warn('Dub playback error:', err.message));
    }

    function setPlayheadTime(curSec) {
      updateTimeDisplay(curSec);

      const dur = currentVideoDuration || 60;
      const pct = (curSec / dur) * 100;
      document.getElementById('scrubberFill').style.width = Math.min(100, Math.max(0, pct)) + '%';

      const needle = document.getElementById('playheadNeedle');
      const container = document.getElementById('tracksContainer');
      const refTrack = document.getElementById('trackSubBlocks') || document.getElementById('trackVideoBar');
      if (needle && container && refTrack) {
        const cRect = container.getBoundingClientRect();
        const tRect = refTrack.getBoundingClientRect();
        const trackLeft = (tRect.left - cRect.left) + container.scrollLeft;
        const trackWidth = tRect.width || Math.max(1, container.clientWidth - 112);
        const ratio = Math.min(1, Math.max(0, curSec / dur));
        needle.style.left = (trackLeft + ratio * trackWidth) + 'px';
        needle.setAttribute('data-time', formatSecToDisplay(curSec));
      }
    }

    function updateTimeDisplay(cur) {
      document.getElementById('playerTimeText').innerText = formatSecToDisplay(cur) + ' / ' + formatSecToDisplay(currentVideoDuration);
    }

    function seekByScrubber(e) {
      const track = document.getElementById('scrubberTrack');
      const rect = track.getBoundingClientRect();
      const pos = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1);
      const v = document.getElementById('mainVideo');
      const targetSec = pos * (currentVideoDuration || 60);
      stopDubAudio();
      lastTriggeredCueIdx = -1;
      v.currentTime = targetSec;
      setPlayheadTime(targetSec);
    }

    function seekByTimeline(e) {
      const container = document.getElementById('tracksContainer');
      const refTrack = document.getElementById('trackSubBlocks') || document.getElementById('trackVideoBar');
      if (!container || !refTrack) return;
      const tRect = refTrack.getBoundingClientRect();
      const clickX = e.clientX - tRect.left;
      if (clickX >= 0 && tRect.width > 0) {
        const pos = Math.min(Math.max(0, clickX / tRect.width), 1);
        const v = document.getElementById('mainVideo');
        const targetSec = pos * (currentVideoDuration || 60);
        stopDubAudio();
        lastTriggeredCueIdx = -1;
        v.currentTime = targetSec;
        setPlayheadTime(targetSec);
      }
    }

    function toggleDubVoice() {
      isDubVoiceEnabled = !isDubVoiceEnabled;
      const sw = document.getElementById('dubVoiceSwitch');
      const v = document.getElementById('mainVideo');
      if (isDubVoiceEnabled) {
        sw.classList.add('active');
        initWebAudio();
        applyVocalSuppressionState(true);
        syncLiveSourceAudioSuppression(v, -1);
      } else {
        sw.classList.remove('active');
        stopDubAudio();
        applyVocalSuppressionState(isVocalInvertOn);
        syncLiveSourceAudioSuppression(v, -1);
      }
    }

    function toggleMuteVideo() {
      const v = document.getElementById('mainVideo');
      v.muted = !v.muted;
      document.getElementById('volIcon').innerText = v.muted ? '🔇' : '🔊';
    }

    function toggleFullscreen() {
      const frame = document.querySelector('.video-frame-916') || document.getElementById('mainVideo');
      if (!frame) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (frame.requestFullscreen) {
        frame.requestFullscreen().catch(() => {});
      }
    }

    // 5. Real Web Audio API Tools (DSP) + Backend BGM Stem Isolation
    let vocalFilterNodes = [];
    let currentIsolatedBgmUrl = null;
    let currentIsolatedVocalsUrl = null;

    function initWebAudio() {
      if (audioCtx) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();
      const v = document.getElementById('mainVideo');
      mediaSourceNode = audioCtx.createMediaElementSource(v);
      boostGainNode = audioCtx.createGain();
      boostGainNode.gain.value = 1.0;

      // 5-band speech-formant notch filters (suppresses 300Hz-3600Hz human vocals when Isolate BGM or Dub Voice is ON)
      const bands = [
        { freq: 380, q: 1.0, cutDb: -14 },
        { freq: 750, q: 1.0, cutDb: -18 },
        { freq: 1400, q: 0.9, cutDb: -22 },
        { freq: 2400, q: 0.9, cutDb: -20 },
        { freq: 3400, q: 1.0, cutDb: -15 }
      ];
      vocalFilterNodes = bands.map(b => {
        const node = audioCtx.createBiquadFilter();
        node.type = 'peaking';
        node.frequency.value = b.freq;
        node.Q.value = b.q;
        node.gain.value = (isVocalInvertOn || isDubVoiceEnabled) ? b.cutDb : 0;
        node._cutDb = b.cutDb;
        return node;
      });

      let prev = mediaSourceNode;
      for (const fNode of vocalFilterNodes) {
        prev.connect(fNode);
        prev = fNode;
      }
      prev.connect(boostGainNode);
      boostGainNode.connect(audioCtx.destination);
    }

    function applyVocalSuppressionState(enabled) {
      for (const node of vocalFilterNodes) {
        if (node && node.gain) {
          node.gain.value = enabled ? (node._cutDb || -10) : 0;
        }
      }
    }

    function toggleAudioBoost() {
      initWebAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      isBoostOn = !isBoostOn;
      if (boostGainNode) boostGainNode.gain.value = isBoostOn ? 2.5 : 1.0;
      const boostCard = document.getElementById('toolAudioBoost');
      const boostTag = document.getElementById('boostTag');
      if (boostCard) boostCard.classList.toggle('active', isBoostOn);
      if (boostTag) boostTag.innerText = isBoostOn ? 'BOOST 250%' : 'OFF';
    }

    async function toggleRemoveVocals() {
      if (!isVocalInvertOn && !currentVideoPath) {
        await ensureVideoReadyOnServer();
        if (!currentVideoPath) {
          await openVideoFile();
        }
        if (!currentVideoPath) return;
      }
      initWebAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      isVocalInvertOn = !isVocalInvertOn;
      applyVocalSuppressionState(isVocalInvertOn);

      const quickBgmBtn = document.getElementById('btnQuickBgm');
      const statusEl = document.getElementById('bottomStatusMsg');
      const exportAudioModeEl = document.getElementById('exportAudioMode');

      if (quickBgmBtn) {
        quickBgmBtn.classList.toggle('active', isVocalInvertOn);
        quickBgmBtn.innerText = isVocalInvertOn ? '🎵 BGM ON' : '🎵 BGM';
      }

      if (exportAudioModeEl) {
        if (isVocalInvertOn) {
          exportAudioModeEl.value = 'bgm_only';
        } else if (exportAudioModeEl.value === 'bgm_only') {
          exportAudioModeEl.value = 'duck';
        }
      }

      if (!isVocalInvertOn) {
        if (!isBgmOn && bgmAudio && !bgmAudio.paused) {
          try { bgmAudio.pause(); } catch (_) {}
        }
        const v = document.getElementById('mainVideo');
        if (v) syncLiveSourceAudioSuppression(v, -1);
        if (statusEl) statusEl.innerText = '🔊 បានបិទមុខងារ Isolate BGM (ត្រឡប់មកសំឡេងធម្មតា)';
        return;
      }

      if (statusEl) {
        statusEl.innerText = '🎵 បានបើក Isolate BGM (កាត់បន្ថយសំឡេងនិយាយដើម និងរក្សាភ្លេង Background)!';
      }

      if (currentVideoPath && typeof fetch === 'function') {
        const requestedVideoPath = currentVideoPath;
        if (quickBgmBtn) quickBgmBtn.innerText = '🎵 ⏳...';
        fetch(`${BACKEND_URL}/api/audio/isolate-bgm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: requestedVideoPath })
        })
          .then(r => r.json())
          .then(data => {
            if (requestedVideoPath !== currentVideoPath) return;
            if (data && data.success && data.bgmUrl) {
              currentIsolatedBgmUrl = resolveBackendUrl(data.bgmUrl);
              currentIsolatedVocalsUrl = data.vocalsUrl ? resolveBackendUrl(data.vocalsUrl) : null;
              if (quickBgmBtn && isVocalInvertOn) quickBgmBtn.innerText = '🎵 BGM READY';
              if (statusEl && isVocalInvertOn) {
                statusEl.innerText = `🎵 បានបំបែកភ្លេង BGM សុទ្ធរួចរាល់ (${data.engine || 'DSP'})!`;
              }
            } else {
              if (quickBgmBtn && isVocalInvertOn) quickBgmBtn.innerText = '🎵 BGM ON';
            }
          })
          .catch(() => {
            if (requestedVideoPath === currentVideoPath && isVocalInvertOn) {
              if (quickBgmBtn) quickBgmBtn.innerText = '🎵 BGM ON';
            }
          });
      }
    }

    function toggleMusicBed() {
      isBgmOn = !isBgmOn;
      const musicCard = document.getElementById('toolMusicBed');
      const musicTag = document.getElementById('musicTag');
      if (musicCard) musicCard.classList.toggle('active', isBgmOn);
      if (musicTag) musicTag.innerText = isBgmOn ? 'PLAYING' : 'OFF';
      if (isBgmOn) {
        bgmAudio.src = currentIsolatedBgmUrl || 'https://actions.google.com/sounds/v1/ambiences/daytime_forest_bonfire.ogg';
        bgmAudio.volume = currentIsolatedBgmUrl ? 0.45 : 0.2;
        bgmAudio.loop = true;
        bgmAudio.play().catch(() => {});
      } else {
        bgmAudio.pause();
      }
    }

    // 6. Timeline Rendering
    function renderTimeline() {
      const container = document.getElementById('tracksContainer');
      const ruler = document.getElementById('timelineRuler');
      const videoTrack = document.getElementById('trackVideoBar');
      const subTrack = document.getElementById('trackSubBlocks');
      const dubTrack = document.getElementById('trackDubBlocks');
      if (!container || !ruler || !subTrack || !dubTrack) return;

      const dur = currentVideoDuration || 60;
      const zoom = Math.max(1, parseFloat(document.getElementById('timelineZoom')?.value || '1') || 1);
      const baseW = Math.max(320, (container.clientWidth || 640) - 20);
      const trackW = Math.round(Math.max(200, baseW - 102) * zoom);

      ruler.style.marginLeft = '96px';
      ruler.style.width = trackW + 'px';
      [videoTrack, dubTrack, subTrack].forEach(el => {
        if (el) {
          el.style.flex = '0 0 ' + trackW + 'px';
          el.style.width = trackW + 'px';
        }
      });
      container.querySelectorAll('.track-row').forEach(row => {
        row.style.minWidth = (trackW + 102) + 'px';
      });

      let rulerHtml = '';
      const step = dur > 120 ? (zoom >= 2 ? 10 : 15) : (zoom >= 2 ? 2 : 5);
      for (let s = 0; s <= dur; s += step) {
        const pct = (s / dur) * 100;
        rulerHtml += '<span style="position:absolute; left:' + pct + '%; transform:translateX(-50%);">' + formatSecToDisplay(s) + '</span>';
      }
      ruler.innerHTML = rulerHtml;

      let subBlocks = '';
      let dubBlocks = '';
      activeCues.forEach((cue) => {
        const leftPct = (cue.startSec / dur) * 100;
        const widthPct = Math.max(0.6, ((cue.endSec - cue.startSec) / dur) * 100);
        const safeTitle = escapeHtml(cue.translated || cue.text || '');

        subBlocks += '<div style="position:absolute; left:' + leftPct + '%; width:' + widthPct + '%; height:100%; background:rgba(245, 158, 11, 0.7); border-radius:2px;" title="' + safeTitle + '"></div>';
        dubBlocks += '<div style="position:absolute; left:' + leftPct + '%; width:' + widthPct + '%; height:100%; background:rgba(16, 185, 129, 0.7); border-radius:2px;" title="' + safeTitle + '"></div>';
      });

      subTrack.innerHTML = subBlocks;
      dubTrack.innerHTML = dubBlocks;

      const v = document.getElementById('mainVideo');
      setPlayheadTime(v ? (v.currentTime || 0) : 0);
    }

    // 7. Cues Operations: Split, Add, Delete, Nudge
    function splitLineAtCurrentTime() {
      const v = document.getElementById('mainVideo');
      const cur = v.currentTime;
      pushUndoState();
      let targetIdx = -1;
      for (let i = 0; i < activeCues.length; i++) {
        if (cur > activeCues[i].startSec && cur < activeCues[i].endSec) {
          targetIdx = i;
          break;
        }
      }

      if (targetIdx === -1) {
        addNewCueLine();
        return;
      }

      const original = activeCues[targetIdx];
      const origEnd = original.endSec;
      original.endSec = cur;
      original.end = formatSecToDisplay(cur);

      const newCue = {
        index: activeCues.length + 1,
        start: formatSecToDisplay(cur),
        end: formatSecToDisplay(origEnd),
        startSec: cur,
        endSec: origEnd,
        text: original.text,
        translated: original.translated,
        voice: original.voice
      };

      activeCues.splice(targetIdx + 1, 0, newCue);
      activeCues.forEach((c, i) => c.index = i + 1);
      renderTable();
      renderTimeline();
      selectCueRow(targetIdx + 1);
    }

    function addNewCueLine() {
      pushUndoState();
      const v = document.getElementById('mainVideo');
      const cur = v.currentTime || 0;
      const endSec = cur + 2.5;

      const newCue = {
        index: activeCues.length + 1,
        start: formatSecToDisplay(cur),
        end: formatSecToDisplay(endSec),
        startSec: cur,
        endSec: endSec,
        text: 'New line',
        translated: 'បន្ទាត់ថ្មី',
        voice: getSelectedSingleVoice()
      };

      activeCues.push(newCue);
      activeCues.sort((a, b) => a.startSec - b.startSec);
      activeCues.forEach((c, i) => c.index = i + 1);
      renderTable();
      renderTimeline();
    }

    function deleteSelectedCue() {
      const checkedIndices = Array.from(document.querySelectorAll('.cue-check:checked'))
        .map(cb => Number.parseInt(cb.dataset.idx, 10))
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < activeCues.length)
        .sort((a, b) => b - a);

      if (checkedIndices.length > 0) {
        pushUndoState();
        checkedIndices.forEach(idx => activeCues.splice(idx, 1));
      } else if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
        pushUndoState();
        activeCues.splice(selectedCueIndex, 1);
      } else {
        return;
      }

      stopDubAudio();
      lastTriggeredCueIdx = -1;
      activeCues.forEach((c, i) => { c.index = i + 1; });

      const selectAll = document.getElementById('selectAllCheck');
      if (selectAll) selectAll.checked = false;

      if (activeCues.length === 0) {
        selectedCueIndex = -1;
        const sub = document.getElementById('liveSubtitleText');
        if (sub) { sub.style.display = 'none'; sub.innerText = ''; }
      } else {
        selectedCueIndex = Math.min(Math.max(0, selectedCueIndex), activeCues.length - 1);
      }

      renderTable();
      renderTimeline();
      if (activeCues.length > 0 && selectedCueIndex >= 0) {
        selectCueRow(selectedCueIndex, false);
      }
    }

    function nudgeActiveCue(offset) {
      if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
        pushUndoState();
        const cue = activeCues[selectedCueIndex];
        cue.startSec = Math.max(0, cue.startSec + offset);
        cue.endSec = Math.max(cue.startSec + 0.5, cue.endSec + offset);
        cue.start = formatSecToDisplay(cue.startSec);
        cue.end = formatSecToDisplay(cue.endSec);
        renderTable();
        renderTimeline();
      }
    }

    function clearAllCues() {
      if (confirm('តើអ្នកចង់លុបបន្ទាត់ទាំងអស់មែនទេ?')) {
        pushUndoState();
        activeCues = [];
        cachedAudioMap.clear();
        clearDubAndPlaybackState();
        const selectAll = document.getElementById('selectAllCheck');
        if (selectAll) selectAll.checked = false;
        renderTable();
        renderTimeline();
      }
    }

    // 8. Drama Picker & Episode Switching
    async function scanCustomFolderPath(folderPath) {
      const target = String(folderPath || '').trim();
      if (!target) return alert('សូមបញ្ចូលទីតាំង Folder (ឧ. C:\\Users\\ASUS\\Downloads\\vd)!');
      try {
        const scanRes = await fetch(`${BACKEND_URL}/api/scan-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: target })
        });
        const scanData = await scanRes.json();
        if (!scanRes.ok || !Array.isArray(scanData.episodes) || scanData.episodes.length === 0) {
          alert(scanData.error || 'មិនមាន File Video ក្នុង Folder នេះទេ! សូមជ្រើស Folder រឿងដែលមានឯកសារ .mp4។');
          return;
        }
        closeHdrgDramaPicker();
        const firstEp = scanData.episodes[0];
        let initialCues = [];
        if (firstEp && firstEp.srtPath) {
          try {
            const srtRes = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath: firstEp.srtPath })
            });
            const srtData = await srtRes.json();
            initialCues = srtData.cues || [];
          } catch (_) {}
        }
        loadDramaData(scanData, firstEp, initialCues);
        showShortcutToast('📁 បានផ្ទុក ' + (scanData.name || target));
      } catch (err) {
        alert('កំហុស៖ ' + err.message);
      }
    }

    function openHdrgDramaPicker() {
      document.getElementById('dramaPickerModal').style.display = 'flex';
      const container = document.getElementById('dramaListContainer');
      container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">⏳ កំពុងស្កេន Folder...</div>';

      fetch(`${BACKEND_URL}/api/list-hdrg-dramas`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(data => {
          const dramas = Array.isArray(data.dramas) ? data.dramas : [];
          let html = '<div style="background:#0b1220; border:1px solid var(--border); border-radius:6px; padding:10px; display:flex; gap:8px; align-items:center; margin-bottom:6px;">' +
            '<input type="text" id="customFolderInput" placeholder="បិទភ្ជាប់ទីតាំង Folder វីដេអូ (ឧ. C:\\Users\\ASUS\\Downloads\\vd\\...)" style="flex:1; background:#070c17; border:1px solid var(--border-light); border-radius:5px; padding:7px 10px; color:#fff; font-size:12px; outline:none;">' +
            '<button class="top-btn" onclick="scanCustomFolderPath(document.getElementById(\'customFolderInput\').value)">📁 បើកតាម Path</button>' +
            '<button class="btn-export" style="padding:6px 12px; font-size:11px;" onclick="closeHdrgDramaPicker(); openVideoFile();">🎬 រើសឯកសារ Video</button>' +
          '</div>';
          if (dramas.length === 0) {
            html += '<div style="color: #94a3b8; text-align: center; padding: 20px;">មិនទាន់មានរឿងក្នុង Folder ស្វ័យប្រវត្តិនៅឡើយទេ។ សូមចុច "🎬 រើសឯកសារ Video" ឬបញ្ចូល Path ខាងលើ។</div>';
            container.innerHTML = html;
            return;
          }
          dramas.forEach((drama, idx) => {
            html += '<div style="background:#111a2d; border:1px solid var(--border); border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">' +
              '<div>' +
                '<div style="font-size:13px; font-weight:700; color:#fff;">🎬 ' + escapeHtml(drama.name) + '</div>' +
                '<div style="font-size:11px; color:#64748b; margin-top:2px;">ចំនួន: ' + Number(drama.episodeCount || 0) + ' ភាគ | មាន SRT: ' + Number(drama.srtCount || 0) + '</div>' +
              '</div>' +
              '<button class="btn-export" style="padding:4px 12px; font-size:11px;" onclick="loadDramaByIndex(' + idx + ')">📂 បើកក្នុង Studio</button>' +
            '</div>';
          });
          container.innerHTML = html;
          window.cachedDramaList = dramas;
        })
        .catch(err => {
          container.innerHTML = '<div style="color: #fca5a5; text-align: center; padding: 20px;">❌ មិនអាចស្កេន Folder រឿងបានទេ៖ ' + escapeHtml(err.message) + '</div>';
        });
    }

    function closeHdrgDramaPicker() {
      document.getElementById('dramaPickerModal').style.display = 'none';
    }

    function loadDramaByIndex(idx) {
      const drama = window.cachedDramaList && window.cachedDramaList[idx];
      closeHdrgDramaPicker();
      if (!drama || !Array.isArray(drama.episodes) || drama.episodes.length === 0) return;

      const firstEp = drama.episodes[0];
      if (firstEp && firstEp.srtPath) {
        fetch(`${BACKEND_URL}/api/load-srt-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: firstEp.srtPath })
        })
          .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then(data => {
            loadDramaData(drama, firstEp, data.cues || []);
          })
          .catch(err => {
            console.warn('Could not load initial SRT:', err.message);
            loadDramaData(drama, firstEp, []);
          });
      } else {
        loadDramaData(drama, firstEp, []);
      }
    }

    function onEpisodeChange(epNum) {
      if (!currentDramaInfo || !currentDramaInfo.episodes) return;
      const ep = currentDramaInfo.episodes.find(e => e.ep == epNum);
      if (!ep) return;

      clearDubAndPlaybackState();
      cachedAudioMap.clear();
      undoStack = [];
      redoStack = [];

      const reqToken = ++episodeRequestToken;
      currentVideoPath = ep.videoPath || '';
      currentSrtPath = ep.srtPath || '';
      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(ep.videoPath));
        document.getElementById('videoTrackTitle').innerText = ep.video || ep.videoPath;
        const v = document.getElementById('mainVideo');
        v.play().catch(err => console.warn('Could not autoplay episode video:', err.message));
      } else {
        setVideoSource('');
        document.getElementById('videoTrackTitle').innerText = 'មិនទាន់មានវីដេអូ';
      }

      if (ep.srtPath) {
        currentSrtPath = ep.srtPath;
        fetch(`${BACKEND_URL}/api/load-srt-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: ep.srtPath })
        })
          .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then(data => {
            if (reqToken !== episodeRequestToken) return;
            activeCues = data.cues || [];
            normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
            renderTable();
            renderTimeline();
            checkAllAudioCache();
          })
          .catch(() => {
            if (reqToken !== episodeRequestToken) return;
            activeCues = [];
            renderTable();
            renderTimeline();
          });
      } else {
        activeCues = [];
        renderTable();
        renderTimeline();
        document.getElementById('bottomStatusMsg').innerText = 'ភាគទី ' + epNum + ' មិនទាន់មាន File SRT ទេ (សូមចុច TRANSCRIBE ឬនាំចូល SRT)';
      }
    }

    let isTranslatingNow = false;
    let isBatchDubbingNow = false;

    async function runAutoOneClickPipeline() {
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
      }
      if (!currentVideoPath && activeCues.length === 0) {
        const picked = await openVideoFile();
        if (!picked && !currentVideoPath) return;
      }

      if (activeCues.length === 0 && currentVideoPath) {
        const transcribed = await startSpeechDetection({ skipConfirm: true, silentSuccess: true });
        if (!transcribed || activeCues.length === 0) return;
      }

      if (activeCues.length > 0) {
        const translated = await startAiTranslation({ silentSuccess: true, skipAutoChain: true });
        if (!translated) return;
      }

      if (currentVideoPath && !isVocalInvertOn) {
        toggleRemoveVocals();
      }

      await batchGenerateAllAudio({ silentSuccess: true });
      showShortcutToast('🎉 ១-Click រួចរាល់ទាំងអស់! (បកប្រែ + សំឡេង Dubbing + BGM)');
      document.getElementById('bottomStatusMsg').innerText = '🎉 ១-Click ធ្វើរួចរាល់ទាំងអស់! ចុច ▶️ ដើម្បីស្ដាប់ ឬចុច EXPORT ដើម្បីទាញយកវីដេអូ HD។';
    }
    async function postJsonWithTunnelRecovery(url, payload, options = {}) {
      const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
      const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2500;
      const onRetryStatus = typeof options.onRetryStatus === 'function' ? options.onRetryStatus : null;
      let lastErr = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const currentPayload = (attempt > 0 && payload && typeof payload === 'object' && payload.force === true)
            ? { ...payload, force: false, useCache: true }
            : payload;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentPayload)
          });

          const status = Number(res && res.status) || 200;
          const isGatewayTimeout = status === 524 || status === 504 || status === 503 || status === 522;
          if (isGatewayTimeout && attempt < maxRetries) {
            if (onRetryStatus) onRetryStatus(attempt + 1, status);
            await new Promise(r => setTimeout(r, retryDelayMs));
            continue;
          }

          let data = null;
          try {
            data = await res.json();
          } catch (parseErr) {
            if (attempt < maxRetries && (isGatewayTimeout || status >= 500)) {
              if (onRetryStatus) onRetryStatus(attempt + 1, status);
              await new Promise(r => setTimeout(r, retryDelayMs));
              continue;
            }
            throw new Error(isGatewayTimeout
              ? `ការតភ្ជាប់ Tunnel ចំណាយពេលយូរពេក (HTTP ${status}) — សូមចុចម្ដងទៀតដើម្បីទាញយកលទ្ធផលពី Cache។`
              : 'Backend បានត្រឡប់ទិន្នន័យមិនត្រឹមត្រូវ។');
          }
          return { res, data };
        } catch (err) {
          lastErr = err;
          const isNetworkBlip = /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String((err && err.message) || ''));
          if (isNetworkBlip && attempt < maxRetries) {
            if (onRetryStatus) onRetryStatus(attempt + 1, 0);
            await new Promise(r => setTimeout(r, retryDelayMs));
            continue;
          }
          throw err;
        }
      }
      throw lastErr || new Error('Request failed');
    }

    async function startAiTranslation(options = {}) {
      if (activeCues.length === 0) {
        if (!currentVideoPath) {
          await ensureVideoReadyOnServer();
        }
        if (!currentVideoPath) {
          await openVideoFile();
        }
        if (currentVideoPath && activeCues.length === 0) {
          if (confirm('មិនទាន់មាន Subtitle ក្នុងតារាងទេ។ តើអ្នកចង់ឲ្យ AI ស្ដាប់សំឡេងវីដេអូបង្កើត Subtitle (Transcribe AI) រួចបកប្រែដោយស្វ័យប្រវត្តិឥឡូវនេះទេ?')) {
            const transcribed = await startSpeechDetection({ skipConfirm: true, silentSuccess: true });
            if (!transcribed || activeCues.length === 0) return false;
          } else {
            return false;
          }
        }
        if (activeCues.length === 0) {
          alert('សូមជ្រើសរើស Video (ចុចប៊ូតុង 🎬 Video ឬ 📁 បើក Folder) ឬនាំចូល File SRT ជាមុនសិន។');
          return false;
        }
      }
      const sourceLangEl = document.getElementById('sourceLangSelect');
      const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';
      const targetLang = document.getElementById('targetLangSelect').value;

      let forceRetranslate = Boolean(options.force);
      if (!options.silentSuccess && !forceRetranslate && activeCues.length > 0 && !cuesNeedTranslation(activeCues, targetLang)) {
        if (!confirm('Subtitle ទាំងអស់មានការបកប្រែរួចហើយ។ តើអ្នកចង់ឲ្យ AI វិភាគសាច់រឿង និងបកប្រែសារជាថ្មីឡើងវិញទាំងអស់ទេ?')) {
          return false;
        }
        forceRetranslate = true;
      }

      document.getElementById('bottomStatusMsg').innerText = '🔥 កំពុងវិភាគសាច់រឿង បកប្រែតាមបរិបទ និងពិនិត្យតួអង្គ...';
      isTranslatingNow = true;
      stopDubAudio();

      try {
        let data = null;
        try {
          const resp = await postJsonWithTunnelRecovery(
            `${BACKEND_URL}/api/translation/translate-cues`,
            {
              cues: activeCues,
              sourceLang,
              targetLang,
              force: forceRetranslate,
              videoPath: currentVideoPath || '',
              castMode: getActiveCastMode(),
              fixedVoice: getSelectedSingleVoice()
            },
            {
              maxRetries: 5,
              retryDelayMs: 3500,
              onRetryStatus: (attempt) => {
                const statusEl = document.getElementById('bottomStatusMsg');
                if (statusEl) {
                  statusEl.innerText = `⏳ Server កំពុងបញ្ចប់ការបកប្រែក្នុងផ្ទៃខាងក្រោយ... កំពុងទាញយកលទ្ធផលបន្ត (${attempt}/5)...`;
                }
              }
            }
          );
          data = resp.data;
        } catch (primaryErr) {
          if (activeCues.length > 20 && /524|504|503|522|Tunnel/i.test(String((primaryErr && primaryErr.message) || ''))) {
            const BATCH_SIZE = 24;
            const mergedCues = activeCues.map(c => ({ ...c }));
            for (let offset = 0; offset < mergedCues.length; offset += BATCH_SIZE) {
              const slice = mergedCues.slice(offset, offset + BATCH_SIZE);
              const statusEl = document.getElementById('bottomStatusMsg');
              if (statusEl) {
                statusEl.innerText = `🔥 កំពុងបកប្រែជាផ្នែកៗការពារដាច់ Tunnel (${Math.min(offset + BATCH_SIZE, mergedCues.length)}/${mergedCues.length} បន្ទាត់)...`;
              }
              const batchResp = await postJsonWithTunnelRecovery(
                `${BACKEND_URL}/api/translation/translate-cues`,
                {
                  cues: slice,
                  sourceLang,
                  targetLang,
                  force: false,
                  videoPath: currentVideoPath || '',
                  castMode: getActiveCastMode(),
                  fixedVoice: getSelectedSingleVoice()
                },
                { maxRetries: 3, retryDelayMs: 2500 }
              );
              if (batchResp.data && batchResp.data.success && Array.isArray(batchResp.data.cues)) {
                for (let k = 0; k < batchResp.data.cues.length; k++) {
                  if (mergedCues[offset + k]) {
                    mergedCues[offset + k] = batchResp.data.cues[k];
                  }
                }
                activeCues = normalizeCuesTiming(mergedCues);
                renderTable();
              }
            }
            data = { success: true, cues: mergedCues };
          } else {
            throw primaryErr;
          }
        }
        isTranslatingNow = false;
        if (data && data.success && data.cues) {
          pushUndoState();
          activeCues = normalizeCuesTiming(data.cues);
          normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
          renderTable();
          renderTimeline();
          checkAllAudioCache();
          const remainingLeaks = countIncompleteCues(activeCues, targetLang);
          if (remainingLeaks > 0) {
            const doneLines = Math.max(0, activeCues.length - remainingLeaks);
            const warnMsg = `⚠️ បកប្រែបាន ${doneLines}/${activeCues.length} បន្ទាត់ — នៅសល់ ${remainingLeaks} បន្ទាត់មិនទាន់បកប្រែអស់ សូមចុចបកប្រែម្ដងទៀត!`;
            document.getElementById('bottomStatusMsg').innerText = warnMsg;
            showShortcutToast(warnMsg);
          } else {
            document.getElementById('bottomStatusMsg').innerText = '✅ បានបកប្រែចប់សព្វគ្រប់ ' + activeCues.length + ' បន្ទាត់!';
            showShortcutToast('✅ បកប្រែរួចរាល់ ' + activeCues.length + ' បន្ទាត់!');
          }

          const autoChainEl = document.getElementById('autoChainDubCheck');
          const shouldAutoChain = !options.skipAutoChain && (!autoChainEl || autoChainEl.checked);
          if (shouldAutoChain && remainingLeaks === 0) {
            if (currentVideoPath && !isVocalInvertOn) {
              toggleRemoveVocals();
            }
            await batchGenerateAllAudio({ silentSuccess: true });
          } else if (remainingLeaks === 0 && !options.silentSuccess) {
            showShortcutToast('✅ បានបកប្រែចប់គ្រប់បន្ទាត់!');
          }
          return remainingLeaks === 0;
        } else {
          alert('កំហុស៖ ' + ((data && data.error) || 'បរាជ័យ'));
          return false;
        }
      } catch (err) {
        isTranslatingNow = false;
        alert('កំហុស Server: ' + err.message);
        return false;
      }
    }

    function seekVideoForOcr(video, timeSec) {
      if (Math.abs(video.currentTime - timeSec) < 0.02 && !video.seeking) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          video.removeEventListener('seeked', onSeeked);
          reject(new Error('មិនអាចរំកិលវីដេអូទៅ frame ដែលត្រូវការ។'));
        }, 10000);
        const onSeeked = () => {
          clearTimeout(timeout);
          resolve();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = timeSec;
      });
    }

    async function startSubtitleOcr() {
      const video = document.getElementById('mainVideo');
      if (!video.src || video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 0) {
        return alert('សូមផ្ទុកវីដេអូ ហើយរង់ចាំឲ្យវារួចរាល់ជាមុនសិន!');
      }

      const intervalSelect = document.getElementById('ocrIntervalSelect');
      const interval = intervalSelect ? Number(intervalSelect.value) || 1 : 1;
      const scanRegion = document.getElementById('ocrScanRegion');
      const useSubtitleRegion = !scanRegion || scanRegion.value !== 'full';
      const sampleTimes = [];
      for (let timeSec = 0; timeSec < video.duration; timeSec += interval) {
        sampleTimes.push(timeSec);
      }
      if (sampleTimes.length > 1200) {
        return alert('វីដេអូវែងពេកសម្រាប់ OCR មួយលើក (កំណត់ 1,200 frames)។ សូមជ្រើសចន្លោះពេលធំជាង។');
      }
      if (!confirm(`Gemini Vision នឹងពិនិត្យប្រហែល ${sampleTimes.length} frame តាមចន្លោះ ${interval}s។ ចំនួនសំណើអាចច្រើន និងមានការប្រើ Gemini API។ បន្តទេ?`)) {
        return;
      }

      const originalTime = video.currentTime;
      const wasPlaying = !video.paused;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const ocrFrames = [];
      let completed = 0;
      video.pause();

      try {
        const maxWidth = 768;
        if (!video.videoWidth || !video.videoHeight || !context) {
          throw new Error('មិនអាចអានទំហំវីដេអូសម្រាប់ OCR បានទេ។');
        }
        let sourceY = 0;
        let sourceHeight = video.videoHeight;
        if (useSubtitleRegion) {
          const maskBottom = parseFloat(document.getElementById('maskYSlider').value) || 70;
          const maskHeight = parseFloat(document.getElementById('maskHSlider').value) || 48;
          const topRatio = Math.max(0, Math.min(1, (480 - maskBottom - maskHeight) / 480));
          const heightRatio = Math.max(0.02, Math.min(1 - topRatio, maskHeight / 480));
          sourceY = Math.round(video.videoHeight * topRatio);
          sourceHeight = Math.max(1, Math.round(video.videoHeight * heightRatio));
        }
        const scale = Math.min(1, maxWidth / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));

        for (let offset = 0; offset < sampleTimes.length; offset += 6) {
          const batch = [];
          for (const timeSec of sampleTimes.slice(offset, offset + 6)) {
            await seekVideoForOcr(video, timeSec);
            context.drawImage(
              video,
              0, sourceY, video.videoWidth, sourceHeight,
              0, 0, canvas.width, canvas.height
            );
            const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
            batch.push({
              timeSec,
              mimeType: 'image/jpeg',
              imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1)
            });
          }

          const sourceLangEl = document.getElementById('sourceLangSelect');
          const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';
          const response = await fetch(`${BACKEND_URL}/api/translation/ocr-frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frames: batch, sourceLang })
          });
          const data = await response.json();
          if (!response.ok || !data.success || !Array.isArray(data.frames)) {
            throw new Error(data.error || 'OCR request failed.');
          }
          ocrFrames.push(...data.frames);
          completed += batch.length;
          document.getElementById('bottomStatusMsg').innerText =
            `🈶 កំពុងស្កេនអក្សរចិន... (${completed}/${sampleTimes.length} frames)`;
        }

        const detectedCues = [];
        let current = null;
        const addCurrent = (endSec) => {
          if (!current) return;
          const end = Math.max(current.startSec + 0.1, Math.min(video.duration, endSec));
          detectedCues.push({
            index: detectedCues.length + 1,
            start: formatSecToDisplay(current.startSec),
            end: formatSecToDisplay(end),
            startSec: current.startSec,
            endSec: end,
            text: current.text,
            translated: '',
            voice: 'Sovereign King'
          });
          current = null;
        };

        for (const frame of ocrFrames) {
          const text = (frame.text || '').replace(/\s+/g, ' ').trim();
          if (current && text === current.text) continue;
          if (current) addCurrent(frame.timeSec);
          if (text) current = { startSec: frame.timeSec, text };
        }
        if (current) {
          const lastTime = ocrFrames.length ? ocrFrames[ocrFrames.length - 1].timeSec : current.startSec;
          addCurrent(Math.min(video.duration, lastTime + interval));
        }
        if (detectedCues.length === 0) {
          throw new Error('មិនបានរកឃើញអក្សរចិននៅលើ frame ដែលបានស្កេនទេ។');
        }
        if (activeCues.length > 0 && !confirm(`រកឃើញ ${detectedCues.length} បន្ទាត់។ តើជំនួស subtitle បច្ចុប្បន្នទេ?`)) {
          return;
        }

        pushUndoState();
        activeCues = detectedCues;
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        renderTable();
        renderTimeline();
        document.getElementById('bottomStatusMsg').innerText =
          `✅ OCR រកឃើញ ${detectedCues.length} បន្ទាត់។ ពេលវេលាត្រូវបានប៉ាន់ស្មានតាមចន្លោះ ${interval}s; សូមពិនិត្យមុនបកប្រែ។`;
        showShortcutToast('🈶 OCR បានបង្កើត subtitle');
      } catch (err) {
        document.getElementById('bottomStatusMsg').innerText = '❌ OCR បរាជ័យ៖ ' + err.message;
        alert('OCR បរាជ័យ៖ ' + err.message);
      } finally {
        if (Number.isFinite(video.duration) && originalTime <= video.duration) {
          try {
            await seekVideoForOcr(video, originalTime);
          } catch (_) {
            video.currentTime = originalTime;
          }
        }
        if (wasPlaying) video.play().catch(err => console.warn('Could not resume video:', err.message));
      }
    }

    // 10. File Uploads & Local Saving
    let pendingVideoSelectResolve = null;

    async function uploadVideoFileToServer(file) {
      if (!file) return '';
      const statusEl = document.getElementById('bottomStatusMsg');
      if (statusEl) {
        statusEl.innerText = `⏳ កំពុងផ្ទុកវីដេអូ "${file.name}" ទៅកាន់ Server...`;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const data = await res.json();
        if (res.ok && data && data.success && data.filePath) {
          currentVideoPath = data.filePath;
          if (statusEl) {
            statusEl.innerText = `✅ បានផ្ទុក "${file.name}" រួចរាល់! អាចចុច ⚡ ១-Click Auto, 🎙️ ស្ដាប់ AI ឬ 🌐 បកប្រែ បានភ្លាម។`;
          }
          showShortcutToast('🎬 បានផ្ទុក ' + file.name);
          return data.filePath;
        }
        const errText = (data && data.error) || `HTTP ${res.status}`;
        if (statusEl) statusEl.innerText = `❌ មិនអាចផ្ទុកវីដេអូទៅ Server៖ ${errText}`;
        showShortcutToast('❌ មិនអាចផ្ទុកវីដេអូ៖ ' + errText);
      } catch (err) {
        console.warn('Video upload sync failed:', err.message);
        if (statusEl) statusEl.innerText = `❌ ផ្ទុកវីដេអូបរាជ័យ៖ ${err.message}`;
        showShortcutToast('❌ ផ្ទុកវីដេអូបរាជ័យ៖ ' + err.message);
      }
      return '';
    }

    async function ensureVideoReadyOnServer() {
      if (currentVideoPath) return true;
      if (activeVideoUploadPromise) {
        const statusEl = document.getElementById('bottomStatusMsg');
        if (statusEl) statusEl.innerText = '⏳ កំពុងរង់ចាំការផ្ទុកវីដេអូពីទូរស័ព្ទបញ្ចប់...';
        try {
          await activeVideoUploadPromise;
        } catch (_) {}
        if (currentVideoPath) return true;
      }
      if (lastSelectedVideoFile && !currentVideoPath) {
        activeVideoUploadPromise = uploadVideoFileToServer(lastSelectedVideoFile);
        try {
          await activeVideoUploadPromise;
        } finally {
          activeVideoUploadPromise = null;
        }
        if (currentVideoPath) return true;
      }
      return false;
    }

    async function openVideoFile() {
      if (window.electronAPI && typeof window.electronAPI.openFileDialog === 'function') {
        try {
          const selectedPath = await window.electronAPI.openFileDialog({
            filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v'] }]
          });
          if (!selectedPath) return false;

          clearDubAndPlaybackState();
          lastSelectedVideoFile = null;
          currentVideoPath = selectedPath;
          currentSrtPath = '';
          currentDramaInfo = null;
          const fileName = selectedPath.split(/[\\/]/).pop() || selectedPath;
          document.getElementById('currentDramaTitleTag').innerText = fileName;
          document.getElementById('videoTrackTitle').innerText = fileName;
          setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(selectedPath));
          const v = document.getElementById('mainVideo');
          v.play().catch(err => console.warn('Could not autoplay selected video:', err.message));
          updateTranslationState();
          showShortcutToast('🎬 បានផ្ទុក ' + fileName);
          return true;
        } catch (err) {
          console.warn('Electron open video dialog failed, falling back to input:', err.message);
        }
      }

      const input = document.getElementById('videoFileInput');
      if (!input) return false;
      return new Promise((resolve) => {
        pendingVideoSelectResolve = resolve;
        const onCancel = () => {
          setTimeout(() => {
            if (pendingVideoSelectResolve === resolve && (!input.files || input.files.length === 0) && !activeVideoUploadPromise) {
              pendingVideoSelectResolve = null;
              resolve(false);
            }
          }, 8000);
        };
        if (typeof input.addEventListener === 'function') {
          input.addEventListener('cancel', () => {
            if (pendingVideoSelectResolve === resolve) {
              pendingVideoSelectResolve = null;
              resolve(false);
            }
          }, { once: true });
        }
        window.addEventListener('focus', onCancel, { once: true });
        input.click();
      });
    }

    async function openSrtFile() {
      if (window.electronAPI && typeof window.electronAPI.openFileDialog === 'function') {
        try {
          const selectedPath = await window.electronAPI.openFileDialog({
            filters: [{ name: 'Subtitles', extensions: ['srt', 'txt'] }]
          });
          if (!selectedPath) return;

          const res = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: selectedPath })
          });
          const data = await res.json();
          if (!res.ok || !data.success || !Array.isArray(data.cues) || data.cues.length === 0) {
            return alert(data.error || 'មិនមាន subtitle ត្រឹមត្រូវក្នុង SRT file ទេ។');
          }

          clearDubAndPlaybackState();
          cachedAudioMap.clear();
          undoStack = [];
          redoStack = [];
          currentSrtPath = selectedPath;
          activeCues = data.cues;
          normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
          renderTable();
          renderTimeline();
          checkAllAudioCache();
          showShortcutToast('📝 បាននាំចូល ' + activeCues.length + ' បន្ទាត់');
          return;
        } catch (err) {
          alert('មិនអាចបើក File SRT បានទេ៖ ' + err.message);
          return;
        }
      }
      const input = document.getElementById('srtFileInput');
      if (input) input.click();
    }

    async function handleVideoUpload(e) {
      const file = e && e.target && e.target.files ? e.target.files[0] : null;
      if (e && e.target) e.target.value = '';
      const resolvePending = pendingVideoSelectResolve;
      pendingVideoSelectResolve = null;
      if (!file) {
        if (resolvePending) resolvePending(false);
        return;
      }
      clearDubAndPlaybackState();
      lastSelectedVideoFile = file;
      currentVideoPath = '';
      currentSrtPath = '';
      currentDramaInfo = null;
      setVideoSource(URL.createObjectURL(file), true);
      document.getElementById('currentDramaTitleTag').innerText = file.name;
      document.getElementById('videoTrackTitle').innerText = file.name;
      const v = document.getElementById('mainVideo');
      v.play().catch(err => console.warn('Could not autoplay selected video:', err.message));

      activeVideoUploadPromise = uploadVideoFileToServer(file);
      try {
        await activeVideoUploadPromise;
      } finally {
        activeVideoUploadPromise = null;
      }
      updateTranslationState();
      if (resolvePending) resolvePending(Boolean(currentVideoPath));
    }

    function parseSrtText(rawText) {
      if (typeof rawText !== 'string') return [];

      const normalized = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      const cues = [];
      for (const block of normalized.split(/\n\s*\n+/)) {
        const lines = block.trim().split('\n');
        const timeLineIndex = lines.findIndex(line => line.includes('-->'));
        if (timeLineIndex < 0 || timeLineIndex === lines.length - 1) continue;

        const [startText, endText] = lines[timeLineIndex].split('-->');
        const parseTime = value => {
          const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
          if (!match) return null;
          return Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3]) +
            Number(match[4].padEnd(3, '0')) / 1000;
        };
        const startSec = parseTime(startText);
        const endSec = parseTime(endText);
        const text = lines.slice(timeLineIndex + 1).join('\n').trim();
        if (startSec === null || endSec === null || endSec < startSec || !text) continue;

        const parsedIndex = Number.parseInt(lines[0], 10);
        cues.push({
          index: Number.isInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : cues.length + 1,
          start: formatSecToDisplay(startSec),
          end: formatSecToDisplay(endSec),
          startSec,
          endSec,
          timecode: lines[timeLineIndex].trim(),
          text,
          translated: text,
          voice: getSelectedSingleVoice()
        });
      }
      return cues;
    }

    function handleSrtUpload(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        alert('SRT file ធំពេក។ សូមជ្រើស file ដែលតូចជាង 10 MB។');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        const cues = parseSrtText(evt.target.result);
        if (cues.length === 0) {
          alert('មិនអាចអាន SRT បានទេ៖ មិនមាន subtitle ត្រឹមត្រូវ។');
          return;
        }

        clearDubAndPlaybackState();
        cachedAudioMap.clear();
        undoStack = [];
        redoStack = [];
        currentSrtPath = '';
        activeCues = cues;
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        renderTable();
        renderTimeline();
        checkAllAudioCache();
      };
      reader.onerror = () => {
        alert('មិនអាចអាន SRT file បានទេ។');
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    async function saveSrtToDisk(silent = false) {
      if (activeCues.length === 0) {
        alert('មិនទាន់មានទិន្នន័យអក្សររត់នៅឡើយទេ!');
        return false;
      }
      const targetPath = currentSrtPath || (currentVideoPath ? currentVideoPath.replace(/\.[^/.\\]+$/i, '_KhmerSub.srt') : '');
      try {
        const res = await fetch(`${BACKEND_URL}/api/save-srt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: activeCues, filePath: targetPath })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          currentSrtPath = data.savedPath;
          if (!silent) {
            alert('✅ បានរក្សាទុក File SRT ដោយជោគជ័យទៅកាន់:\n' + data.savedPath);
          } else {
            showShortcutToast('💾 រក្សាទុក SRT (Ctrl+S)');
          }
          return true;
        }
        alert('កំហុស៖ ' + (data.error || 'មិនអាចរក្សាទុក SRT បានទេ។'));
        return false;
      } catch (err) {
        alert('កំហុស Server: ' + err.message);
        return false;
      }
    }

    // 11. Real Export Features & Optional Logo + Sponsor Overlays
    const EXPORT_OUTPUT_DIR_STORAGE_KEY = 'eza_export_output_dir';
    const LOGO_OVERLAY_STORAGE_KEY = 'eza_logo_overlay_config';
    const SPONSOR_OVERLAY_STORAGE_KEY = 'eza_sponsor_overlay_config';
    let exportCapabilitiesLoaded = false;
    let defaultExportDirPath = '';
    let lastExportedFilePath = '';

    function loadSavedOverlaySlotState(storageKey, defaults = {}) {
      const fallback = {
        enabled: false,
        filePath: '',
        fileName: '',
        mediaType: defaults.mediaType || 'image',
        position: defaults.position || 'top-right',
        scalePercent: defaults.scalePercent || 22,
        opacityPercent: 100,
        customXPercent: defaults.customXPercent ?? 0.74,
        customYPercent: defaults.customYPercent ?? 0.04
      };
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              return {
                enabled: Boolean(parsed.enabled && parsed.filePath),
                filePath: typeof parsed.filePath === 'string' ? parsed.filePath : '',
                fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
                mediaType: parsed.mediaType === 'video' ? 'video' : 'image',
                position: typeof parsed.position === 'string' ? parsed.position : fallback.position,
                scalePercent: Math.min(55, Math.max(8, Number(parsed.scalePercent) || fallback.scalePercent)),
                opacityPercent: Math.min(100, Math.max(20, Number(parsed.opacityPercent) || 100)),
                customXPercent: Number.isFinite(Number(parsed.customXPercent)) ? Number(parsed.customXPercent) : fallback.customXPercent,
                customYPercent: Number.isFinite(Number(parsed.customYPercent)) ? Number(parsed.customYPercent) : fallback.customYPercent
              };
            }
          }
        }
      } catch (_) {}
      return fallback;
    }

    function loadSavedLogoOverlayState() {
      return loadSavedOverlaySlotState(LOGO_OVERLAY_STORAGE_KEY, {
        mediaType: 'image',
        position: 'top-right',
        scalePercent: 18,
        customXPercent: 0.76,
        customYPercent: 0.04
      });
    }

    function loadSavedSponsorOverlayState() {
      return loadSavedOverlaySlotState(SPONSOR_OVERLAY_STORAGE_KEY, {
        mediaType: 'video',
        position: 'bottom-center',
        scalePercent: 26,
        customXPercent: 0.37,
        customYPercent: 0.86
      });
    }

    let logoOverlayState = loadSavedLogoOverlayState();
    let sponsorOverlayState = loadSavedSponsorOverlayState();

    function saveOverlaySlotState(storageKey, stateObj) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          const toSave = {
            enabled: Boolean(stateObj.enabled),
            filePath: stateObj.filePath || '',
            fileName: stateObj.fileName || '',
            mediaType: stateObj.mediaType || 'image',
            position: stateObj.position || 'top-right',
            scalePercent: stateObj.scalePercent || 22,
            opacityPercent: stateObj.opacityPercent || 100,
            customXPercent: stateObj.customXPercent,
            customYPercent: stateObj.customYPercent,
            updatedAt: stateObj.updatedAt || Date.now()
          };
          localStorage.setItem(storageKey, JSON.stringify(toSave));
        }
      } catch (_) {}
    }

    function saveLogoOverlayState() {
      saveOverlaySlotState(LOGO_OVERLAY_STORAGE_KEY, logoOverlayState);
    }

    function saveSponsorOverlayState() {
      saveOverlaySlotState(SPONSOR_OVERLAY_STORAGE_KEY, sponsorOverlayState);
    }

    function detectSponsorMediaType(filePathOrName) {
      const ext = String(filePathOrName || '').split('.').pop().toLowerCase();
      return ['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext) ? 'video' : 'image';
    }

    function getSponsorExportPayload() {
      const isLogoEnabled = Boolean(logoOverlayState.enabled && logoOverlayState.filePath);
      const isSponsorEnabled = Boolean(sponsorOverlayState.enabled && sponsorOverlayState.filePath);
      return {
        logoEnabled: isLogoEnabled,
        logoPath: isLogoEnabled ? logoOverlayState.filePath : '',
        logoPosition: logoOverlayState.position || 'top-right',
        logoScale: logoOverlayState.scalePercent || 18,
        logoOpacity: logoOverlayState.opacityPercent || 100,
        logoXPercent: logoOverlayState.customXPercent,
        logoYPercent: logoOverlayState.customYPercent,
        sponsorEnabled: isSponsorEnabled,
        sponsorPath: isSponsorEnabled ? sponsorOverlayState.filePath : '',
        sponsorPosition: sponsorOverlayState.position || 'bottom-center',
        sponsorScale: sponsorOverlayState.scalePercent || 26,
        sponsorOpacity: sponsorOverlayState.opacityPercent || 100,
        sponsorXPercent: sponsorOverlayState.customXPercent,
        sponsorYPercent: sponsorOverlayState.customYPercent
      };
    }

    function setMediaElementVisibility(el, visible) {
      if (!el) return;
      el.hidden = !visible;
      if (el.style) el.style.display = visible ? 'block' : 'none';
    }

    function syncMediaElementSource(el, mediaSrc, isVideo) {
      if (!el || !mediaSrc) return;
      if (!el.dataset) el.dataset = {};
      if (el.dataset.mediaSrc !== mediaSrc) {
        el.dataset.mediaSrc = mediaSrc;
        el.src = mediaSrc;
        if (isVideo) {
          if (typeof el.load === 'function') el.load();
          if (typeof el.play === 'function') el.play().catch(() => {});
        }
      } else if (isVideo && el.paused && typeof el.play === 'function') {
        el.play().catch(() => {});
      }
    }

    function renderOverlaySlotDom(stateObj, ids, defaults = {}) {
      const box = document.getElementById(ids.box);
      const imgEl = document.getElementById(ids.img);
      const vidEl = document.getElementById(ids.video);
      const miniThumbImg = document.getElementById(ids.miniImg);
      const miniThumbVid = document.getElementById(ids.miniVid);
      const exportThumbImg = document.getElementById(ids.exportImg);
      const exportThumbVid = document.getElementById(ids.exportVid);
      const chk1 = document.getElementById(ids.chk1);
      const chk2 = document.getElementById(ids.chk2);
      const pos1 = document.getElementById(ids.pos1);
      const pos2 = document.getElementById(ids.pos2);
      const scaleEl = document.getElementById(ids.scale);
      const opEl = document.getElementById(ids.opacity);
      const nameBadge = document.getElementById(ids.nameBadge);
      const exportInput = document.getElementById(ids.exportInput);
      const clearBtn1 = document.getElementById(ids.clear1);
      const clearBtn2 = document.getElementById(ids.clear2);

      const defaultPos = defaults.position || 'top-right';
      const defaultScale = defaults.scalePercent || 22;
      const hasFile = Boolean(stateObj.filePath || stateObj.previewUrl);
      const isActive = Boolean(stateObj.enabled && hasFile);
      const isVideo = stateObj.mediaType === 'video';
      const displayName = hasFile
        ? (stateObj.fileName || extractFileName(stateObj.filePath))
        : '';

      if (chk1) chk1.checked = isActive;
      if (chk2) chk2.checked = isActive;
      if (pos1) pos1.value = stateObj.position || defaultPos;
      if (pos2) pos2.value = stateObj.position || defaultPos;
      if (scaleEl) scaleEl.value = String(stateObj.scalePercent || defaultScale);
      if (opEl) opEl.value = String(stateObj.opacityPercent || 100);

      if (nameBadge) {
        nameBadge.innerText = hasFile ? (isActive ? displayName : `${displayName} (បិទ)`) : 'មិនដាក់';
        nameBadge.title = hasFile ? (stateObj.filePath || displayName) : (defaults.emptyTitle || 'ចុចដើម្បីរើសឯកសារ');
        if (nameBadge.classList && typeof nameBadge.classList.toggle === 'function') {
          nameBadge.classList.toggle('active', isActive);
        }
      }
      if (exportInput) {
        exportInput.value = hasFile
          ? (isActive ? `${displayName} (${stateObj.scalePercent || defaultScale}%)` : `${displayName} — បិទបណ្ដោះអាសន្ន`)
          : 'មិនដាក់ (Optional)';
      }
      if (clearBtn1) clearBtn1.hidden = !hasFile;
      if (clearBtn2) clearBtn2.hidden = !hasFile;

      const streamUrl = hasFile
        ? (stateObj.previewUrl
          || `${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(stateObj.filePath)}&v=${stateObj.updatedAt || 1}`)
        : '';

      setMediaElementVisibility(miniThumbImg, hasFile && !isVideo);
      setMediaElementVisibility(miniThumbVid, hasFile && isVideo);
      setMediaElementVisibility(exportThumbImg, hasFile && !isVideo);
      setMediaElementVisibility(exportThumbVid, hasFile && isVideo);
      if (hasFile && streamUrl) {
        if (isVideo) {
          syncMediaElementSource(miniThumbVid, streamUrl, true);
          syncMediaElementSource(exportThumbVid, streamUrl, true);
        } else {
          syncMediaElementSource(miniThumbImg, streamUrl, false);
          syncMediaElementSource(exportThumbImg, streamUrl, false);
        }
      }

      if (box) {
        box.hidden = !isActive;
        if (box.style) box.style.display = isActive ? 'block' : 'none';
        box.className = `sponsor-overlay-box pos-${stateObj.position || defaultPos}`;
        box.style.width = `${stateObj.scalePercent || defaultScale}%`;
        box.style.opacity = String((stateObj.opacityPercent || 100) / 100);
        if (stateObj.position === 'custom') {
          box.style.left = `${(Number(stateObj.customXPercent || 0) * 100).toFixed(2)}%`;
          box.style.top = `${(Number(stateObj.customYPercent || 0) * 100).toFixed(2)}%`;
          box.style.right = 'auto';
          box.style.bottom = 'auto';
          box.style.transform = 'none';
        } else {
          box.style.left = '';
          box.style.top = '';
          box.style.right = '';
          box.style.bottom = '';
          box.style.transform = '';
        }

        if (isActive && streamUrl) {
          if (isVideo) {
            setMediaElementVisibility(imgEl, false);
            setMediaElementVisibility(vidEl, true);
            if (vidEl) {
              vidEl.dataset.filePath = stateObj.filePath;
              syncMediaElementSource(vidEl, streamUrl, true);
            }
          } else {
            if (vidEl && typeof vidEl.pause === 'function') vidEl.pause();
            setMediaElementVisibility(vidEl, false);
            setMediaElementVisibility(imgEl, true);
            if (imgEl) {
              imgEl.dataset.filePath = stateObj.filePath;
              syncMediaElementSource(imgEl, streamUrl, false);
            }
          }
        } else {
          setMediaElementVisibility(imgEl, false);
          setMediaElementVisibility(vidEl, false);
          if (vidEl && typeof vidEl.pause === 'function') {
            vidEl.pause();
          }
        }
      }
    }

    function renderLogoOverlayPreview() {
      renderOverlaySlotDom(logoOverlayState, {
        box: 'logoOverlayBox',
        img: 'logoOverlayImg',
        video: 'logoOverlayVideo',
        miniImg: 'logoMiniThumbImg',
        miniVid: 'logoMiniThumbVideo',
        exportImg: 'exportLogoThumbImg',
        exportVid: 'exportLogoThumbVideo',
        chk1: 'logoToggleCheck',
        chk2: 'exportLogoCheck',
        pos1: 'logoPosSelect',
        pos2: 'exportLogoPosSelect',
        scale: 'logoScaleSlider',
        opacity: 'logoOpacitySlider',
        nameBadge: 'logoFileNameLabel',
        exportInput: 'exportLogoFileInput',
        clear1: 'btnClearLogo',
        clear2: 'btnExportClearLogo'
      }, {
        position: 'top-right',
        scalePercent: 18,
        emptyTitle: 'ចុចដើម្បីរើសឯកសារ Logo'
      });
      updateExportPreviewSummary();
    }

    function renderSponsorOverlayPreview() {
      renderLogoOverlayPreview();
      renderOverlaySlotDom(sponsorOverlayState, {
        box: 'sponsorOverlayBox',
        img: 'sponsorOverlayImg',
        video: 'sponsorOverlayVideo',
        miniImg: 'sponsorMiniThumbImg',
        miniVid: 'sponsorMiniThumbVideo',
        exportImg: 'exportSponsorThumbImg',
        exportVid: 'exportSponsorThumbVideo',
        chk1: 'sponsorToggleCheck',
        chk2: 'exportSponsorCheck',
        pos1: 'sponsorPosSelect',
        pos2: 'exportSponsorPosSelect',
        scale: 'sponsorScaleSlider',
        opacity: 'sponsorOpacitySlider',
        nameBadge: 'sponsorFileNameLabel',
        exportInput: 'exportSponsorFileInput',
        clear1: 'btnClearSponsor',
        clear2: 'btnExportClearSponsor'
      }, {
        position: 'bottom-center',
        scalePercent: 26,
        emptyTitle: 'ចុចដើម្បីរើសឯកសារ Sponsor'
      });
      updateExportPreviewSummary();
    }

    // --- Logo Slot Actions ---
    async function toggleLogoOverlay(checked) {
      const wantEnable = Boolean(checked);
      if (wantEnable && !logoOverlayState.filePath && !logoOverlayState.previewUrl) {
        const picked = await pickLogoOverlayFile();
        if (!picked) {
          renderLogoOverlayPreview();
          return;
        }
        return;
      }
      logoOverlayState.enabled = wantEnable;
      saveLogoOverlayState();
      renderLogoOverlayPreview();
      showShortcutToast(wantEnable ? '🖼️ បានបើក Logo លើវីដេអូ' : '🖼️ បានបិទ Logo (មិនដាក់)');
    }

    function applySelectedLogoFile(filePath, fileName = '', previewUrl = '') {
      if (!filePath && !previewUrl) return;
      const cleanPath = String(filePath || fileName || '').trim();
      const cleanName = fileName || extractFileName(cleanPath);
      if (logoOverlayState.previewUrl && logoOverlayState.previewUrl !== previewUrl) {
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(logoOverlayState.previewUrl);
          }
        } catch (_) {}
      }
      logoOverlayState.filePath = cleanPath;
      logoOverlayState.fileName = cleanName;
      logoOverlayState.mediaType = detectSponsorMediaType(cleanName || cleanPath);
      logoOverlayState.previewUrl = previewUrl || '';
      logoOverlayState.updatedAt = Date.now();
      logoOverlayState.enabled = true;
      saveLogoOverlayState();
      renderLogoOverlayPreview();
      showShortcutToast(`🖼️ បានដាក់ Logo៖ ${cleanName}`);
    }

    async function pickLogoOverlayFile() {
      if (window.electronAPI && typeof window.electronAPI.openFileDialog === 'function') {
        try {
          const selected = await window.electronAPI.openFileDialog({
            filters: [
              { name: 'Image Logo (.png, .jpg, .webp, .gif)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] },
              { name: 'Logo Video / Animation (.mp4, .mov, .webm)', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] },
              { name: 'All Supported Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'mp4', 'mov', 'webm', 'mkv', 'm4v'] }
            ]
          });
          if (!selected) return '';
          applySelectedLogoFile(selected);
          return selected;
        } catch (err) {
          console.warn('Electron logo dialog failed, falling back to file input:', err.message);
        }
      }

      const input = document.getElementById('logoFileInput');
      if (input && typeof input.click === 'function') {
        input.value = '';
        input.click();
        return 'browser-input';
      }
      return '';
    }

    async function handleLogoFileUpload(e) {
      const file = e && e.target && e.target.files ? e.target.files[0] : null;
      if (e && e.target) e.target.value = '';
      if (!file) return;
      const localPreviewUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(file)
        : '';
      if (localPreviewUrl) {
        applySelectedLogoFile(file.name, file.name, localPreviewUrl);
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const data = await res.json();
        if (res.ok && data && data.success && data.filePath) {
          applySelectedLogoFile(data.filePath, file.name, localPreviewUrl);
        } else if (!localPreviewUrl) {
          showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Logo បានទេ៖ ' + ((data && data.error) || res.status));
        }
      } catch (err) {
        if (!localPreviewUrl) {
          showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Logo បានទេ៖ ' + err.message);
        }
      }
    }

    function clearLogoOverlayFile() {
      if (logoOverlayState.previewUrl) {
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(logoOverlayState.previewUrl);
          }
        } catch (_) {}
      }
      logoOverlayState.enabled = false;
      logoOverlayState.filePath = '';
      logoOverlayState.fileName = '';
      logoOverlayState.previewUrl = '';
      saveLogoOverlayState();
      renderLogoOverlayPreview();
      showShortcutToast('🖼️ បានដក Logo ចេញ (មិនដាក់)');
    }

    function changeLogoPosition(pos) {
      logoOverlayState.position = String(pos || 'top-right');
      saveLogoOverlayState();
      renderLogoOverlayPreview();
    }

    function updateLogoScale(val) {
      logoOverlayState.scalePercent = Math.min(55, Math.max(8, parseInt(val, 10) || 18));
      saveLogoOverlayState();
      renderLogoOverlayPreview();
    }

    function updateLogoOpacity(val) {
      logoOverlayState.opacityPercent = Math.min(100, Math.max(20, parseInt(val, 10) || 100));
      saveLogoOverlayState();
      renderLogoOverlayPreview();
    }

    // --- Sponsor Slot Actions ---
    async function toggleSponsorOverlay(checked) {
      const wantEnable = Boolean(checked);
      if (wantEnable && !sponsorOverlayState.filePath && !sponsorOverlayState.previewUrl) {
        const picked = await pickSponsorOverlayFile();
        if (!picked) {
          renderSponsorOverlayPreview();
          return;
        }
        return;
      }
      sponsorOverlayState.enabled = wantEnable;
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
      showShortcutToast(wantEnable ? '🎬 បានបើក Sponsor លើវីដេអូ' : '🎬 បានបិទ Sponsor (មិនដាក់)');
    }

    function applySelectedSponsorFile(filePath, fileName = '', previewUrl = '') {
      if (!filePath && !previewUrl) return;
      const cleanPath = String(filePath || fileName || '').trim();
      const cleanName = fileName || extractFileName(cleanPath);
      if (sponsorOverlayState.previewUrl && sponsorOverlayState.previewUrl !== previewUrl) {
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(sponsorOverlayState.previewUrl);
          }
        } catch (_) {}
      }
      sponsorOverlayState.filePath = cleanPath;
      sponsorOverlayState.fileName = cleanName;
      sponsorOverlayState.mediaType = detectSponsorMediaType(cleanName || cleanPath);
      sponsorOverlayState.previewUrl = previewUrl || '';
      sponsorOverlayState.updatedAt = Date.now();
      sponsorOverlayState.enabled = true;
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
      showShortcutToast(`🎬 បានដាក់ Sponsor៖ ${cleanName}`);
    }

    async function pickSponsorOverlayFile() {
      if (window.electronAPI && typeof window.electronAPI.openFileDialog === 'function') {
        try {
          const selected = await window.electronAPI.openFileDialog({
            filters: [
              { name: 'Sponsor Video or Banner', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'gif', 'png', 'jpg', 'jpeg', 'webp'] },
              { name: 'Sponsor Video (.mp4, .mov, .webm)', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] },
              { name: 'Sponsor Image / GIF (.gif, .png, .jpg, .webp)', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg'] }
            ]
          });
          if (!selected) return '';
          applySelectedSponsorFile(selected);
          return selected;
        } catch (err) {
          console.warn('Electron sponsor dialog failed, falling back to file input:', err.message);
        }
      }

      const input = document.getElementById('sponsorFileInput');
      if (input && typeof input.click === 'function') {
        input.value = '';
        input.click();
        return 'browser-input';
      }
      return '';
    }

    async function handleSponsorFileUpload(e) {
      const file = e && e.target && e.target.files ? e.target.files[0] : null;
      if (e && e.target) e.target.value = '';
      if (!file) return;
      const localPreviewUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(file)
        : '';
      if (localPreviewUrl) {
        applySelectedSponsorFile(file.name, file.name, localPreviewUrl);
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const data = await res.json();
        if (res.ok && data && data.success && data.filePath) {
          applySelectedSponsorFile(data.filePath, file.name, localPreviewUrl);
        } else if (!localPreviewUrl) {
          showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Sponsor បានទេ៖ ' + ((data && data.error) || res.status));
        }
      } catch (err) {
        if (!localPreviewUrl) {
          showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Sponsor បានទេ៖ ' + err.message);
        }
      }
    }

    function clearSponsorOverlayFile() {
      if (sponsorOverlayState.previewUrl) {
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(sponsorOverlayState.previewUrl);
          }
        } catch (_) {}
      }
      sponsorOverlayState.enabled = false;
      sponsorOverlayState.filePath = '';
      sponsorOverlayState.fileName = '';
      sponsorOverlayState.previewUrl = '';
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
      showShortcutToast('🎬 បានដក Sponsor ចេញ (មិនដាក់)');
    }

    function changeSponsorPosition(pos) {
      sponsorOverlayState.position = String(pos || 'bottom-center');
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
    }

    function updateSponsorScale(val) {
      sponsorOverlayState.scalePercent = Math.min(55, Math.max(8, parseInt(val, 10) || 26));
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
    }

    function updateSponsorOpacity(val) {
      sponsorOverlayState.opacityPercent = Math.min(100, Math.max(20, parseInt(val, 10) || 100));
      saveSponsorOverlayState();
      renderSponsorOverlayPreview();
    }

    function bindOverlayBoxDrag(boxId, stateObj, renderFn, saveFn) {
      const box = document.getElementById(boxId);
      if (!box || typeof box.addEventListener !== 'function') return;
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let initLeft = 0;
      let initTop = 0;

      const startDragAt = (clientX, clientY, ev) => {
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        const frameRect = frame.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        dragging = true;
        startX = clientX;
        startY = clientY;
        initLeft = boxRect.left - frameRect.left;
        initTop = boxRect.top - frameRect.top;
      };

      const moveDragAt = (clientX, clientY, ev) => {
        if (!dragging) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        const frameRect = frame.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        if (!frameRect.width || !frameRect.height) return;
        const maxLeft = Math.max(0, frameRect.width - boxRect.width);
        const maxTop = Math.max(0, frameRect.height - boxRect.height);
        const nextLeft = Math.min(maxLeft, Math.max(0, initLeft + (clientX - startX)));
        const nextTop = Math.min(maxTop, Math.max(0, initTop + (clientY - startY)));
        stateObj.position = 'custom';
        stateObj.customXPercent = Number((nextLeft / frameRect.width).toFixed(4));
        stateObj.customYPercent = Number((nextTop / frameRect.height).toFixed(4));
        renderFn();
      };

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        saveFn();
      };

      box.addEventListener('mousedown', (e) => startDragAt(e.clientX, e.clientY, e));
      window.addEventListener('mousemove', (e) => moveDragAt(e.clientX, e.clientY, null));
      window.addEventListener('mouseup', endDrag);

      // Mobile Phone Touch Drag Support
      box.addEventListener('touchstart', (e) => {
        const touch = e.touches && e.touches[0];
        if (!touch) return;
        startDragAt(touch.clientX, touch.clientY, e);
      }, { passive: false });
      window.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const touch = e.touches && e.touches[0];
        if (!touch) return;
        moveDragAt(touch.clientX, touch.clientY, e);
      }, { passive: false });
      window.addEventListener('touchend', endDrag);
      window.addEventListener('touchcancel', endDrag);
    }

    function initSponsorOverlayDrag() {
      bindOverlayBoxDrag('logoOverlayBox', logoOverlayState, renderLogoOverlayPreview, saveLogoOverlayState);
      bindOverlayBoxDrag('sponsorOverlayBox', sponsorOverlayState, renderSponsorOverlayPreview, saveSponsorOverlayState);
    }

    function getCustomExportOutputDir() {
      try {
        return typeof localStorage !== 'undefined'
          ? String(localStorage.getItem(EXPORT_OUTPUT_DIR_STORAGE_KEY) || '').trim()
          : '';
      } catch (_) {
        return '';
      }
    }

    function updateExportOutputDirDisplay() {
      const customDir = getCustomExportOutputDir();
      const inputEl = document.getElementById('exportOutputDirInput');
      if (inputEl) {
        inputEl.value = customDir || defaultExportDirPath || 'Exported\\';
      }
      const resetBtn = document.getElementById('btnResetExportDir');
      if (resetBtn) {
        resetBtn.hidden = !customDir;
      }
      const vmBtn = document.getElementById('vmExportDirBtn');
      if (vmBtn) {
        const shortName = customDir ? extractFileName(customDir.replace(/[\\/]+$/, '')) : '';
        vmBtn.innerText = customDir ? `📁 ទីតាំង MP4: ${shortName || customDir}` : '📁 ទីតាំង MP4: លំនាំដើម';
        vmBtn.title = customDir ? `រក្សាទុក MP4 នៅ៖ ${customDir}` : 'រើស Folder រក្សាទុក MP4 ពេល Auto Export';
      }
    }

    function updateExportPreviewSummary() {
      const summaryEl = document.getElementById('exportPreviewSummary');
      if (!summaryEl) return;
      const styleEl = document.getElementById('subStyleSelect');
      const maskChk = document.getElementById('maskToggleCheck');
      const maskModeEl = document.getElementById('maskModeSelect');
      const styleText = styleEl && styleEl.options && styleEl.selectedIndex >= 0
        ? styleEl.options[styleEl.selectedIndex].text
        : (currentSubStyle || 'tiktok').toUpperCase();
      const maskEnabled = Boolean(maskChk && maskChk.checked);
      const maskModeText = maskModeEl && maskModeEl.options && maskModeEl.selectedIndex >= 0
        ? maskModeEl.options[maskModeEl.selectedIndex].text
        : 'ព្រិលស្រាល';
      const logoText = (logoOverlayState && logoOverlayState.enabled && (logoOverlayState.filePath || logoOverlayState.previewUrl))
        ? ` · Logo៖ ${logoOverlayState.fileName || extractFileName(logoOverlayState.filePath)}`
        : '';
      const sponsorText = (sponsorOverlayState && sponsorOverlayState.enabled && (sponsorOverlayState.filePath || sponsorOverlayState.previewUrl))
        ? ` · Sponsor៖ ${sponsorOverlayState.fileName || extractFileName(sponsorOverlayState.filePath)}`
        : '';
      const overlaySummary = (logoText || sponsorText) || ' · Logo/Sponsor៖ មិនដាក់';
      summaryEl.innerText = `ស្ទីល៖ ${styleText} · ផ្ទៃបាំងអក្សរ៖ ${maskEnabled ? maskModeText : 'បិទ'}${overlaySummary}`;
    }

    async function pickExportOutputFolder() {
      let selected = '';
      try {
        if (window.electronAPI && typeof window.electronAPI.openFolderDialog === 'function') {
          selected = await window.electronAPI.openFolderDialog();
        } else {
          const res = await fetch(`${BACKEND_URL}/api/browse-folder`);
          const data = await res.json().catch(() => null);
          if (res.ok && data && data.selected) selected = data.selected;
        }
      } catch (err) {
        showShortcutToast('❌ មិនអាចបើកផ្ទាំងរើស Folder បានទេ៖ ' + err.message);
        return '';
      }
      if (!selected) return '';
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(EXPORT_OUTPUT_DIR_STORAGE_KEY, String(selected).trim());
        }
      } catch (_) {}
      updateExportOutputDirDisplay();
      showShortcutToast(`📁 បានរើសទីតាំងរក្សាទុក៖ ${selected}`);
      return selected;
    }

    function resetExportOutputFolder() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(EXPORT_OUTPUT_DIR_STORAGE_KEY);
        }
      } catch (_) {}
      updateExportOutputDirDisplay();
      showShortcutToast('↺ ត្រឡប់ទៅ Folder លំនាំដើមវិញ');
    }

    async function openExportFolder(targetPath = '') {
      const target = String(targetPath || getCustomExportOutputDir() || defaultExportDirPath || '').trim();
      try {
        const res = await fetch(`${BACKEND_URL}/api/export/open-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPath: target })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចបើក Folder បានទេ');
        }
      } catch (err) {
        showShortcutToast('❌ ' + err.message);
      }
    }

    function openLastExportedLocation() {
      return openExportFolder(lastExportedFilePath || getCustomExportOutputDir());
    }

    function downloadLastExportedFile(customPath = '') {
      const target = String(customPath || lastExportedFilePath || '').trim();
      if (!target) {
        showShortcutToast('⚠️ មិនទាន់មានឯកសារដែលបាន Export នៅឡើយទេ');
        return '';
      }
      const downloadUrl = `${BACKEND_URL}/api/export/download?file=${encodeURIComponent(target)}`;
      if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = extractFileName(target) || 'EZA_Export.mp4';
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(a);
          if (typeof a.click === 'function') a.click();
          if (typeof a.remove === 'function') a.remove();
        } else if (typeof a.click === 'function') {
          a.click();
        }
      }
      showShortcutToast('⬇️ កំពុងទាញយកឯកសារ MP4...');
      return downloadUrl;
    }

    function syncExportDubControls() {
      const dubCheck = document.getElementById('exportDubCheck');
      const modeEl = document.getElementById('exportAudioMode');
      const fitCheck = document.getElementById('exportAutoFitCheck');
      if (!modeEl) return;

      if (dubCheck && !dubCheck.checked) {
        modeEl.disabled = true;
        if (fitCheck) fitCheck.disabled = true;
      } else {
        modeEl.disabled = false;
        const isOriginalOnly = modeEl.value === 'original';
        if (fitCheck) fitCheck.disabled = isOriginalOnly;
      }
    }

    function openExportModal() {
      document.getElementById('exportModal').style.display = 'flex';
      lastExportedFilePath = '';
      const statusMsg = document.getElementById('exportStatusMsg');
      if (statusMsg) statusMsg.innerText = '';
      const openFileBtn = document.getElementById('btnOpenExportedFile');
      if (openFileBtn) openFileBtn.hidden = true;
      const dlMp4Btn = document.getElementById('btnDownloadExportedMp4');
      if (dlMp4Btn) dlMp4Btn.hidden = true;
      const progTrack = document.getElementById('exportProgressTrack');
      const progFill = document.getElementById('exportProgressFill');
      if (progTrack) progTrack.hidden = true;
      if (progFill) progFill.style.width = '0%';

      syncExportDubControls();
      renderSponsorOverlayPreview();
      updateExportOutputDirDisplay();

      if (!defaultExportDirPath && typeof fetch === 'function') {
        fetch(`${BACKEND_URL}/api/export/default-dir`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.exportDir) {
              defaultExportDirPath = data.exportDir;
              updateExportOutputDirDisplay();
            }
          })
          .catch(() => {});
      }

      if (!exportCapabilitiesLoaded && typeof fetch === 'function') {
        exportCapabilitiesLoaded = true;
        fetch(`${BACKEND_URL}/api/export/capabilities`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            const badge = document.getElementById('exportGpuBadge');
            if (!badge || !data) return;
            if (data.gpuEncoder === 'h264_nvenc') {
              badge.innerText = '⚡ NVIDIA NVENC រួចរាល់';
            } else if (data.gpuEncoder === 'h264_qsv') {
              badge.innerText = '⚡ Intel QSV រួចរាល់';
            } else if (data.gpuEncoder === 'h264_amf') {
              badge.innerText = '⚡ AMD AMF រួចរាល់';
            } else {
              badge.innerText = '🖥️ CPU (libx264 HD)';
            }
          })
          .catch(() => {});
      }
    }
    function closeExportModal() { document.getElementById('exportModal').style.display = 'none'; }

    async function downloadSrtFile() {
      if (activeCues.length === 0) return alert('មិនទាន់មានទិន្នន័យអក្សររត់នៅឡើយទេ!');
      const fileName = (currentDramaInfo ? (currentDramaInfo.name || currentDramaInfo.dramaName || 'Subtitles') : 'Subtitles') + '_Khmer.srt';
      const customDir = getCustomExportOutputDir();
      const statusMsg = document.getElementById('exportStatusMsg');
      const openFileBtn = document.getElementById('btnOpenExportedFile');

      if (window.electronAPI && typeof window.electronAPI.saveFileDialog === 'function') {
        try {
          const baseDir = customDir || defaultExportDirPath;
          const defaultPath = baseDir ? `${baseDir.replace(/[\\/]+$/, '')}\\${fileName}` : fileName;
          const chosenPath = await window.electronAPI.saveFileDialog({
            defaultPath,
            filters: [{ name: 'SubRip Subtitles', extensions: ['srt'] }]
          });
          if (!chosenPath) return;
          const res = await fetch(`${BACKEND_URL}/api/save-srt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cues: activeCues, filePath: chosenPath })
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || 'មិនអាចរក្សាទុក .SRT បានទេ');
          lastExportedFilePath = data.savedPath || chosenPath;
          if (statusMsg) statusMsg.innerText = `✅ បានរក្សាទុក .SRT នៅ៖ ${lastExportedFilePath}`;
          if (openFileBtn) openFileBtn.hidden = false;
          showShortcutToast(`✅ រក្សាទុក .SRT រួចរាល់`);
          return;
        } catch (err) {
          if (statusMsg) statusMsg.innerText = `❌ កំហុសរក្សាទុក .SRT៖ ${err.message}`;
          return alert('❌ កំហុស៖ ' + err.message);
        }
      }

      if (customDir && typeof fetch === 'function') {
        try {
          const targetPath = `${customDir.replace(/[\\/]+$/, '')}\\${fileName}`;
          const res = await fetch(`${BACKEND_URL}/api/save-srt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cues: activeCues, filePath: targetPath })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            lastExportedFilePath = data.savedPath || targetPath;
            if (statusMsg) statusMsg.innerText = `✅ បានរក្សាទុក .SRT នៅ៖ ${lastExportedFilePath}`;
            if (openFileBtn) openFileBtn.hidden = false;
            showShortcutToast(`✅ រក្សាទុក .SRT រួចរាល់`);
            return;
          }
        } catch (_) {}
      }

      let srtContent = '';
      activeCues.forEach((c, i) => {
        const idx = i + 1;
        const txt = String(c.translated || c.text || '').trim();
        srtContent += idx + '\n' + formatSecToSrt(c.startSec) + ' --> ' + formatSecToSrt(c.endSec) + '\n' + txt + '\n\n';
      });

      const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      closeExportModal();
    }

    function formatSecToSrt(totalSec) {
      const safeSec = Math.max(0, Number(totalSec) || 0);
      const totalMs = Math.round(safeSec * 1000);
      const ms = totalMs % 1000;
      const wholeSec = Math.floor(totalMs / 1000);
      const s = wholeSec % 60;
      const m = Math.floor(wholeSec / 60) % 60;
      const h = Math.floor(wholeSec / 3600);
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
    }

    // Subtitle Masking & Word-Pop Controls
    function setWordPopEffect(enabled) {
      isWordPopEnabled = Boolean(enabled);
      const sub = document.getElementById('liveSubtitleText');
      if (sub) {
        sub.classList.toggle('no-word-pop', !isWordPopEnabled);
        sub.dataset.karaokeKey = '';
      }
      const chk = document.getElementById('wordPopToggleCheck');
      if (chk) chk.checked = isWordPopEnabled;
      onVideoTimeUpdate();
      showShortcutToast(isWordPopEnabled ? '🎯 បានបើកអក្សរលោតមកមុខ' : '🎯 បានបិទអក្សរលោតមកមុខ');
    }

    function toggleMaskBox(checked) {
      const enabled = Boolean(checked);
      const box = document.getElementById('subtitleMaskBox');
      if (box) box.classList.toggle('hidden-mask', !enabled);
      const chk = document.getElementById('maskToggleCheck');
      if (chk) chk.checked = enabled;
      updateExportPreviewSummary();
    }

    let currentSubStyle = 'tiktok';
    let currentSubFontSize = 16;

    function changeSubStyle(style) {
      currentSubStyle = style;
      const previewStyle = document.getElementById('subStyleSelect');
      if (previewStyle) previewStyle.value = style;
      const sub = document.getElementById('liveSubtitleText');
      if (sub) {
        sub.className = 'subtitle-text-inside style-' + style + (isWordPopEnabled ? '' : ' no-word-pop');
        sub.style.fontSize = currentSubFontSize + 'px';
      }
      updateExportPreviewSummary();
      showShortcutToast('✨ ស្ទីល Sub: ' + style.toUpperCase());
    }

    function updateSubFontSize(size) {
      currentSubFontSize = parseInt(size, 10);
      const sub = document.getElementById('liveSubtitleText');
      if (sub) sub.style.fontSize = size + 'px';
    }

    function toggleSafeZone(checked) {
      const zone = document.getElementById('safeZoneOverlay');
      if (zone) zone.style.display = checked ? 'block' : 'none';
      showShortcutToast(checked ? '📱 បើក Safe Zone' : '📱 បិទ Safe Zone');
    }

    function changeMaskMode(mode) {
      const box = document.getElementById('subtitleMaskBox');
      box.classList.remove('blackout', 'frosted', 'feathered', 'cinema_bar');
      if (mode === 'black') box.classList.add('blackout');
      else if (mode === 'frosted') box.classList.add('frosted');
      else if (mode === 'cinema_bar') box.classList.add('cinema_bar');
      else if (mode === 'feathered') box.classList.add('feathered');

      const previewMode = document.getElementById('maskModeSelect');
      if (previewMode) previewMode.value = mode;
      updateExportPreviewSummary();
    }

    function updateMaskY(val) {
      document.getElementById('subtitleMaskBox').style.bottom = val + 'px';
    }

    function updateMaskH(val) {
      const box = document.getElementById('subtitleMaskBox');
      if (box) {
        box.style.minHeight = val + 'px';
        box.style.height = 'auto';
      }
    }

    // Auto-detect speech & timestamps via AI VAD/STT
    async function startSpeechDetection(options = {}) {
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
      }
      if (!currentVideoPath) {
        await openVideoFile();
        if (!currentVideoPath) return false;
      }
      if (!options.skipConfirm && !confirm('សំឡេងវីដេអូនឹងត្រូវផ្ញើទៅ Gemini ដើម្បីចាប់ពាក្យនិយាយ (Transcribe AI)។ តើអ្នកចង់បន្តទេ?')) {
        return false;
      }
      const statusMsg = document.getElementById('bottomStatusMsg');
      statusMsg.innerText = '🎙️ កំពុងដំណើរការ AI ចាប់យកនាទី និងពាក្យសំដីមនុស្សនិយាយក្នុងវីដេអូ... (សូមរង់ចាំ)';

      try {
        const sourceLangEl = document.getElementById('sourceLangSelect');
        const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';
        const { res, data } = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/auto-detect-speech`,
          {
            videoPath: currentVideoPath,
            sourceLang,
            isolateVocals: true,
            castMode: getActiveCastMode(),
            fixedVoice: getSelectedSingleVoice()
          },
          {
            maxRetries: 4,
            retryDelayMs: 3500,
            onRetryStatus: (attempt) => {
              statusMsg.innerText = `⏳ AI កំពុងបញ្ចប់ការចាប់សំឡេងក្នុងផ្ទៃខាងក្រោយ... កំពុងទាញយកលទ្ធផលបន្ត (${attempt}/4)...`;
            }
          }
        );
        if (!res.ok || !data || !data.success) throw new Error((data && data.error) || 'មិនអាចចាប់សំឡេងបាន។');
        if (!Array.isArray(data.cues) || data.cues.length === 0) {
          throw new Error('មិនបានរកឃើញពាក្យនិយាយទេ។');
        }

        activeCues = normalizeCuesTiming(data.cues);
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        renderTable();
        renderTimeline();
        checkAllAudioCache();
        statusMsg.innerText = '✅ បានរកឃើញ និងចាប់យកនាទីសំឡេងមនុស្សចំនួន ' + activeCues.length + ' បន្ទាត់!';
        if (!options.silentSuccess) {
          alert('🎉 ជោគជ័យ! បានចាប់យកសំឡេងមនុស្សនិយាយចំនួន ' + activeCues.length + ' បន្ទាត់។ ចុច 🌐 TRANSLATE ដើម្បីបកប្រែ subtitle។');
        }
        if (activeCues[0]) selectCueRow(0);
        return true;
      } catch (err) {
        statusMsg.innerText = '❌ កំហុស៖ ' + err.message;
        alert('កំហុស Server: ' + err.message);
        return false;
      }
    }

    let exportPollInterval = null;

    async function waitForExportCompletionViaProgress(statusMsg, progFill) {
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        try {
          const pRes = await fetch(`${BACKEND_URL}/api/export/progress`);
          const pData = await pRes.json();
          if (pData) {
            const pct = Number.isFinite(pData.percent) ? pData.percent : null;
            if (progFill && pct !== null) progFill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
            if (!pData.running) {
              if (pData.phase === 'done' && pData.outputFile) {
                return { success: true, outputFile: pData.outputFile };
              }
              if (pData.phase === 'cancelled') {
                return { success: false, cancelled: true };
              }
              if (pData.phase === 'error') {
                return { success: false, error: pData.error || pData.statusText || 'Export failed' };
              }
            }
            if (statusMsg) {
              const progress = pct !== null ? ` (${pct}%)` : '';
              statusMsg.innerText = `⏳ Server កំពុងបញ្ចប់ Render ក្នុងផ្ទៃខាងក្រោយ${progress}...`;
            }
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1500));
      }
      return { success: false, error: 'Export timed out waiting for server completion.' };
    }

    async function exportVideoWithFfmpeg() {
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
      }
      if (!currentVideoPath) return alert('សូមផ្ទុកវីដេអូជាមុនសិន!');
      if (activeCues.length === 0) return alert('សូមផ្ទុកបន្ទាត់អក្សររត់ជាមុនសិន!');

      const statusMsg = document.getElementById('exportStatusMsg');
      const startBtn = document.getElementById('btnStartExport');
      const cancelBtn = document.getElementById('btnCancelExport');
      const openFileBtn = document.getElementById('btnOpenExportedFile');
      const dlMp4Btn = document.getElementById('btnDownloadExportedMp4');
      const progTrack = document.getElementById('exportProgressTrack');
      const progFill = document.getElementById('exportProgressFill');
      if (startBtn) startBtn.disabled = true;
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';
      if (openFileBtn) openFileBtn.hidden = true;
      if (dlMp4Btn) dlMp4Btn.hidden = true;
      if (progTrack) progTrack.hidden = false;
      if (progFill) progFill.style.width = '3%';
      lastExportedFilePath = '';
      if (statusMsg) statusMsg.innerText = '⏳ កំពុងចាប់ផ្ដើម FFmpeg...';

      const maskCheckEl = document.getElementById('maskToggleCheck') || document.getElementById('exportMaskCheck');
      const maskModeEl = document.getElementById('maskModeSelect') || document.getElementById('exportMaskMode');
      const subStyleEl = document.getElementById('subStyleSelect') || document.getElementById('exportSubStyle');
      const maskEnabled = Boolean(maskCheckEl && maskCheckEl.checked);
      const maskMode = (maskModeEl && maskModeEl.value) || 'feathered';
      const subStyle = (subStyleEl && subStyleEl.value) || currentSubStyle || 'tiktok';
      const maskYVal = parseInt(document.getElementById('maskYSlider')?.value || '70', 10);
      const maskHVal = parseInt(document.getElementById('maskHSlider')?.value || '48', 10);

      const dubCheckEl = document.getElementById('exportDubCheck');
      const audioModeEl = document.getElementById('exportAudioMode');
      const autoFitEl = document.getElementById('exportAutoFitCheck');
      const resEl = document.getElementById('exportResolution');
      const qualityEl = document.getElementById('exportQualityPreset');
      const encoderEl = document.getElementById('exportEncoder');

      const audioMixMode = audioModeEl ? audioModeEl.value : 'duck';
      const includeDubAudio = Boolean(dubCheckEl ? dubCheckEl.checked : true) && audioMixMode !== 'original';
      const autoFitTiming = Boolean(autoFitEl ? autoFitEl.checked : true);
      const resolution = resEl ? resEl.value : 'source';
      const qualityPreset = qualityEl ? qualityEl.value : 'hd';
      const encoder = encoderEl ? encoderEl.value : 'auto';
      const outputDir = getCustomExportOutputDir();
      
      const maskYPercent = Math.max(0.6, Math.min(0.92, (480 - maskYVal - maskHVal) / 480));
      const maskHPercent = Math.max(0.04, Math.min(0.14, maskHVal / 480));
      const subMarginV = Math.round(maskYVal * 4.2);

      const v = document.getElementById('mainVideo');
      const videoDuration = v.duration || currentVideoDuration || 120;

      // Start polling export progress
      clearInterval(exportPollInterval);
      exportPollInterval = setInterval(async () => {
        try {
          const pRes = await fetch(`${BACKEND_URL}/api/export/progress`);
          const pData = await pRes.json();
          if (pData) {
            const pct = Number.isFinite(pData.percent) ? pData.percent : null;
            if (progFill && pct !== null) progFill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
            const progress = pct !== null ? ` (${pct}%)` : '';
            const speed = pData.phase === 'encoding' && pData.speed ? ` · ${pData.speed}` : '';
            const elapsed = pData.phase === 'encoding' && pData.timeStr ? ` · ${pData.timeStr}` : '';
            const phaseLabel = pData.statusText || '⚡ កំពុងដុតអក្សររត់ និង Render HD';
            if (statusMsg) statusMsg.innerText = `${phaseLabel}${progress}${speed}${elapsed}`;
          }
        } catch (_) {}
      }, 400);

      const finalizeExportUi = (resData) => {
        if (resData && resData.success) {
          lastExportedFilePath = resData.outputFile || '';
          if (progFill) progFill.style.width = '100%';
          const dubNote = resData.dubbedCueCount > 0 ? ` · AI Dubbing ${resData.dubbedCueCount} បន្ទាត់` : '';
          const metaNote = resData.encoder ? ` (${resData.encoder}, ${resData.exportTime || ''})` : '';
          if (statusMsg) statusMsg.innerText = `✅ Export ជោគជ័យ${dubNote}${metaNote}: ${resData.outputFile}`;
          if (openFileBtn) openFileBtn.hidden = false;
          if (dlMp4Btn) dlMp4Btn.hidden = false;
          showShortcutToast(`🎉 Export HD រួចរាល់!`);
          if (isMobileOrRemoteClient() && resData.outputFile) {
            downloadLastExportedFile(resData.outputFile);
          }
        } else if (resData && resData.cancelled) {
          if (progTrack) progTrack.hidden = true;
          if (statusMsg) statusMsg.innerText = '🛑 បានបោះបង់ការ Export';
        } else {
          if (progTrack) progTrack.hidden = true;
          const errTxt = (resData && resData.error) || 'មិនអាច Export បាន';
          if (statusMsg) statusMsg.innerText = '❌ កំហុស Export៖ ' + errTxt;
          alert('❌ កំហុស Export៖ ' + errTxt);
        }
      };

      try {
        const lockedCastMode = getActiveCastMode();
        const lockedFixedVoice = getSelectedSingleVoice();
        if (lockedCastMode === 'single') {
          normalizeActiveCuesForCastMode(activeCues, 'single', lockedFixedVoice);
        }
        const res = await fetch(`${BACKEND_URL}/api/export/video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: currentVideoPath,
            cues: activeCues,
            duration: videoDuration,
            maskEnabled,
            maskMode,
            subStyle,
            subFontSize: Math.round(currentSubFontSize * 4),
            subMarginV,
            wordPopEnabled: isWordPopEnabled,
            maskYPercent: parseFloat(maskYPercent.toFixed(3)),
            maskHPercent: parseFloat(maskHPercent.toFixed(3)),
            includeDubAudio,
            autoGenerateMissingTts: includeDubAudio,
            autoFitTiming,
            audioMixMode,
            ttsEngine: getActiveTtsEngine(),
            castMode: lockedCastMode,
            fixedVoice: lockedFixedVoice,
            strictVoice: true,
            qualityPreset,
            resolution,
            encoder,
            outputDir,
            ...getSponsorExportPayload()
          })
        });
        let data = null;
        try {
          data = await res.json();
        } catch (parseErr) {
          const st = Number(res && res.status) || 0;
          if (st === 524 || st === 504 || st === 503 || st === 522 || st >= 500) {
            data = await waitForExportCompletionViaProgress(statusMsg, progFill);
          } else {
            throw parseErr;
          }
        }
        if (res && (res.status === 524 || res.status === 504 || res.status === 503 || res.status === 522) && (!data || !data.success)) {
          data = await waitForExportCompletionViaProgress(statusMsg, progFill);
        }
        clearInterval(exportPollInterval);
        finalizeExportUi(data);
      } catch (err) {
        clearInterval(exportPollInterval);
        let recovered = null;
        if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String((err && err.message) || ''))) {
          try {
            const chk = await fetch(`${BACKEND_URL}/api/export/progress`);
            const chkData = await chk.json().catch(() => null);
            if (chkData && (chkData.running || (chkData.phase === 'done' && chkData.outputFile))) {
              recovered = await waitForExportCompletionViaProgress(statusMsg, progFill);
            }
          } catch (_) {}
        }
        if (recovered && (recovered.success || recovered.cancelled)) {
          finalizeExportUi(recovered);
        } else {
          if (progTrack) progTrack.hidden = true;
          const finalMsg = (recovered && recovered.error) || err.message;
          if (statusMsg) statusMsg.innerText = '❌ កំហុស Server: ' + finalMsg;
          alert('❌ កំហុស Server: ' + finalMsg);
        }
      } finally {
        if (startBtn) startBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
      }
    }

    async function cancelActiveExport() {
      if (confirm('តើអ្នកចង់បោះបង់ការ Export នេះមែនទេ?')) {
        clearInterval(exportPollInterval);
        try {
          await fetch(`${BACKEND_URL}/api/export/cancel`, { method: 'POST' });
        } catch (_) {}
        const startBtn = document.getElementById('btnStartExport');
        const cancelBtn = document.getElementById('btnCancelExport');
        if (startBtn) startBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
        const statusMsg = document.getElementById('exportStatusMsg');
        if (statusMsg) statusMsg.innerText = '🛑 បានបោះបង់ការ Export';
        showShortcutToast('🛑 បានបោះបង់ការ Export');
      }
    }

    async function openImportFolderDialog() {
      if (window.electronAPI && typeof window.electronAPI.openFolderDialog === 'function') {
        document.getElementById('bottomStatusMsg').innerText = '⏳ កំពុងបើកផ្ទាំងរើស Folder លើ Windows...';
        try {
          const selectedFolder = await window.electronAPI.openFolderDialog();
          if (!selectedFolder) {
            document.getElementById('bottomStatusMsg').innerText = 'បានបោះបង់ការជ្រើសរើស Folder។';
            return;
          }
          await scanCustomFolderPath(selectedFolder);
        } catch (e) {
          alert('កំហុស៖ ' + e.message);
        }
        return;
      }
      openHdrgDramaPicker();
    }

    const ROUTER_NODE_PALETTE = [
      '#22d3ee',
      '#10b981',
      '#f59e0b',
      '#38bdf8',
      '#a855f7',
      '#ec4899',
      '#f43f5e',
      '#e2e8f0'
    ];
    const ROUTER_MODEL_MODE_STORAGE_KEY = 'eza_router_model_mode';
    function loadSavedRouterModelMode() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const saved = localStorage.getItem(ROUTER_MODEL_MODE_STORAGE_KEY);
          if (saved === 'smart' || saved === 'fast') return saved;
        }
      } catch (_) {}
      return '';
    }

    function saveRouterModelModeLocal(mode) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_MODEL_MODE_STORAGE_KEY, mode === 'smart' ? 'smart' : 'fast');
        }
      } catch (_) {}
    }

    let routerPollTimer = null;
    let routerTopologySignature = '';
    let routerAiModelMode = loadSavedRouterModelMode() || 'fast';

    function setRouterSidebarStatus(message, isError = false) {
      const status = document.getElementById('routerSidebarStatus');
      if (!status) return;
      status.innerText = message;
      status.style.color = isError ? '#fca5a5' : '';
    }

    function formatRouterCooldownRemaining(rawMs) {
      const ms = Number(rawMs || 0);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const totalSec = Math.ceil(ms / 1000);
      if (totalSec >= 60) {
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
      }
      return `${totalSec}s`;
    }

    function toggleRouterKeyVisibility(forceVisible) {
      const input = document.getElementById('routerApiKeyInput');
      const btn = document.getElementById('routerKeyEyeBtn');
      if (!input) return;
      const show = typeof forceVisible === 'boolean' ? forceVisible : (input.type === 'password');
      input.type = show ? 'text' : 'password';
      if (btn) {
        btn.innerText = show ? '🙈' : '👁️';
        btn.setAttribute('aria-label', show ? 'លាក់ API Key' : 'បង្ហាញ API Key');
      }
    }

    function toggleRouterAddPanel(forceState, editAccount = null) {
      const panel = document.getElementById('routerAddPanel');
      if (!panel) return;
      const shouldOpen = typeof forceState === 'boolean' ? forceState : panel.hidden;
      panel.hidden = !shouldOpen;
      if (shouldOpen) {
        const batchPanel = document.getElementById('routerBatchPanel');
        if (batchPanel) batchPanel.hidden = true;
      }
      toggleRouterKeyVisibility(false);

      const form = panel.querySelector('form');
      const titleEl = document.getElementById('routerAddTitle');
      const submitBtn = document.getElementById('routerAddSubmitBtn');
      const keyHintEl = document.getElementById('routerKeyOptionalHint');
      const keyInput = document.getElementById('routerApiKeyInput');
      if (!shouldOpen) {
        if (form) form.reset();
        const idField = form && form.querySelector('input[name="accountId"]');
        if (idField) idField.value = '';
        return;
      }

      if (form) {
        const idField = form.querySelector('input[name="accountId"]');
        const nameField = form.querySelector('input[name="name"]');
        const emailField = form.querySelector('input[name="email"]');
        if (editAccount && editAccount.id) {
          if (idField) idField.value = editAccount.id;
          if (nameField) nameField.value = editAccount.name || '';
          if (emailField) emailField.value = editAccount.email || '';
          if (keyInput) {
            keyInput.value = '';
            keyInput.required = false;
            keyInput.minLength = 0;
            keyInput.placeholder = 'ទុកទំនេរ បើរក្សា API Key ចាស់...';
          }
          if (keyHintEl) keyHintEl.hidden = false;
          if (titleEl) titleEl.innerText = `✎ កែប្រែ Gemini Account · ${editAccount.name || ''}`;
          if (submitBtn) submitBtn.innerText = '💾 រក្សាទុកការកែប្រែ';
        } else {
          form.reset();
          if (idField) idField.value = '';
          if (keyInput) {
            keyInput.required = true;
            keyInput.minLength = 20;
            keyInput.placeholder = 'AIza... ឬ AQ...';
          }
          if (keyHintEl) keyHintEl.hidden = true;
          if (titleEl) titleEl.innerText = '＋ បន្ថែម Gemini Account ថ្មី';
          if (submitBtn) submitBtn.innerText = '💾 រក្សាទុក និងដាក់ឲ្យសកម្ម';
        }
        if (nameField) nameField.focus();
      }
    }

    function maskRouterEmail(email) {
      const str = typeof email === 'string' ? email.trim() : '';
      if (!str) return '';
      const atIdx = str.indexOf('@');
      if (atIdx <= 1) return str;
      const local = str.slice(0, atIdx);
      const domain = str.slice(atIdx + 1);
      const prefix = local.slice(0, Math.min(3, local.length));
      const domPrefix = domain.split('.')[0] || '';
      return `${prefix}***@${domPrefix ? domPrefix.slice(0, 3) + '***' : '***'}`;
    }

    function toggleRouterBatchPanel(forceState) {
      const panel = document.getElementById('routerBatchPanel');
      if (!panel) return;
      const shouldOpen = typeof forceState === 'boolean' ? forceState : panel.hidden;
      panel.hidden = !shouldOpen;
      if (shouldOpen) {
        toggleRouterAddPanel(false);
        const ta = document.getElementById('routerBatchInput');
        if (ta && typeof ta.focus === 'function') ta.focus();
      } else {
        const form = document.getElementById('routerBatchForm');
        if (form) form.reset();
      }
    }

    function stopRouterPolling() {
      if (routerPollTimer) {
        clearInterval(routerPollTimer);
        routerPollTimer = null;
      }
      if (routerStarResizeObserver) {
        routerStarResizeObserver.disconnect();
        routerStarResizeObserver = null;
      }
    }

    async function openRouterSidebar() {
      const sidebar = document.getElementById('routerSidebar');
      const studioPane = document.getElementById('studioViewPane');
      const vmPane = document.getElementById('videoManagerModal');
      if (studioPane) studioPane.style.display = 'none';
      if (vmPane) vmPane.style.display = 'none';
      if (sidebar) sidebar.hidden = false;
      currentAppView = 'router';
      setActiveSidebarNav('router');
      const closeBtn = sidebar ? sidebar.querySelector('.modal-close') : null;
      if (closeBtn) closeBtn.focus();
      routerTopologySignature = '';
      await syncRouterModelMode();
      await refreshGeminiAccounts();

      stopRouterPolling();
      routerPollTimer = setInterval(() => {
        const sb = document.getElementById('routerSidebar');
        if (sb && !sb.hidden) {
          refreshGeminiAccounts({ silent: true });
        }
      }, 900);
    }

    function closeRouterSidebar() {
      stopRouterPolling();
      const sidebar = document.getElementById('routerSidebar');
      const addPanel = document.getElementById('routerAddPanel');
      const batchPanel = document.getElementById('routerBatchPanel');
      const studioPane = document.getElementById('studioViewPane');
      if (sidebar) sidebar.hidden = true;
      if (addPanel) addPanel.hidden = true;
      if (batchPanel) batchPanel.hidden = true;
      if (studioPane && currentAppView !== 'video-manager') {
        studioPane.style.display = 'flex';
      }
      if (currentAppView === 'router') {
        currentAppView = 'studio';
        setActiveSidebarNav('studio');
      }
    }

    function formatRouterMs(rawMs) {
      const ms = Number(rawMs || 0);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
    }

    function formatRouterLatencyLabel(account) {
      return formatRouterMs(account && (account.ewmaLatencyMs || account.lastLatencyMs));
    }

    function formatRouterAccountStatusText(account) {
      const isEnabled = account.enabled !== false;
      if (!isEnabled) return 'Paused';
      if (account.isStreaming) return 'Streaming';
      if (account.lastStatus === 'rate_limited') {
        const cdText = formatRouterCooldownRemaining(account.cooldownRemainingMs);
        return cdText ? `429 · ${cdText}` : '429 Cooldown';
      }
      if (account.lastStatus === 'error') return 'Error';
      return account.isActive ? 'Ready · Primary' : 'Ready';
    }

    function applyRouterCardBadge(titleRow, account) {
      if (!titleRow) return;
      const isEnabled = account.enabled !== false;
      let badgeEl = titleRow.querySelector('.router-node-badge');
      if (!isEnabled || account.isStreaming || account.isActive) {
        if (!badgeEl) {
          badgeEl = document.createElement('span');
          titleRow.appendChild(badgeEl);
        }
        if (!isEnabled) {
          badgeEl.className = 'router-node-badge paused';
          badgeEl.innerText = 'Paused';
        } else if (account.isStreaming) {
          badgeEl.className = 'router-node-badge live';
          badgeEl.innerText = 'LIVE';
        } else {
          badgeEl.className = 'router-node-badge';
          badgeEl.innerText = 'Active';
        }
      } else if (badgeEl) {
        badgeEl.remove();
      }
    }

    function createRouterAccountCard(account, color, maxRequestCount = 1, wingSide = '') {
      const isEnabled = account.enabled !== false;
      const card = document.createElement('article');
      card.className = 'router-node-card';
      card.dataset.accountId = account.id;
      card.dataset.color = color;
      if (wingSide === 'left' || wingSide === 'right') {
        card.dataset.wing = wingSide;
        const port = document.createElement('span');
        port.className = `router-node-port ${wingSide === 'left' ? 'right' : 'left'}`;
        card.appendChild(port);
      }
      card.dataset.enabled = String(isEnabled);
      card.dataset.active = String(Boolean(account.isActive && isEnabled));
      card.dataset.streaming = String(Boolean(account.isStreaming && isEnabled));
      card.dataset.status = account.lastStatus || 'ready';
      card.style.setProperty('--node-color', color);

      const topRow = document.createElement('div');
      topRow.className = 'router-card-top';

      const avatar = document.createElement('div');
      avatar.className = 'router-node-avatar';
      const initial = (account.name || account.email || 'G').trim().charAt(0).toUpperCase() || 'G';
      avatar.innerText = initial;
      const dot = document.createElement('span');
      dot.className = 'router-node-dot';
      avatar.appendChild(dot);
      topRow.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'router-node-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'router-node-title-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'router-node-name';
      nameEl.innerText = account.name;
      titleRow.appendChild(nameEl);
      applyRouterCardBadge(titleRow, account);
      info.appendChild(titleRow);

      const subRow = document.createElement('div');
      subRow.className = 'router-node-sub-row';
      const subEl = document.createElement('span');
      subEl.className = 'router-node-sub';
      subEl.innerText = account.email ? maskRouterEmail(account.email) : (account.keyHint || 'Gemini');
      subRow.appendChild(subEl);
      info.appendChild(subRow);

      const statusEl = document.createElement('div');
      statusEl.className = 'router-node-status';
      statusEl.innerText = formatRouterAccountStatusText(account);
      if (isEnabled && account.lastStatus === 'rate_limited') statusEl.style.color = '#fcd34d';
      else if (isEnabled && account.lastStatus === 'error') statusEl.style.color = '#fda4af';
      info.appendChild(statusEl);
      topRow.appendChild(info);

      const rightTools = document.createElement('div');
      rightTools.className = 'router-node-right-tools';

      const actions = document.createElement('div');
      actions.className = 'router-node-actions';

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'router-node-action-btn';
      testBtn.innerText = '⚡';
      testBtn.title = 'តេស្តការតភ្ជាប់ API Key នេះ';
      testBtn.setAttribute('aria-label', `តេស្ត ${account.name}`);
      testBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        testGeminiAccount(account.id, account.name);
      });
      actions.appendChild(testBtn);

      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = `router-node-action-btn${isEnabled ? '' : ' paused-state'}`;
      pauseBtn.innerText = isEnabled ? '⏸' : '▶';
      pauseBtn.title = isEnabled ? 'ផ្អាកប្រើ Key នេះបណ្ដោះអាសន្ន' : 'បើកឲ្យ Key នេះដំណើរការវិញ';
      pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleGeminiAccountEnabled(account.id, account.name, !isEnabled);
      });
      actions.appendChild(pauseBtn);

      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'router-node-action-btn';
      switchBtn.innerText = account.isActive ? '★' : '⇄';
      switchBtn.title = account.isActive ? 'កំពុងប្រើជា Key ចម្បង' : 'ដាក់ Key នេះជាចម្បង';
      switchBtn.disabled = Boolean(account.isActive && isEnabled);
      switchBtn.setAttribute('aria-label', account.isActive ? `${account.name} កំពុងប្រើ` : `ប្ដូរទៅ ${account.name}`);
      switchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        switchGeminiAccount(account.id);
      });
      actions.appendChild(switchBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'router-node-action-btn';
      editBtn.innerText = '✎';
      editBtn.title = `កែប្រែ ${account.name}`;
      editBtn.setAttribute('aria-label', `កែប្រែ ${account.name}`);
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRouterAddPanel(true, account);
      });
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'router-node-action-btn delete';
      delBtn.innerText = '✕';
      delBtn.title = `លុប ${account.name}`;
      delBtn.setAttribute('aria-label', `លុប ${account.name}`);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteGeminiAccount(account.id, account.name);
      });
      actions.appendChild(delBtn);

      rightTools.appendChild(actions);

      const reqCount = Number(account.requestCount) || 0;
      const countPill = document.createElement('div');
      countPill.className = 'router-node-count';
      countPill.innerText = `${reqCount}`;
      countPill.title = `ចំនួនសំណើ Gemini (${reqCount})`;
      rightTools.appendChild(countPill);

      topRow.appendChild(rightTools);
      card.appendChild(topRow);

      const loadBar = document.createElement('div');
      loadBar.className = 'router-node-loadbar';
      const loadFill = document.createElement('span');
      const pct = reqCount > 0 ? Math.max(8, Math.round((reqCount / Math.max(1, maxRequestCount)) * 100)) : 5;
      loadFill.style.width = `${pct}%`;
      loadBar.appendChild(loadFill);
      card.appendChild(loadBar);

      return card;
    }

    function createRouterGhostActionCard(label, onClick) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'router-node-card router-node-add-ghost';
      card.innerText = label;
      card.addEventListener('click', onClick);
      return card;
    }

    function renderRouterTelemetryDock(data) {
      const dock = document.getElementById('routerTelemetryDock');
      if (!dock) return;
      const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
      const enabledAccounts = accounts.filter(a => a && a.enabled !== false);
      const totalReqs = accounts.reduce((sum, a) => sum + (Number(a && a.requestCount) || 0), 0);
      const streamingCount = Number(data && data.streamingCount) || enabledAccounts.filter(a => a && a.isStreaming).length;
      const readyCount = enabledAccounts.filter(a => a && a.lastStatus !== 'rate_limited' && a.lastStatus !== 'error').length;
      const cooldownCount = enabledAccounts.filter(a => a && a.lastStatus === 'rate_limited').length;
      const pausedCount = accounts.length - enabledAccounts.length;
      const latencies = enabledAccounts
        .map(a => Number((a && (a.ewmaLatencyMs || a.lastLatencyMs)) || 0))
        .filter(ms => Number.isFinite(ms) && ms > 0);
      const avgLatMs = latencies.length > 0 ? (latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
      const avgLatText = formatRouterMs(avgLatMs) || 'Standby';
      const healthParts = [];
      if (cooldownCount > 0) healthParts.push(`${cooldownCount} 429`);
      if (pausedCount > 0) healthParts.push(`${pausedCount} Paused`);
      const healthText = healthParts.length > 0
        ? `${readyCount}/${accounts.length} Ready (${healthParts.join(', ')})`
        : `${readyCount}/${accounts.length} Ready`;

      dock.replaceChildren();

      const metrics = document.createElement('div');
      metrics.className = 'router-dock-metrics';
      const items = [
        { label: 'សំណើសរុប', value: String(totalReqs), cls: '' },
        { label: 'កំពុងដំណើរការ', value: streamingCount > 0 ? `${streamingCount} Parallel` : '0 Idle', cls: streamingCount > 0 ? 'accent' : '' },
        { label: 'ល្បឿនមធ្យម', value: avgLatText, cls: avgLatMs > 0 && avgLatMs < 4500 ? 'good' : '' },
        { label: 'សុខភាព Pool', value: healthText, cls: readyCount === enabledAccounts.length && enabledAccounts.length > 0 ? 'good' : '' }
      ];
      items.forEach(({ label, value, cls }) => {
        const stat = document.createElement('div');
        stat.className = 'router-dock-stat';
        const lEl = document.createElement('span');
        lEl.className = 'router-dock-label';
        lEl.innerText = label;
        const vEl = document.createElement('span');
        vEl.className = `router-dock-val${cls ? ' ' + cls : ''}`;
        vEl.innerText = value;
        stat.appendChild(lEl);
        stat.appendChild(vEl);
        metrics.appendChild(stat);
      });
      dock.appendChild(metrics);

      const isSmartMode = routerAiModelMode === 'smart';
      const pipeline = document.createElement('div');
      pipeline.className = 'router-dock-pipeline';
      const chipPrimary = document.createElement('button');
      chipPrimary.type = 'button';
      chipPrimary.className = `router-model-chip${!isSmartMode ? ' selected' : ''}`;
      chipPrimary.innerText = !isSmartMode ? '⚡ 3-Flash · ចម្បង (Active)' : '⚡ 3-Flash · បម្រុងលឿន';
      chipPrimary.title = 'ប្រើ Gemini 3-Flash ជាចម្បង (ត្រឹមត្រូវខ្ពស់ និងលឿន)';
      if (typeof chipPrimary.setAttribute === 'function') chipPrimary.setAttribute('aria-pressed', String(!isSmartMode));
      if (typeof chipPrimary.addEventListener === 'function') chipPrimary.addEventListener('click', () => setRouterModelMode('fast'));

      const arrow = document.createElement('span');
      arrow.className = 'router-model-arrow';
      arrow.innerText = '➔';

      const chipFallback = document.createElement('button');
      chipFallback.type = 'button';
      chipFallback.className = `router-model-chip secondary${isSmartMode ? ' selected' : ''}`;
      chipFallback.innerText = isSmartMode ? '🧪 4-Hydrogen · Smart (Active)' : '🧪 4-Hydrogen · Smart បម្រុង';
      chipFallback.title = 'ប្ដូរទៅ 4-Hydrogen ជាចម្បង (thinking=low សម្រាប់រឿងស្មុគស្មាញ)';
      if (typeof chipFallback.setAttribute === 'function') chipFallback.setAttribute('aria-pressed', String(isSmartMode));
      if (typeof chipFallback.addEventListener === 'function') chipFallback.addEventListener('click', () => setRouterModelMode('smart'));

      pipeline.appendChild(chipPrimary);
      pipeline.appendChild(arrow);
      pipeline.appendChild(chipFallback);
      dock.appendChild(pipeline);
    }

    let routerStarResizeObserver = null;

    function buildRouterCenterHubElement(data) {
      const wrap = document.createElement('div');
      wrap.className = 'router-core-wrap';

      const hub = document.createElement('div');
      hub.id = 'routerCenterHub';
      hub.className = 'router-center-hub';

      const outerRing = document.createElement('div');
      outerRing.className = 'router-orb-ring-outer';
      const ticksRing = document.createElement('div');
      ticksRing.className = 'router-hub-ticks';
      hub.appendChild(outerRing);
      hub.appendChild(ticksRing);

      if (typeof document.createElementNS === 'function') {
        const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        iconSvg.setAttribute('viewBox', '0 0 24 24');
        iconSvg.setAttribute('class', 'router-orb-svg');
        iconSvg.setAttribute('fill', 'none');
        iconSvg.setAttribute('stroke', 'currentColor');
        iconSvg.setAttribute('stroke-width', '2');
        iconSvg.setAttribute('stroke-linecap', 'round');
        const spokes = [
          [12, 5.4],
          [17.7, 8.7],
          [17.7, 15.3],
          [12, 18.6],
          [6.3, 15.3],
          [6.3, 8.7]
        ];
        spokes.forEach(([x, y]) => {
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          p.setAttribute('d', `M12 12 L${x} ${y}`);
          iconSvg.appendChild(p);
        });
        [[12, 12, 2.3], ...spokes.map(([x, y]) => [x, y, 1.75])].forEach(([cx, cy, r]) => {
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('cx', String(cx));
          c.setAttribute('cy', String(cy));
          c.setAttribute('r', String(r));
          c.setAttribute('fill', 'currentColor');
          c.setAttribute('stroke', 'none');
          iconSvg.appendChild(c);
        });
        hub.appendChild(iconSvg);
      }

      const termL = document.createElement('span');
      termL.className = 'router-orb-terminal left';
      const termR = document.createElement('span');
      termR.className = 'router-orb-terminal right';
      hub.appendChild(termL);
      hub.appendChild(termR);

      const caption = document.createElement('div');
      caption.id = 'routerCoreCaption';
      caption.className = 'router-core-caption';

      const title = document.createElement('div');
      title.className = 'router-core-title';
      title.innerText = 'EZA PRO Router';

      const state = document.createElement('div');
      state.className = 'router-core-state';

      caption.appendChild(title);
      caption.appendChild(state);
      wrap.appendChild(hub);
      wrap.appendChild(caption);

      updateRouterCenterHubElement(hub, data, caption);
      return wrap;
    }

    function updateRouterCenterHubElement(hub, data, captionEl = null) {
      if (!hub) return;
      const caption = captionEl || document.getElementById('routerCoreCaption');
      const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
      const enabled = accounts.filter(a => a && a.enabled !== false);
      const streamingCount = Number(data && data.streamingCount) || enabled.filter(a => a && a.isStreaming).length;
      const readyCount = enabled.filter(a => a && a.lastStatus !== 'rate_limited' && a.lastStatus !== 'error').length;
      const allPaused = accounts.length > 0 && enabled.length === 0;

      hub.dataset.streaming = String(streamingCount > 0);
      hub.dataset.pausedAll = String(allPaused);

      const stateEl = caption ? caption.querySelector('.router-core-state') : null;
      if (stateEl) {
        if (streamingCount > 0) stateEl.innerText = `Smart Pool · ${streamingCount} Streaming`;
        else if (allPaused) stateEl.innerText = 'Smart Pool · All Paused';
        else if (accounts.length === 0) stateEl.innerText = 'Smart Pool · 0 Accounts Ready';
        else stateEl.innerText = `Smart Pool · ${readyCount} Accounts Ready`;
      }
    }

    function drawRouterStarConnectors(inPlaceOnly = false) {
      const stage = document.getElementById('routerStarStage');
      const svg = document.getElementById('routerStarLinesSvg');
      const hub = document.getElementById('routerCenterHub');
      if (!stage || !svg || !hub || typeof document.createElementNS !== 'function' || typeof stage.getBoundingClientRect !== 'function') {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const hubRect = hub.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height || !hubRect.width) return;

      const termL = hub.querySelector('.router-orb-terminal.left');
      const termR = hub.querySelector('.router-orb-terminal.right');
      const termLRect = termL && typeof termL.getBoundingClientRect === 'function' ? termL.getBoundingClientRect() : null;
      const termRRect = termR && typeof termR.getBoundingClientRect === 'function' ? termR.getBoundingClientRect() : null;
      const hubLeftX = termLRect && termLRect.width
        ? (termLRect.left - stageRect.left + termLRect.width / 2)
        : (hubRect.left - stageRect.left - 8);
      const hubRightX = termRRect && termRRect.width
        ? (termRRect.left - stageRect.left + termRRect.width / 2)
        : (hubRect.right - stageRect.left + 8);
      const hubCenterY = hubRect.top - stageRect.top + hubRect.height / 2;

      const computeCurvePath = (card, side) => {
        const cardRect = card.getBoundingClientRect();
        if (!cardRect.width || !cardRect.height) return '';
        const portEl = card.querySelector('.router-node-port');
        const portRect = portEl && typeof portEl.getBoundingClientRect === 'function' ? portEl.getBoundingClientRect() : null;
        const x1 = portRect && portRect.width
          ? (portRect.left - stageRect.left + portRect.width / 2)
          : (side === 'left' ? (cardRect.right - stageRect.left) : (cardRect.left - stageRect.left));
        const y1 = portRect && portRect.height
          ? (portRect.top - stageRect.top + portRect.height / 2)
          : (cardRect.top - stageRect.top + cardRect.height / 2);
        const x2 = side === 'left' ? hubLeftX : hubRightX;
        const y2 = hubCenterY;
        const dx = Math.max(36, Math.abs(x2 - x1) * 0.52);
        const cx1 = side === 'left' ? x1 + dx : x1 - dx;
        const cx2 = side === 'left' ? x2 - dx : x2 + dx;
        return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      };

      const leftCards = Array.from(stage.querySelectorAll('.router-node-card[data-wing="left"][data-account-id]'));
      const rightCards = Array.from(stage.querySelectorAll('.router-node-card[data-wing="right"][data-account-id]'));
      const allCards = leftCards.concat(rightCards);

      if (inPlaceOnly && svg.querySelectorAll('path.router-star-trace').length === allCards.length) {
        allCards.forEach((card) => {
          const id = card.dataset.accountId;
          const side = card.dataset.wing || 'left';
          const d = computeCurvePath(card, side);
          let stateMod = '';
          if (card.dataset.enabled === 'false') stateMod = ' paused';
          else if (card.dataset.streaming === 'true') stateMod = ' streaming';
          else if (card.dataset.status === 'rate_limited') stateMod = ' rate-limited';
          else if (card.dataset.status === 'error') stateMod = ' error';
          else if (card.dataset.active === 'true') stateMod = ' active';

          const traceEl = svg.querySelector(`path.router-star-trace[data-account-id="${id}"]`);
          const nextTraceCls = `router-star-trace${stateMod}`;
          if (traceEl) {
            if (d && traceEl.getAttribute('d') !== d) traceEl.setAttribute('d', d);
            if (traceEl.getAttribute('class') !== nextTraceCls) traceEl.setAttribute('class', nextTraceCls);
          }
          const pulseEl = svg.querySelector(`path.router-cable-pulse[data-account-id="${id}"]`);
          const nextPulseCls = `router-cable-pulse${stateMod}`;
          if (pulseEl) {
            if (d && pulseEl.getAttribute('d') !== d) pulseEl.setAttribute('d', d);
            if (pulseEl.getAttribute('class') !== nextPulseCls) pulseEl.setAttribute('class', nextPulseCls);
          }
        });
        return;
      }

      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${Math.round(stageRect.width)} ${Math.round(stageRect.height)}`);

      const drawWingTraces = (cards, side) => {
        cards.forEach((card, idx) => {
          const d = computeCurvePath(card, side);
          if (!d) return;
          const color = card.dataset.color || '#38bdf8';
          const accId = card.dataset.accountId || '';

          let stateMod = '';
          if (card.dataset.enabled === 'false') stateMod = ' paused';
          else if (card.dataset.streaming === 'true') stateMod = ' streaming';
          else if (card.dataset.status === 'rate_limited') stateMod = ' rate-limited';
          else if (card.dataset.status === 'error') stateMod = ' error';
          else if (card.dataset.active === 'true') stateMod = ' active';

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('data-account-id', accId);
          path.setAttribute('class', `router-star-trace${stateMod}`);
          path.style.setProperty('--trace-color', color);
          svg.appendChild(path);

          const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          pulse.setAttribute('d', d);
          pulse.setAttribute('pathLength', '100');
          pulse.setAttribute('data-account-id', accId);
          pulse.setAttribute('class', `router-cable-pulse${stateMod}`);
          pulse.style.setProperty('--trace-color', color);
          pulse.style.animationDelay = `${((idx * 0.47) % 2.4).toFixed(2)}s`;
          svg.appendChild(pulse);
        });
      };

      drawWingTraces(leftCards, 'left');
      drawWingTraces(rightCards, 'right');
    }

    function updateRouterTelemetryInPlace(data) {
      const stage = document.getElementById('routerStarStage');
      if (!stage) return false;
      const accounts = data.accounts || [];
      const byId = new Map(accounts.map(a => [a.id, a]));
      const cards = stage.querySelectorAll('.router-node-card[data-account-id]');
      if (cards.length !== accounts.length) return false;

      const maxReqCount = Math.max(1, ...accounts.map(a => Number(a && a.requestCount) || 0));
      for (const card of cards) {
        const acc = byId.get(card.dataset.accountId);
        if (!acc) return false;
        const isEnabled = acc.enabled !== false;
        card.dataset.enabled = String(isEnabled);
        card.dataset.streaming = String(Boolean(acc.isStreaming && isEnabled));
        card.dataset.active = String(Boolean(acc.isActive && isEnabled));
        card.dataset.status = acc.lastStatus || 'ready';

        const titleRow = card.querySelector('.router-node-title-row');
        applyRouterCardBadge(titleRow, acc);

        const reqCount = Number(acc.requestCount) || 0;
        const countEl = card.querySelector('.router-node-count');
        if (countEl) countEl.innerText = String(reqCount);
        const loadFill = card.querySelector('.router-node-loadbar > span');
        if (loadFill) {
          const pct = reqCount > 0 ? Math.max(8, Math.round((reqCount / maxReqCount) * 100)) : 5;
          loadFill.style.width = `${pct}%`;
        }
        const statusEl = card.querySelector('.router-node-status');
        if (statusEl) {
          statusEl.innerText = formatRouterAccountStatusText(acc);
          if (isEnabled && acc.lastStatus === 'rate_limited') statusEl.style.color = '#fcd34d';
          else if (isEnabled && acc.lastStatus === 'error') statusEl.style.color = '#fda4af';
          else statusEl.style.color = '';
        }
      }
      updateRouterCenterHubElement(document.getElementById('routerCenterHub'), data);
      drawRouterStarConnectors(true);
      renderRouterTelemetryDock(data);
      return true;
    }

    async function fetchMergedGeminiAccounts() {
      let primaryData = null;
      if (window.electronAPI && typeof window.electronAPI.listGeminiAccounts === 'function') {
        primaryData = await window.electronAPI.listGeminiAccounts();
      }
      let backendData = null;
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/accounts`);
        const json = await res.json();
        if (res.ok && json.success && Array.isArray(json.accounts)) {
          backendData = json;
        }
      } catch (_) {}

      const source = primaryData && Array.isArray(primaryData.accounts) ? primaryData : backendData;
      if (!source || !Array.isArray(source.accounts)) {
        throw new Error('មិនអាចអាន Gemini accounts បានទេ។');
      }

      if (primaryData && backendData) {
        const byId = new Map(backendData.accounts.map(a => [a.id, a]));
        const byHint = new Map(backendData.accounts.map(a => [a.keyHint, a]));
        source.streamingCount = backendData.streamingCount || 0;
        source.accounts = source.accounts.map(acc => {
          const tel = byId.get(acc.id) || byHint.get(acc.keyHint);
          return tel ? {
            ...acc,
            requestCount: tel.requestCount ?? acc.requestCount ?? 0,
            isStreaming: Boolean(tel.isStreaming),
            activeTask: tel.activeTask || '',
            lastStatus: tel.lastStatus || 'ready',
            cooldownRemainingMs: Number(tel.cooldownRemainingMs) || 0,
            lastLatencyMs: tel.lastLatencyMs || null,
            ewmaLatencyMs: tel.ewmaLatencyMs || null
          } : acc;
        });
      }
      return source;
    }

    function updateRouterSidebarNavBadge(accounts) {
      const badge = document.getElementById('routerSidebarBadge');
      if (!badge) return;
      const list = Array.isArray(accounts) ? accounts : [];
      if (list.length === 0) {
        badge.hidden = true;
        badge.innerText = '0';
        return;
      }
      badge.hidden = false;
      badge.innerText = String(list.length);
    }

    async function refreshGeminiAccounts(options = {}) {
      const list = document.getElementById('routerAccountsList');
      if (!list) return;
      if (!options.silent) {
        setRouterSidebarStatus('⏳ កំពុងផ្ទុក accounts...');
      }

      try {
        const data = await fetchMergedGeminiAccounts();
        updateRouterSidebarNavBadge(data.accounts);
        const sig = JSON.stringify(data.accounts.map(a => [a.id, a.name, a.email, a.isActive, a.enabled !== false]));

        if (options.silent && sig === routerTopologySignature && updateRouterTelemetryInPlace(data)) {
          setRouterSidebarStatus(
            data.streamingCount > 0
              ? `● កំពុងបកប្រែ (${data.streamingCount}) · ${data.accounts.length} Keys`
              : `✅ ${data.accounts.length} Keys រួចរាល់`
          );
          return;
        }
        routerTopologySignature = sig;

        list.replaceChildren();
        const stage = document.createElement('div');
        stage.className = 'router-star-stage';
        stage.id = 'routerStarStage';

        if (typeof document.createElementNS === 'function') {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', 'router-star-lines-svg');
          svg.id = 'routerStarLinesSvg';
          stage.appendChild(svg);
        }

        const leftWing = document.createElement('div');
        leftWing.className = 'router-wing-column left';

        const coreCol = document.createElement('div');
        coreCol.className = 'router-core-column';
        coreCol.appendChild(buildRouterCenterHubElement(data));

        const rightWing = document.createElement('div');
        rightWing.className = 'router-wing-column right';

        const palette = ['#38bdf8', '#10b981', '#a855f7', '#f59e0b', '#22d3ee', '#ec4899'];
        const maxReqCount = Math.max(1, ...data.accounts.map(a => Number(a && a.requestCount) || 0));

        data.accounts.forEach((acc, i) => {
          const side = i % 2 === 0 ? 'left' : 'right';
          const card = createRouterAccountCard(acc, palette[i % palette.length], maxReqCount, side);
          if (side === 'left') leftWing.appendChild(card);
          else rightWing.appendChild(card);
        });

        if (data.accounts.length === 0) {
          leftWing.appendChild(createRouterGhostActionCard('＋ បន្ថែម ១ Gemini Key', () => toggleRouterAddPanel(true)));
          rightWing.appendChild(createRouterGhostActionCard('📥 បិទភ្ជាប់ API Key ច្រើនព្រមគ្នា', () => toggleRouterBatchPanel(true)));
        } else if (data.accounts.length === 1) {
          rightWing.appendChild(createRouterGhostActionCard('＋ បន្ថែម Key ជំនួយ / បញ្ចូលច្រើន', () => toggleRouterBatchPanel(true)));
        }

        stage.appendChild(leftWing);
        stage.appendChild(coreCol);
        stage.appendChild(rightWing);
        list.appendChild(stage);
        renderRouterTelemetryDock(data);

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => drawRouterStarConnectors());
        } else {
          drawRouterStarConnectors();
        }
        if (typeof ResizeObserver === 'function') {
          if (routerStarResizeObserver) routerStarResizeObserver.disconnect();
          routerStarResizeObserver = new ResizeObserver(() => drawRouterStarConnectors());
          routerStarResizeObserver.observe(stage);
        }

        if (data.accounts.length === 0) {
          toggleRouterAddPanel(true);
        }

        setRouterSidebarStatus(
          data.streamingCount > 0
            ? `● កំពុងបកប្រែ (${data.streamingCount}) · ${data.accounts.length} Keys`
            : (data.accounts.length ? `✅ ${data.accounts.length} Keys រួចរាល់` : 'បន្ថែម Key ដើម្បីចាប់ផ្ដើម')
        );
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      }
    }

    async function toggleGeminiAccountEnabled(accountId, accountName, nextEnabled) {
      setRouterSidebarStatus(nextEnabled ? `▶️ កំពុងបើក ${accountName}...` : `⏸️ កំពុងផ្អាក ${accountName}...`);
      try {
        if (window.electronAPI && typeof window.electronAPI.updateGeminiAccount === 'function') {
          await window.electronAPI.updateGeminiAccount(accountId, { enabled: nextEnabled });
        } else {
          const res = await fetch(`${BACKEND_URL}/api/config/accounts/${encodeURIComponent(accountId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextEnabled })
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'មិនអាចប្ដូរស្ថានភាព Key បានទេ។');
          }
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts();
        const msg = nextEnabled ? `▶️ បានបើក ${accountName} វិញ` : `⏸️ បានផ្អាក ${accountName} បណ្ដោះអាសន្ន`;
        setRouterSidebarStatus(msg);
        showShortcutToast(msg);
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      }
    }

    async function submitBatchGeminiKeys(event) {
      event.preventDefault();
      const inputEl = document.getElementById('routerBatchInput');
      const autoTestEl = document.getElementById('routerBatchAutoTestCheck');
      const submitBtn = document.getElementById('routerBatchSubmitBtn');
      const rawText = inputEl ? String(inputEl.value || '').trim() : '';
      if (!rawText) return;

      if (submitBtn) submitBtn.disabled = true;
      setRouterSidebarStatus('📥 កំពុងបញ្ចូល API Key ច្រើនព្រមគ្នា...');
      try {
        let result = null;
        if (window.electronAPI && typeof window.electronAPI.batchAddGeminiAccounts === 'function') {
          result = await window.electronAPI.batchAddGeminiAccounts({ rawText });
        } else {
          const res = await fetch(`${BACKEND_URL}/api/config/accounts/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawText })
          });
          result = await res.json();
          if (!res.ok || !result.success) {
            throw new Error(result.error || 'មិនអាចបញ្ចូល Key បានទេ។');
          }
        }
        toggleRouterBatchPanel(false);
        routerTopologySignature = '';
        await refreshGeminiAccounts();
        const msg = `📥 បានបន្ថែម ${result.addedCount || 0} Key` +
          (result.skippedCount ? ` (រំលងស្ទួន ${result.skippedCount})` : '');
        setRouterSidebarStatus(msg);
        showShortcutToast(msg);

        if (autoTestEl && autoTestEl.checked && (result.addedCount || 0) > 0) {
          await testAllGeminiAccounts();
        }
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    async function testGeminiAccount(accountId, accountName) {
      setRouterSidebarStatus(`⚡ កំពុងតេស្ត ${accountName}...`);
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/accounts/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'មិនអាចតេស្ត Account បានទេ');
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts({ silent: true });
        if (data.healthy) {
          setRouterSidebarStatus(`✅ ${accountName} ដំណើរការល្អ (${data.latencyMs}ms)`);
          showShortcutToast(`⚡ ${accountName}: OK (${data.latencyMs}ms)`);
        } else {
          setRouterSidebarStatus(`⚠️ ${accountName}: ${data.error || 'មានបញ្ហា Quota'} (${data.latencyMs}ms)`, true);
          showShortcutToast(`⚠️ ${accountName}: ${data.error}`);
        }
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      }
    }

    async function syncRouterModelMode() {
      const localPreferred = loadSavedRouterModelMode();
      if (localPreferred) {
        routerAiModelMode = localPreferred;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/translation/router-mode`);
        const data = await res.json();
        if (res.ok && data && data.success && (data.mode === 'fast' || data.mode === 'smart')) {
          if (localPreferred && localPreferred !== data.mode) {
            const postRes = await fetch(`${BACKEND_URL}/api/translation/router-mode`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: localPreferred })
            });
            const postData = await postRes.json();
            if (postRes.ok && postData && postData.success && (postData.mode === 'fast' || postData.mode === 'smart')) {
              routerAiModelMode = postData.mode;
              saveRouterModelModeLocal(postData.mode);
              return;
            }
          }
          routerAiModelMode = data.mode;
          saveRouterModelModeLocal(data.mode);
        }
      } catch (_) {}
    }

    async function setRouterModelMode(mode) {
      const targetMode = mode === 'smart' ? 'smart' : 'fast';
      routerAiModelMode = targetMode;
      saveRouterModelModeLocal(targetMode);
      setRouterSidebarStatus(`🔀 កំពុងប្ដូរ AI Model Mode ទៅ ${targetMode === 'smart' ? '4-Hydrogen' : '3-Flash'}...`);
      try {
        const res = await fetch(`${BACKEND_URL}/api/translation/router-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: targetMode })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'មិនអាចប្ដូរ AI Model Mode បានទេ');
        }
        routerAiModelMode = data.mode;
        saveRouterModelModeLocal(data.mode);
        await refreshGeminiAccounts({ silent: true });
        const label = data.mode === 'smart'
          ? '🧪 4-Hydrogen (Smart Primary · thinking=low)'
          : '⚡ 3-Flash (Fast Primary)';
        setRouterSidebarStatus(`✅ កំពុងប្រើ ${label}`);
        showShortcutToast(`🔀 AI Mode: ${label}`);
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      }
    }

    async function testAllGeminiAccounts() {
      const btn = document.getElementById('routerTestAllBtn');
      if (btn) btn.disabled = true;
      setRouterSidebarStatus('⚡ កំពុងតេស្តគ្រប់ Gemini Account ព្រមគ្នា...');
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/accounts/test-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'មិនអាចតេស្ត Accounts ទាំងអស់បានទេ');
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts({ silent: true });
        const latList = (data.results || []).map(r => Number(r.latencyMs || 0)).filter(n => n > 0);
        const avgMs = latList.length > 0 ? Math.round(latList.reduce((a, b) => a + b, 0) / latList.length) : 0;
        const summary = `⚡ តេស្តរួចរាល់: ${data.healthyCount}/${data.totalCount} Ready${avgMs > 0 ? ` · មធ្យម ${formatRouterMs(avgMs)}` : ''}`;
        setRouterSidebarStatus(summary, data.healthyCount < data.totalCount);
        showShortcutToast(summary);
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function resetRouterCooldowns() {
      const btn = document.getElementById('routerResetCooldownBtn');
      if (btn) btn.disabled = true;
      setRouterSidebarStatus('🧹 កំពុងសម្អាតស្ថានភាព 429 Cooldown...');
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/accounts/reset-cooldown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'មិនអាចលាង 429 Cooldown បានទេ');
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts({ silent: true });
        setRouterSidebarStatus('✅ បានលាង 429 Cooldown គ្រប់ Account រួចរាល់');
        showShortcutToast('🧹 បានលាង 429 Cooldown រួចរាល់');
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function addGeminiAccount(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const accountId = String(formData.get('accountId') || '').trim();
      const isEdit = Boolean(accountId);
      const payload = {
        name: String(formData.get('name') || '').trim(),
        email: String(formData.get('email') || '').trim(),
        apiKey: String(formData.get('apiKey') || '').trim()
      };
      setRouterSidebarStatus(isEdit ? '⏳ កំពុងកែប្រែ account...' : '⏳ កំពុងរក្សាទុក account...');
      try {
        let savedData = null;
        if (isEdit) {
          const updates = { name: payload.name, email: payload.email };
          if (payload.apiKey) updates.apiKey = payload.apiKey;
          if (window.electronAPI && typeof window.electronAPI.updateGeminiAccount === 'function') {
            savedData = await window.electronAPI.updateGeminiAccount(accountId, updates);
          } else {
            const res = await fetch(`${BACKEND_URL}/api/config/accounts/${encodeURIComponent(accountId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updates)
            });
            savedData = await res.json();
            if (!res.ok || !savedData.success) {
              throw new Error(savedData.error || 'កែប្រែ Gemini account មិនបានទេ។');
            }
          }
        } else if (window.electronAPI && typeof window.electronAPI.addGeminiAccount === 'function') {
          savedData = await window.electronAPI.addGeminiAccount(payload);
        } else {
          const res = await fetch(`${BACKEND_URL}/api/config/accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          savedData = await res.json();
          if (!res.ok || !savedData.success) {
            throw new Error(savedData.error || 'រក្សាទុក Gemini account មិនបានទេ។');
          }
        }
        form.reset();
        toggleRouterAddPanel(false);
        routerTopologySignature = '';
        await refreshGeminiAccounts();

        const createdAcc = !isEdit && savedData && Array.isArray(savedData.accounts)
          ? (savedData.accounts.find(a => a.id === savedData.activeAccountId) || savedData.accounts[savedData.accounts.length - 1])
          : null;
        const probeId = isEdit ? (payload.apiKey ? accountId : '') : (createdAcc && createdAcc.id);
        let probeNote = '';
        if (probeId && typeof fetch === 'function') {
          try {
            const probeRes = await fetch(`${BACKEND_URL}/api/config/accounts/test`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: probeId })
            });
            const probeJson = await probeRes.json();
            if (probeRes.ok && probeJson.success) {
              await refreshGeminiAccounts({ silent: true });
              probeNote = probeJson.healthy
                ? ` · ⚡ OK (${probeJson.latencyMs}ms)`
                : ` · ⚠️ ${probeJson.error || 'Error'}`;
            }
          } catch (_) {}
        }

        const msg = (isEdit ? '✅ បានកែប្រែ Account: ' : '✅ បានបន្ថែម Account: ') + payload.name + probeNote;
        setRouterSidebarStatus(msg);
        showShortcutToast(msg);
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      }
    }

    async function switchGeminiAccount(accountId) {
      setRouterSidebarStatus('🔀 កំពុងប្ដូរ account...');
      try {
        if (window.electronAPI && typeof window.electronAPI.switchGeminiAccount === 'function') {
          await window.electronAPI.switchGeminiAccount(accountId);
        } else {
          const res = await fetch(`${BACKEND_URL}/api/config/accounts/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId })
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'ប្ដូរ Gemini account មិនបានទេ។');
          }
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts();
        setRouterSidebarStatus('✅ បានប្ដូរ Gemini account សកម្មរួចរាល់។');
        showShortcutToast('🔀 បានប្ដូរ Gemini Account');
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      }
    }

    async function deleteGeminiAccount(accountId, accountName) {
      if (!confirm(`តើអ្នកចង់លុប account "${accountName}" មែនទេ?`)) return;
      setRouterSidebarStatus('⏳ កំពុងលុប account...');
      try {
        if (window.electronAPI && typeof window.electronAPI.deleteGeminiAccount === 'function') {
          await window.electronAPI.deleteGeminiAccount(accountId);
        } else {
          const res = await fetch(`${BACKEND_URL}/api/config/accounts/${encodeURIComponent(accountId)}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'លុប Gemini account មិនបានទេ។');
          }
        }
        routerTopologySignature = '';
        await refreshGeminiAccounts();
        setRouterSidebarStatus('បានលុប Gemini account រួចរាល់។');
      } catch (error) {
        setRouterSidebarStatus(error.message, true);
      }
    }

    // ==================== MULTI-VIDEO BATCH MANAGER ====================
    let vmQueue = [];
    let vmIsRunning = false;
    let vmAbortRequested = false;
    let vmNextItemId = 1;
    let vmConfigInitialized = false;
    let vmExportChain = Promise.resolve();

    function extractFileName(filePath) {
      if (!filePath) return '';
      const parts = String(filePath).split(/[\\/]/);
      return parts[parts.length - 1] || String(filePath);
    }

    function normalizePathKey(p) {
      return String(p || '').trim().toLowerCase().replace(/\//g, '\\');
    }

    const KM_LEAKED_SCRIPT_RE = /[\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u31A0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFEF\u0E00-\u109F\u{20000}-\u{2FA1F}]/u;

    function countIncompleteCues(cues, targetLang) {
      if (!Array.isArray(cues) || cues.length === 0) return 0;
      const target = String(targetLang || 'km').trim().toLowerCase();
      let untranslated = 0;
      for (let i = 0; i < cues.length; i++) {
        const orig = String(cues[i].text || '').trim();
        if (!orig) continue;
        const trans = String(cues[i].translated || '').trim();
        const numericOnly = /^[\d\s.,!?\-'"()…]+$/.test(orig);
        if (!trans || (trans === orig && !numericOnly)) {
          untranslated++;
        } else if (target === 'km' && (!/[\u1780-\u17FF]/.test(trans) || KM_LEAKED_SCRIPT_RE.test(trans))) {
          if (!(numericOnly && trans === orig)) untranslated++;
        }
      }
      return untranslated;
    }

    function cuesNeedTranslation(cues, targetLang) {
      return countIncompleteCues(cues, targetLang) > 0;
    }

    function updateVideoManagerTopBadge() {
      const badge = document.getElementById('vmTopBadge');
      if (!badge) return;
      const total = vmQueue.length;
      const done = vmQueue.filter(item => item.status === 'done').length;
      const running = vmQueue.filter(item => item.status === 'running').length;
      if (total === 0) {
        badge.hidden = true;
        badge.innerText = '0';
        return;
      }
      badge.hidden = false;
      badge.innerText = vmIsRunning ? `${done}/${total} ⚡${running}` : `${done}/${total}`;
    }

    function updateVideoManagerProgressUi() {
      const summaryEl = document.getElementById('vmProgressSummary');
      const countEl = document.getElementById('vmProgressCount');
      const fillEl = document.getElementById('vmProgressFill');
      const startBtn = document.getElementById('btnVmStart');
      const stopBtn = document.getElementById('btnVmStop');

      const total = vmQueue.length;
      const selected = vmQueue.filter(item => item.selected).length;
      const done = vmQueue.filter(item => item.status === 'done').length;
      const running = vmQueue.filter(item => item.status === 'running').length;
      const errored = vmQueue.filter(item => item.status === 'error').length;

      let pct = 0;
      if (total > 0) {
        const sum = vmQueue.reduce((acc, item) => acc + (Number(item.progress) || 0), 0);
        pct = Math.max(0, Math.min(100, Math.round(sum / total)));
      }

      if (countEl) countEl.innerText = `${done} / ${total}`;
      if (fillEl) fillEl.style.width = `${pct}%`;

      if (summaryEl) {
        if (total === 0) {
          summaryEl.innerText = 'ជ្រើសវីដេអូ ឬ Folder ដើម្បីចាប់ផ្ដើម Auto បកប្រែ + សំឡេងច្រើនព្រមគ្នា';
        } else if (vmIsRunning) {
          summaryEl.innerText = `⚡ កំពុងដំណើរការព្រមគ្នា ${running} វីដេអូ · រួចរាល់ ${done}/${total}` + (errored ? ` · បរាជ័យ ${errored}` : '');
        } else if (done === total && total > 0) {
          summaryEl.innerText = `✅ បានបញ្ចប់គ្រប់ ${done} វីដេអូ! ចុច 📂 បើក លើវីដេអូណាមួយដើម្បីស្ដាប់ និង Export។`;
        } else {
          summaryEl.innerText = `ក្នុងបញ្ជី ${total} វីដេអូ (ធីក ${selected}) · រួចរាល់ ${done}` + (errored ? ` · បរាជ័យ ${errored}` : '');
        }
      }

      if (startBtn) {
        startBtn.disabled = vmIsRunning || selected === 0;
        startBtn.innerText = vmIsRunning ? '⚡ កំពុងដំណើរការ...' : '🚀 ចាប់ផ្ដើម Auto ទាំងអស់';
      }
      if (stopBtn) {
        stopBtn.style.display = vmIsRunning ? 'inline-flex' : 'none';
      }
      updateVideoManagerTopBadge();
    }

    function renderVideoManagerQueue() {
      const container = document.getElementById('vmQueueContainer');
      if (!container) {
        updateVideoManagerTopBadge();
        return;
      }

      if (vmQueue.length === 0) {
        container.innerHTML = '<div class="vm-empty">មិនទាន់មានវីដេអូក្នុងបញ្ជីទេ។ ចុច "🎬 បន្ថែមវីដេអូច្រើន" ឬ "📁 ផ្ទុកពី Folder" ខាងលើ។</div>';
        updateVideoManagerProgressUi();
        return;
      }

      container.innerHTML = vmQueue.map((item, idx) => {
        const safeName = escapeHtml(item.name || `Video ${idx + 1}`);
        const epTag = item.ep ? `<span class="vm-pill">${escapeHtml(item.ep)}</span>` : '';
        const srtTag = item.srtPath
          ? '<span class="vm-pill done">SRT ✓</span>'
          : '<span class="vm-pill warn">AI Speech</span>';
        const cueTag = Array.isArray(item.cues) && item.cues.length > 0
          ? `<span class="vm-pill done">${item.cues.length} បន្ទាត់</span>`
          : (item.draftInfo && item.draftInfo.cueCount
            ? `<span class="vm-pill">Draft ${item.draftInfo.cueCount}</span>`
            : '');
        const dubTag = item.dubReady
          ? '<span class="vm-pill done">🔊 Dub Ready</span>'
          : '';
        const exportBtn = item.exportUrl
          ? `<a class="btn-mini" href="${escapeHtml(resolveBackendUrl(item.exportUrl))}" download title="ទាញយក MP4">⬇️ MP4</a>`
          : '';
        const openDisabled = (!item.videoPath && !(Array.isArray(item.cues) && item.cues.length)) ? ' disabled' : '';
        const removeDisabled = item.status === 'running' ? ' disabled' : '';
        const checkedAttr = item.selected ? ' checked' : '';
        const pct = Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0)));

        return `<div class="vm-row" data-status="${escapeHtml(item.status || 'pending')}">`
          + `<input type="checkbox"${checkedAttr} onchange="toggleVideoManagerItemSelect(${item.id}, this.checked)" ${vmIsRunning && item.status === 'running' ? 'disabled' : ''}>`
          + `<div style="min-width:0;">`
            + `<div class="vm-row-name" title="${safeName}">${idx + 1}. ${safeName}</div>`
            + `<div class="vm-row-meta">${epTag}${srtTag}${cueTag}${dubTag}</div>`
          + `</div>`
          + `<div class="vm-row-status">`
            + `<div class="vm-status-text" title="${escapeHtml(item.error || item.stageText || '')}">${escapeHtml(item.error ? ('❌ ' + item.error) : (item.stageText || 'រង់ចាំ Auto'))}</div>`
            + `<div class="vm-mini-bar"><div class="vm-mini-bar-fill" style="width:${pct}%;"></div></div>`
          + `</div>`
          + `<div class="vm-row-actions">`
            + exportBtn
            + `<button type="button" class="btn-mini" onclick="openVideoManagerItemInStudio(${item.id})"${openDisabled} title="បើកក្នុង Studio ដើម្បីមើល & Export">📂 បើក</button>`
            + `<button type="button" class="btn-mini" onclick="removeVideoManagerItem(${item.id})"${removeDisabled} title="ដកចេញ">✕</button>`
          + `</div>`
        + `</div>`;
      }).join('');

      updateVideoManagerProgressUi();
    }

    // ==================== UNIFIED SIDEBAR NAVIGATION & ADMIN ROUTER LOCK ====================
    let currentAppView = 'studio';
    const ROUTER_USER_LOCKED_STORAGE_KEY = 'eza_router_user_locked';
    const ROUTER_ADMIN_PIN_STORAGE_KEY = 'eza_router_admin_pin';
    const DEFAULT_ROUTER_ADMIN_PIN = '1688';
    let routerUserLockedState = false;
    let routerAdminPinState = DEFAULT_ROUTER_ADMIN_PIN;
    let brandBadgeTapCount = 0;
    let brandBadgeTapTimer = null;

    function isRouterLockedForUsers() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const val = localStorage.getItem(ROUTER_USER_LOCKED_STORAGE_KEY);
          if (val === '1' || val === '0') {
            routerUserLockedState = val === '1';
          }
        }
      } catch (_) {}
      return Boolean(routerUserLockedState);
    }

    function getRouterAdminPin() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const saved = String(localStorage.getItem(ROUTER_ADMIN_PIN_STORAGE_KEY) || '').trim();
          if (saved) routerAdminPinState = saved;
        }
      } catch (_) {}
      return routerAdminPinState || DEFAULT_ROUTER_ADMIN_PIN;
    }

    function syncRouterLockUi() {
      const locked = isRouterLockedForUsers();
      const navBtn = document.getElementById('navBtnRouter');
      if (navBtn) {
        navBtn.hidden = locked;
        if (navBtn.style) navBtn.style.display = locked ? 'none' : '';
      }
      const lockBtn = document.getElementById('routerLockUserBtn');
      if (lockBtn) {
        lockBtn.innerText = locked ? '🔓 បើកបង្ហាញ Router' : '🔒 លាក់ពី User';
      }
    }

    function setMobileStudioMode(mode = 'split') {
      const normalized = (mode === 'script' || mode === 'player') ? mode : 'split';
      const pane = document.getElementById('studioViewPane');
      if (pane && typeof pane.setAttribute === 'function') {
        pane.setAttribute('data-mobile-mode', normalized);
      }
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('#mobileStudioModeBar .mobile-studio-tab').forEach(btn => {
          const btnMode = typeof btn.getAttribute === 'function' ? btn.getAttribute('data-mobile-mode') : '';
          if (btn.classList && typeof btn.classList.toggle === 'function') {
            btn.classList.toggle('active', btnMode === normalized);
          }
        });
      }
      return normalized;
    }

    function lockRouterForUserMode(customPin = '') {
      let pin = String(customPin || '').trim();
      if (!pin && typeof prompt === 'function') {
        const currentPin = getRouterAdminPin();
        const entered = prompt('🔒 កំណត់លេខកូដ Admin PIN សម្រាប់បើក Router វិញ (ចុច OK ដើម្បីប្រើលេខកូដនេះ)៖', currentPin);
        if (entered === null) return false;
        pin = String(entered || '').trim() || currentPin;
      }
      if (!pin) pin = getRouterAdminPin();
      routerAdminPinState = pin;
      routerUserLockedState = true;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_ADMIN_PIN_STORAGE_KEY, pin);
          localStorage.setItem(ROUTER_USER_LOCKED_STORAGE_KEY, '1');
        }
      } catch (_) {}
      syncRouterLockUi();
      switchAppView('studio');
      showShortcutToast('🔒 បានលាក់ផ្ទាំង Router ពី User (ចុចផ្លាក PRO ៥ ដង ឬ Ctrl+Shift+R ដើម្បីបើកវិញ)');
      return true;
    }

    async function unlockRouterAdminMode(providedPin = '') {
      const expectedPin = getRouterAdminPin();
      let entered = String(providedPin || '').trim();
      if (!entered && typeof prompt === 'function') {
        const raw = prompt('🔑 បញ្ចូលលេខកូដ Admin PIN ដើម្បីបើកគ្រប់គ្រង Router Manager៖', '');
        if (raw === null) return false;
        entered = String(raw || '').trim();
      }
      if (entered !== expectedPin) {
        showShortcutToast('❌ លេខកូដ Admin PIN មិនត្រឹមត្រូវទេ');
        return false;
      }
      routerUserLockedState = false;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_USER_LOCKED_STORAGE_KEY, '0');
        }
      } catch (_) {}
      syncRouterLockUi();
      showShortcutToast('🔓 បានបើកសិទ្ធិ Admin Router Manager');
      await switchAppView('router');
      return true;
    }

    function handleBrandBadgeTap(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      brandBadgeTapCount += 1;
      if (brandBadgeTapTimer) clearTimeout(brandBadgeTapTimer);
      if (brandBadgeTapCount >= 5) {
        brandBadgeTapCount = 0;
        if (isRouterLockedForUsers()) {
          unlockRouterAdminMode();
        } else {
          switchAppView('router');
        }
        return;
      }
      brandBadgeTapTimer = setTimeout(() => {
        brandBadgeTapCount = 0;
      }, 2200);
    }

    function setActiveSidebarNav(viewName) {
      const navMap = [
        ['navBtnStudio', 'studio'],
        ['navBtnVideoManager', 'video-manager'],
        ['navBtnRouter', 'router']
      ];
      for (const [elId, target] of navMap) {
        const btn = document.getElementById(elId);
        if (btn && btn.classList && typeof btn.classList.toggle === 'function') {
          btn.classList.toggle('active', viewName === target);
        }
      }
    }

    function toggleAppSidebar(forceCollapsed) {
      const sidebar = document.getElementById('appSidebar');
      const toggleBtn = document.getElementById('appSidebarToggleBtn');
      if (!sidebar) return;
      const nextCollapsed = typeof forceCollapsed === 'boolean'
        ? forceCollapsed
        : !sidebar.classList.contains('collapsed');
      sidebar.classList.toggle('collapsed', nextCollapsed);
      if (toggleBtn) {
        toggleBtn.innerText = nextCollapsed ? '▶' : '◀';
        toggleBtn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
      }
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('eza_sidebar_collapsed', nextCollapsed ? '1' : '0');
        }
      } catch (_) {}
      if (currentAppView === 'router') {
        setTimeout(drawRouterStarConnectors, 220);
      }
    }

    async function switchAppView(viewName = 'studio') {
      const target = viewName === 'video-manager' || viewName === 'router' ? viewName : 'studio';
      if (target === 'router') {
        if (isRouterLockedForUsers()) {
          await unlockRouterAdminMode();
          return;
        }
        await openRouterSidebar();
        return;
      }
      if (target === 'video-manager') {
        openVideoManagerModal();
        return;
      }
      stopRouterPolling();
      const routerPane = document.getElementById('routerSidebar');
      const routerAdd = document.getElementById('routerAddPanel');
      const vmPane = document.getElementById('videoManagerModal');
      const studioPane = document.getElementById('studioViewPane');
      if (routerPane) routerPane.hidden = true;
      if (routerAdd) routerAdd.hidden = true;
      if (vmPane && vmPane.style) vmPane.style.display = 'none';
      if (studioPane && studioPane.style) studioPane.style.display = 'flex';
      currentAppView = 'studio';
      setActiveSidebarNav('studio');
    }

    function openVideoManagerModal() {
      const modal = document.getElementById('videoManagerModal');
      if (!modal) return;
      stopRouterPolling();
      const routerPane = document.getElementById('routerSidebar');
      const studioPane = document.getElementById('studioViewPane');
      if (routerPane) routerPane.hidden = true;
      if (studioPane && studioPane.style) studioPane.style.display = 'none';

      if (!vmConfigInitialized) {
        vmConfigInitialized = true;
        const srcEl = document.getElementById('sourceLangSelect');
        const vmSrc = document.getElementById('vmSourceLangSelect');
        const vmVoice = document.getElementById('vmDefaultVoiceSelect');
        if (srcEl && vmSrc) vmSrc.value = srcEl.value || 'auto';
        if (vmVoice) {
          const singleChoice = getSelectedSingleVoice();
          vmVoice.innerHTML = renderVoiceOptionsHtml(singleChoice);
          vmVoice.value = singleChoice;
        }
      }
      renderVideoManagerQueue();
      updateExportOutputDirDisplay();
      modal.style.display = 'flex';
      currentAppView = 'video-manager';
      setActiveSidebarNav('video-manager');
    }

    function closeVideoManagerModal() {
      const modal = document.getElementById('videoManagerModal');
      const studioPane = document.getElementById('studioViewPane');
      if (modal && modal.style) modal.style.display = 'none';
      if (studioPane && studioPane.style && currentAppView !== 'router') {
        studioPane.style.display = 'flex';
      }
      if (currentAppView === 'video-manager') {
        currentAppView = 'studio';
        setActiveSidebarNav('studio');
      }
    }

    function toggleVideoManagerItemSelect(itemId, checked) {
      const item = vmQueue.find(entry => entry.id === itemId);
      if (!item) return;
      item.selected = Boolean(checked);
      updateVideoManagerProgressUi();
    }

    function toggleSelectAllVideoManager() {
      if (vmQueue.length === 0) return;
      const allSelected = vmQueue.every(item => item.selected);
      const next = !allSelected;
      vmQueue.forEach(item => {
        if (item.status !== 'running') item.selected = next;
      });
      renderVideoManagerQueue();
    }

    function removeVideoManagerItem(itemId) {
      const idx = vmQueue.findIndex(item => item.id === itemId);
      if (idx === -1) return;
      if (vmQueue[idx].status === 'running') return;
      vmQueue.splice(idx, 1);
      renderVideoManagerQueue();
    }

    function clearVideoManagerQueue() {
      if (vmIsRunning) {
        showShortcutToast('⚠️ សូមចុច "⏹️ បញ្ឈប់" មុនពេលលាងបញ្ជី!');
        return;
      }
      vmQueue = [];
      renderVideoManagerQueue();
    }

    function appendBatchItems(rawItems) {
      if (!Array.isArray(rawItems) || rawItems.length === 0) return 0;
      const existingPaths = new Set(vmQueue.map(item => normalizePathKey(item.videoPath)).filter(Boolean));
      let added = 0;

      for (const raw of rawItems) {
        if (!raw) continue;
        const videoPath = String(raw.videoPath || '').trim();
        const key = normalizePathKey(videoPath);
        if (key && existingPaths.has(key)) continue;
        if (key) existingPaths.add(key);

        const srtPath = String(raw.srtPath || '').trim();
        const draftInfo = raw.draftInfo || null;
        vmQueue.push({
          id: vmNextItemId++,
          selected: true,
          name: String(raw.videoName || raw.name || extractFileName(videoPath) || 'Video'),
          ep: String(raw.ep || ''),
          videoPath,
          srtPath,
          fileObj: raw.fileObj || null,
          cues: Array.isArray(raw.cues) ? raw.cues : [],
          draftInfo,
          status: 'pending',
          stageText: srtPath ? 'រកឃើញ .srt · រង់ចាំ Auto' : 'រង់ចាំ AI Transcribe + Auto',
          progress: 0,
          error: '',
          bgmUrl: '',
          exportUrl: '',
          dubReady: false
        });
        added++;
      }

      vmQueue.sort((a, b) => String(a.ep || a.name).localeCompare(String(b.ep || b.name), undefined, { numeric: true, sensitivity: 'base' }));
      renderVideoManagerQueue();
      return added;
    }

    async function addVideoPathsToManager(filePaths) {
      const cleaned = Array.isArray(filePaths)
        ? filePaths.map(p => String(p || '').trim()).filter(Boolean)
        : [];
      if (cleaned.length === 0) return 0;

      try {
        const res = await fetch(`${BACKEND_URL}/api/inspect-videos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: cleaned })
        });
        const data = await res.json();
        if (res.ok && data && data.success && Array.isArray(data.items)) {
          return appendBatchItems(data.items);
        }
      } catch (err) {
        console.warn('[VideoManager] /api/inspect-videos fallback:', err.message);
      }

      return appendBatchItems(cleaned.map(videoPath => ({
        videoPath,
        videoName: extractFileName(videoPath),
        srtPath: '',
        draftInfo: null
      })));
    }

    async function pickBatchVideoFiles() {
      if (isMobileOrRemoteClient()) {
        const fileInput = document.getElementById('batchVideoFilesInput');
        if (fileInput) fileInput.click();
        return;
      }
      try {
        if (window.electronAPI && typeof window.electronAPI.openFilesDialog === 'function') {
          const paths = await window.electronAPI.openFilesDialog();
          if (Array.isArray(paths) && paths.length > 0) {
            const added = await addVideoPathsToManager(paths);
            showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
          }
          return;
        }
        const res = await fetch(`${BACKEND_URL}/api/browse-files?type=video`);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.selected) && data.selected.length > 0) {
            const added = await addVideoPathsToManager(data.selected);
            showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
            return;
          }
          if (data && data.success) return;
        }
      } catch (err) {
        console.warn('[VideoManager] Native multi-file dialog fallback:', err.message);
      }

      const fileInput = document.getElementById('batchVideoFilesInput');
      if (fileInput) fileInput.click();
    }

    async function handleBatchVideoUpload(event) {
      const files = Array.from(event?.target?.files || []);
      if (event?.target) event.target.value = '';
      if (files.length === 0) return;

      const diskPaths = [];
      const uploadItems = [];
      for (const file of files) {
        const diskPath = typeof file.path === 'string' && file.path ? file.path.trim() : '';
        if (diskPath) {
          diskPaths.push(diskPath);
        } else {
          uploadItems.push({
            videoName: file.name,
            videoPath: '',
            srtPath: '',
            fileObj: file
          });
        }
      }

      let added = 0;
      if (diskPaths.length > 0) added += await addVideoPathsToManager(diskPaths);
      if (uploadItems.length > 0) added += appendBatchItems(uploadItems);
      if (added > 0) {
        showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
      }
    }

    async function pickBatchVideoFolder() {
      try {
        let selectedFolder = null;
        if (window.electronAPI && typeof window.electronAPI.openFolderDialog === 'function') {
          selectedFolder = await window.electronAPI.openFolderDialog();
        } else {
          const res = await fetch(`${BACKEND_URL}/api/browse-folder`);
          const data = await res.json();
          selectedFolder = data.selected || null;
        }
        if (!selectedFolder) return;

        const scanRes = await fetch(`${BACKEND_URL}/api/scan-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: selectedFolder })
        });
        const drama = await scanRes.json();
        const episodes = Array.isArray(drama?.episodes) ? drama.episodes.filter(ep => ep.videoPath) : [];
        if (episodes.length === 0) {
          showShortcutToast('⚠️ មិនឃើញឯកសារវីដេអូក្នុង Folder នេះទេ។');
          return;
        }
        const added = appendBatchItems(episodes.map(ep => ({
          ep: ep.ep || '',
          name: ep.video || ep.name || extractFileName(ep.videoPath),
          videoPath: ep.videoPath,
          srtPath: ep.srtPath || ''
        })));
        showShortcutToast(`📁 បានបន្ថែម ${added} វីដេអូពី "${drama.name || selectedFolder}"`);
      } catch (err) {
        showShortcutToast('❌ មិនអាចស្កេន Folder បានទេ៖ ' + err.message);
      }
    }

    async function loadCurrentDramaIntoVideoManager() {
      const episodes = Array.isArray(currentDramaInfo?.episodes)
        ? currentDramaInfo.episodes.filter(ep => ep.videoPath)
        : [];
      if (episodes.length > 0) {
        const added = appendBatchItems(episodes.map(ep => ({
          ep: ep.ep || '',
          name: ep.video || ep.name || extractFileName(ep.videoPath),
          videoPath: ep.videoPath,
          srtPath: ep.srtPath || ''
        })));
        showShortcutToast(`📂 បានផ្ទុក ${added} ភាគពីរឿងបច្ចុប្បន្ន`);
        return;
      }
      if (currentVideoPath) {
        const added = await addVideoPathsToManager([currentVideoPath]);
        const target = vmQueue.find(item => normalizePathKey(item.videoPath) === normalizePathKey(currentVideoPath));
        if (target) {
          if (currentSrtPath && !target.srtPath) target.srtPath = currentSrtPath;
          if (Array.isArray(activeCues) && activeCues.length > 0) target.cues = activeCues.map(c => ({ ...c }));
        }
        renderVideoManagerQueue();
        if (added > 0) showShortcutToast('📂 បានបន្ថែមវីដេអូបច្ចុប្បន្ន');
        return;
      }
      showShortcutToast('⚠️ មិនទាន់មានរឿង ឬវីដេអូកំពុងបើកទេ។ សូមជ្រើសវីដេអូ ឬ Folder!');
    }

    function readVideoManagerConfig() {
      const sourceLang = document.getElementById('vmSourceLangSelect')?.value || 'auto';
      const targetLang = document.getElementById('vmTargetLangSelect')?.value || 'km';
      const ttsEngine = 'edge';
      const castMode = 'single';
      const fixedVoice = normalizeVoicePresetId(document.getElementById('vmDefaultVoiceSelect')?.value || getSelectedSingleVoice());
      const concurrency = Math.max(1, Math.min(6, parseInt(document.getElementById('vmConcurrencySelect')?.value || '4', 10) || 4));
      const generateTts = document.getElementById('vmGenerateTtsCheck')?.checked !== false;
      const saveDraft = document.getElementById('vmSaveDraftCheck')?.checked !== false;
      const isolateBgm = Boolean(document.getElementById('vmIsolateBgmCheck')?.checked);
      const autoExport = Boolean(document.getElementById('vmAutoExportCheck')?.checked);
      return { sourceLang, targetLang, ttsEngine, castMode, fixedVoice, concurrency, generateTts, saveDraft, isolateBgm, autoExport };
    }

    function stopVideoManagerBatch() {
      if (!vmIsRunning) return;
      vmAbortRequested = true;
      showShortcutToast('⏹️ កំពុងស្នើសុំបញ្ឈប់ក្រោយបញ្ចប់ជំហានបច្ចុប្បន្ន...');
    }

    async function openVideoManagerItemInStudio(itemId) {
      const item = vmQueue.find(entry => entry.id === itemId);
      if (!item) return;

      let loadedCues = Array.isArray(item.cues) && item.cues.length > 0 ? item.cues.map(c => ({ ...c })) : [];
      if (loadedCues.length === 0 && item.srtPath) {
        try {
          const res = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: item.srtPath })
          });
          const data = await res.json();
          if (res.ok && data.success && Array.isArray(data.cues)) {
            loadedCues = data.cues;
          }
        } catch (err) {
          console.warn('[VideoManager] Open cue load failed:', err.message);
        }
      }

      if (currentDramaInfo && Array.isArray(currentDramaInfo.episodes)) {
        const matchedEp = currentDramaInfo.episodes.find(ep => normalizePathKey(ep.videoPath) === normalizePathKey(item.videoPath));
        if (matchedEp) {
          loadDramaData(currentDramaInfo, matchedEp, loadedCues);
          closeVideoManagerModal();
          return;
        }
      }

      clearDubAndPlaybackState();
      currentVideoPath = item.videoPath || '';
      currentSrtPath = item.srtPath || '';
      currentDramaInfo = null;
      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(currentVideoPath)}`);
      }
      activeCues = normalizeCuesTiming(loadedCues);
      normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
      const titleTag = document.getElementById('currentDramaTitleTag');
      const trackTitle = document.getElementById('videoTrackTitle');
      if (titleTag) titleTag.innerText = item.name || extractFileName(currentVideoPath);
      if (trackTitle) trackTitle.innerText = item.name || extractFileName(currentVideoPath);
      renderTable();
      checkAllAudioCache();
      updateTranslationState();
      closeVideoManagerModal();
    }

    function patchVmRow(item, stageText, progress, status = 'running') {
      item.status = status;
      if (stageText !== undefined) item.stageText = stageText;
      if (typeof progress === 'number') item.progress = progress;
      renderVideoManagerQueue();
    }

    async function processVideoManagerItem(item, config) {
      const checkAbort = () => {
        if (vmAbortRequested) throw new Error('បានបញ្ឈប់ដោយអ្នកប្រើ');
      };

      item.error = '';
      patchVmRow(item, '⏳ កំពុងចាប់ផ្ដើម...', 6, 'running');
      checkAbort();

      if (!item.videoPath && item.fileObj) {
        patchVmRow(item, '⬆️ កំពុងផ្ទុកវីដេអូទៅ Server...', 12);
        const upRes = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(item.fileObj.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: item.fileObj
        });
        const upData = await upRes.json();
        if (!upRes.ok || !upData.success || !upData.filePath) {
          throw new Error(upData.error || 'Upload វីដេអូបរាជ័យ');
        }
        item.videoPath = upData.filePath;
      }

      if (!item.videoPath) {
        throw new Error('មិនមានទីតាំងវីដេអូ');
      }

      const bgmPromise = config.isolateBgm
        ? fetch(`${BACKEND_URL}/api/audio/isolate-bgm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: item.videoPath })
        }).then(r => r.json()).catch(() => null)
        : Promise.resolve(null);

      let cues = Array.isArray(item.cues) && item.cues.length > 0 ? item.cues.map(c => ({ ...c })) : [];

      if (cues.length === 0 && item.srtPath) {
        patchVmRow(item, '📄 កំពុងអាន SRT...', 22);
        const srtRes = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: item.srtPath })
        });
        const srtData = await srtRes.json();
        if (srtRes.ok && srtData.success && Array.isArray(srtData.cues) && srtData.cues.length > 0) {
          cues = normalizeCuesTiming(srtData.cues);
        }
      }

      checkAbort();

      if (cues.length === 0) {
        patchVmRow(item, '🎙️ AI កំពុងស្តាប់សំឡេង & កាត់បន្ទាត់...', 28);
        const { res: speechRes, data: speechData } = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/auto-detect-speech`,
          {
            videoPath: item.videoPath,
            sourceLang: config.sourceLang,
            isolateVocals: true,
            castMode: config.castMode,
            fixedVoice: config.fixedVoice
          },
          { maxRetries: 4, retryDelayMs: 3500 }
        );
        if (!speechRes.ok || !speechData.success || !Array.isArray(speechData.cues) || speechData.cues.length === 0) {
          throw new Error(speechData.error || 'AI មិនអាចចាប់សំឡេងក្នុងវីដេអូនេះបានទេ');
        }
        cues = normalizeCuesTiming(speechData.cues);
      }

      item.cues = cues;
      checkAbort();

      if (cuesNeedTranslation(cues, config.targetLang)) {
        patchVmRow(item, `🌐 កំពុងបកប្រែ (${cues.length} បន្ទាត់)...`, 50);
        const { res: trRes, data: trData } = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/translate-cues`,
          {
            cues,
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            videoPath: item.videoPath,
            castMode: config.castMode,
            fixedVoice: config.fixedVoice
          },
          { maxRetries: 5, retryDelayMs: 3500 }
        );
        if (!trRes.ok || !trData.success || !Array.isArray(trData.cues)) {
          throw new Error(trData.error || 'បកប្រែបរាជ័យ');
        }
        cues = normalizeCuesTiming(trData.cues);
        const leftoverLeaks = countIncompleteCues(cues, config.targetLang);
        if (leftoverLeaks > 0) {
          patchVmRow(item, `🔁 កំពុងបកប្រែបន្ថែម ${leftoverLeaks} បន្ទាត់សេសសល់...`, 56);
          const { res: rescueRes, data: rescueData } = await postJsonWithTunnelRecovery(
            `${BACKEND_URL}/api/translation/translate-cues`,
            {
              cues,
              sourceLang: config.sourceLang,
              targetLang: config.targetLang,
              useCache: false,
              force: false,
              videoPath: item.videoPath,
              castMode: config.castMode,
              fixedVoice: config.fixedVoice
            },
            { maxRetries: 3, retryDelayMs: 3000 }
          ).catch(() => ({ res: { ok: false }, data: null }));
          if (rescueRes.ok && rescueData && rescueData.success && Array.isArray(rescueData.cues)) {
            cues = normalizeCuesTiming(rescueData.cues);
          }
          const finalLeaks = countIncompleteCues(cues, config.targetLang);
          if (finalLeaks > 0) {
            item.cues = cues;
            throw new Error(`នៅសល់ ${finalLeaks} បន្ទាត់មិនទាន់បកប្រែអស់ (អាចមកពី API quota ឬបណ្ដាញ)`);
          }
        }
      } else if (config.castMode === 'single') {
        normalizeActiveCuesForCastMode(cues, 'single', config.fixedVoice);
      } else {
        const noVoiceCast = cues.every(c => !c.voice || c.voice === 'Sovereign King' || c.voice === 'km-KH-PisethNeural');
        if (noVoiceCast && cues.length > 0) {
          patchVmRow(item, '🎭 កំពុងបែងចែកសំឡេងតួអង្គ...', 55);
          try {
            const castRes = await fetch(`${BACKEND_URL}/api/translation/auto-cast-voices`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cues, force: false, videoPath: item.videoPath, castMode: config.castMode })
            });
            const castData = await castRes.json();
            if (castRes.ok && castData.success && Array.isArray(castData.cues)) {
              cues = normalizeCuesTiming(castData.cues);
            }
          } catch (_) {}
        }
      }

      normalizeActiveCuesForCastMode(cues, config.castMode, config.fixedVoice);
      item.cues = cues;
      checkAbort();

      if (config.generateTts && cues.length > 0) {
        const ttsItems = cues
          .map((cue, idx) => ({
            index: idx,
            text: String(cue.translated || cue.text || '').trim(),
            voice: normalizeVoicePresetId(cue.voice),
            engine: config.ttsEngine
          }))
          .filter(entry => entry.text);

        if (ttsItems.length > 0) {
          const batchChunkSize = 40;
          const workerConc = 12;
          let ttsDone = 0;
          let ttsSucceeded = 0;

          for (let start = 0; start < ttsItems.length; start += batchChunkSize) {
            checkAbort();
            const slice = ttsItems.slice(start, start + batchChunkSize);
            patchVmRow(item, `🎙️ បង្កើតសំឡេង ${ttsDone}/${ttsItems.length}...`, 60 + Math.round((ttsDone / ttsItems.length) * 28));
            const ttsRes = await fetch(`${BACKEND_URL}/api/tts/batch-generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                items: slice,
                concurrency: workerConc,
                strictVoice: true,
                fixedVoice: config.castMode === 'single' ? config.fixedVoice : ''
              })
            });
            const ttsData = await ttsRes.json();
            if (!ttsRes.ok || !ttsData.success) {
              throw new Error(ttsData.error || 'បង្កើតសំឡេង Batch បរាជ័យ');
            }
            ttsDone += slice.length;
            const results = Array.isArray(ttsData.results) ? ttsData.results : [];
            for (const resEntry of results) {
              if (!resEntry || !resEntry.success) continue;
              ttsSucceeded++;
              const itemEntry = slice.find(x => x.index === resEntry.index);
              if (itemEntry && resEntry.audioUrl) {
                const cKey = getAudioCacheKey(itemEntry.voice, itemEntry.text, 'auto', config.ttsEngine);
                cachedAudioMap.add(cKey);
                cachedAudioUrls.set(cKey, resolveBackendUrl(resEntry.audioUrl));
              }
            }
          }

          item.dubReady = ttsSucceeded > 0;
        }
      }

      checkAbort();

      const bgmResult = await bgmPromise;
      if (bgmResult && bgmResult.success && bgmResult.bgmUrl) {
        item.bgmUrl = resolveBackendUrl(bgmResult.bgmUrl);
      }

      if (config.saveDraft && cues.length > 0) {
        patchVmRow(item, '💾 កំពុងរក្សាទុក SRT & Draft...', 92);
        const srtSavePath = item.srtPath || item.videoPath.replace(/\.[^.\\/]+$/, '.srt');
        await fetch(`${BACKEND_URL}/api/save-srt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues, filePath: srtSavePath })
        }).then(async r => {
          const d = await r.json().catch(() => null);
          if (r.ok && d && d.savedPath) item.srtPath = d.savedPath;
        }).catch(() => {});

        await fetch(`${BACKEND_URL}/api/drafts/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cues,
            videoPath: item.videoPath,
            videoName: item.name,
            timestamp: new Date().toISOString()
          })
        }).catch(() => {});
      }

      if (currentVideoPath && normalizePathKey(item.videoPath) === normalizePathKey(currentVideoPath)) {
        activeCues = cues.map(c => ({ ...c }));
        if (item.srtPath) currentSrtPath = item.srtPath;
        renderTable();
        checkAllAudioCache();
      }

      if (config.autoExport && cues.length > 0) {
        checkAbort();
        patchVmRow(item, '⏳ រង់ចាំជួរ Export MP4...', 95);
        await new Promise((resolve, reject) => {
          vmExportChain = vmExportChain.then(async () => {
            if (vmAbortRequested) return;
            patchVmRow(item, '🎬 កំពុង Export វីដេអូ MP4...', 97);
            const expRes = await fetch(`${BACKEND_URL}/api/export/video`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoPath: item.videoPath,
                cues,
                duration: 0,
                maskEnabled: Boolean(document.getElementById('maskToggleCheck')?.checked ?? document.getElementById('exportMaskCheck')?.checked),
                maskMode: document.getElementById('maskModeSelect')?.value || document.getElementById('exportMaskMode')?.value || 'feathered',
                subStyle: document.getElementById('subStyleSelect')?.value || document.getElementById('exportSubStyle')?.value || currentSubStyle || 'tiktok',
                subFontSize: typeof currentSubFontSize === 'number' ? currentSubFontSize : 22,
                subMarginV: typeof currentSubMarginV === 'number' ? currentSubMarginV : 64,
                wordPopEnabled: typeof currentWordPopEnabled === 'boolean' ? currentWordPopEnabled : true,
                maskYPercent: document.getElementById('maskYSlider')?.value || 82,
                maskHPercent: document.getElementById('maskHSlider')?.value || 15,
                includeDubAudio: config.generateTts,
                autoGenerateMissingTts: config.generateTts,
                autoFitTiming: document.getElementById('exportAutoFitCheck')?.checked !== false,
                audioMixMode: config.isolateBgm ? 'bgm_only' : (document.getElementById('exportAudioMode')?.value || 'duck'),
                ttsEngine: config.ttsEngine,
                castMode: config.castMode,
                fixedVoice: config.fixedVoice,
                strictVoice: true,
                resolution: document.getElementById('exportResolution')?.value || '1080p',
                qualityPreset: document.getElementById('exportQualityPreset')?.value || 'fast',
                encoder: document.getElementById('exportEncoder')?.value || 'auto',
                outputDir: getCustomExportOutputDir(),
                ...getSponsorExportPayload()
              })
            });
            const expData = await expRes.json();
            if (!expRes.ok || !expData.success) {
              throw new Error(expData.error || 'Export MP4 បរាជ័យ');
            }
            item.exportUrl = expData.downloadUrl || '';
          }).then(resolve, reject);
        });
      }

      const finalBadge = item.exportUrl ? '✅ រួចរាល់ + MP4!' : '✅ បកប្រែ + សំឡេងរួចរាល់!';
      patchVmRow(item, finalBadge, 100, 'done');
    }

    async function startVideoManagerBatch() {
      if (vmIsRunning) return;
      const targets = vmQueue.filter(item => item.selected && item.status !== 'done');
      const runQueue = targets.length > 0 ? targets : vmQueue.filter(item => item.selected);
      if (runQueue.length === 0) {
        showShortcutToast('⚠️ សូមធីកជ្រើសវីដេអូយ៉ាងតិច ១ ដើម្បីដំណើរការ!');
        return;
      }

      const config = readVideoManagerConfig();
      vmIsRunning = true;
      vmAbortRequested = false;
      runQueue.forEach(item => {
        item.status = 'pending';
        item.error = '';
        item.stageText = '⏳ រង់ចាំជួរព្រមគ្នា...';
        item.progress = 0;
      });
      renderVideoManagerQueue();

      let cursor = 0;
      const poolSize = Math.min(config.concurrency, runQueue.length);
      const workers = Array.from({ length: poolSize }, async () => {
        while (cursor < runQueue.length && !vmAbortRequested) {
          const item = runQueue[cursor++];
          if (!item) break;
          try {
            await processVideoManagerItem(item, config);
          } catch (err) {
            item.error = err.message || 'បរាជ័យ';
            patchVmRow(item, item.error, item.progress || 0, vmAbortRequested ? 'pending' : 'error');
          }
        }
      });

      await Promise.all(workers);
      vmIsRunning = false;
      renderVideoManagerQueue();

      const completed = runQueue.filter(item => item.status === 'done').length;
      const failed = runQueue.filter(item => item.status === 'error').length;
      const toastMsg = vmAbortRequested
        ? `⏹️ បានបញ្ឈប់! សម្រេចបាន ${completed}/${runQueue.length} វីដេអូ`
        : (failed === 0
          ? `✅ Video Manager: បានបញ្ចប់គ្រប់ ${completed} វីដេអូដោយជោគជ័យ!`
          : `⚠️ Video Manager: សម្រេច ${completed}/${runQueue.length} · បរាជ័យ ${failed}`);
      showShortcutToast(toastMsg);
      const bottomEl = document.getElementById('bottomStatusMsg');
      if (bottomEl) bottomEl.innerText = toastMsg;
    }

    function filterTable() {
      renderTable();
    }

    // Keyboard Shortcuts Handler
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const routerSb = document.getElementById('routerSidebar');
        const vmPane = document.getElementById('videoManagerModal');
        if (routerSb && !routerSb.hidden) {
          switchAppView('studio');
          return;
        }
        if (vmPane && vmPane.style && vmPane.style.display === 'flex') {
          switchAppView('studio');
          return;
        }
      }

      const tag = (document.activeElement && document.activeElement.tagName) ? document.activeElement.tagName.toLowerCase() : '';
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || (document.activeElement && document.activeElement.isContentEditable);

      // Ctrl+Shift+R: Admin Router Unlock / Toggle
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        if (isRouterLockedForUsers()) {
          unlockRouterAdminMode();
        } else if (currentAppView === 'router') {
          lockRouterForUserMode();
        } else {
          switchAppView('router');
        }
        return;
      }

      // Ctrl+S: Save SRT
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveSrtToDisk(true);
        return;
      }

      // Ctrl+Z: Undo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (!isInput) {
          e.preventDefault();
          undoAction();
          return;
        }
      }

      // Ctrl+Y or Ctrl+Shift+Z: Redo
      if (((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
        if (!isInput) {
          e.preventDefault();
          redoAction();
          return;
        }
      }

      // If typing in input, don't trigger media keys
      if (isInput) return;

      const v = document.getElementById('mainVideo');

      // Spacebar: Play / Pause
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const wasPaused = v.paused;
        togglePlayPause();
        showShortcutToast(wasPaused ? '▶️ ចាក់វីដេអូ (Space)' : '⏸️ ផ្អាកវីដេអូ (Space)');
        return;
      }

      // Left Arrow: Seek -5s
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
        setPlayheadTime(v.currentTime);
        showShortcutToast('⏪ -5 វិនាទី (←)');
        return;
      }

      // Right Arrow: Seek +5s
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || 9999, v.currentTime + 5);
        setPlayheadTime(v.currentTime);
        showShortcutToast('⏩ +5 វិនាទី (→)');
        return;
      }

      // Delete / Backspace: Delete selected cue
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
          e.preventDefault();
          deleteSelectedCue();
          showShortcutToast('🗑️ បានលុបបន្ទាត់ (Del)');
          return;
        }
      }
    });

    window.onload = async () => {
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('eza_sidebar_collapsed') === '1') {
          toggleAppSidebar(true);
        }
      } catch (_) {}

      await initProject();
      syncRouterLockUi();
      updateExportOutputDirDisplay();
      renderSponsorOverlayPreview();
      initSponsorOverlayDrag();
      syncRouterModelMode().catch(() => {});
      syncRouterModelMode().catch(() => {});

      fetchMergedGeminiAccounts()
        .then(data => { if (data && Array.isArray(data.accounts)) updateRouterSidebarNavBadge(data.accounts); })
        .catch(() => {});

      // Check URL Query Parameters (Integration with HDRG)
      const urlParams = new URLSearchParams(window.location.search);
      const queryDrama = urlParams.get('drama');
      const queryEp = urlParams.get('ep');

      if (queryDrama) {
        try {
          const res = await fetch(`${BACKEND_URL}/api/list-hdrg-dramas`);
          const data = await res.json();
          if (data.dramas && data.dramas.length > 0) {
            window.cachedDramaList = data.dramas;
            const targetDrama = data.dramas.find(d => d.name.toLowerCase().includes(queryDrama.toLowerCase()));
            if (targetDrama) {
              const epNum = queryEp ? parseInt(queryEp, 10) : 1;
              const ep = targetDrama.episodes.find(e => e.ep == epNum) || targetDrama.episodes[0];
              if (ep && ep.srtPath) {
                const srtRes = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ filePath: ep.srtPath })
                });
                const srtData = await srtRes.json();
                loadDramaData(targetDrama, ep, srtData.cues || []);
              } else {
                loadDramaData(targetDrama, ep, []);
              }
              showShortcutToast('🎬 បានបើក ' + targetDrama.name);
            }
          }
        } catch (_) {}
      }
    };

    // --- Voice Clone Studio & Seed-VC 1-Click Installer ---
    let cloneStatusPollTimer = null;
    let cloneMediaRecorder = null;
    let cloneRecordedChunks = [];
    let cloneRecordStopTimeout = null;

    async function refreshVoicesAndPresets() {
      if (typeof fetch !== 'function') return;
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/voices`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.presets) && data.presets.length > 0) {
          VOICE_PRESETS = data.presets;
          populateBulkVoiceSelect();
          if (typeof renderTable === 'function' && activeCues.length > 0) {
            renderTable();
          }
        }
        if (data && data.cloneEngine) {
          renderCloneEngineStatus(data.cloneEngine);
        }
        if (data && Array.isArray(data.clonedVoices)) {
          renderClonedVoicesList(data.clonedVoices);
        }
      } catch (_) {}
    }

    function openVoiceCloneModal() {
      const modal = document.getElementById('voiceCloneModal');
      if (!modal) return;
      modal.style.display = 'flex';
      refreshClonedVoicesPanel();
    }

    function closeVoiceCloneModal() {
      const modal = document.getElementById('voiceCloneModal');
      if (modal) modal.style.display = 'none';
      if (cloneStatusPollTimer) {
        clearInterval(cloneStatusPollTimer);
        cloneStatusPollTimer = null;
      }
    }

    async function refreshClonedVoicesPanel() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/cloned-voices`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.engine) renderCloneEngineStatus(data.engine);
        if (Array.isArray(data.voices)) renderClonedVoicesList(data.voices);
      } catch (_) {}
    }

    function renderCloneEngineStatus(status) {
      if (!status) return;
      const hwEl = document.getElementById('cloneEngineHwText');
      const badgeEl = document.getElementById('cloneEngineReadyBadge');
      const btnInstall = document.getElementById('btnInstallSeedVc');
      const btnCancel = document.getElementById('btnCancelSeedVc');
      const progWrap = document.getElementById('cloneInstallProgressWrap');
      const stageEl = document.getElementById('cloneInstallStageText');
      const pctEl = document.getElementById('cloneInstallPercentText');
      const barEl = document.getElementById('cloneInstallBarFill');
      const logEl = document.getElementById('cloneInstallLogBox');

      if (hwEl) {
        const gpu = status.gpuName ? `${status.gpuName} (${status.gpuVramMb || '?'}MB VRAM)` : 'CPU Mode';
        const py = status.pythonAvailable ? `Python ${status.pythonVersion}` : 'ខ្វះ Python';
        const free = status.diskFreeGb != null ? `ទំនេរ ${status.diskFreeGb} GB` : '';
        hwEl.innerText = `${gpu} · ${py} · ${free} · ទីតាំង៖ ${status.engineDir || 'D:\\'}`;
      }

      const isInstalling = status.installState === 'installing';
      if (badgeEl) {
        if (status.ready) {
          badgeEl.innerText = '✅ រួចរាល់ (Seed-VC)';
          badgeEl.style.background = 'rgba(16,185,129,0.16)';
          badgeEl.style.color = '#34d399';
          badgeEl.style.borderColor = 'rgba(16,185,129,0.4)';
        } else if (isInstalling) {
          badgeEl.innerText = '⏳ កំពុងដំឡើង...';
          badgeEl.style.background = 'rgba(56,189,248,0.16)';
          badgeEl.style.color = '#7dd3fc';
          badgeEl.style.borderColor = 'rgba(56,189,248,0.4)';
        } else {
          badgeEl.innerText = 'មិនទាន់ដំឡើង';
          badgeEl.style.background = 'rgba(245,158,11,0.14)';
          badgeEl.style.color = '#fcd34d';
          badgeEl.style.borderColor = 'rgba(245,158,11,0.35)';
        }
      }

      if (btnInstall) {
        btnInstall.style.display = status.ready ? 'none' : 'inline-flex';
        btnInstall.disabled = isInstalling;
        btnInstall.innerText = isInstalling ? '⏳ កំពុងដំឡើង...' : '⬇️ ដំឡើង Seed-VC (~3–4GB)';
      }
      if (btnCancel) {
        btnCancel.style.display = isInstalling ? 'inline-flex' : 'none';
      }

      const showProgress = isInstalling || status.installState === 'error' || (status.installLogs && status.installLogs.length > 0 && !status.ready);
      if (progWrap) progWrap.style.display = showProgress ? 'flex' : 'none';
      if (stageEl) stageEl.innerText = status.installStage || status.installError || '';
      if (pctEl) pctEl.innerText = `${Number(status.installPercent) || 0}%`;
      if (barEl) barEl.style.width = `${Math.min(100, Math.max(0, Number(status.installPercent) || 0))}%`;
      if (logEl && Array.isArray(status.installLogs)) {
        logEl.innerText = status.installLogs.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (isInstalling && !cloneStatusPollTimer) {
        cloneStatusPollTimer = setInterval(async () => {
          try {
            const r = await fetch(`${BACKEND_URL}/api/tts/clone/status`);
            if (!r.ok) return;
            const st = await r.json();
            renderCloneEngineStatus(st);
            if (st.installState !== 'installing') {
              clearInterval(cloneStatusPollTimer);
              cloneStatusPollTimer = null;
              await refreshVoicesAndPresets();
            }
          } catch (_) {}
        }, 1800);
      }
    }

    async function installSeedVcEngine() {
      if (!confirm('ប្រព័ន្ធនឹង Download ម៉ូដែល Seed-VC AI (~3–4GB) ចូល Drive D ដើម្បីប្រើ Clone សំឡេងដោយផ្ទាល់លើម៉ាស៊ីន (ឥតគិតថ្លៃ)។ តើអ្នកចង់ចាប់ផ្ដើមដំឡើងឥឡូវនេះទេ?')) {
        return;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/clone/install`, { method: 'POST' });
        const data = await res.json();
        renderCloneEngineStatus(data);
        if (!res.ok || data.installState === 'error') {
          alert('មិនអាចដំឡើងបានទេ៖ ' + (data.error || data.installError || 'Unknown error'));
        }
      } catch (err) {
        alert('កំហុស Server៖ ' + err.message);
      }
    }

    async function cancelSeedVcEngine() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/clone/cancel`, { method: 'POST' });
        const data = await res.json();
        renderCloneEngineStatus(data);
      } catch (_) {}
    }

    function renderClonedVoicesList(voices) {
      const container = document.getElementById('clonedVoicesList');
      if (!container) return;
      if (!Array.isArray(voices) || voices.length === 0) {
        container.innerHTML = '<div style="font-size:12px; color:#64748b; text-align:center; padding:14px;">មិនទាន់មានសំឡេង Clone នៅឡើយទេ</div>';
        return;
      }
      const activeId = getSelectedSingleVoice();
      container.innerHTML = voices.map(v => {
        const isActive = v.id === activeId;
        const genderText = v.baseGender === 'Female' ? 'ស្ត្រី (Sreymom)' : 'បុរស (Piseth)';
        const durText = v.durationSec ? `${Number(v.durationSec).toFixed(1)}s` : '';
        const sampleSrc = resolveBackendUrl(v.sampleUrl);
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 10px; border-radius:6px; background:${isActive ? 'rgba(0,229,192,0.1)' : '#0d1526'}; border:1px solid ${isActive ? '#00e5c0' : '#1e293b'};">
            <div style="min-width:0; flex:1;">
              <div style="font-size:12px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🎭 ${escapeHtml(v.name)}</div>
              <div style="font-size:10px; color:#94a3b8;">${genderText} · គំរូ ${durText}</div>
            </div>
            <audio controls preload="none" src="${escapeHtml(sampleSrc)}" style="height:28px; max-width:170px;"></audio>
            <button type="button" class="action-icon-btn green" onclick="useClonedVoice('${escapeHtml(v.id)}')">${isActive ? '✓ កំពុងប្រើ' : 'ប្រើសំឡេងនេះ'}</button>
            <button type="button" class="action-icon-btn danger" onclick="deleteClonedVoiceProfile('${escapeHtml(v.id)}')" title="លុប">🗑️</button>
          </div>
        `;
      }).join('');
    }

    function useClonedVoice(voiceId) {
      onDefaultVoiceChange(voiceId);
      closeVoiceCloneModal();
    }

    async function deleteClonedVoiceProfile(voiceId) {
      if (!confirm('តើអ្នកចង់លុបសំឡេង Clone នេះមែនទេ?')) return;
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/cloned-voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Delete failed');
        }
        if (getSelectedSingleVoice() === voiceId) {
          onDefaultVoiceChange('Sovereign King');
        }
        await refreshVoicesAndPresets();
        showShortcutToast('🗑️ បានលុបសំឡេង Clone រួចរាល់');
      } catch (err) {
        alert('មិនអាចលុបបានទេ៖ ' + err.message);
      }
    }

    async function submitClonedVoiceSample({ name, baseGender, audioBase64 }) {
      const res = await fetch(`${BACKEND_URL}/api/tts/cloned-voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, baseGender, audioBase64 })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'មិនអាចបង្កើតសំឡេង Clone បានទេ');
      }
      const nameInput = document.getElementById('cloneVoiceNameInput');
      if (nameInput) nameInput.value = '';
      await refreshVoicesAndPresets();
      onDefaultVoiceChange(data.voice.id);
      showShortcutToast(`🎭 បានបង្កើត និងរើសសំឡេង Clone៖ ${data.voice.name}`);
    }

    function handleCloneFileUpload(event) {
      const file = event?.target?.files?.[0];
      if (event?.target) event.target.value = '';
      if (!file) return;
      const nameInput = document.getElementById('cloneVoiceNameInput');
      const genderSel = document.getElementById('cloneVoiceGenderSelect');
      const cleanName = (nameInput && nameInput.value.trim()) || file.name.replace(/\.[^.]+$/, '');
      const baseGender = (genderSel && genderSel.value) || 'Male';
      const statusEl = document.getElementById('cloneRecordStatusText');
      if (statusEl) statusEl.innerText = '⏳ កំពុងបម្លែងសំឡេងគំរូ...';

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await submitClonedVoiceSample({ name: cleanName, baseGender, audioBase64: reader.result });
          if (statusEl) statusEl.innerText = '✅ រួចរាល់!';
        } catch (err) {
          if (statusEl) statusEl.innerText = '❌ ' + err.message;
          alert(err.message);
        }
      };
      reader.readAsDataURL(file);
    }

    async function toggleCloneMicRecord() {
      const btn = document.getElementById('btnRecordCloneMic');
      const statusEl = document.getElementById('cloneRecordStatusText');
      if (cloneMediaRecorder && cloneMediaRecorder.state === 'recording') {
        clearTimeout(cloneRecordStopTimeout);
        cloneMediaRecorder.stop();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return alert('Browser/Device នេះមិនគាំទ្រការថតតាម Mic ទេ។');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        cloneRecordedChunks = [];
        cloneMediaRecorder = new MediaRecorder(stream);
        cloneMediaRecorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) cloneRecordedChunks.push(ev.data);
        };
        cloneMediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          if (btn) btn.innerText = '🎙️ ថតសំឡេងតាម Mic';
          const blob = new Blob(cloneRecordedChunks, { type: cloneMediaRecorder.mimeType || 'audio/webm' });
          const reader = new FileReader();
          reader.onload = async () => {
            const nameInput = document.getElementById('cloneVoiceNameInput');
            const genderSel = document.getElementById('cloneVoiceGenderSelect');
            const cleanName = (nameInput && nameInput.value.trim()) || `My Voice ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
            try {
              if (statusEl) statusEl.innerText = '⏳ កំពុងរក្សាទុកសំឡេង...';
              await submitClonedVoiceSample({
                name: cleanName,
                baseGender: (genderSel && genderSel.value) || 'Male',
                audioBase64: reader.result
              });
              if (statusEl) statusEl.innerText = '✅ រក្សាទុកសំឡេង Mic រួចរាល់!';
            } catch (err) {
              if (statusEl) statusEl.innerText = '❌ ' + err.message;
              alert(err.message);
            }
          };
          reader.readAsDataURL(blob);
        };
        cloneMediaRecorder.start();
        if (btn) btn.innerText = '⏹️ បញ្ឈប់ការថត (និយាយ 5–15s)';
        if (statusEl) statusEl.innerText = '🔴 កំពុងថតសំឡេង (អតិបរមា 20 វិនាទី)...';
        cloneRecordStopTimeout = setTimeout(() => {
          if (cloneMediaRecorder && cloneMediaRecorder.state === 'recording') {
            cloneMediaRecorder.stop();
          }
        }, 20000);
      } catch (err) {
        alert('មិនអាចបើក Mic បានទេ៖ ' + err.message);
      }
    }

    function useVideoPlayheadForClone() {
      const v = document.getElementById('mainVideo');
      const startInput = document.getElementById('cloneVideoStartSec');
      if (v && startInput) {
        startInput.value = Number(v.currentTime || 0).toFixed(1);
      }
    }

    async function extractCloneFromCurrentVideo() {
      if (!currentVideoPath) {
        return alert('សូមបើកវីដេអូជាមុនសិន!');
      }
      const nameInput = document.getElementById('cloneVoiceNameInput');
      const genderSel = document.getElementById('cloneVoiceGenderSelect');
      const startEl = document.getElementById('cloneVideoStartSec');
      const durEl = document.getElementById('cloneVideoDurSec');
      const cleanName = (nameInput && nameInput.value.trim()) || `Video Voice ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
      const baseGender = (genderSel && genderSel.value) || 'Male';
      const startSec = Number(startEl && startEl.value) || 0;
      const durationSec = Number(durEl && durEl.value) || 12;
      const statusEl = document.getElementById('cloneRecordStatusText');

      try {
        if (statusEl) statusEl.innerText = '✂️ កំពុងកាត់ និងបំបែកសំឡេងចេញពីវីដេអូ...';
        const res = await fetch(`${BACKEND_URL}/api/tts/cloned-voices/extract-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cleanName, baseGender, videoPath: currentVideoPath, startSec, durationSec })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'មិនអាចកាត់សំឡេងពីវីដេអូបានទេ');
        }
        if (nameInput) nameInput.value = '';
        await refreshVoicesAndPresets();
        onDefaultVoiceChange(data.voice.id);
        if (statusEl) statusEl.innerText = '✅ កាត់សំឡេងគំរូពីវីដេអូរួចរាល់!';
        showShortcutToast(`🎭 បានកាត់សំឡេង Clone៖ ${data.voice.name}`);
      } catch (err) {
        if (statusEl) statusEl.innerText = '❌ ' + err.message;
        alert(err.message);
      }
    }

    // 14. Mobile Connect (QR / LAN Link) & System Maintenance Hub
    function buildVisualQrSvg(urlText) {
      const str = String(urlText || 'http://127.0.0.1:3001');
      const size = 21;
      const grid = Array.from({ length: size }, () => Array(size).fill(0));
      const drawFinder = (r0, c0) => {
        for (let r = 0; r < 7; r++) {
          for (let c = 0; c < 7; c++) {
            const border = r === 0 || r === 6 || c === 0 || c === 6;
            const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            grid[r0 + r][c0 + c] = (border || inner) ? 1 : 0;
          }
        }
      };
      drawFinder(0, 0);
      drawFinder(0, size - 7);
      drawFinder(size - 7, 0);
      for (let i = 8; i < size - 8; i++) {
        grid[6][i] = i % 2 === 0 ? 1 : 0;
        grid[i][6] = i % 2 === 0 ? 1 : 0;
      }
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const inFinderTL = r < 8 && c < 8;
          const inFinderTR = r < 8 && c >= size - 8;
          const inFinderBL = r >= size - 8 && c < 8;
          if (inFinderTL || inFinderTR || inFinderBL || r === 6 || c === 6) continue;
          const charCode = str.charCodeAt((r * size + c) % str.length) || 49;
          const bit = ((hash ^ (charCode * (r + 3) * (c + 5))) >>> ((r + c) % 16)) & 1;
          grid[r][c] = bit;
        }
      }
      let rects = '';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (grid[r][c]) {
            rects += `<rect x="${c * 4 + 6}" y="${r * 4 + 6}" width="4" height="4" rx="0.6" fill="#0f172a"/>`;
          }
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="104" height="104" role="img" aria-label="QR ${escapeHtml(str)}"><rect width="96" height="96" rx="6" fill="#ffffff"/>${rects}</svg>`;
    }

    function applyMaintenanceAnnouncementBanner(bannerText) {
      const bar = document.getElementById('maintenanceAnnouncementBar');
      const txt = document.getElementById('maintenanceAnnouncementText');
      const clean = String(bannerText || '').trim();
      if (!bar || !txt) return;
      if (clean) {
        txt.innerText = `📢 ${clean}`;
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
    }

    const ACCESS_TOKEN_STORAGE_KEY = 'eza_verified_access_token';
    let sessionAccessTokenState = '';

    function getSavedAccessToken() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const saved = String(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '').trim();
          if (saved) sessionAccessTokenState = saved;
        }
      } catch (_) {}
      return sessionAccessTokenState;
    }

    function saveVerifiedAccessToken(token) {
      sessionAccessTokenState = String(token || '').trim();
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, sessionAccessTokenState);
        }
      } catch (_) {}
    }

    let cloudLicenseHeartbeatTimer = null;

    function applyGateDownloadLink(url) {
      const linkEl = document.getElementById('gateDownloadLink');
      if (!linkEl) return;
      const clean = String(url || '').trim();
      if (clean && /^https?:\/\//i.test(clean)) {
        linkEl.href = clean;
        linkEl.style.display = 'inline-block';
      } else {
        linkEl.style.display = 'none';
      }
    }

    function applyRemoteRouterControl(routerLocked) {
      if (!routerLocked) return;
      routerUserLockedState = true;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_USER_LOCKED_STORAGE_KEY, '1');
        }
      } catch (_) {}
      syncRouterLockUi();
    }

    function updateCustomerLicenseUi(info) {
      const box = document.getElementById('customerCloudLicenseSection');
      if (!box) return;
      if (!info) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      const nameEl = document.getElementById('hubCustLicenseName');
      const keyEl = document.getElementById('hubCustLicenseKey');
      const expEl = document.getElementById('hubCustLicenseExpiry');
      if (nameEl) nameEl.innerText = info.customerName || 'Licensed User';
      if (keyEl) keyEl.innerText = info.maskedKey || '-';
      if (expEl) {
        expEl.innerText = info.expiresAt
          ? new Date(info.expiresAt).toLocaleDateString('en-GB')
          : 'Lifetime';
      }
    }

    async function copyGateMachineId() {
      const el = document.getElementById('gateMachineIdText');
      const hwid = el ? String(el.innerText || '').trim() : '';
      if (!hwid) return;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(hwid);
        }
      } catch (_) {}
      showShortcutToast(`📋 បានចម្លង Machine ID៖ ${hwid}`);
    }

    async function switchCustomerLicenseKey() {
      try {
        await fetch(`${BACKEND_URL}/api/config/verify-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear' })
        });
      } catch (_) {}
      saveVerifiedAccessToken('');
      closeMobileConnectModal();
      const gate = document.getElementById('accessGateOverlay');
      const errEl = document.getElementById('gateErrorMsg');
      if (errEl) errEl.innerText = 'សូមបញ្ចូល License Key ថ្មីរបស់អ្នក។';
      if (gate) gate.style.display = 'flex';
    }

    function startCloudLicenseHeartbeat() {
      if (cloudLicenseHeartbeatTimer || typeof setInterval !== 'function') return;
      cloudLicenseHeartbeatTimer = setInterval(async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/api/config/verify-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recheck', token: getSavedAccessToken() })
          });
          const data = await res.json();
          if (data && typeof data.maintenanceBanner === 'string') {
            applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
          }
          if (data && data.routerLocked) {
            applyRemoteRouterControl(true);
          }
          if (!res.ok || !data || !data.valid) {
            const gate = document.getElementById('accessGateOverlay');
            const errEl = document.getElementById('gateErrorMsg');
            if (errEl && data && data.error) errEl.innerText = data.error;
            if (data && data.downloadUrl) applyGateDownloadLink(data.downloadUrl);
            if (gate) gate.style.display = 'flex';
          }
        } catch (_) {}
      }, 10 * 60 * 1000);
    }

    async function syncAccessGateOverlay(hubData) {
      const gate = document.getElementById('accessGateOverlay');
      if (!gate || !hubData) return;
      const gateHwid = document.getElementById('gateMachineIdText');
      if (gateHwid && hubData.machineId) gateHwid.innerText = hubData.machineId;

      if (hubData.isPackagedClient) {
        const adminSec = document.getElementById('systemHubAdminSection');
        if (adminSec) adminSec.style.display = 'none';
        const routerLockBtn = document.getElementById('routerLockUserBtn');
        if (routerLockBtn) routerLockBtn.style.display = 'none';
      }

      if (hubData.cloudLicenseEnforced) {
        updateCustomerLicenseUi(hubData.cloudLicensed ? hubData.cloudLicenseInfo : null);
        if (hubData.routerDefaultLocked) applyRemoteRouterControl(true);
        startCloudLicenseHeartbeat();
        try {
          const vRes = await fetch(`${BACKEND_URL}/api/config/verify-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recheck', token: getSavedAccessToken() })
          });
          const vData = await vRes.json();
          if (vData && typeof vData.maintenanceBanner === 'string' && vData.maintenanceBanner) {
            applyMaintenanceAnnouncementBanner(vData.maintenanceBanner);
          }
          if (vData && vData.downloadUrl) applyGateDownloadLink(vData.downloadUrl);
          if (vData && vData.routerLocked) applyRemoteRouterControl(true);
          if (vRes.ok && vData && vData.valid) {
            if (vData.accessToken) saveVerifiedAccessToken(vData.accessToken);
            if (vData.cloudLicenseInfo) updateCustomerLicenseUi(vData.cloudLicenseInfo);
            gate.style.display = 'none';
            return;
          }
          const errEl = document.getElementById('gateErrorMsg');
          if (errEl && vData && vData.reason !== 'missing_key' && vData.error) {
            errEl.innerText = vData.error;
          }
        } catch (_) {}
        gate.style.display = 'flex';
        return;
      }

      if (!hubData.userAccessEnabled || !hubData.hasUserAccessCode) {
        gate.style.display = 'none';
        return;
      }

      const existingToken = getSavedAccessToken();
      if (existingToken) {
        try {
          const vRes = await fetch(`${BACKEND_URL}/api/config/verify-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: existingToken })
          });
          const vData = await vRes.json();
          if (vRes.ok && vData && vData.valid) {
            gate.style.display = 'none';
            return;
          }
        } catch (_) {}
      }
      gate.style.display = 'flex';
    }

    async function submitAccessGateCode() {
      const inputEl = document.getElementById('gateAccessCodeInput');
      const errEl = document.getElementById('gateErrorMsg');
      const gate = document.getElementById('accessGateOverlay');
      const code = inputEl ? String(inputEl.value || '').trim() : '';
      if (!code) {
        if (errEl) errEl.innerText = 'សូមបញ្ចូលលេខកូដ ឬ License Key ជាមុនសិន។';
        return false;
      }
      try {
        if (errEl) errEl.innerText = '⏳ កំពុងផ្ទៀងផ្ទាត់សុវត្ថិភាព...';
        const res = await fetch(`${BACKEND_URL}/api/config/verify-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data && data.downloadUrl) applyGateDownloadLink(data.downloadUrl);
        if (data && data.maintenanceBanner) applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
        if (!res.ok || !data || !data.valid) {
          if (errEl) errEl.innerText = (data && data.error) || 'លេខកូដមិនត្រឹមត្រូវទេ។';
          return false;
        }
        if (data.accessToken) saveVerifiedAccessToken(data.accessToken);
        if (data.cloudLicenseInfo) updateCustomerLicenseUi(data.cloudLicenseInfo);
        if (data.routerLocked) applyRemoteRouterControl(true);
        if (inputEl) inputEl.value = '';
        if (errEl) errEl.innerText = '';
        if (gate) gate.style.display = 'none';
        showShortcutToast('🔓 បានផ្ទៀងផ្ទាត់សិទ្ធិប្រើប្រាស់ជោគជ័យ!');
        return true;
      } catch (err) {
        if (errEl) errEl.innerText = '❌ កំហុសតភ្ជាប់៖ ' + err.message;
        return false;
      }
    }

    async function generateCustomerLicenseKey() {
      const targetInput = document.getElementById('hubTargetMachineIdInput');
      const durSelect = document.getElementById('hubLicenseDurationSelect');
      const outInput = document.getElementById('hubGeneratedLicenseOutput');
      const curHwidEl = document.getElementById('hubCurrentMachineId');
      const machineId = (targetInput && String(targetInput.value || '').trim()) || (curHwidEl ? curHwidEl.innerText : '');
      const durationDays = durSelect ? Number(durSelect.value || 0) : 0;

      try {
        const res = await fetch(`${BACKEND_URL}/api/config/generate-license`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineId, durationDays })
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success || !data.licenseKey) {
          throw new Error((data && data.error) || 'មិនអាចបង្កើត License Key បានទេ');
        }
        if (outInput) outInput.value = data.licenseKey;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(data.licenseKey);
          }
        } catch (_) {}
        showShortcutToast(`🎫 បានបង្កើត និងចម្លង License Key៖ ${data.licenseKey}`);
        return data.licenseKey;
      } catch (err) {
        showShortcutToast('❌ ' + err.message);
        return '';
      }
    }

    function syncPublicTunnelUi(data) {
      const pubInput = document.getElementById('mobilePublicTunnelUrlInput');
      const startBtn = document.getElementById('btnStartPublicTunnel');
      const copyBtn = document.getElementById('btnCopyPublicTunnel');
      const stopBtn = document.getElementById('btnStopPublicTunnel');
      const qrBox = document.getElementById('mobileQrContainer');
      const url = (data && data.publicTunnelUrl) ? String(data.publicTunnelUrl).trim() : '';
      if (pubInput) {
        pubInput.value = url;
      }
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerText = url ? '🌍 កំពុងបើក (4G/5G)' : '🌍 បើក Link 4G/5G';
      }
      if (copyBtn) copyBtn.hidden = !url;
      if (stopBtn) stopBtn.hidden = !url;
      if (qrBox && (url || (data && data.phoneUrl))) {
        qrBox.innerHTML = buildVisualQrSvg(url || data.phoneUrl);
      }
    }

    async function startPublicInternetLink() {
      const startBtn = document.getElementById('btnStartPublicTunnel');
      const pubInput = document.getElementById('mobilePublicTunnelUrlInput');
      try {
        if (startBtn) {
          startBtn.disabled = true;
          startBtn.innerText = '⏳ កំពុងបង្កើត Link...';
        }
        if (pubInput) pubInput.value = '⏳ កំពុងភ្ជាប់ Public HTTPS Tunnel (សូមរង់ចាំ 3–5 វិនាទី)...';
        const res = await fetch(`${BACKEND_URL}/api/config/public-tunnel/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        syncPublicTunnelUi(data);
        if (data && data.publicTunnelUrl) {
          showShortcutToast(`🌍 បានបើក Link 4G/5G៖ ${data.publicTunnelUrl}`);
          return data.publicTunnelUrl;
        }
        if (pubInput) pubInput.value = (data && data.error) || 'មិនអាចបើក Tunnel បានទេ';
        return '';
      } catch (err) {
        if (startBtn) {
          startBtn.disabled = false;
          startBtn.innerText = '🌍 បើក Link 4G/5G';
        }
        if (pubInput) pubInput.value = '❌ ' + err.message;
        return '';
      }
    }

    async function stopPublicInternetLink() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/public-tunnel/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        syncPublicTunnelUi(data);
        showShortcutToast('⏹️ បានបិទតំណភ្ជាប់ Public Internet');
      } catch (_) {}
    }

    async function copyPublicTunnelUrl() {
      const pubInput = document.getElementById('mobilePublicTunnelUrlInput');
      const url = (pubInput && pubInput.value) || '';
      if (!url || !url.startsWith('http')) return '';
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(url);
        } else if (pubInput && typeof pubInput.select === 'function') {
          pubInput.select();
          if (typeof document.execCommand === 'function') document.execCommand('copy');
        }
      } catch (_) {}
      showShortcutToast(`📋 បានចម្លង Link 4G/5G៖ ${url}`);
      return url;
    }

    async function refreshSystemHubModal() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/system-hub`);
        const data = await res.json();
        if (!res.ok || !data || !data.success) return null;

        const urlInput = document.getElementById('mobileLanUrlInput');
        if (urlInput && data.phoneUrl) {
          urlInput.value = data.phoneUrl;
        }
        syncPublicTunnelUi(data);
        const hwidEl = document.getElementById('hubCurrentMachineId');
        if (hwidEl && data.machineId) {
          hwidEl.innerText = data.machineId;
        }
        const targetHwidInput = document.getElementById('hubTargetMachineIdInput');
        if (targetHwidInput && !targetHwidInput.value && data.machineId) {
          targetHwidInput.value = data.machineId;
        }
        const accessChk = document.getElementById('hubUserAccessCheck');
        if (accessChk) accessChk.checked = Boolean(data.userAccessEnabled);
        const bannerInput = document.getElementById('hubMaintenanceBannerInput');
        if (bannerInput) bannerInput.value = data.maintenanceBanner || '';
        const lockBtn = document.getElementById('hubRouterLockToggleBtn');
        if (lockBtn) {
          const locked = isRouterLockedForUsers();
          lockBtn.innerText = locked ? '🔓 បើកបង្ហាញ Router វិញ' : '🔒 លាក់ Router ពី User';
        }
        applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
        await syncAccessGateOverlay(data);
        return data;
      } catch (_) {
        return null;
      }
    }

    async function openMobileConnectModal() {
      const modal = document.getElementById('mobileConnectModal');
      if (modal) modal.style.display = 'flex';
      return refreshSystemHubModal();
    }

    function closeMobileConnectModal() {
      const modal = document.getElementById('mobileConnectModal');
      if (modal) modal.style.display = 'none';
    }

    async function copyMobileConnectUrl() {
      const urlInput = document.getElementById('mobileLanUrlInput');
      const url = (urlInput && urlInput.value) || 'http://127.0.0.1:3001';
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(url);
        } else if (urlInput && typeof urlInput.select === 'function') {
          urlInput.select();
          if (typeof document.execCommand === 'function') document.execCommand('copy');
        }
      } catch (_) {}
      showShortcutToast(`📋 បានចម្លង Link៖ ${url}`);
      return url;
    }

    async function toggleRouterLockFromHub() {
      if (isRouterLockedForUsers()) {
        await unlockRouterAdminMode();
      } else {
        lockRouterForUserMode();
      }
      const lockBtn = document.getElementById('hubRouterLockToggleBtn');
      if (lockBtn) {
        lockBtn.innerText = isRouterLockedForUsers() ? '🔓 បើកបង្ហាញ Router វិញ' : '🔒 លាក់ Router ពី User';
      }
    }

    async function saveSystemHubConfig() {
      const accessChk = document.getElementById('hubUserAccessCheck');
      const codeInput = document.getElementById('hubUserAccessCodeInput');
      const bannerInput = document.getElementById('hubMaintenanceBannerInput');
      const statusEl = document.getElementById('hubAdminStatusMsg');

      const payload = {
        userAccessEnabled: Boolean(accessChk && accessChk.checked),
        userAccessCode: codeInput ? String(codeInput.value || '').trim() : '',
        maintenanceBanner: bannerInput ? String(bannerInput.value || '').trim() : ''
      };

      try {
        if (statusEl) statusEl.innerText = '⏳ កំពុងរក្សាទុក...';
        const res = await fetch(`${BACKEND_URL}/api/config/system-hub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចរក្សាទុកបានទេ');
        }
        if (codeInput) codeInput.value = '';
        applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
        if (statusEl) statusEl.innerText = '✅ រក្សាទុកការកំណត់រួចរាល់!';
        showShortcutToast('💾 រក្សាទុកការកំណត់ថែទាំ និងសិទ្ធិ User រួចរាល់');
        return data;
      } catch (err) {
        if (statusEl) statusEl.innerText = '❌ ' + err.message;
        return null;
      }
    }

    if (typeof fetch === 'function') {
      refreshSystemHubModal().catch(() => {});
    }


  