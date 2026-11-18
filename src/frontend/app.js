
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

    function appendAccessTokenToUrl(rawUrl) {
      const str = String(rawUrl || '').trim();
      if (!str || str.startsWith('blob:') || str.startsWith('data:')) return str;
      const token = getSavedAccessToken();
      if (!token) return str;
      const isBackendUrl = str.startsWith('/') || (BACKEND_URL && str.startsWith(BACKEND_URL));
      if (!isBackendUrl) return str;
      if (/[?&]accessToken=/i.test(str)) {
        return str.replace(/([?&]accessToken=)[^&]*/i, `$1${encodeURIComponent(token)}`);
      }
      return `${str}${str.includes('?') ? '&' : '?'}accessToken=${encodeURIComponent(token)}`;
    }

    if (typeof fetch === 'function' && !fetch._ezaAuthWrapped) {
      const _baseFetch = (typeof window !== 'undefined' && typeof fetch.bind === 'function')
        ? fetch.bind(window)
        : fetch;
      const _ezaWrappedFetch = async function ezaAuthorizedFetch(input, init) {
        const urlStr = typeof input === 'string'
          ? input
          : (input && typeof input.url === 'string' ? input.url : '');
        const isBackendReq = Boolean(urlStr && (urlStr.startsWith('/') || (BACKEND_URL && urlStr.startsWith(BACKEND_URL))));
        const token = isBackendReq ? getSavedAccessToken() : '';
        let finalInit = init;
        if (isBackendReq && token) {
          const nextInit = init ? { ...init } : {};
          if (typeof Headers !== 'undefined' && nextInit.headers instanceof Headers) {
            const h = new Headers(nextInit.headers);
            if (!h.has('x-eza-access-token')) h.set('x-eza-access-token', token);
            nextInit.headers = h;
          } else {
            nextInit.headers = { ...(nextInit.headers || {}) };
            if (!nextInit.headers['x-eza-access-token'] && !nextInit.headers['X-Eza-Access-Token']) {
              nextInit.headers['x-eza-access-token'] = token;
            }
          }
          finalInit = nextInit;
        }
        const res = await _baseFetch(input, finalInit);
        if (res && (res.status === 401 || res.status === 403) && isBackendReq && !urlStr.includes('/api/config/verify-access')) {
          try {
            const cloned = typeof res.clone === 'function' ? res.clone() : null;
            const body = cloned ? await cloned.json().catch(() => null) : null;
            if (body && (body.authRequired || body.licenseRequired) && typeof document !== 'undefined') {
              if (body.authRequired) saveVerifiedAccessToken('');
              const gate = document.getElementById('accessGateOverlay');
              const errEl = document.getElementById('gateErrorMsg');
              if (errEl && body.error) errEl.innerText = body.error;
              if (gate && gate.style) gate.style.display = 'flex';
            } else if (res.status === 401 && body && typeof body.error === 'string' && /gemini api key/i.test(body.error)) {
              if (typeof openByokSetupModal === 'function') openByokSetupModal();
            }
          } catch (_) {}
        }
        return res;
      };
      _ezaWrappedFetch._ezaAuthWrapped = true;
      fetch = _ezaWrappedFetch;
      if (typeof window !== 'undefined' && window !== globalThis) {
        try { window.fetch = _ezaWrappedFetch; } catch (_) {}
      }
    }

    let activeCues = [];
    let currentVideoPath = '';
    let currentSrtPath = '';
    let currentVideoDuration = 0;
    let isDubVoiceEnabled = true;
    let selectedCueIndex = -1;
    let activeAudioPlayer = new Audio();
    activeAudioPlayer.crossOrigin = 'anonymous';
    let currentDramaInfo = null;
    let activeObjectUrl = '';
    let activeVideoUploadPromise = null;
    let activeUploadAbortController = null;
    let videoSelectionSeq = 0;
    let lastSelectedVideoFile = null;
    let currentDubAudio = null;
    let dubVolumeBeforeDuck = null;
    let dubRequestToken = 0;
    let episodeRequestToken = 0;
    let _bgmIsolationSeq = 0;
    let activeExportRunId = 0;
    let isOpeningCloneMic = false;
    let activeSpeakingCueIdx = -1;
    let syncTimerId = null;
    let cachedAudioUrls = new Map();

    const AUDIO_MIX_STORAGE_KEY = 'eza_audio_mixer_v1';
    const audioMixerState = {
      origPct: 0,
      bgmPct: 65,
      dubPct: 100,
      bgmOnPause: true
    };

    function clampNum(val, min, max, fallback) {
      const n = Number(val);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function shouldSuppressOrigVocals() {
      return audioMixerState.origPct <= 0 && (isVocalInvertOn || isDubVoiceEnabled);
    }

    function syncAudioMixerUi() {
      if (typeof document === 'undefined') return;
      const syncPair = (sliderIds, labelIds, pct) => {
        for (const id of sliderIds) {
          const el = document.getElementById(id);
          if (el) el.value = String(pct);
        }
        for (const id of labelIds) {
          const el = document.getElementById(id);
          if (el) el.innerText = `${pct}%`;
        }
      };
      syncPair(['playerOrigVolSlider', 'exportOrigVolSlider'], ['playerOrigVolLabel', 'exportOrigVolLabel'], audioMixerState.origPct);
      syncPair(['playerBgmVolSlider', 'exportBgmVolSlider'], ['playerBgmVolLabel', 'exportBgmVolLabel'], audioMixerState.bgmPct);
      syncPair(['playerDubVolSlider', 'exportDubVolSlider'], ['playerDubVolLabel', 'exportDubVolLabel'], audioMixerState.dubPct);
      for (const id of ['bgmOnPauseCheck', 'exportBgmOnPauseCheck']) {
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(audioMixerState.bgmOnPause);
      }
      const mixSlidersDisabled = Boolean(document.getElementById('exportAudioMode')?.value === 'original');
      for (const id of ['exportOrigVolSlider', 'exportBgmVolSlider', 'exportDubVolSlider', 'exportBgmOnPauseCheck']) {
        const el = document.getElementById(id);
        if (el) el.disabled = mixSlidersDisabled;
      }
    }

    function saveAudioMixerState() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(AUDIO_MIX_STORAGE_KEY, JSON.stringify(audioMixerState));
        }
      } catch (_) {}
    }

    function syncAudioMixModeFromSliders() {
      if (typeof document === 'undefined') return;
      const modeEl = document.getElementById('exportAudioMode');
      if (!modeEl || modeEl.value === 'original') return;
      if (audioMixerState.origPct > 0) {
        modeEl.value = 'mix_custom';
      } else if (audioMixerState.bgmPct > 0) {
        modeEl.value = isVocalInvertOn ? 'bgm_only' : 'mix_custom';
      } else {
        modeEl.value = 'dub_only';
      }
    }

    function disconnectDubGainNodes(audioEl) {
      if (!audioEl) return;
      try {
        if (audioEl._dubSourceNode) audioEl._dubSourceNode.disconnect();
      } catch (_) {}
      try {
        if (audioEl._dubGainNode) audioEl._dubGainNode.disconnect();
      } catch (_) {}
      audioEl._dubSourceNode = null;
      audioEl._dubGainNode = null;
    }

    function applyDubElementGain(audioEl, dubGain) {
      if (!audioEl) return;
      if (typeof ensureAudioCtxResumed === 'function') ensureAudioCtxResumed();
      const safeGain = clampNum(dubGain, 0, 2.2, 1.0);
      audioEl.volume = Math.min(1.0, safeGain);
      if (safeGain > 1.01) {
        initWebAudio();
        if (audioCtx && typeof audioCtx.createMediaElementSource === 'function') {
          try {
            if (!audioEl._dubGainNode) {
              const srcNode = audioCtx.createMediaElementSource(audioEl);
              const gainNode = audioCtx.createGain();
              srcNode.connect(gainNode);
              gainNode.connect(audioCtx.destination);
              audioEl._dubSourceNode = srcNode;
              audioEl._dubGainNode = gainNode;
            }
            audioEl._dubGainNode.gain.value = safeGain;
            audioEl.volume = 1.0;
          } catch (_) {}
        }
      } else if (audioEl._dubGainNode) {
        try {
          audioEl._dubGainNode.gain.value = 1.0;
        } catch (_) {}
      }
    }

    function setAudioMixerControl(kind, rawValue) {
      ensureAudioCtxResumed();
      if (kind === 'orig') audioMixerState.origPct = Math.round(clampNum(rawValue, 0, 100, audioMixerState.origPct));
      else if (kind === 'bgm') audioMixerState.bgmPct = Math.round(clampNum(rawValue, 0, 150, audioMixerState.bgmPct));
      else if (kind === 'dub') audioMixerState.dubPct = Math.round(clampNum(rawValue, 0, 150, audioMixerState.dubPct));
      else if (kind === 'bgmPause') audioMixerState.bgmOnPause = Boolean(rawValue);

      saveAudioMixerState();
      syncAudioMixModeFromSliders();
      syncAudioMixerUi();
      if (typeof applyVocalSuppressionState === 'function') {
        applyVocalSuppressionState(shouldSuppressOrigVocals());
      }
      const dubGain = clampNum(audioMixerState.dubPct / 100, 0, 1.5, 1.0);
      if (currentDubAudio) applyDubElementGain(currentDubAudio, dubGain);
      if (activeAudioPlayer) applyDubElementGain(activeAudioPlayer, dubGain);
      const v = typeof document !== 'undefined' ? document.getElementById('mainVideo') : null;
      if (v && typeof syncLiveSourceAudioSuppression === 'function') {
        syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
      }
      if (typeof updateExportPreviewSummary === 'function') {
        updateExportPreviewSummary();
      }
    }

    function loadSavedAudioMixerState() {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(AUDIO_MIX_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              audioMixerState.origPct = Math.round(clampNum(parsed.origPct, 0, 100, 0));
              audioMixerState.bgmPct = Math.round(clampNum(parsed.bgmPct, 0, 150, 85));
              audioMixerState.dubPct = Math.round(clampNum(parsed.dubPct, 0, 150, 100));
              if (typeof parsed.bgmOnPause === 'boolean') audioMixerState.bgmOnPause = parsed.bgmOnPause;
            }
          }
        }
      } catch (_) {}
      syncAudioMixModeFromSliders();
      syncAudioMixerUi();
      if (typeof updateExportReadinessBar === 'function') updateExportReadinessBar();
    }

    function getAudioMixExportPayload(overrideMode = null) {
      const modeEl = typeof document !== 'undefined' ? document.getElementById('exportAudioMode') : null;
      const resolvedMode = overrideMode || (modeEl ? modeEl.value : 'bgm_only');
      return {
        audioMixMode: resolvedMode,
        origVolume: Number((clampNum(audioMixerState.origPct, 0, 100, 0) / 100).toFixed(2)),
        bgVolume: Number((clampNum(audioMixerState.bgmPct, 0, 150, 85) / 100).toFixed(2)),
        dubVolume: Number((clampNum(audioMixerState.dubPct, 0, 150, 100) / 100 * 1.15).toFixed(2)),
        bgmOnPause: Boolean(audioMixerState.bgmOnPause)
      };
    }

    const audioSeparationCapabilities = {
      loaded: false,
      id: 'ffmpeg_dsp',
      model: '',
      label: 'FFmpeg DSP',
      ai: false
    };
    const _autoUpgradedBgmPaths = new Set();
    let _isIsolatingBgmInFlight = false;

    function isAiSeparationEngineClient(engineId) {
      return engineId === 'audio-separator' || engineId === 'demucs';
    }

    function syncAudioAiStatusUi() {
      if (typeof document === 'undefined') return;
      const badge = document.getElementById('audioAiEngineBadge');
      const dockBtn = document.getElementById('btnDockIsolateBgm');
      const quickBgmBtn = document.getElementById('btnQuickBgm');
      const boostBtn = document.getElementById('btnQuickAudioBoost');
      const boostTag = document.getElementById('boostTag');
      const presetBgmDub = document.getElementById('presetBgmDubBtn');
      const presetMovieDub = document.getElementById('presetMovieDubBtn');
      const presetOrigOnly = document.getElementById('presetOrigOnlyBtn');

      const hasAiEngine = Boolean(audioSeparationCapabilities.ai);
      const hasStem = Boolean(currentIsolatedBgmUrl);
      const stemIsAi = isAiSeparationEngineClient(currentIsolatedBgmEngine);

      if (badge) {
        if (typeof badge.classList?.remove === 'function') {
          badge.classList.remove('is-ai', 'is-dsp', 'is-busy');
        }
        if (_isIsolatingBgmInFlight) {
          badge.classList?.add('is-busy');
          badge.innerText = hasAiEngine
            ? '⏳ កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU)...'
            : '⏳ កំពុងបំបែកភ្លេង BGM...';
        } else if (hasStem && stemIsAi) {
          badge.classList?.add('is-ai');
          badge.innerText = '✅ BGM+SFX ដោយ UVR AI (GPU)';
        } else if (hasStem) {
          badge.classList?.add('is-dsp');
          badge.innerText = hasAiEngine
            ? '⚠️ Stem ចាស់ (DSP) — ចុច Upgrade ទៅ UVR AI GPU'
            : '🎛️ BGM ដោយ FFmpeg DSP';
        } else if (hasAiEngine) {
          badge.classList?.add('is-ai');
          badge.innerText = '⚡ UVR MDX-Net AI (GPU រួចរាល់) · ចុច «បំបែក AI»';
        } else {
          badge.classList?.add('is-dsp');
          badge.innerText = '🎛️ ម៉ាស៊ីន BGM៖ FFmpeg DSP';
        }
      }

      if (dockBtn) {
        dockBtn.disabled = _isIsolatingBgmInFlight;
        if (_isIsolatingBgmInFlight) {
          dockBtn.innerText = '⏳ AI...';
        } else if (hasStem && stemIsAi) {
          dockBtn.innerText = '🔄 AI ម្តងទៀត';
        } else if (hasStem && hasAiEngine) {
          dockBtn.innerText = '⚡ Upgrade AI';
        } else {
          dockBtn.innerText = hasAiEngine ? '🎵 បំបែក AI' : '🎵 បំបែក BGM';
        }
      }

      if (quickBgmBtn && !_isIsolatingBgmInFlight) {
        if (hasStem && isVocalInvertOn) {
          quickBgmBtn.innerText = stemIsAi ? '🎵 AI BGM ✓' : '🎵 BGM (DSP)';
        } else if (isVocalInvertOn) {
          quickBgmBtn.innerText = '🎵 BGM ON';
        } else {
          quickBgmBtn.innerText = hasAiEngine ? '🎵 BGM AI' : '🎵 BGM';
        }
      }

      if (boostBtn) boostBtn.classList?.toggle('active', Boolean(isBoostOn));
      if (boostTag) boostTag.innerText = isBoostOn ? '250%' : 'OFF';

      const dubOn = Boolean(isDubVoiceEnabled);
      if (presetBgmDub) {
        presetBgmDub.classList?.toggle('active', dubOn && audioMixerState.origPct <= 0 && audioMixerState.bgmPct > 0);
      }
      if (presetMovieDub) {
        presetMovieDub.classList?.toggle('active', dubOn && audioMixerState.origPct > 0 && audioMixerState.origPct < 90);
      }
      if (presetOrigOnly) {
        presetOrigOnly.classList?.toggle('active', !dubOn && audioMixerState.origPct >= 90);
      }
    }

    async function refreshAudioCapabilities() {
      if (typeof fetch !== 'function') return audioSeparationCapabilities;
      try {
        const res = await fetch(`${BACKEND_URL}/api/audio/capabilities`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.success && data.engine) {
            Object.assign(audioSeparationCapabilities, {
              loaded: true,
              id: data.engine.id || 'ffmpeg_dsp',
              model: data.engine.model || '',
              label: data.engine.label || 'FFmpeg DSP',
              ai: Boolean(data.engine.ai)
            });
          } else {
            audioSeparationCapabilities.loaded = true;
          }
        } else {
          audioSeparationCapabilities.loaded = true;
        }
      } catch (_) {
        audioSeparationCapabilities.loaded = true;
      }
      syncAudioAiStatusUi();
      return audioSeparationCapabilities;
    }

    const STT_ENGINE_STORAGE_KEY = 'eza_stt_engine_v1';
    const STT_LOCAL_SUPPORTED_LANGS = new Set(['auto', 'zh', 'zh-cn', 'zh-hans', 'zh-km', 'yue', 'en', 'en-km', 'ja', 'ko']);
    const speechSttCapabilities = {
      loaded: false,
      defaultEngine: 'gemini',
      sensevoice: {
        available: false,
        cuda: false,
        device: 'cpu',
        gpuName: '',
        modelsCached: false
      }
    };

    function normalizeClientSttEngine(raw) {
      const val = String(raw || '').trim().toLowerCase();
      if (val === 'sensevoice' || val === 'sensevoice_local' || val === 'local') return 'sensevoice';
      if (val === 'cloud_gemini' || val === 'gemini' || val === 'cloud') return 'cloud_gemini';
      return 'auto';
    }

    function syncSttEngineSelects(nextVal) {
      const chosen = normalizeClientSttEngine(nextVal);
      if (typeof document !== 'undefined') {
        for (const id of ['sttEngineSelect', 'vmSttEngineSelect']) {
          const el = document.getElementById(id);
          if (el) el.value = chosen;
        }
      }
      return chosen;
    }

    function getSelectedSttEngine() {
      if (typeof document !== 'undefined') {
        const el = document.getElementById('sttEngineSelect') || document.getElementById('vmSttEngineSelect');
        if (el && el.value) return normalizeClientSttEngine(el.value);
      }
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem) {
          const saved = localStorage.getItem(STT_ENGINE_STORAGE_KEY);
          if (saved) return normalizeClientSttEngine(saved);
        }
      } catch (_) {}
      return 'auto';
    }

    function loadSavedSttEngine() {
      let chosen = 'auto';
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem) {
          const saved = localStorage.getItem(STT_ENGINE_STORAGE_KEY);
          if (saved) chosen = normalizeClientSttEngine(saved);
        }
      } catch (_) {}
      return syncSttEngineSelects(chosen);
    }

    function onSttEngineChange(nextEngine) {
      const chosen = syncSttEngineSelects(nextEngine);
      try {
        if (typeof localStorage !== 'undefined' && localStorage.setItem) {
          localStorage.setItem(STT_ENGINE_STORAGE_KEY, chosen);
        }
      } catch (_) {}
      if (typeof showShortcutToast === 'function') {
        const msg = chosen === 'sensevoice'
          ? '🧠 បានជ្រើស Local GPU (SenseVoice-Small) សម្រាប់ស្ដាប់សំឡេង'
          : (chosen === 'cloud_gemini'
            ? '☁️ បានជ្រើស Gemini Cloud សម្រាប់ស្ដាប់សំឡេង'
            : '⚡ បានជ្រើស Auto (SenseVoice GPU → Gemini Fallback)');
        showShortcutToast(msg);
      }
      return chosen;
    }

    function willUseLocalSenseVoice(sourceLang = 'auto') {
      const sel = getSelectedSttEngine();
      if (sel === 'cloud_gemini') return false;
      const langOk = STT_LOCAL_SUPPORTED_LANGS.has(String(sourceLang || 'auto').trim().toLowerCase());
      if (sel === 'sensevoice') return langOk;
      return Boolean(speechSttCapabilities.sensevoice && speechSttCapabilities.sensevoice.available && langOk);
    }

    function syncSpeechCapabilitiesUi() {
      if (typeof document === 'undefined') return;
      const sv = speechSttCapabilities.sensevoice || {};
      const gpuShort = sv.gpuName ? sv.gpuName.replace(/^NVIDIA\s+GeForce\s+/i, '') : (sv.cuda ? 'CUDA GPU' : 'CPU');
      const svLabel = sv.available
        ? `🧠 SenseVoice (${gpuShort}${sv.modelsCached ? ' · រួចរាល់' : ''})`
        : '🧠 SenseVoice Local (មិនទាន់ដំឡើង)';
      for (const id of ['sttEngineSelect', 'vmSttEngineSelect']) {
        const el = document.getElementById(id);
        if (!el || !el.options) continue;
        for (const opt of Array.from(el.options)) {
          if (opt.value === 'sensevoice') {
            opt.text = svLabel;
            opt.disabled = Boolean(speechSttCapabilities.loaded && !sv.available);
          } else if (opt.value === 'auto') {
            opt.text = sv.available ? `⚡ Auto (SenseVoice ${gpuShort})` : '⚡ Auto (Gemini Cloud)';
          }
        }
      }
    }

    async function refreshSpeechCapabilities() {
      if (typeof fetch !== 'function') return speechSttCapabilities;
      try {
        const res = await fetch(`${BACKEND_URL}/api/translation/speech-capabilities`);
        if (!res.ok) return speechSttCapabilities;
        const data = await res.json();
        if (data && data.success && data.engines && data.engines.sensevoice) {
          speechSttCapabilities.loaded = true;
          speechSttCapabilities.defaultEngine = data.defaultEngine || 'gemini';
          Object.assign(speechSttCapabilities.sensevoice, data.engines.sensevoice);
        }
      } catch (_) {}
      syncSpeechCapabilitiesUi();
      return speechSttCapabilities;
    }

    function applyAudioMixPreset(presetName) {
      initWebAudio();
      ensureAudioCtxResumed();
      const quickBgmBtn = document.getElementById('btnQuickBgm');
      if (presetName === 'orig_only') {
        setDubVoiceEnabled(false);
        isVocalInvertOn = false;
        if (quickBgmBtn) quickBgmBtn.classList?.remove('active');
        audioMixerState.origPct = 100;
        audioMixerState.bgmOnPause = false;
      } else if (presetName === 'movie_plus_dub') {
        setDubVoiceEnabled(true);
        isVocalInvertOn = true;
        if (quickBgmBtn) quickBgmBtn.classList?.add('active');
        audioMixerState.origPct = 25;
        if (audioMixerState.bgmPct <= 0) audioMixerState.bgmPct = 85;
        audioMixerState.bgmOnPause = true;
      } else {
        setDubVoiceEnabled(true);
        isVocalInvertOn = true;
        if (quickBgmBtn) quickBgmBtn.classList?.add('active');
        audioMixerState.origPct = 0;
        if (audioMixerState.bgmPct <= 0) audioMixerState.bgmPct = 85;
        audioMixerState.bgmOnPause = true;
      }
      saveAudioMixerState();
      syncAudioMixModeFromSliders();
      syncAudioMixerUi();
      if (typeof applyVocalSuppressionState === 'function') {
        applyVocalSuppressionState(shouldSuppressOrigVocals());
      }
      const v = document.getElementById('mainVideo');
      if (v && typeof syncLiveSourceAudioSuppression === 'function') {
        syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
      }
      syncAudioAiStatusUi();
      if (presetName !== 'orig_only' && currentVideoPath && (!currentIsolatedBgmUrl || (audioSeparationCapabilities.ai && !isAiSeparationEngineClient(currentIsolatedBgmEngine)))) {
        requestBgmIsolationForCurrentVideo({ activateVocalInvert: true });
      }
      if (typeof showShortcutToast === 'function') {
        const msg = presetName === 'orig_only'
          ? '🔊 កំពុងស្ដាប់សំឡេងរឿងដើម 100% (បិទ Dub)'
          : (presetName === 'movie_plus_dub'
            ? '🎬 លាយសំឡេងរឿង (25%) + BGM/SFX + Dubbing ខ្មែរ'
            : '🎼 ភ្លេង BGM/SFX សុទ្ធ + Dubbing ខ្មែរ');
        showShortcutToast(msg);
      }
    }

    const SUBTITLE_MASK_STORAGE_KEY = 'eza_subtitle_mask_v1';
    const DEFAULT_SUBTITLE_MASK_STATE = {
      enabled: false,
      mode: 'feathered',
      xPercent: 4,
      yPercent: 78,
      wPercent: 92,
      hPercent: 8,
      blurSigma: 14
    };

    function clampMaskNumber(raw, min, max, fallback) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    function normalizeSubtitleMaskState(candidate = {}) {
      const wPercent = Number(clampMaskNumber(candidate.wPercent, 5, 100, DEFAULT_SUBTITLE_MASK_STATE.wPercent).toFixed(1));
      const hPercent = Number(clampMaskNumber(candidate.hPercent, 2, 60, DEFAULT_SUBTITLE_MASK_STATE.hPercent).toFixed(1));
      const xPercent = Number(clampMaskNumber(candidate.xPercent, 0, Math.max(0, 100 - wPercent), DEFAULT_SUBTITLE_MASK_STATE.xPercent).toFixed(1));
      const yPercent = Number(clampMaskNumber(candidate.yPercent, 0, Math.max(0, 100 - hPercent), DEFAULT_SUBTITLE_MASK_STATE.yPercent).toFixed(1));
      const blurSigma = Math.round(clampMaskNumber(candidate.blurSigma, 2, 40, DEFAULT_SUBTITLE_MASK_STATE.blurSigma));
      const allowedModes = ['feathered', 'cinema_bar', 'blur', 'black', 'frosted'];
      const mode = allowedModes.includes(candidate.mode) ? candidate.mode : DEFAULT_SUBTITLE_MASK_STATE.mode;
      return {
        enabled: Boolean(candidate.enabled),
        mode,
        xPercent,
        yPercent,
        wPercent,
        hPercent,
        blurSigma
      };
    }

    function loadSubtitleMaskState() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const raw = localStorage.getItem(SUBTITLE_MASK_STORAGE_KEY);
          if (raw) return normalizeSubtitleMaskState(JSON.parse(raw));
        }
      } catch (_) {}
      return { ...DEFAULT_SUBTITLE_MASK_STATE };
    }

    const subtitleMaskState = loadSubtitleMaskState();

    function saveSubtitleMaskState() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(SUBTITLE_MASK_STORAGE_KEY, JSON.stringify(subtitleMaskState));
        }
      } catch (_) {}
    }

    function getSubtitleAndMaskExportPayload() {
      const getEl = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
      const maskCheckEl = getEl('maskToggleCheck') || getEl('exportMaskCheck');
      const maskModeEl = getEl('maskModeSelect') || getEl('exportMaskMode');
      const subStyleEl = getEl('subStyleSelect') || getEl('exportSubStyle');
      const rawX = getEl('maskXSlider')?.value;
      const rawY = getEl('maskYSlider')?.value;
      const rawW = getEl('maskWSlider')?.value;
      const rawH = getEl('maskHSlider')?.value;
      const rawBlur = getEl('maskBlurSlider')?.value;
      const normalized = normalizeSubtitleMaskState({
        enabled: maskCheckEl ? maskCheckEl.checked : subtitleMaskState.enabled,
        mode: (maskModeEl && maskModeEl.value) || subtitleMaskState.mode,
        xPercent: rawX !== undefined ? rawX : subtitleMaskState.xPercent,
        yPercent: rawY !== undefined ? rawY : subtitleMaskState.yPercent,
        wPercent: rawW !== undefined ? rawW : subtitleMaskState.wPercent,
        hPercent: rawH !== undefined ? rawH : subtitleMaskState.hPercent,
        blurSigma: rawBlur !== undefined ? rawBlur : subtitleMaskState.blurSigma
      });
      const rawFontPx = (typeof currentSubFontSize === 'number' && Number.isFinite(currentSubFontSize)) ? currentSubFontSize : 16;
      const rawPosYPct = (typeof currentSubPosYPercent === 'number' && Number.isFinite(currentSubPosYPercent)) ? currentSubPosYPercent : 8;
      // PlayResY is 1920 in ASS. With Alignment: 2 (bottom-center), MarginV is distance from bottom in pixels.
      // 8% -> 154, 15% -> 288, 48% -> 922, 82% -> 1574.
      const computedMarginV = Math.abs(rawPosYPct - 8) < 0.05
        ? 154
        : Math.max(20, Math.min(1800, Math.round((rawPosYPct / 100) * 1920)));

      return {
        maskEnabled: normalized.enabled,
        maskMode: normalized.mode,
        subStyle: (subStyleEl && subStyleEl.value) || currentSubStyle || 'tiktok',
        subFontSize: Math.round(rawFontPx * 3.6),
        subMarginV: computedMarginV,
        subPrimaryColor: (typeof currentSubTextColor === 'string' && currentSubTextColor.trim()) ? currentSubTextColor.trim() : null,
        subOutlineColor: (typeof currentSubOutlineColor === 'string' && currentSubOutlineColor.trim()) ? currentSubOutlineColor.trim() : null,
        wordPopEnabled: typeof isWordPopEnabled === 'boolean' ? isWordPopEnabled : true,
        maskXPercent: Number((normalized.xPercent / 100).toFixed(4)),
        maskYPercent: Number((normalized.yPercent / 100).toFixed(4)),
        maskWPercent: Number((normalized.wPercent / 100).toFixed(4)),
        maskHPercent: Number((normalized.hPercent / 100).toFixed(4)),
        maskBlurSigma: normalized.blurSigma,
        customTextOverlay: typeof getCustomTextOverlayExportPayload === 'function'
          ? getCustomTextOverlayExportPayload()
          : null
      };
    }

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
          if (next.startSec - cur.startSec >= 0.25) {
            cur.endSec = Number((next.startSec - 0.02).toFixed(3));
          } else {
            const cleanEnd = Number((cur.startSec + Math.min(0.6, Math.max(0.25, textLen * 0.045))).toFixed(3));
            cur.endSec = cleanEnd;
            next.startSec = Number((cleanEnd + 0.03).toFixed(3));
            next.start = formatSecToDisplay(next.startSec);
            if (next.endSec <= next.startSec + 0.25) {
              next.endSec = Number((next.startSec + 1.0).toFixed(3));
              next.end = formatSecToDisplay(next.endSec);
            }
          }
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

    let autoVoiceBatchTimer = null;
    let previewAudioPlayer = null;

    const VOICE_SAMPLE_TEXTS = {
      'Sovereign King': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងពិសិទ្ធ បុរសធម្មតា។',
      'Radiant Queen': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងស្រីមុំ ស្ត្រីធម្មតា។',
      'kh_narrator_fast': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងនិទានរឿង TikTok រហ័សទាន់ចិត្ត។',
      'kh_young_man': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងយុវជន ក្មេង ស្រស់ថ្លា។',
      'kh_deep_boss': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងលោកប្រធាន ឬលោកតា ធ្ងន់ និងម៉ឺងម៉ាត់។',
      'kh_young_girl': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងយុវតី ឬក្មេងស្រី ស្រស់ស្រាយ។',
      'kh_child': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងកូនក្មេង តូច គួរឲ្យស្រឡាញ់។',
      'kh_elder_woman': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងម្តាយ ឬលោកយាយ ធ្ងន់ និងស្ងប់។'
    };

    let currentCustomVoicePitch = null;
    let currentCustomVoiceRate = null;

    function getPresetDefaultProsody(voiceId) {
      const norm = normalizeVoicePresetId(voiceId || getSelectedSingleVoice());
      const preset = VOICE_PRESETS.find(p => p.id === norm);
      return {
        pitch: Number(preset?.pitchNum ?? preset?.pitch ?? 0) || 0,
        rate: Number(preset?.rateNum ?? preset?.rate ?? 0) || 0
      };
    }

    function getEffectiveVoiceProsody(voiceId) {
      const defaults = getPresetDefaultProsody(voiceId);
      const pitch = (currentCustomVoicePitch !== null && Number.isFinite(currentCustomVoicePitch))
        ? currentCustomVoicePitch
        : defaults.pitch;
      const rate = (currentCustomVoiceRate !== null && Number.isFinite(currentCustomVoiceRate))
        ? currentCustomVoiceRate
        : defaults.rate;
      return {
        pitch,
        rate,
        pitchStr: pitch >= 0 ? `+${pitch}Hz` : `${pitch}Hz`,
        rateStr: rate >= 0 ? `+${rate}%` : `${rate}%`,
        isCustom: currentCustomVoicePitch !== null || currentCustomVoiceRate !== null
      };
    }

    function getVoicePitchBadgeText(pitchNum) {
      const n = Number(pitchNum) || 0;
      if (n <= -20) return 'ធ្ងន់ខ្លាំង';
      if (n <= -8) return 'ធ្ងន់/ក្រាស់';
      if (n >= 25) return 'កូនក្មេង/ស្រួច';
      if (n >= 10) return 'ស្រួយ/ស្តើង';
      return 'ធម្មតា';
    }

    function syncVoiceTunerUiToCurrentVoice() {
      if (typeof document === 'undefined') return;
      const chosen = getSelectedSingleVoice();
      const defaults = getPresetDefaultProsody(chosen);
      const curPitch = (currentCustomVoicePitch !== null) ? currentCustomVoicePitch : defaults.pitch;
      const curRate = (currentCustomVoiceRate !== null) ? currentCustomVoiceRate : defaults.rate;

      const labelEl = document.getElementById('voiceTunerPresetLabel');
      if (labelEl) {
        const p = VOICE_PRESETS.find(v => v.id === chosen);
        labelEl.textContent = p ? p.label.replace(/^[^a-zA-Z\u1780-\u17FF]+/, '') : chosen;
      }

      const rateSlider = document.getElementById('voiceRateSlider');
      const rateValText = document.getElementById('voiceRateValText');
      if (rateSlider) rateSlider.value = curRate;
      if (rateValText) rateValText.textContent = curRate >= 0 ? `+${curRate}%` : `${curRate}%`;

      const pitchSlider = document.getElementById('voicePitchSlider');
      const pitchValText = document.getElementById('voicePitchValText');
      const pitchBadge = document.getElementById('voicePitchBadge');
      if (pitchSlider) pitchSlider.value = curPitch;
      if (pitchValText) pitchValText.textContent = curPitch >= 0 ? `+${curPitch}Hz` : `${curPitch}Hz`;
      if (pitchBadge) pitchBadge.textContent = getVoicePitchBadgeText(curPitch);
    }

    function toggleVoiceTunerPanel(force) {
      if (typeof document === 'undefined') return;
      const drawer = document.getElementById('voiceTunerDrawer');
      if (!drawer) return;
      const show = typeof force === 'boolean' ? force : (drawer.style.display === 'none' || !drawer.style.display);
      drawer.style.display = show ? 'block' : 'none';
      if (show) {
        syncVoiceTunerUiToCurrentVoice();
      }
    }

    function onVoiceRateSliderInput(val) {
      const num = Math.min(50, Math.max(-30, Math.round(Number(val) || 0)));
      currentCustomVoiceRate = num;
      const valText = typeof document !== 'undefined' && document.getElementById('voiceRateValText');
      if (valText) valText.textContent = num >= 0 ? `+${num}%` : `${num}%`;
    }

    function onVoicePitchSliderInput(val) {
      const num = Math.min(45, Math.max(-35, Math.round(Number(val) || 0)));
      currentCustomVoicePitch = num;
      const valText = typeof document !== 'undefined' && document.getElementById('voicePitchValText');
      const badge = typeof document !== 'undefined' && document.getElementById('voicePitchBadge');
      if (valText) valText.textContent = num >= 0 ? `+${num}Hz` : `${num}Hz`;
      if (badge) badge.textContent = getVoicePitchBadgeText(num);
    }

    function resetVoiceTuningToPreset() {
      const chosen = getSelectedSingleVoice();
      const defaults = getPresetDefaultProsody(chosen);
      currentCustomVoicePitch = null;
      currentCustomVoiceRate = null;
      syncVoiceTunerUiToCurrentVoice();
      if (Array.isArray(activeCues) && activeCues.length > 0) {
        for (const cue of activeCues) {
          if (cue) {
            delete cue.pitch;
            delete cue.rate;
          }
        }
        renderTable();
        checkAllAudioCache();
      }
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(`🔄 បានកំណត់សំនៀងតាម Preset ដើម (${defaults.pitch >= 0 ? '+' : ''}${defaults.pitch}Hz, ${defaults.rate >= 0 ? '+' : ''}${defaults.rate}%)`);
      }
    }

    function applyNarratorTuningPreset() {
      onVoiceRateSliderInput(12);
      onVoicePitchSliderInput(-4);
      const rateSlider = typeof document !== 'undefined' && document.getElementById('voiceRateSlider');
      const pitchSlider = typeof document !== 'undefined' && document.getElementById('voicePitchSlider');
      if (rateSlider) rateSlider.value = 12;
      if (pitchSlider) pitchSlider.value = -4;
      applyTunedVoiceToAllCues();
      if (typeof showShortcutToast === 'function') {
        showShortcutToast('🎙️ បានអនុវត្តសំនៀងសម្រាយរឿង (+12% ល្បឿន, -4Hz ធ្ងន់/គ្រល័រ)');
      }
    }

    async function previewTunedVoice() {
      const chosen = getSelectedSingleVoice();
      const prosody = getEffectiveVoiceProsody(chosen);
      await previewVoice(chosen, { pitch: prosody.pitch, rate: prosody.rate });
    }

    function applyTunedVoiceToAllCues() {
      const chosen = getSelectedSingleVoice();
      const prosody = getEffectiveVoiceProsody(chosen);
      if (Array.isArray(activeCues) && activeCues.length > 0) {
        for (const cue of activeCues) {
          if (cue) {
            cue.voice = chosen;
            cue.pitch = prosody.pitch;
            cue.rate = prosody.rate;
          }
        }
        renderTable();
        checkAllAudioCache();
        if (typeof batchGenerateAllAudio === 'function') {
          batchGenerateAllAudio({ onlyMissing: false, silentSuccess: false }).catch(() => {});
        }
      }
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(`✅ បានអនុវត្តសំនៀងថ្មី (${prosody.pitchStr}, ${prosody.rateStr}) ទៅគ្រប់បន្ទាត់ទាំងអស់!`);
      }
    }

    async function previewVoice(voiceId, options = {}) {
      if (typeof fetch !== 'function') return;
      const chosen = normalizeVoicePresetId(voiceId || getSelectedSingleVoice());
      const sampleText = VOICE_SAMPLE_TEXTS[chosen] || 'ជំរាបសួរ! ខ្ញុំជាសំឡេងខ្មែរ AI។';
      try {
        if (!previewAudioPlayer && typeof Audio === 'function') {
          previewAudioPlayer = new Audio();
          if (previewAudioPlayer) previewAudioPlayer.crossOrigin = 'anonymous';
        }
        if (previewAudioPlayer && typeof previewAudioPlayer.pause === 'function') {
          try {
            previewAudioPlayer.pause();
            previewAudioPlayer.currentTime = 0;
          } catch (_) {}
        }

        const payload = { voice: chosen, text: sampleText };
        if (options && options.pitch !== undefined && options.pitch !== null) {
          payload.pitch = options.pitch;
        }
        if (options && options.rate !== undefined && options.rate !== null) {
          payload.rate = options.rate;
        }

        const res = await fetch(`${BACKEND_URL}/api/tts/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data && data.audioUrl && previewAudioPlayer) {
          const resolvedUrl = resolveBackendUrl(data.audioUrl);
          previewAudioPlayer.src = resolvedUrl;
          previewAudioPlayer.volume = 1.0;
          if (typeof ensureAudioCtxResumed === 'function') ensureAudioCtxResumed();
          if (typeof previewAudioPlayer.play === 'function') {
            previewAudioPlayer.play().catch(e => console.warn('Preview play warning:', e.message));
          }
        }
      } catch (err) {
        console.warn('Voice preview failed:', err.message);
      }
    }

    function previewCurrentVoice(selectId = 'defaultVoiceSelect') {
      const el = typeof document !== 'undefined' && document.getElementById(selectId);
      const voice = el && el.value ? el.value : getSelectedSingleVoice();
      previewVoice(voice);
    }

    function onDefaultVoiceChange(nextVoice, options = {}) {
      singleVoiceUserChanged = true;
      currentCustomVoicePitch = null;
      currentCustomVoiceRate = null;
      const chosen = syncSingleVoiceSelects(nextVoice || getSelectedSingleVoice());
      syncVoiceTunerUiToCurrentVoice();
      try {
        if (typeof localStorage !== 'undefined' && localStorage.setItem) {
          localStorage.setItem(DEFAULT_VOICE_STORAGE_KEY, chosen);
        }
      } catch (_) {}

      if (Array.isArray(activeCues) && activeCues.length > 0) {
        const changed = normalizeActiveCuesForCastMode(activeCues, 'single', chosen, { clearCustomProsody: true });
        if (changed) {
          renderTable();
          checkAllAudioCache();
          if (options.autoBatch !== false) {
            if (autoVoiceBatchTimer) clearTimeout(autoVoiceBatchTimer);
            autoVoiceBatchTimer = setTimeout(() => {
              if (Array.isArray(activeCues) && activeCues.length > 0 && typeof batchGenerateAllAudio === 'function') {
                batchGenerateAllAudio({ onlyMissing: true, silentSuccess: false }).catch(() => {});
              }
            }, 300);
          }
        }
      }
      if (Array.isArray(vmQueue) && vmQueue.length > 0) {
        for (const vmItem of vmQueue) {
          if (vmItem && Array.isArray(vmItem.cues) && vmItem.cues.length > 0) {
            normalizeActiveCuesForCastMode(vmItem.cues, 'single', chosen, { clearCustomProsody: true });
          }
        }
      }
      if (options.preview !== false) {
        previewVoice(chosen);
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

    function normalizeActiveCuesForCastMode(cues = activeCues, castMode = getActiveCastMode(), fixedVoice = getSelectedSingleVoice(), opts = {}) {
      if (!Array.isArray(cues)) return false;
      const clearCustomProsody = Boolean(opts && opts.clearCustomProsody);
      let changed = false;
      for (let i = 0; i < cues.length; i++) {
        if (!cues[i]) continue;
        const targetVoice = collapseCueVoiceForMode(cues[i].voice, castMode, fixedVoice);
        if (cues[i].voice !== targetVoice) {
          cues[i].voice = targetVoice;
          changed = true;
        }
        if (clearCustomProsody) {
          if (cues[i].pitch !== undefined) {
            delete cues[i].pitch;
            changed = true;
          }
          if (cues[i].rate !== undefined) {
            delete cues[i].rate;
            changed = true;
          }
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

    function getVoiceSignature(voice, emotion = 'auto', engine = getActiveTtsEngine(), prosody = null) {
      const str = typeof voice === 'string' ? voice.trim() : '';
      const preset = VOICE_PRESETS.find(p => p.id === str);
      if (preset && preset.isClone) {
        return `clone:${preset.id}|b=${preset.baseVoice || 'km-KH-PisethNeural'}|r=${preset.revision || 1}`;
      }
      if (isCustomCloneVoiceId(str)) {
        return `clone:${str}`;
      }
      let sig;
      const baseVoice = preset ? preset.baseVoice : resolveVoiceName(str);
      const pitchVal = (prosody && prosody.pitch !== undefined && prosody.pitch !== null)
        ? prosody.pitch
        : (preset ? (preset.pitchNum ?? preset.pitch) : 0);
      const rateVal = (prosody && prosody.rate !== undefined && prosody.rate !== null)
        ? prosody.rate
        : (preset ? (preset.rateNum ?? preset.rate) : 0);
      const pitchNum = Number(pitchVal) || 0;
      const rateNum = Number(rateVal) || 0;
      if (pitchNum !== 0 || rateNum !== 0) {
        const pStr = pitchNum >= 0 ? `+${pitchNum}Hz` : `${pitchNum}Hz`;
        const rStr = rateNum >= 0 ? `+${rateNum}%` : `${rateNum}%`;
        sig = `${baseVoice}|p=${pStr}|r=${rStr}`;
      } else {
        sig = baseVoice;
      }
      const emo = normalizeEmotionId(emotion);
      if (emo && emo !== 'auto' && emo !== 'natural') {
        sig += `|e=${emo}`;
      }
      return sig;
    }

    function getAudioCacheKey(voice, text, emotion = 'auto', engine = getActiveTtsEngine(), prosody = null) {
      return `${getVoiceSignature(voice, emotion, engine, prosody)}:${String(text || '').trim()}`;
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
        return appendAccessTokenToUrl(assetUrl);
      }
      const full = assetUrl.startsWith('/') ? `${BACKEND_URL}${assetUrl}` : `${BACKEND_URL}/${assetUrl}`;
      return appendAccessTokenToUrl(full);
    }

    function stopDubAudio() {
      dubRequestToken++;
      activeSpeakingCueIdx = -1;
      if (currentDubAudio) {
        try {
          currentDubAudio.pause();
          currentDubAudio.currentTime = 0;
        } catch (_) {}
        disconnectDubGainNodes(currentDubAudio);
        currentDubAudio = null;
      }
      if (!isBgmOn && bgmAudio && !bgmAudio.paused) {
        try { bgmAudio.pause(); } catch (_) {}
      }
      const v = document.getElementById('mainVideo');
      if (v && !isDubVoiceEnabled && !isVocalInvertOn && dubVolumeBeforeDuck !== null) {
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
      if (typeof document !== 'undefined') {
        const stage = document.getElementById('previewStage') ||
          document.querySelector('.video-preview-wrapper') ||
          document.getElementById('previewFrameBox') ||
          document.getElementById('videoDropZone');
        if (stage && v) {
          stage.classList.toggle('is-playing', !v.paused);
        }
      }
    }

    function setVideoSource(src, isObjectUrl = false) {
      _bgmIsolationSeq++;
      _isIsolatingBgmInFlight = false;
      currentIsolatedBgmUrl = null;
      currentIsolatedVocalsUrl = null;
      currentIsolatedBgmEngine = '';
      const quickBgmBtn = typeof document !== 'undefined' ? document.getElementById('btnQuickBgm') : null;
      if (quickBgmBtn) {
        quickBgmBtn.classList.toggle('active', Boolean(isVocalInvertOn));
        quickBgmBtn.innerText = isVocalInvertOn ? '🎵 BGM ON' : '🎵 BGM';
      }
      if (typeof syncAudioAiStatusUi === 'function') syncAudioAiStatusUi();
      if (bgmAudio) {
        if (!bgmAudio.paused) {
          try { bgmAudio.pause(); } catch (_) {}
        }
        try {
          if (typeof bgmAudio.removeAttribute === 'function') bgmAudio.removeAttribute('src');
          else bgmAudio.src = '';
          if (typeof bgmAudio.load === 'function') bgmAudio.load();
        } catch (_) {}
        bgmAudio._assignedSrc = '';
        bgmAudio._lastSyncSeekAt = 0;
      }
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
        const finalSrc = isObjectUrl ? src : appendAccessTokenToUrl(src);
        if (isObjectUrl) activeObjectUrl = finalSrc;
        v.src = finalSrc;
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
    bgmAudio.crossOrigin = 'anonymous';
    if (typeof bgmAudio.addEventListener === 'function') {
      bgmAudio.addEventListener('loadedmetadata', () => {
        const v = typeof document !== 'undefined' ? document.getElementById('mainVideo') : null;
        if (!v || !currentIsolatedBgmUrl) return;
        const drift = Math.abs((bgmAudio.currentTime || 0) - (v.currentTime || 0));
        if (drift > 0.08) {
          bgmAudio._lastSyncSeekAt = Date.now();
          try { bgmAudio.currentTime = v.currentTime || 0; } catch (_) {}
        }
      });
    }
    let isBgmOn = false;

    // Caching state for audio hashes
    let cachedAudioMap = new Set();

    async function saveDraftNow() {
      if (!currentVideoPath) {
        return alert('សូមបើកវីដេអូពី Folder ឬជ្រើសឯកសារវីដេអូជាមុនសិន។');
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
        if (currentVideoPath) syncCachedBgmStemForVideo(currentVideoPath);
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

    function syncUiAfterCueHistoryRestore(toastText) {
      lastTriggeredCueIdx = -1;
      if (!Array.isArray(activeCues) || activeCues.length === 0) {
        selectedCueIndex = -1;
      } else if (selectedCueIndex >= activeCues.length) {
        selectedCueIndex = activeCues.length - 1;
      }
      const sub = typeof document !== 'undefined' ? document.getElementById('liveSubtitleText') : null;
      if (sub) {
        if (sub.dataset) sub.dataset.karaokeKey = '';
        sub.style.display = 'none';
      }
      renderTable();
      renderTimeline();
      if (typeof syncActiveCuesToQueueAndEpisode === 'function') syncActiveCuesToQueueAndEpisode();
      if (typeof updateTranslationState === 'function') updateTranslationState();
      if (typeof updateVoiceReadyBadge === 'function') updateVoiceReadyBadge();
      if (typeof checkAllAudioCache === 'function') checkAllAudioCache();
      showShortcutToast(toastText);
    }

    function undoAction() {
      if (undoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវមិនធ្វើវិញ'); return; }
      redoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = undoStack.pop();
      syncUiAfterCueHistoryRestore('↩️ មិនធ្វើវិញ');
    }

    function redoAction() {
      if (redoStack.length === 0) { showShortcutToast('⚠️ គ្មានអ្វីត្រូវធ្វើវិញ'); return; }
      undoStack.push(JSON.parse(JSON.stringify(activeCues)));
      activeCues = redoStack.pop();
      syncUiAfterCueHistoryRestore('↪️ ធ្វើវិញ');
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
        const res = await fetch(`${BACKEND_URL}/api/drafts/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: activeCues, videoPath: currentVideoPath, timestamp: Date.now(), isAutoSave: true })
        });
        if (!res.ok) return;
        const st = document.getElementById('bottomStatusMsg');
        if (!st) return;
        const prev = st.innerText;
        const savedMsg = '💾 បានរក្សាទុកស្វ័យប្រវត្តិ';
        st.innerText = savedMsg;
        setTimeout(() => { if (st.innerText === savedMsg && prev !== savedMsg) st.innerText = prev; }, 2000);
      } catch(e) { console.error('Auto-save error:', e); }
    }

    // 1. Initialize Real Project
    async function initProject() {
      try {
        const video = document.getElementById('mainVideo');
        if (video && !video.dataset.syncBound) {
          video.dataset.syncBound = 'true';
          video.addEventListener('play', () => {
            ensureAudioCtxResumed();
            syncPlayPauseButton();
            startSyncLoop();
            syncLiveSourceAudioSuppression(video, activeSpeakingCueIdx);
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
            lastTriggeredCueIdx = -1;
          });
          video.addEventListener('seeked', () => {
            ensureAudioCtxResumed();
            lastTriggeredCueIdx = -1;
            if (bgmAudio) {
              bgmAudio._lastSyncSeekAt = 0;
              if (bgmAudio.src && bgmAudio.readyState >= 1) {
                try { bgmAudio.currentTime = video.currentTime || 0; } catch (_) {}
              }
            }
            syncLiveSourceAudioSuppression(video, activeSpeakingCueIdx);
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
        if (typeof refreshAudioCapabilities === 'function') {
          refreshAudioCapabilities().then((cap) => {
            const st = document.getElementById('bottomStatusMsg');
            if (st && cap && cap.ai && String(st.innerText || '').includes('សូមស្វាគមន៍')) {
              st.innerText = '👋 សូមស្វាគមន៍មកកាន់ EZA PRO! · Edge-TTS + ⚡ UVR AI GPU (បំបែកភ្លេង+SFX) រួចរាល់។';
            }
          });
        }
        loadSavedSttEngine();
        if (typeof applyEcoCpuSavedState === 'function') {
          applyEcoCpuSavedState();
        }
        if (typeof refreshExportCapabilities === 'function') {
          refreshExportCapabilities().catch(() => {});
        }
        if (typeof refreshSpeechCapabilities === 'function') {
          refreshSpeechCapabilities().catch(() => {});
        }
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
                syncCachedBgmStemForVideo(currentVideoPath);
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
      videoSelectionSeq++;
      if (activeUploadAbortController) {
        try { activeUploadAbortController.abort(); } catch (_) {}
        activeUploadAbortController = null;
      }
      clearDubAndPlaybackState();
      cachedAudioMap.clear();
      cachedAudioUrls.clear();
      undoStack = [];
      redoStack = [];
      currentDramaInfo = drama;
      currentVideoPath = episode && episode.videoPath ? episode.videoPath : '';
      currentSrtPath = episode && episode.srtPath ? episode.srtPath : '';
      document.getElementById('currentDramaTitleTag').innerText = (drama && (drama.name || drama.dramaName)) || 'មើលវីដេអូជាមុន';

      // Populate episodes if episode selector exists
      const epSelect = document.getElementById('episodeSelect');
      if (epSelect) {
        const episodes = (drama && Array.isArray(drama.episodes)) ? drama.episodes : [];
        epSelect.innerHTML = episodes.map(e => '<option value="' + escapeHtml(e.ep) + '">ភាគ ' + escapeHtml(e.ep) + '</option>').join('');
        epSelect.hidden = episodes.length <= 1;
        if (episode) epSelect.value = episode.ep;
      }

      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(episode.videoPath));
        document.getElementById('videoTrackTitle').innerText = episode.video || episode.videoPath;
        syncCachedBgmStemForVideo(currentVideoPath);
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
        .map(c => {
          const v = castMode === 'single' ? lockedVoice : normalizeVoicePresetId(c.voice);
          const itemPitch = (c.pitch !== undefined && c.pitch !== null && c.pitch !== '')
            ? c.pitch
            : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
          const itemRate = (c.rate !== undefined && c.rate !== null && c.rate !== '')
            ? c.rate
            : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
          return {
            text: String(c.translated || c.text || '').trim(),
            voice: v,
            emotion: normalizeEmotionId(c.emotion),
            engine,
            ...(itemPitch !== undefined ? { pitch: itemPitch } : {}),
            ...(itemRate !== undefined ? { rate: itemRate } : {})
          };
        })
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

    function isCueVoiceCached(cue, castMode, lockedVoice, engine) {
      if (!cue) return false;
      const text = String(cue.translated || cue.text || '').trim();
      if (!text) return false;
      const v = castMode === 'single' ? lockedVoice : normalizeVoicePresetId(cue.voice);
      const itemPitch = (cue.pitch !== undefined && cue.pitch !== null && cue.pitch !== '')
        ? cue.pitch
        : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
      const itemRate = (cue.rate !== undefined && cue.rate !== null && cue.rate !== '')
        ? cue.rate
        : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
      const prosody = (itemPitch !== undefined || itemRate !== undefined) ? { pitch: itemPitch, rate: itemRate } : null;
      if (cachedAudioMap.has(getAudioCacheKey(v, text, 'auto', engine, prosody))) return true;
      const normEmo = normalizeEmotionId(cue.emotion);
      return normEmo !== 'auto' && cachedAudioMap.has(getAudioCacheKey(v, text, normEmo, engine, prosody));
    }

    function updateVoiceReadyBadge() {
      const engine = getActiveTtsEngine();
      const castMode = getActiveCastMode();
      const lockedVoice = getSelectedSingleVoice();
      let ready = 0;
      activeCues.forEach(c => {
        if (isCueVoiceCached(c, castMode, lockedVoice, engine)) ready++;
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
      if (typeof document !== 'undefined' && document && document.body && document.body.classList) {
        document.body.classList.toggle('has-translated-cues', hasTranslations);
      }
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
        const isReady = isCueVoiceCached(cue, singleModeLocked ? 'single' : 'auto', lockedVoice, engine);
        const hasTranslated = Boolean(cue.translated && String(cue.translated).trim());
        const isUntranslated = !hasTranslated || (Boolean(origText.trim()) && decodeEscapedUnicode(cue.translated).trim() === origText.trim());

        if (statusFilter === 'unvoiced' && isReady) return;
        if (statusFilter === 'untranslated' && !isUntranslated) return;
        visibleCount++;

        const origTooltip = (origText && origText !== text) ? (' title="ដើម: ' + escapeHtml(origText) + '"') : '';

        html += '<tr class="script-row ' + activeClass + '" id="row_cue_' + idx + '" data-cue-index="' + idx + '" onclick="onRowClick(' + idx + ', event)">' +
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

      if (visibleCount === 0) {
        let emptyContent = '';
        if (activeCues.length === 0) {
          emptyContent = '<div style="font-size:28px; margin-bottom:8px;">📝</div>' +
            '<div style="font-weight:700; color:#f1f5f9; font-size:13.5px; margin-bottom:4px;">មិនទាន់មាន Subtitle នៅឡើយទេ</div>' +
            '<div style="color:#94a3b8; font-size:12px; margin-bottom:14px;">សូមជ្រើសរើសវីដេអូ ឬបញ្ចូល File SRT ដើម្បីចាប់ផ្ដើមបកប្រែ និងបង្កើតសំឡេង AI</div>' +
            '<div style="display:flex; justify-content:center; gap:8px; flex-wrap:wrap;">' +
              '<button type="button" class="top-btn" onclick="openVideoFile()" style="font-size:12px; padding:6px 14px; background:#1e293b; border-color:#38bdf8; color:#38bdf8; cursor:pointer;">🎬 បើកវីដេអូ</button>' +
              '<button type="button" class="top-btn" onclick="openSrtFile()" style="font-size:12px; padding:6px 14px; background:#1e293b; cursor:pointer;">📝 នាំចូល SRT</button>' +
              '<button type="button" onclick="runAutoOneClickPipeline()" style="min-height:32px; padding:5px 14px; font-size:12px; cursor:pointer; background:linear-gradient(135deg, #f59e0b, #ec4899); color:#ffffff; border:none; border-radius:7px; font-weight:700; box-shadow:0 3px 12px rgba(236,72,153,0.3); display:inline-flex; align-items:center; gap:6px;">⚡ ១-Click Auto</button>' +
            '</div>';
        } else {
          emptyContent = '<div style="padding:10px; color:#94a3b8;">រកមិនឃើញបន្ទាត់ដែលត្រូវនឹងការច្រោះនេះទេ</div>';
        }
        html = '<tr class="script-empty-row"><td colspan="6"><div class="script-empty-box">' + emptyContent + '</div></td></tr>';
      }

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

      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.script-row').forEach(r => r.classList && r.classList.remove('active'));
        document.querySelectorAll('.timeline-block.is-selected').forEach(b => b.classList && b.classList.remove('is-selected'));
        document.querySelectorAll(`.timeline-block[data-cue-idx="${idx}"]`).forEach(b => b.classList && b.classList.add('is-selected'));
      }
      const row = document.getElementById('row_cue_' + idx);
      if (row) {
        if (row.classList) row.classList.add('active');
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      if (typeof updateTimelineActiveCueBadge === 'function') updateTimelineActiveCueBadge();

      if (shouldSeek) {
        stopDubAudio();
        const v = document.getElementById('mainVideo');
        if (v) v.currentTime = cue.startSec;
        setPlayheadTime(cue.startSec);
      }
    }

    let lastTextUndoCueIdx = -1;
    let lastTextUndoTime = 0;

    function syncActiveCuesToQueueAndEpisode() {
      if (!currentVideoPath || !Array.isArray(activeCues)) return;
      const normCur = typeof normalizePathKey === 'function'
        ? normalizePathKey(currentVideoPath)
        : String(currentVideoPath || '').trim().toLowerCase().replace(/\//g, '\\');
      if (typeof vmQueue !== 'undefined' && Array.isArray(vmQueue)) {
        for (const item of vmQueue) {
          if (item && item.videoPath) {
            const normItem = typeof normalizePathKey === 'function'
              ? normalizePathKey(item.videoPath)
              : String(item.videoPath || '').trim().toLowerCase().replace(/\//g, '\\');
            if (normItem === normCur) {
              item.cues = activeCues.map(c => ({ ...c }));
            }
          }
        }
      }
      if (typeof currentDramaInfo !== 'undefined' && currentDramaInfo && Array.isArray(currentDramaInfo.episodes)) {
        for (const ep of currentDramaInfo.episodes) {
          if (ep && ep.videoPath) {
            const normEp = typeof normalizePathKey === 'function'
              ? normalizePathKey(ep.videoPath)
              : String(ep.videoPath || '').trim().toLowerCase().replace(/\//g, '\\');
            if (normEp === normCur) {
              ep.cues = activeCues.map(c => ({ ...c }));
            }
          }
        }
      }
    }

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
        cue._userEdited = true;
        syncActiveCuesToQueueAndEpisode();
        updateTranslationState();
        updateVoiceReadyBadge();
        const sub = typeof document !== 'undefined' ? document.getElementById('liveSubtitleText') : null;
        const v = typeof document !== 'undefined' ? document.getElementById('mainVideo') : null;
        if (sub && (selectedCueIndex === idx || selectedCueIndex === -1)) {
          if (sub.dataset) sub.dataset.karaokeKey = '';
          updateKaraokeSubtitleDOM(sub, cue, idx, v ? v.currentTime : (cue.startSec || 0));
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
          syncActiveCuesToQueueAndEpisode();
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
      const itemPitch = (cue.pitch !== undefined && cue.pitch !== null && cue.pitch !== '')
        ? cue.pitch
        : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
      const itemRate = (cue.rate !== undefined && cue.rate !== null && cue.rate !== '')
        ? cue.rate
        : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
      const prosody = (itemPitch !== undefined || itemRate !== undefined) ? { pitch: itemPitch, rate: itemRate } : null;

      try {
        const res = await fetch(`${BACKEND_URL}/api/tts/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice,
            engine,
            strictVoice: true,
            allowBaseFallback: true,
            force: Boolean(forceRegenerate),
            ...(itemPitch !== undefined ? { pitch: itemPitch } : {}),
            ...(itemRate !== undefined ? { rate: itemRate } : {})
          })
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
        activeAudioPlayer.crossOrigin = 'anonymous';
        const resolvedUrl = resolveBackendUrl(data.audioUrl);
        activeAudioPlayer.src = resolvedUrl + (forceRegenerate ? `${resolvedUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : '');
        const mainVidEl = document.getElementById('mainVideo');
        activeAudioPlayer.muted = Boolean(mainVidEl && mainVidEl.muted);
        applyDubElementGain(activeAudioPlayer, clampNum(audioMixerState.dubPct / 100, 0, 1.5, 1.0));
        activeAudioPlayer.play().catch(err => console.warn('Audio play prevented:', err.message));
        const cacheKey = getAudioCacheKey(voice, text, 'auto', engine, prosody);
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

    function getTargetLangCode() {
      const el = document.getElementById('targetLangSelect');
      return el ? el.value : 'km';
    }

    function getTranslationSpeedMode() {
      const el = document.getElementById('translationSpeedSelect');
      return el ? el.value : 'auto';
    }

    function isCueSpeakableForTts(cue, targetLang = 'km') {
      if (!cue) return false;
      const tr = String(cue.translated || '').trim();
      const raw = String(cue.text || '').trim();
      const spoken = tr || raw;
      if (!spoken) return false;
      if (targetLang === 'km') {
        if (tr && /[\u1780-\u17FF]/.test(tr)) return true;
        if (!tr && /[\u1780-\u17FF]/.test(raw)) return true;
        // Skip untranslated foreign-script lines to avoid 422 errors on Khmer TTS voices
        if (/[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F]/.test(spoken)) {
          return false;
        }
        if (!tr && /^[A-Za-z0-9\s.,!?;:'"()-]+$/.test(spoken)) {
          return false;
        }
      }
      return true;
    }

    async function synthesizeTtsBatchSlice(entries, options = {}) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return { count: 0, failedCount: 0, fallbackCount: 0, cloneInstallNeeded: false };
      }
      const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
      const fixedVoice = String(options.fixedVoice || '');
      const strictVoice = options.strictVoice !== false;
      const res = await fetch(`${BACKEND_URL}/api/tts/batch-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: entries.map(entry => {
            const itemPitch = (entry.pitch !== undefined && entry.pitch !== null && entry.pitch !== '')
              ? entry.pitch
              : (options.pitch !== undefined && options.pitch !== null && options.pitch !== '' ? options.pitch : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined));
            const itemRate = (entry.rate !== undefined && entry.rate !== null && entry.rate !== '')
              ? entry.rate
              : (options.rate !== undefined && options.rate !== null && options.rate !== '' ? options.rate : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined));
            return {
              index: entry.index,
              text: entry.text,
              voice: entry.voice,
              engine: entry.engine,
              ...(itemPitch !== undefined ? { pitch: itemPitch } : {}),
              ...(itemRate !== undefined ? { rate: itemRate } : {})
            };
          }),
          concurrency,
          strictVoice,
          allowBaseFallback: true,
          fixedVoice
        })
      });
      const data = await res.json();
      if (!res.ok || !data || !data.success || !Array.isArray(data.results)) {
        const err = new Error((data && data.error) || `Batch TTS failed (${res.status}).`);
        err.statusCode = res.status;
        throw err;
      }

      let count = 0;
      let failedCount = 0;
      let cloneInstallNeeded = false;
      const entryByIndex = new Map(entries.map(e => [e.index, e]));
      for (const r of data.results) {
        if (!r) continue;
        if (r.needsCloneEngineInstall) cloneInstallNeeded = true;
        if (r.success && r.audioUrl) {
          count++;
          const entry = entryByIndex.get(r.index);
          if (entry) {
            const entryPitch = (entry.pitch !== undefined && entry.pitch !== null && entry.pitch !== '')
              ? entry.pitch
              : (options.pitch !== undefined && options.pitch !== null && options.pitch !== '' ? options.pitch : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined));
            const entryRate = (entry.rate !== undefined && entry.rate !== null && entry.rate !== '')
              ? entry.rate
              : (options.rate !== undefined && options.rate !== null && options.rate !== '' ? options.rate : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined));
            const prosody = (entryPitch !== undefined || entryRate !== undefined) ? { pitch: entryPitch, rate: entryRate } : null;
            const cKey = getAudioCacheKey(entry.voice, entry.text, 'auto', entry.engine, prosody);
            cachedAudioMap.add(cKey);
            cachedAudioUrls.set(cKey, resolveBackendUrl(r.audioUrl));
          }
        } else {
          failedCount++;
        }
      }
      updateVoiceReadyBadge();
      return { count, failedCount, fallbackCount: 0, cloneInstallNeeded };
    }

    async function batchGenerateAllAudio(options = {}) {
      if (isBatchDubbingNow) {
        if (!options.silentSuccess && typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ កំពុងបង្កើតសំឡេង Dubbing...');
        }
        return null;
      }
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
      const targetLang = getTargetLangCode();
      const ttsEngine = getActiveTtsEngine();
      let count = 0;
      let failedCount = 0;
      let fallbackCount = 0;
      let skippedCount = 0;
      const pendingEntries = [];
      for (let i = 0; i < activeCues.length; i++) {
        const cue = activeCues[i];
        if (!isCueSpeakableForTts(cue, targetLang)) continue;
        const text = String(cue && (cue.translated || cue.text) || '').trim();
        const voice = batchCastMode === 'single' ? singleVoice : normalizeVoicePresetId(cue.voice);
        const itemPitch = (cue.pitch !== undefined && cue.pitch !== null && cue.pitch !== '')
          ? cue.pitch
          : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
        const itemRate = (cue.rate !== undefined && cue.rate !== null && cue.rate !== '')
          ? cue.rate
          : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
        const prosody = (itemPitch !== undefined || itemRate !== undefined) ? { pitch: itemPitch, rate: itemRate } : null;
        const cacheKey = getAudioCacheKey(voice, text, 'auto', ttsEngine, prosody);
        if (onlyMissing && cachedAudioMap.has(cacheKey)) {
          skippedCount++;
          continue;
        }
        pendingEntries.push({ index: i, text, voice, engine: ttsEngine, pitch: itemPitch, rate: itemRate });
      }
      const validTotal = pendingEntries.length;

      if (validTotal === 0) {
        const doneMsg = onlyMissing
          ? `✅ គ្រប់ ${activeCues.length} បន្ទាត់មានសំឡេងរួចរាល់អស់ហើយ!`
          : 'មិនមានអក្សរខ្មែរសម្រាប់បង្កើតសំឡេងទេ (សូមបកប្រែជាមុនសិន)។';
        const bottomEl = document.getElementById('bottomStatusMsg');
        if (bottomEl) bottomEl.innerText = doneMsg;
        if (!options.silentSuccess && typeof showShortcutToast === 'function') {
          showShortcutToast(doneMsg);
        }
        return { count: 0, failedCount: 0, skippedCount, validTotal: 0 };
      }

      isBatchDubbingNow = true;
      let cloneInstallNeeded = false;
      const bottomStatusEl = document.getElementById('bottomStatusMsg');
      const BATCH_TTS_SIZE = 64;
      try {
        if (bottomStatusEl) {
          bottomStatusEl.innerText = onlyMissing
            ? `🔄 កំពុងបង្កើតសំឡេងបន្ទាត់ដែលនៅខ្វះ (${validTotal} បន្ទាត់ · Batch Mode)...`
            : `🎙️ កំពុងសំយោគសំឡេង Batch (${validTotal} បន្ទាត់)...`;
        }

        let processed = 0;
        for (let off = 0; off < pendingEntries.length; off += BATCH_TTS_SIZE) {
          const slice = pendingEntries.slice(off, off + BATCH_TTS_SIZE);
          try {
            const batchRes = await synthesizeTtsBatchSlice(slice, {
              concurrency: 20,
              fixedVoice: singleVoice,
              strictVoice: true,
              pitch: currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined,
              rate: currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined
            });
            count += batchRes.count;
            failedCount += batchRes.failedCount;
            fallbackCount += batchRes.fallbackCount;
            if (batchRes.cloneInstallNeeded) cloneInstallNeeded = true;
          } catch (batchErr) {
            failedCount += slice.length;
            console.warn('[TTS] Batch slice error:', batchErr.message);
          }
          processed += slice.length;
          if (bottomStatusEl) {
            bottomStatusEl.innerText = `🎙️ កំពុងសំយោគសំឡេង Batch: ${processed}/${validTotal} បន្ទាត់ (${Math.round((processed / validTotal) * 100)}%)...`;
          }
          if (cloneInstallNeeded && count === 0) break;
        }
      } finally {
        isBatchDubbingNow = false;
      }

      if (cloneInstallNeeded && count === 0) {
        if (!options.silentSuccess) {
          alert('🎭 សំឡេង Clone ត្រូវការដំឡើង Seed-VC AI Model (~3–4GB) ជាមុនសិន។');
        }
        if (typeof openVoiceCloneModal === 'function') openVoiceCloneModal();
        return { count, failedCount, skippedCount, validTotal };
      }

      renderTable();
      const allSucceeded = failedCount === 0 && count > 0;
      if (bottomStatusEl) {
        bottomStatusEl.innerText = allSucceeded
          ? '✅ បានសំយោគសំឡេងរួចរាល់ ' + count + '/' + validTotal + ' បន្ទាត់!'
          : `⚠️ សំយោគបាន ${count}/${validTotal} បន្ទាត់; មាន ${failedCount} បរាជ័យ (សូមពិនិត្យបន្ទាត់ដែលនៅខ្វះ ឬចុចបកប្រែម្ដងទៀត)។`;
      }
      if (allSucceeded) {
        showShortcutToast(`🎙️ សំឡេង Dubbing រួចរាល់ ${count}/${validTotal} បន្ទាត់!`);
      } else {
        showShortcutToast(`⚠️ សំឡេង Dubbing នៅខ្វះ ${failedCount} បន្ទាត់!`, 5000);
        if (!options.silentSuccess) {
          alert(`⚠️ សំយោគបាន ${count}/${validTotal} បន្ទាត់ (បរាជ័យ ${failedCount} បន្ទាត់)។ សូមពិនិត្យបន្ទាត់ដែលមិនទាន់បកប្រែ ឬសាកល្បងម្ដងទៀត។`);
        }
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
      currentVideoDuration = (Number.isFinite(v?.duration) && v.duration > 0) ? v.duration : 60;
      fitPreviewFrameSize();
      updateTimeDisplay(v.currentTime);
      renderTimeline();
      syncPlayPauseButton();
      if (typeof applyCopyrightPreviewTransform === 'function') applyCopyrightPreviewTransform();
      if (typeof syncVideoPlaybackRate === 'function') syncVideoPlaybackRate();
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
      const rawLine = (cue._userEdited && cue.translated !== undefined)
        ? cue.translated
        : (cue.translated || cue.text || '');
      const displayText = decodeEscapedUnicode(String(rawLine || '')).trim();
      if (!displayText) {
        subEl.style.display = 'none';
        return;
      }

      if (!isWordPopEnabled) {
        const staticKey = `static:${cueIdx}:${displayText}`;
        subEl.style.display = 'inline-block';
        if (subEl.dataset.karaokeKey === staticKey) return;
        subEl.dataset.karaokeKey = staticKey;
        subEl.innerHTML = `<span class="sub-word">${escapeSubHtml(displayText).replace(/\n/g, '<br>')}</span>`;
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

      const { chunks } = segmentSubtitleIntoChunks(displayText, 24, 5);
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
      if (bgmAudio) bgmAudio.muted = Boolean(v.muted);
      if (!isDubVoiceEnabled && !isVocalInvertOn) {
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

      const origGain = clampNum(audioMixerState.origPct / 100, 0, 1, 0);
      const bgmGain = clampNum(audioMixerState.bgmPct / 100, 0, 1.5, 0.85);
      const dubGain = isDubVoiceEnabled ? clampNum(audioMixerState.dubPct / 100, 0, 1.5, 1.0) : 0;
      const bgmOnPause = Boolean(audioMixerState.bgmOnPause);
      const isDubSpeaking = isDubVoiceEnabled && Boolean(currentDubAudio && !currentDubAudio.paused);
      const isInCueWindow = isDubVoiceEnabled && matchedIdx !== -1;
      const isSpeakingNow = dubGain > 0.01 && (isDubSpeaking || isInCueWindow);

      const desiredOrigVol = isSpeakingNow
        ? (origGain > 0 ? Math.max(0.03, origGain * 0.65) : 0.0)
        : origGain;

      // Only layer isolated BGM stem alongside original audio when origGain === 0 or separated by neural AI (Demucs / UVR audio-separator);
      // ffmpeg_dsp stems carry notch/MP3 priming delay relative to <video>, causing metallic echo if both play together.
      const isAiBgmStem = currentIsolatedBgmEngine === 'demucs' || currentIsolatedBgmEngine === 'audio-separator';
      const hasUsableStem = Boolean(currentIsolatedBgmUrl && !(bgmAudio && bgmAudio.error));
      const canLayerBgmStem = Boolean(
        hasUsableStem &&
        (isVocalInvertOn || bgmOnPause || bgmGain > 0) &&
        (origGain <= 0 || isAiBgmStem)
      );
      if (canLayerBgmStem) {
        v.volume = desiredOrigVol;
        if (!v.paused && bgmGain > 0) {
          if (bgmAudio._assignedSrc !== currentIsolatedBgmUrl && bgmAudio.src !== currentIsolatedBgmUrl) {
            bgmAudio._assignedSrc = currentIsolatedBgmUrl;
            bgmAudio.src = currentIsolatedBgmUrl;
            bgmAudio.loop = false;
            bgmAudio._lastSyncSeekAt = 0;
          }
          const targetRate = Number(v.playbackRate) || 1.0;
          if (Math.abs((bgmAudio.playbackRate || 1.0) - targetRate) > 0.02) {
            try { bgmAudio.playbackRate = targetRate; } catch (_) {}
          }
          const stemTargetGain = isSpeakingNow
            ? (bgmOnPause ? bgmGain * 0.78 : bgmGain * 0.85)
            : (bgmOnPause ? bgmGain * 1.35 : bgmGain * 0.90);
          applyDubElementGain(bgmAudio, stemTargetGain);
          const nowMs = Date.now();
          if (
            Math.abs((bgmAudio.currentTime || 0) - (v.currentTime || 0)) > 0.12 &&
            (!bgmAudio._lastSyncSeekAt || (nowMs - bgmAudio._lastSyncSeekAt) >= 200)
          ) {
            bgmAudio._lastSyncSeekAt = nowMs;
            try { bgmAudio.currentTime = v.currentTime || 0; } catch (_) {}
          }
          if (bgmAudio.paused) {
            bgmAudio.play().catch(() => {});
          }
        } else if (!bgmAudio.paused && (v.paused || bgmGain <= 0 || !isBgmOn)) {
          bgmAudio.pause();
        }
        return;
      }

      if (bgmAudio && !bgmAudio.paused && (!isBgmOn || (currentIsolatedBgmUrl && (bgmAudio._assignedSrc === currentIsolatedBgmUrl || bgmAudio.src === currentIsolatedBgmUrl)))) {
        bgmAudio.pause();
      }

      // No isolated BGM stem yet: apply WebAudio speech-notch filter and keep BGM/SFX audible under Dub speech
      if (bgmGain > 0 && origGain <= 0 && !audioCtx && typeof v === 'object') {
        initWebAudio();
        ensureAudioCtxResumed();
      }
      if (isSpeakingNow) {
        v.volume = origGain > 0
          ? Math.max(0.05, origGain * 0.65)
          : (bgmGain > 0 ? Math.min(1.0, bgmGain * 0.34) : 0.0);
      } else if (bgmGain > 0) {
        v.volume = Math.min(1.0, Math.max(origGain, bgmOnPause ? bgmGain * 0.78 : bgmGain * 0.55));
      } else {
        v.volume = origGain;
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
      const v = typeof document !== 'undefined' ? document.getElementById('mainVideo') : null;
      if (!isDubVoiceEnabled || !v || v.paused || !audioUrl) return;

      const curTime = Number(v.currentTime) || 0;
      const isStillInCueWindow = cue &&
        (curTime >= (Number(cue.startSec) - 0.25) && curTime <= (Number(cue.endSec) + 0.5));
      const isDubBusy = Boolean(currentDubAudio && !currentDubAudio.paused && activeSpeakingCueIdx !== idx);

      // If token expired, only allow playback if playhead is still currently inside this cue window and not busy
      if (reqId !== dubRequestToken && (!isStillInCueWindow || isDubBusy)) {
        return;
      }

      if (currentDubAudio) {
        try {
          currentDubAudio.pause();
          currentDubAudio.currentTime = 0;
        } catch (_) {}
        disconnectDubGainNodes(currentDubAudio);
        currentDubAudio = null;
      }

      const dubPlayer = new Audio();
      dubPlayer.crossOrigin = 'anonymous';
      dubPlayer.src = audioUrl;
      dubPlayer.muted = Boolean(v.muted);
      applyDubElementGain(dubPlayer, clampNum(audioMixerState.dubPct / 100, 0, 1.5, 1.0));
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
        const slotSec = Math.max(0.40, (cueEnd - curVideoSec) / vidRate);
        if (clipDur > slotSec * 1.04) {
          const fitRate = Math.min(1.65, Math.max(vidRate, Number((clipDur / slotSec).toFixed(2))));
          dubPlayer._slotFitFactor = Number((fitRate / Math.max(0.5, vidRate)).toFixed(3));
          dubPlayer.playbackRate = fitRate;
        } else {
          dubPlayer._slotFitFactor = 1;
          dubPlayer.playbackRate = vidRate;
        }
      });

      const restoreVolume = () => {
        if (currentDubAudio === dubPlayer) {
          disconnectDubGainNodes(dubPlayer);
          currentDubAudio = null;
          activeSpeakingCueIdx = -1;
        } else {
          disconnectDubGainNodes(dubPlayer);
        }
        if (v) {
          syncLiveSourceAudioSuppression(v, -1);
        }
      };

      dubPlayer.addEventListener('ended', restoreVolume);
      dubPlayer.addEventListener('error', restoreVolume);
      if (typeof dubPlayer.play === 'function') {
        dubPlayer.play().catch(() => restoreVolume());
      }
    }

    function playDubVoiceForCue(cue, idx = -1) {
      if (!isCueSpeakableForTts(cue, getTargetLangCode())) return;
      const text = String(cue.translated || cue.text || '').trim();
      if (!text) return;
      const castMode = getActiveCastMode();
      const voice = castMode === 'single' ? getSelectedSingleVoice() : normalizeVoicePresetId(cue.voice);
      if (castMode === 'single' && cue.voice !== voice) {
        cue.voice = voice;
      }
      const engine = getActiveTtsEngine();
      const reqId = ++dubRequestToken;

      const itemPitch = (cue.pitch !== undefined && cue.pitch !== null && cue.pitch !== '')
        ? cue.pitch
        : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
      const itemRate = (cue.rate !== undefined && cue.rate !== null && cue.rate !== '')
        ? cue.rate
        : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
      const prosody = (itemPitch !== undefined || itemRate !== undefined) ? { pitch: itemPitch, rate: itemRate } : null;

      const cacheKey = getAudioCacheKey(voice, text, 'auto', engine, prosody);
      const cachedUrl = cachedAudioUrls.get(cacheKey);
      if (cachedUrl) {
        startDubAudioElement(cachedUrl, cue, idx, reqId);
        return;
      }

      // Prefetch upcoming cue 1 step ahead so real-time playback never experiences network lag
      if (Number.isInteger(idx) && activeCues[idx + 1]) {
        const nextCue = activeCues[idx + 1];
        if (isCueSpeakableForTts(nextCue, getTargetLangCode())) {
          const nextText = String(nextCue.translated || nextCue.text || '').trim();
          const nextVoice = castMode === 'single' ? voice : normalizeVoicePresetId(nextCue.voice);
          const nextPitch = (nextCue.pitch !== undefined && nextCue.pitch !== null && nextCue.pitch !== '')
            ? nextCue.pitch
            : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
          const nextRate = (nextCue.rate !== undefined && nextCue.rate !== null && nextCue.rate !== '')
            ? nextCue.rate
            : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
          const nextProsody = (nextPitch !== undefined || nextRate !== undefined) ? { pitch: nextPitch, rate: nextRate } : null;
          const nextKey = getAudioCacheKey(nextVoice, nextText, 'auto', engine, nextProsody);
          if (!cachedAudioUrls.has(nextKey)) {
            fetch(`${BACKEND_URL}/api/tts/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: nextText,
                voice: nextVoice,
                engine,
                strictVoice: true,
                ...(nextPitch !== undefined ? { pitch: nextPitch } : {}),
                ...(nextRate !== undefined ? { rate: nextRate } : {})
              })
            }).then(r => r.json()).then(d => {
              if (d && d.audioUrl) {
                cachedAudioMap.add(nextKey);
                cachedAudioUrls.set(nextKey, resolveBackendUrl(d.audioUrl));
              }
            }).catch(() => {});
          }
        }
      }

      const fetchLiveTts = async (attempt = 0) => {
        const res = await fetch(`${BACKEND_URL}/api/tts/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice,
            engine,
            strictVoice: true,
            ...(itemPitch !== undefined ? { pitch: itemPitch } : {}),
            ...(itemRate !== undefined ? { rate: itemRate } : {})
          })
        });
        if (!res.ok && res.status >= 500 && attempt < 2) {
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          return fetchLiveTts(attempt + 1);
        }
        return res.json();
      };

      fetchLiveTts().then(data => {
        if (!data || !data.audioUrl) return;
        const resolvedUrl = resolveBackendUrl(data.audioUrl);
        cachedAudioMap.add(cacheKey);
        cachedAudioUrls.set(cacheKey, resolvedUrl);
        startDubAudioElement(resolvedUrl, cue, idx, reqId);
      }).catch(err => console.warn('Dub playback error:', err.message));
    }

    let isTimelineDragging = false;
    let suppressNextTimelineClick = false;
    let cachedTimelineMetrics = null;

    function getTimelineMetrics(container, refTrack) {
      const clientW = container.clientWidth || 600;
      if (cachedTimelineMetrics && cachedTimelineMetrics.clientWidth === clientW) {
        return cachedTimelineMetrics;
      }
      const cRect = typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : { left: 0 };
      const tRect = typeof refTrack.getBoundingClientRect === 'function' ? refTrack.getBoundingClientRect() : { left: 94, width: 500 };
      const trackLeft = (tRect.left - cRect.left) + (container.scrollLeft || 0);
      const trackWidth = tRect.width || Math.max(1, clientW - 104);
      cachedTimelineMetrics = { clientWidth: clientW, trackLeft, trackWidth };
      return cachedTimelineMetrics;
    }

    function setPlayheadTime(curSec) {
      updateTimeDisplay(curSec);

      const dur = currentVideoDuration || 60;
      const pct = (curSec / dur) * 100;
      const scrubFill = document.getElementById('scrubberFill');
      if (scrubFill && scrubFill.style) scrubFill.style.width = Math.min(100, Math.max(0, pct)) + '%';

      const needle = document.getElementById('playheadNeedle');
      const container = document.getElementById('tracksContainer');
      const refTrack = document.getElementById('trackSubBlocks') || document.getElementById('trackVideoBar');
      if (needle && container && refTrack) {
        const { trackLeft, trackWidth } = getTimelineMetrics(container, refTrack);
        const ratio = Math.min(1, Math.max(0, curSec / dur));
        const xPos = trackLeft + ratio * trackWidth;
        if (needle.style) needle.style.left = xPos + 'px';
        if (typeof needle.setAttribute === 'function') needle.setAttribute('data-time', formatSecToDisplay(curSec));

        // Keep playhead comfortably in view when zoomed & playing
        if (!isTimelineDragging && container.scrollWidth > (container.clientWidth || 0) + 4) {
          const minView = (container.scrollLeft || 0) + 96;
          const maxView = (container.scrollLeft || 0) + (container.clientWidth || 600) - 28;
          if (xPos > maxView || xPos < minView) {
            container.scrollLeft = Math.max(0, xPos - Math.round((container.clientWidth || 600) * 0.35));
          }
        }
      }
    }

    function updateTimeDisplay(cur) {
      const el = document.getElementById('playerTimeText');
      if (el) el.innerText = formatSecToDisplay(cur) + ' / ' + formatSecToDisplay(currentVideoDuration);
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

    function seekTimelineToClientX(clientX) {
      const refTrack = document.getElementById('trackSubBlocks') || document.getElementById('trackVideoBar');
      const v = document.getElementById('mainVideo');
      if (!refTrack || !v) return;
      const tRect = refTrack.getBoundingClientRect();
      if (tRect.width <= 0) return;
      const clickX = Math.min(Math.max(0, clientX - tRect.left), tRect.width);
      const pos = Math.min(Math.max(0, clickX / tRect.width), 1);
      const targetSec = pos * (currentVideoDuration || 60);
      stopDubAudio();
      lastTriggeredCueIdx = -1;
      v.currentTime = targetSec;
      setPlayheadTime(targetSec);
    }

    function seekByTimeline(e) {
      if (suppressNextTimelineClick) {
        suppressNextTimelineClick = false;
        return;
      }
      if (e && e.target && typeof e.target.closest === 'function') {
        if (e.target.closest('.track-label') || e.target.closest('.timeline-block')) return;
      }
      const refTrack = document.getElementById('trackSubBlocks') || document.getElementById('trackVideoBar');
      if (!refTrack) return;
      const tRect = refTrack.getBoundingClientRect();
      if (e.clientX >= tRect.left - 2 && tRect.width > 0) {
        seekTimelineToClientX(e.clientX);
      }
    }

    function onTimelineMouseDown(e) {
      if (!e || e.button !== 0) return;
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('.track-label')) return;
      const startX = e.clientX;
      let moved = false;
      isTimelineDragging = true;

      const onMove = (ev) => {
        if (!isTimelineDragging) return;
        if (Math.abs(ev.clientX - startX) >= 4) moved = true;
        if (moved) seekTimelineToClientX(ev.clientX);
      };
      const onUp = () => {
        isTimelineDragging = false;
        if (moved) suppressNextTimelineClick = true;
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        }
      };
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }
    }

    function onTimelineWheel(e) {
      const container = document.getElementById('tracksContainer');
      if (!e || !container) return;
      if (e.ctrlKey || e.metaKey) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        stepTimelineZoom(e.deltaY < 0 ? 0.5 : -0.5);
        return;
      }
      if (container.scrollWidth > container.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        container.scrollLeft += e.deltaY;
      }
    }

    function setDubVoiceEnabled(enabled) {
      isDubVoiceEnabled = Boolean(enabled);
      const sw = typeof document !== 'undefined' ? document.getElementById('dubVoiceSwitch') : null;
      const v = typeof document !== 'undefined' ? document.getElementById('mainVideo') : null;
      if (isDubVoiceEnabled) {
        if (sw) sw.classList.add('active');
        initWebAudio();
        ensureAudioCtxResumed();
        applyVocalSuppressionState(shouldSuppressOrigVocals());
        if (v) syncLiveSourceAudioSuppression(v, -1);
      } else {
        if (sw) sw.classList.remove('active');
        stopDubAudio();
        applyVocalSuppressionState(shouldSuppressOrigVocals());
        if (v) syncLiveSourceAudioSuppression(v, -1);
      }
      if (typeof syncAudioAiStatusUi === 'function') syncAudioAiStatusUi();
    }

    function toggleDubVoice() {
      setDubVoiceEnabled(!isDubVoiceEnabled);
    }

    function toggleMuteVideo() {
      ensureAudioCtxResumed();
      const v = document.getElementById('mainVideo');
      v.muted = !v.muted;
      if (bgmAudio) bgmAudio.muted = v.muted;
      if (currentDubAudio) currentDubAudio.muted = v.muted;
      if (activeAudioPlayer) activeAudioPlayer.muted = v.muted;
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
    let currentIsolatedBgmEngine = '';

    function ensureAudioCtxResumed() {
      if (audioCtx && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        audioCtx.resume().catch(() => {});
      }
    }

    async function syncCachedBgmStemForVideo(videoPath) {
      const targetPath = String(videoPath || '').trim();
      if (!targetPath || typeof fetch !== 'function') return false;
      try {
        if (!audioSeparationCapabilities.loaded) {
          await refreshAudioCapabilities();
        }
        const res = await fetch(`${BACKEND_URL}/api/audio/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: targetPath })
        });
        if (targetPath !== currentVideoPath) return false;
        if (!res.ok) return false;
        const data = await res.json();
        if (targetPath !== currentVideoPath) return false;
        if (!data || !data.ready || !data.bgmUrl) {
          currentIsolatedBgmUrl = null;
          currentIsolatedVocalsUrl = null;
          currentIsolatedBgmEngine = '';
          syncAudioAiStatusUi();
          return false;
        }
        currentIsolatedBgmEngine = data.engine || 'ffmpeg_dsp';
        currentIsolatedBgmUrl = resolveBackendUrl(data.bgmUrl);
        currentIsolatedVocalsUrl = data.vocalsUrl ? resolveBackendUrl(data.vocalsUrl) : null;
        const quickBgmBtn = document.getElementById('btnQuickBgm');
        const stemIsAi = isAiSeparationEngineClient(currentIsolatedBgmEngine);
        if (quickBgmBtn) {
          if (audioMixerState.origPct <= 0 && audioMixerState.bgmPct > 0 && audioMixerState.bgmOnPause) {
            isVocalInvertOn = true;
            quickBgmBtn.classList.add('active');
          }
        }
        if (typeof applyVocalSuppressionState === 'function') {
          applyVocalSuppressionState(shouldSuppressOrigVocals());
        }
        const v = document.getElementById('mainVideo');
        if (v) syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
        syncAudioAiStatusUi();

        // Auto-upgrade legacy ffmpeg_dsp stems once per video when local UVR GPU AI is installed
        if (!stemIsAi && audioSeparationCapabilities.ai && !_autoUpgradedBgmPaths.has(targetPath)) {
          _autoUpgradedBgmPaths.add(targetPath);
          requestBgmIsolationForCurrentVideo({ activateVocalInvert: isVocalInvertOn, isAutoUpgrade: true });
        }
        return true;
      } catch (_) {
        return false;
      }
    }

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
        node.gain.value = shouldSuppressOrigVocals() ? b.cutDb : 0;
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
      const boostCard = document.getElementById('toolAudioBoost') || document.getElementById('btnQuickAudioBoost');
      const boostTag = document.getElementById('boostTag');
      if (boostCard) boostCard.classList.toggle('active', isBoostOn);
      if (boostTag) boostTag.innerText = isBoostOn ? '250%' : 'OFF';
      syncAudioAiStatusUi();
    }

    function requestBgmIsolationForCurrentVideo(options = {}) {
      if (!currentVideoPath || typeof fetch !== 'function') return Promise.resolve(null);
      const requestedVideoPath = currentVideoPath;
      const reqSeq = ++_bgmIsolationSeq;
      const quickBgmBtn = document.getElementById('btnQuickBgm');
      const statusEl = document.getElementById('bottomStatusMsg');
      if (options.activateVocalInvert) {
        isVocalInvertOn = true;
        if (quickBgmBtn) quickBgmBtn.classList.add('active');
        applyVocalSuppressionState(shouldSuppressOrigVocals());
      }
      _isIsolatingBgmInFlight = true;
      if (quickBgmBtn) {
        quickBgmBtn.innerText = audioSeparationCapabilities.ai ? '🎵 ⏳ AI...' : '🎵 ⏳...';
      }
      if (statusEl && !options.isAutoUpgrade) {
        statusEl.innerText = audioSeparationCapabilities.ai
          ? '⚡ កំពុងបំបែកភ្លេង BGM & SFX ដោយ UVR AI (GPU)...'
          : '🎵 កំពុងបំបែកភ្លេង BGM សុទ្ធ...';
      }
      syncAudioAiStatusUi();

      let bgmProgPollTimer = null;
      let bgmProgPollBusy = false;
      if (typeof setInterval === 'function') {
        bgmProgPollTimer = setInterval(async () => {
          if (reqSeq !== _bgmIsolationSeq || !_isIsolatingBgmInFlight) {
            clearInterval(bgmProgPollTimer);
            bgmProgPollTimer = null;
            return;
          }
          if (bgmProgPollBusy) return;
          bgmProgPollBusy = true;
          try {
            const pr = await fetch(`${BACKEND_URL}/api/audio/bgm-progress`);
            if (!pr || !pr.ok) return;
            const pd = await pr.json().catch(() => null);
            if (!pd || !pd.running || reqSeq !== _bgmIsolationSeq || !_isIsolatingBgmInFlight) return;
            const badge = document.getElementById('audioAiEngineBadge');
            const pctText = pd.totalChunks > 1
              ? `វគ្គ ${Math.min(pd.totalChunks, (pd.doneChunks || 0) + 1)}/${pd.totalChunks} · ${pd.percent || 0}%`
              : `${pd.percent || 0}%`;
            if (quickBgmBtn) quickBgmBtn.innerText = `🎵 ${pd.percent || 0}%`;
            if (badge) badge.innerText = `⏳ UVR AI (${pctText})`;
            if (statusEl && !options.isAutoUpgrade && pd.statusText) {
              statusEl.innerText = `${pd.statusText} (${pd.percent || 0}%)`;
            }
          } catch (_) {
          } finally {
            bgmProgPollBusy = false;
          }
        }, 1200);
      }
      const stopBgmPoll = () => {
        if (bgmProgPollTimer && typeof clearInterval === 'function') {
          clearInterval(bgmProgPollTimer);
          bgmProgPollTimer = null;
        }
      };

      return fetch(`${BACKEND_URL}/api/audio/isolate-bgm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: requestedVideoPath, force: Boolean(options.force) })
      })
        .then(async r => {
          const data = await r.json().catch(() => null);
          if (!r.ok) {
            const errMsg = (data && data.error) || `HTTP ${r.status}`;
            throw new Error(errMsg);
          }
          return data;
        })
        .then(data => {
          stopBgmPoll();
          if (reqSeq !== _bgmIsolationSeq) return null;
          _isIsolatingBgmInFlight = false;
          if (requestedVideoPath !== currentVideoPath) {
            syncAudioAiStatusUi();
            return null;
          }
          if (data && data.success && data.bgmUrl) {
            currentIsolatedBgmEngine = data.engine || 'ffmpeg_dsp';
            currentIsolatedBgmUrl = resolveBackendUrl(data.bgmUrl);
            currentIsolatedVocalsUrl = data.vocalsUrl ? resolveBackendUrl(data.vocalsUrl) : null;
            const v = document.getElementById('mainVideo');
            if (v && isVocalInvertOn) syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
            const usedAi = isAiSeparationEngineClient(currentIsolatedBgmEngine);
            if (statusEl && isVocalInvertOn) {
              statusEl.innerText = usedAi
                ? '✅ បានបំបែកភ្លេង BGM+SFX សុទ្ធដោយ UVR AI GPU រួចរាល់!'
                : `🎵 បានបំបែកភ្លេង BGM សុទ្ធរួចរាល់ (${data.engine || 'DSP'})!`;
            }
          }
          syncAudioAiStatusUi();
          if (typeof updateExportPreviewSummary === 'function') updateExportPreviewSummary();
          return data;
        })
        .catch(() => {
          stopBgmPoll();
          if (reqSeq === _bgmIsolationSeq) {
            _isIsolatingBgmInFlight = false;
            syncAudioAiStatusUi();
          }
          return null;
        });
    }

    async function triggerDockBgmIsolation() {
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
        if (!currentVideoPath) await openVideoFile();
        if (!currentVideoPath) return null;
      }
      initWebAudio();
      ensureAudioCtxResumed();
      const forceAi = Boolean(currentIsolatedBgmUrl && isAiSeparationEngineClient(currentIsolatedBgmEngine));
      return requestBgmIsolationForCurrentVideo({ activateVocalInvert: true, force: forceAi });
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
      ensureAudioCtxResumed();
      isVocalInvertOn = !isVocalInvertOn;
      applyVocalSuppressionState(shouldSuppressOrigVocals());

      const quickBgmBtn = document.getElementById('btnQuickBgm');
      const statusEl = document.getElementById('bottomStatusMsg');
      const exportAudioModeEl = document.getElementById('exportAudioMode');

      if (quickBgmBtn) {
        quickBgmBtn.classList.toggle('active', isVocalInvertOn);
        quickBgmBtn.innerText = isVocalInvertOn ? '🎵 BGM ON' : '🎵 BGM';
      }

      if (exportAudioModeEl && exportAudioModeEl.value !== 'original') {
        if (audioMixerState.origPct > 0) {
          exportAudioModeEl.value = 'mix_custom';
        } else if (isVocalInvertOn) {
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
        if (v) syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
        if (statusEl) statusEl.innerText = '🔊 បានបិទមុខងារ Isolate BGM (ត្រឡប់មកសំឡេងធម្មតា)';
        syncAudioAiStatusUi();
        return;
      }

      if (statusEl) {
        statusEl.innerText = '🎵 បានបើក Isolate BGM (កាត់បន្ថយសំឡេងនិយាយដើម និងរក្សាភ្លេង Background)!';
      }

      if (currentVideoPath && typeof fetch === 'function') {
        requestBgmIsolationForCurrentVideo({ activateVocalInvert: true });
      }
    }

    function toggleMusicBed() {
      isBgmOn = !isBgmOn;
      if (isBgmOn) {
        if (!currentIsolatedBgmUrl) {
          isBgmOn = false;
          if (typeof showShortcutToast === 'function') {
            showShortcutToast('💡 សូមចុច "🎵 បំបែក AI" ដើម្បីទាញយកភ្លេង BGM ពីវីដេអូជាមុនសិន');
          }
          return;
        }
        bgmAudio.src = currentIsolatedBgmUrl;
        bgmAudio.volume = 0.45;
        bgmAudio.loop = true;
        bgmAudio.play().catch(() => {});
      } else {
        bgmAudio.pause();
      }
    }

    // 6. Timeline Rendering & Interactive Controls
    function updateTimelineActiveCueBadge() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const badge = document.getElementById('timelineActiveCueBadge');
      if (!badge) return;
      if (selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) {
        const cue = activeCues[selectedCueIndex];
        badge.innerText = `🎯 #${cue.index || (selectedCueIndex + 1)} · ${formatSecToDisplay(cue.startSec)} → ${formatSecToDisplay(cue.endSec)}`;
      } else {
        badge.innerText = activeCues.length > 0 ? `🎯 ចុចលើប្លុក ឬតារាង (${activeCues.length} បន្ទាត់)` : '🎯 ចុចលើបន្ទាត់ ឬអូស Timeline';
      }
    }

    function stepTimelineZoom(delta) {
      const zoomEl = document.getElementById('timelineZoom');
      if (!zoomEl) return;
      const cur = parseFloat(zoomEl.value) || 1;
      const next = Math.min(8, Math.max(1, Math.round((cur + delta) * 4) / 4));
      zoomEl.value = String(next);
      renderTimeline();
    }

    function resetTimelineZoom() {
      const zoomEl = document.getElementById('timelineZoom');
      const container = document.getElementById('tracksContainer');
      if (zoomEl) zoomEl.value = '1';
      if (container) container.scrollLeft = 0;
      renderTimeline();
    }

    function onTimelineBlockClick(idx, e) {
      if (suppressNextTimelineClick) {
        suppressNextTimelineClick = false;
        return;
      }
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      selectCueRow(idx, true);
    }

    function renderTimeline() {
      const container = document.getElementById('tracksContainer');
      const ruler = document.getElementById('timelineRuler');
      const videoTrack = document.getElementById('trackVideoBar');
      const subTrack = document.getElementById('trackSubBlocks');
      const dubTrack = document.getElementById('trackDubBlocks');
      if (!container || !ruler || !subTrack || !dubTrack) return;

      const dur = currentVideoDuration || 60;
      const zoom = Math.max(1, Math.min(8, parseFloat(document.getElementById('timelineZoom')?.value || '1') || 1));
      const zoomLabel = document.getElementById('timelineZoomLabel');
      if (zoomLabel) zoomLabel.innerText = `${zoom.toFixed(1)}x`;

      const labelWidth = 94;
      const baseW = Math.max(320, (container.clientWidth || 640) - 14);
      const trackW = Math.round(Math.max(220, baseW - labelWidth) * zoom);

      ruler.style.marginLeft = labelWidth + 'px';
      ruler.style.width = trackW + 'px';
      [videoTrack, dubTrack, subTrack].forEach(el => {
        if (el) {
          el.style.flex = '0 0 ' + trackW + 'px';
          el.style.width = trackW + 'px';
        }
      });
      if (typeof container.querySelectorAll === 'function') {
        container.querySelectorAll('.track-row').forEach(row => {
          row.style.minWidth = (trackW + labelWidth) + 'px';
        });
      }

      let rulerHtml = '';
      const rawStep = dur / Math.max(4, Math.min(18, Math.round(6 * zoom)));
      const stepChoices = [1, 2, 5, 10, 15, 20, 30, 60];
      const step = stepChoices.find(v => v >= rawStep) || Math.ceil(rawStep / 30) * 30;
      for (let s = 0; s <= dur; s += step) {
        const pct = (s / dur) * 100;
        const edgeCls = s === 0 ? ' is-start' : '';
        const edgeStyle = s === 0 ? 'left:0%;' : `left:${pct.toFixed(2)}%; transform:translateX(-50%);`;
        rulerHtml += `<span class="tl-ruler-tick${edgeCls}" style="${edgeStyle}">${formatSecToDisplay(s)}</span>`;
      }
      ruler.innerHTML = rulerHtml;

      let subBlocks = '';
      let dubBlocks = '';
      const engine = getActiveTtsEngine();
      const singleModeLocked = getActiveCastMode() === 'single';
      const lockedVoice = singleModeLocked ? getSelectedSingleVoice() : '';
      activeCues.forEach((cue, idx) => {
        const leftPct = Math.max(0, (cue.startSec / dur) * 100);
        const widthPct = Math.max(0.8, ((cue.endSec - cue.startSec) / dur) * 100);
        const rawText = cue.translated || cue.text || '';
        const safeTitle = escapeHtml(`#${cue.index || idx + 1} [${formatSecToDisplay(cue.startSec)} - ${formatSecToDisplay(cue.endSec)}] ${rawText}`);
        const snippet = escapeHtml(rawText.replace(/\s+/g, ' ').trim().slice(0, 28));
        const selectedCls = idx === selectedCueIndex ? ' is-selected' : '';
        const hasAudio = Boolean(cue.audioUrl) || isCueVoiceCached(cue, singleModeLocked ? 'single' : 'auto', lockedVoice, engine);
        const dubCls = hasAudio ? '' : ' is-missing-dub';
        const dubLabel = trackW * (widthPct / 100) >= 44 ? (hasAudio ? '🔊' : '⚪') : '';
        const subLabel = trackW * (widthPct / 100) >= 34 ? `#${cue.index || idx + 1}${snippet ? ' ' + snippet : ''}` : '';

        subBlocks += `<div class="timeline-block timeline-sub-block${selectedCls}" data-cue-idx="${idx}" onclick="onTimelineBlockClick(${idx}, event)" style="left:${leftPct.toFixed(3)}%; width:${widthPct.toFixed(3)}%;" title="${safeTitle}">${subLabel}</div>`;
        dubBlocks += `<div class="timeline-block timeline-dub-block${dubCls}${selectedCls}" data-cue-idx="${idx}" onclick="onTimelineBlockClick(${idx}, event)" style="left:${leftPct.toFixed(3)}%; width:${widthPct.toFixed(3)}%;" title="${safeTitle}">${dubLabel}</div>`;
      });

      subTrack.innerHTML = subBlocks;
      dubTrack.innerHTML = dubBlocks;
      cachedTimelineMetrics = null;
      updateTimelineActiveCueBadge();

      const v = document.getElementById('mainVideo');
      setPlayheadTime(v ? (v.currentTime || 0) : 0);
    }

    // 7. Cues Operations: Split, Add, Delete, Nudge
    function splitLineAtCurrentTime() {
      const v = document.getElementById('mainVideo');
      const cur = v ? v.currentTime : 0;
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

      pushUndoState();

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
        ...(original.translatedLang ? { translatedLang: original.translatedLang } : {}),
        voice: original.voice,
        ...(original.suggestedVoice ? { suggestedVoice: original.suggestedVoice } : {}),
        ...(original.pitch !== undefined ? { pitch: original.pitch } : {}),
        ...(original.rate !== undefined ? { rate: original.rate } : {}),
        ...(original._userEdited ? { _userEdited: true } : {})
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
      const cur = v ? (v.currentTime || 0) : 0;
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
      selectedCueIndex = activeCues.indexOf(newCue);
      renderTable();
      renderTimeline();
      if (selectedCueIndex >= 0) selectCueRow(selectedCueIndex, false);
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
        activeCues.sort((a, b) => a.startSec - b.startSec);
        activeCues.forEach((c, i) => c.index = i + 1);
        selectedCueIndex = activeCues.indexOf(cue);
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
      if (!target) return alert('សូមបញ្ចូលទីតាំង Folder វីដេអូ (ឧ. D:\\Videos\\Drama1)!');
      const loadSeq = ++videoSelectionSeq;
      try {
        const scanRes = await fetch(`${BACKEND_URL}/api/scan-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: target })
        });
        const scanData = await scanRes.json();
        if (loadSeq !== videoSelectionSeq) return;
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
        if (loadSeq !== videoSelectionSeq) return;
        loadDramaData(scanData, firstEp, initialCues);
        showShortcutToast('📁 បានផ្ទុក ' + (scanData.name || target));
      } catch (err) {
        if (loadSeq !== videoSelectionSeq) return;
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
            '<input type="text" id="customFolderInput" placeholder="បិទភ្ជាប់ទីតាំង Folder វីដេអូ (ឧ. D:\\Videos\\Drama1...)" style="flex:1; background:#070c17; border:1px solid var(--border-light); border-radius:5px; padding:7px 10px; color:#fff; font-size:12px; outline:none;">' +
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

      const loadSeq = ++videoSelectionSeq;
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
            if (loadSeq !== videoSelectionSeq) return;
            loadDramaData(drama, firstEp, data.cues || []);
          })
          .catch(err => {
            if (loadSeq !== videoSelectionSeq) return;
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

      videoSelectionSeq++;
      if (activeUploadAbortController) {
        try { activeUploadAbortController.abort(); } catch (_) {}
        activeUploadAbortController = null;
      }
      clearDubAndPlaybackState();
      cachedAudioMap.clear();
      cachedAudioUrls.clear();
      activeCues = [];
      undoStack = [];
      redoStack = [];
      renderTable();
      renderTimeline();
      updateTranslationState();
      updateVoiceReadyBadge();

      const reqToken = ++episodeRequestToken;
      currentVideoPath = ep.videoPath || '';
      currentSrtPath = ep.srtPath || '';
      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(ep.videoPath));
        document.getElementById('videoTrackTitle').innerText = ep.video || ep.videoPath;
        syncCachedBgmStemForVideo(currentVideoPath);
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
            activeCues = normalizeCuesTiming(data.cues || []);
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
        document.getElementById('bottomStatusMsg').innerText = 'ភាគទី ' + epNum + ' មិនទាន់មាន File SRT ទេ (សូមចុច TRANSCRIBE ឬនាំចូល SRT)';
      }
    }

    let isTranslatingNow = false;
    let isBatchDubbingNow = false;
    let isAutoPipelineRunning = false;
    let isSpeechDetectingNow = false;
    let isOcrRunningNow = false;

    async function findCompanionSrtFile(videoPath) {
      if (!videoPath) return null;
      try {
        const res = await fetch(`${BACKEND_URL}/api/find-companion-srt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath })
        });
        const data = await res.json();
        if (res.ok && data && data.success && data.found && Array.isArray(data.cues) && data.cues.length > 0) {
          return data;
        }
      } catch (err) {
        console.warn('[companion-srt] Lookup failed:', err.message);
      }
      return null;
    }

    async function runAutoOneClickPipeline() {
      if (isAutoPipelineRunning) {
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ ១-Click Auto កំពុងដំណើរការហើយ...');
        }
        return;
      }
      isAutoPipelineRunning = true;
      try {
        const statusMsg = document.getElementById('bottomStatusMsg');
        const autoInputEl = document.getElementById('autoInputSourceSelect');
        const autoInputMode = autoInputEl ? autoInputEl.value : 'auto';
        if (!currentVideoPath && autoInputMode !== 'ocr') {
          await ensureVideoReadyOnServer();
        }
        if (!currentVideoPath && activeCues.length === 0) {
          const picked = await openVideoFile();
          if (!picked && !currentVideoPath) return;
        }

        const exportAudioModeEl = document.getElementById('exportAudioMode');
        const selectedAudioMode = exportAudioModeEl ? exportAudioModeEl.value : 'bgm_only';
        const wantsBgmPipeline = (selectedAudioMode === 'bgm_only' || (selectedAudioMode === 'mix_custom' && audioMixerState.bgmOnPause && audioMixerState.bgmPct > 0));
        const needsAiBgmWork = !isVocalInvertOn || (audioSeparationCapabilities.ai && !isAiSeparationEngineClient(currentIsolatedBgmEngine));
        if (currentVideoPath && wantsBgmPipeline && needsAiBgmWork) {
          // Run BGM isolation in parallel from t=0 alongside Speech AI / OCR so it adds 0s wait
          if (!isVocalInvertOn) {
            toggleRemoveVocals();
          } else {
            requestBgmIsolationForCurrentVideo({ activateVocalInvert: true });
          }
        }

        if (activeCues.length === 0) {
          if (currentVideoPath) {
            if (statusMsg) statusMsg.innerText = '🔍 កំពុងស្វែងរកឯកសារ .SRT ជាប់វីដេអូ...';
            const companionSrt = await findCompanionSrtFile(currentVideoPath);
            if (companionSrt) {
              currentSrtPath = companionSrt.filePath || currentSrtPath;
              activeCues = normalizeCuesTiming(companionSrt.cues);
              normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
              renderTable();
              renderTimeline();
              checkAllAudioCache();
              updateTranslationState();
              if (activeCues[0]) selectCueRow(0);
              showShortcutToast(`📄 រកឃើញ SRT ស្វ័យប្រវត្តិ: ${companionSrt.fileName} (${activeCues.length} បន្ទាត់)!`);
              if (statusMsg) statusMsg.innerText = `📄 បានផ្ទុក SRT ស្វ័យប្រវត្តិ (${companionSrt.fileName}) — បន្តបកប្រែភ្លាម!`;
            }
          }
          if (activeCues.length === 0) {
            if (autoInputMode === 'ocr') {
              const ocrOk = await startSubtitleOcr({ skipConfirm: true, silentSuccess: true });
              if (!ocrOk || activeCues.length === 0) return;
            } else {
              const transcribed = await startSpeechDetection({ skipConfirm: true, silentSuccess: true });
              if (!transcribed || activeCues.length === 0) return;
            }
          }
        }

        const targetLangEl = document.getElementById('targetLangSelect');
        const targetLang = targetLangEl ? targetLangEl.value : 'km';
        let didStreamTts = false;
        if (activeCues.length > 0 && cuesNeedTranslation(activeCues, targetLang)) {
          const translated = await startAiTranslation({
            silentSuccess: true,
            skipAutoChain: true,
            pipelineTts: true,
            speedMode: getTranslationSpeedMode()
          });
          if (!translated) return;
          didStreamTts = true;
        } else if (activeCues.length > 0 && statusMsg) {
          statusMsg.innerText = `✅ មាន Subtitle បកប្រែរួចហើយ (${activeCues.length} បន្ទាត់) — កំពុងបង្កើតសំឡេង Dubbing...`;
        }

        const batchResult = await batchGenerateAllAudio({
          silentSuccess: true,
          onlyMissing: didStreamTts
        });
        const modeSummary = selectedAudioMode === 'dub_only' ? 'Dubbing សុទ្ធ (បិទសំឡេងដើម)' : 'បកប្រែ + Dubbing + BGM';
        if (batchResult && batchResult.failedCount > 0) {
          showShortcutToast(`⚠️ Smart Auto បានបញ្ចប់ តែនៅខ្វះសំឡេង ${batchResult.failedCount} បន្ទាត់!`, 5500);
          if (statusMsg) {
            statusMsg.innerText = `⚠️ Smart Auto ធ្វើបាន ${batchResult.count}/${batchResult.validTotal} បន្ទាត់ (នៅខ្វះ ${batchResult.failedCount} បន្ទាត់ — សូមពិនិត្យបន្ទាត់ដែលនៅខ្វះ)។`;
          }
        } else {
          showShortcutToast(`🎉 Smart Auto រួចរាល់! (${modeSummary})`);
          if (statusMsg) {
            statusMsg.innerText = `🎉 Smart Auto ធ្វើរួចរាល់ទាំងអស់ (${modeSummary})! ចុច ▶️ ដើម្បីស្ដាប់ ឬ EXPORT HD។`;
          }
        }
      } finally {
        isAutoPipelineRunning = false;
      }
    }
    async function postJsonWithTunnelRecovery(url, payload, options = {}) {
      const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
      const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2500;
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
      const onRetryStatus = typeof options.onRetryStatus === 'function' ? options.onRetryStatus : null;
      let lastErr = null;
      let unreachableCount = 0;

      const isBackendReachable = async () => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
        try {
          const pingRes = await fetch(`${BACKEND_URL}/api/health`, ctrl ? { signal: ctrl.signal } : undefined);
          return Boolean(pingRes && pingRes.ok);
        } catch (_) {
          return false;
        } finally {
          if (t) clearTimeout(t);
        }
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const ctrl = (timeoutMs > 0 && typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
          const currentPayload = (attempt > 0 && payload && typeof payload === 'object' && payload.force === true)
            ? { ...payload, force: false, useCache: true }
            : payload;
          const fetchOpts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentPayload)
          };
          if (ctrl) fetchOpts.signal = ctrl.signal;
          const res = await fetch(url, fetchOpts);

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
          const isNetworkBlip = /Failed to fetch|NetworkError|Load failed|fetch failed|AbortError/i.test(String((err && err.message) || ''));
          if (isNetworkBlip && attempt < maxRetries) {
            const alive = await isBackendReachable();
            if (!alive) {
              unreachableCount++;
              if (unreachableCount >= 2) {
                throw new Error('មិនអាចភ្ជាប់ទៅ Backend Server បានទេ — សូមពិនិត្យថា Server កំពុងដំណើរការ។');
              }
            } else {
              unreachableCount = 0;
            }
            if (onRetryStatus) onRetryStatus(attempt + 1, 0);
            await new Promise(r => setTimeout(r, retryDelayMs));
            continue;
          }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw lastErr || new Error('Request failed');
    }

    async function startAiTranslation(options = {}) {
      if (isTranslatingNow && !options.isAutoRescueAttempt) {
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ កំពុងបកប្រែ Subtitle...');
        }
        return false;
      }
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

      const speedMode = options.speedMode || getTranslationSpeedMode();
      const autoChainEl = document.getElementById('autoChainDubCheck');
      const shouldAutoChain = !options.skipAutoChain && (!autoChainEl || autoChainEl.checked);
      const enablePipelinedTts = Boolean((options.pipelineTts || shouldAutoChain) && !options.isAutoRescueAttempt);
      const translationJobSeq = videoSelectionSeq;

      document.getElementById('bottomStatusMsg').innerText = '🔥 កំពុងវិភាគសាច់រឿង បកប្រែតាមបរិបទ និងពិនិត្យតួអង្គ...';
      isTranslatingNow = true;
      stopDubAudio();

      try {
        let data = null;
        let usedStreamingTts = false;
        const castMode = getActiveCastMode();
        const fixedVoice = getSelectedSingleVoice();
        const ttsEngine = getActiveTtsEngine();
        const singleVoice = castMode === 'single' ? fixedVoice : '';
        let ttsPipelineChain = Promise.resolve();

        const queueSliceTts = (sliceCues, sliceOffset) => {
          if (!enablePipelinedTts || !Array.isArray(sliceCues) || sliceCues.length === 0) return;
          const speakable = [];
          for (let k = 0; k < sliceCues.length; k++) {
            const c = sliceCues[k];
            if (!isCueSpeakableForTts(c, targetLang)) continue;
            const spoken = String(c.translated || c.text || '').trim();
            const voice = castMode === 'single' ? singleVoice : normalizeVoicePresetId(c.voice);
            const itemPitch = (c.pitch !== undefined && c.pitch !== null && c.pitch !== '')
              ? c.pitch
              : (currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined);
            const itemRate = (c.rate !== undefined && c.rate !== null && c.rate !== '')
              ? c.rate
              : (currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined);
            const prosody = (itemPitch !== undefined || itemRate !== undefined) ? { pitch: itemPitch, rate: itemRate } : null;
            const cKey = getAudioCacheKey(voice, spoken, 'auto', ttsEngine, prosody);
            if (!cachedAudioMap.has(cKey)) {
              speakable.push({
                index: sliceOffset + k,
                text: spoken,
                voice,
                engine: ttsEngine,
                ...(itemPitch !== undefined ? { pitch: itemPitch } : {}),
                ...(itemRate !== undefined ? { rate: itemRate } : {})
              });
            }
          }
          if (speakable.length === 0) return;
          usedStreamingTts = true;
          for (let off = 0; off < speakable.length; off += 64) {
            const sub = speakable.slice(off, off + 64);
            ttsPipelineChain = ttsPipelineChain.then(() =>
              synthesizeTtsBatchSlice(sub, {
                concurrency: 20,
                fixedVoice: singleVoice,
                strictVoice: true,
                pitch: currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined,
                rate: currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined
              })
                .catch(e => console.warn('[Streaming TTS] slice warning:', e.message))
            );
          }
        };

        const shouldStreamMacroBatches = !options.isAutoRescueAttempt && activeCues.length > 100 && speedMode !== 'quality';
        let pushedPreBatchUndo = false;
        if (shouldStreamMacroBatches) {
          let storyBible = null;
          try {
            const sbResp = await postJsonWithTunnelRecovery(
              `${BACKEND_URL}/api/translation/story-bible`,
              { cues: activeCues, sourceLang, targetLang, speedMode, videoPath: currentVideoPath || '' },
              { maxRetries: 2, retryDelayMs: 2000 }
            );
            if (sbResp && sbResp.data && sbResp.data.success) {
              storyBible = sbResp.data.storyBible || null;
            }
          } catch (_) {}

          const STREAM_SLICE_SIZE = 240;
          const mergedCues = activeCues.map(c => ({ ...c }));
          for (let offset = 0; offset < mergedCues.length; offset += STREAM_SLICE_SIZE) {
            const slice = mergedCues.slice(offset, offset + STREAM_SLICE_SIZE);
            if (!forceRetranslate && !cuesNeedTranslation(slice, targetLang)) {
              queueSliceTts(slice, offset);
              continue;
            }
            const statusEl = document.getElementById('bottomStatusMsg');
            const doneTarget = Math.min(offset + STREAM_SLICE_SIZE, mergedCues.length);
            if (statusEl) {
              statusEl.innerText = enablePipelinedTts
                ? `⚡ កំពុងបកប្រែ + បង្កើតសំឡេងព្រមគ្នា (${doneTarget}/${mergedCues.length} បន្ទាត់)...`
                : `⚡ កំពុងបកប្រែ Fast Stream (${doneTarget}/${mergedCues.length} បន្ទាត់)...`;
            }
            const sliceResp = await postJsonWithTunnelRecovery(
              `${BACKEND_URL}/api/translation/translate-cues`,
              {
                cues: slice,
                sourceLang,
                targetLang,
                force: forceRetranslate,
                videoPath: currentVideoPath || '',
                castMode,
                fixedVoice,
                speedMode,
                storyBible
              },
              { maxRetries: 4, retryDelayMs: 2500 }
            );
            if (sliceResp.data && sliceResp.data.success && Array.isArray(sliceResp.data.cues)) {
              if (!storyBible && sliceResp.data.storyBible) storyBible = sliceResp.data.storyBible;
              if (!pushedPreBatchUndo) {
                pushUndoState();
                pushedPreBatchUndo = true;
              }
              for (let k = 0; k < sliceResp.data.cues.length; k++) {
                if (mergedCues[offset + k]) {
                  mergedCues[offset + k] = sliceResp.data.cues[k];
                }
              }
              activeCues = normalizeCuesTiming(mergedCues);
              normalizeActiveCuesForCastMode(activeCues, castMode, fixedVoice);
              renderTable();
              queueSliceTts(activeCues.slice(offset, offset + slice.length), offset);
            } else {
              const sliceErr = new Error((sliceResp && sliceResp.data && sliceResp.data.error) || 'បរាជ័យក្នុងការបកប្រែផ្នែកនេះ');
              console.warn('[translation/stream] Slice failed, triggering recovery batching:', sliceErr.message);
              throw sliceErr;
            }
          }
          await ttsPipelineChain;
          data = { success: true, cues: activeCues };
        } else {
          try {
            const resp = await postJsonWithTunnelRecovery(
              `${BACKEND_URL}/api/translation/translate-cues`,
              {
                cues: activeCues,
                sourceLang,
                targetLang,
                force: forceRetranslate,
                videoPath: currentVideoPath || '',
                castMode,
                fixedVoice,
                speedMode
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
            if (activeCues.length > 20) {
              const BATCH_SIZE = 48;
              const mergedCues = activeCues.map(c => ({ ...c }));
              for (let offset = 0; offset < mergedCues.length; offset += BATCH_SIZE) {
                const slice = mergedCues.slice(offset, offset + BATCH_SIZE);
                if (!forceRetranslate && !cuesNeedTranslation(slice, targetLang)) {
                  continue;
                }
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
                    force: forceRetranslate,
                    videoPath: currentVideoPath || '',
                    castMode,
                    fixedVoice,
                    speedMode
                  },
                  { maxRetries: 3, retryDelayMs: 2500 }
                );
                if (translationJobSeq !== videoSelectionSeq) return false;
                if (batchResp.data && batchResp.data.success && Array.isArray(batchResp.data.cues)) {
                  if (!pushedPreBatchUndo) {
                    pushUndoState();
                    pushedPreBatchUndo = true;
                  }
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
        }
        if (translationJobSeq !== videoSelectionSeq) return false;
        if (data && data.success && data.cues) {
          if (!pushedPreBatchUndo) {
            pushUndoState();
          }
          activeCues = normalizeCuesTiming(data.cues);
          normalizeActiveCuesForCastMode(activeCues, castMode, fixedVoice);
          renderTable();
          renderTimeline();
          checkAllAudioCache();
          let remainingLeaks = countIncompleteCues(activeCues, targetLang);
          if (remainingLeaks > 0 && remainingLeaks < activeCues.length && !options.isAutoRescueAttempt) {
            const doneSoFar = Math.max(0, activeCues.length - remainingLeaks);
            document.getElementById('bottomStatusMsg').innerText = `🔄 បកប្រែបាន ${doneSoFar}/${activeCues.length} — កំពុងជួសជុល ${remainingLeaks} បន្ទាត់ដែលនៅសល់ដោយស្វ័យប្រវត្តិ...`;
            await startAiTranslation({
              silentSuccess: true,
              skipAutoChain: true,
              force: false,
              isAutoRescueAttempt: true,
              speedMode
            });
            if (translationJobSeq !== videoSelectionSeq) return false;
            remainingLeaks = countIncompleteCues(activeCues, targetLang);
          }
          if (remainingLeaks > 0) {
            const doneLines = Math.max(0, activeCues.length - remainingLeaks);
            const warnMsg = `⚠️ បកប្រែបាន ${doneLines}/${activeCues.length} បន្ទាត់ — នៅសល់ ${remainingLeaks} បន្ទាត់មិនទាន់បកប្រែអស់ សូមចុចបកប្រែម្ដងទៀត!`;
            document.getElementById('bottomStatusMsg').innerText = warnMsg;
            showShortcutToast(warnMsg);
          } else {
            document.getElementById('bottomStatusMsg').innerText = '✅ បានបកប្រែចប់សព្វគ្រប់ ' + activeCues.length + ' បន្ទាត់!';
            showShortcutToast('✅ បកប្រែរួចរាល់ ' + activeCues.length + ' បន្ទាត់!');
          }

          if (options.isAutoRescueAttempt) {
            return remainingLeaks === 0;
          }

          if (shouldAutoChain && remainingLeaks === 0) {
            if (currentVideoPath && !isVocalInvertOn) {
              toggleRemoveVocals();
            }
            await batchGenerateAllAudio({ silentSuccess: true, onlyMissing: usedStreamingTts });
          } else if (remainingLeaks === 0 && !options.silentSuccess) {
            showShortcutToast('✅ បានបកប្រែចប់គ្រប់បន្ទាត់!');
          }
          return remainingLeaks === 0;
        } else {
          alert('កំហុស៖ ' + ((data && data.error) || 'បរាជ័យ'));
          return false;
        }
      } catch (err) {
        if (translationJobSeq !== videoSelectionSeq) return false;
        alert('កំហុស Server: ' + err.message);
        return false;
      } finally {
        if (!options.isAutoRescueAttempt) {
          isTranslatingNow = false;
        }
      }
    }

    async function polishTranslatedScript() {
      if (isTranslatingNow) {
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ កំពុងដំណើរការបកប្រែ/សម្រួលពាក្យ សូមរង់ចាំបន្តិច...');
        }
        return false;
      }
      if (!Array.isArray(activeCues) || activeCues.length === 0) {
        alert('មិនទាន់មាន Subtitle សម្រាប់សម្រួលពាក្យទេ!');
        return false;
      }
      const sourceLangEl = document.getElementById('sourceLangSelect');
      const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';
      const targetLangEl = document.getElementById('targetLangSelect');
      const targetLang = targetLangEl ? targetLangEl.value : 'km';
      const hasAnyTranslated = activeCues.some(c => {
        const tr = String((c && c.translated) || '').trim();
        const src = String((c && c.text) || '').trim();
        return Boolean(tr && tr !== src);
      });
      if (!hasAnyTranslated) {
        alert('សូមបកប្រែ Subtitle ជាមុនសិន មុនពេលចុចសម្រួលពាក្យ!');
        return false;
      }

      const statusEl = document.getElementById('bottomStatusMsg');
      if (statusEl) {
        statusEl.innerText = '✨ កំពុងសម្រួលពាក្យបកប្រែឲ្យត្រូវជីវិតពិត និងត្រួតពិនិត្យឈ្មោះតួអង្គ...';
      }
      isTranslatingNow = true;
      stopDubAudio();
      const jobSeq = videoSelectionSeq;
      try {
        const resp = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/polish-cues`,
          {
            cues: activeCues,
            sourceLang,
            targetLang,
            videoPath: currentVideoPath || '',
            speedMode: 'quality'
          },
          { maxRetries: 3, retryDelayMs: 2500 }
        );
        if (jobSeq !== videoSelectionSeq) return false;
        const data = resp && resp.data;
        if (!data || !data.success || !Array.isArray(data.cues)) {
          alert('កំហុស៖ ' + ((data && data.error) || 'បរាជ័យក្នុងការសម្រួលពាក្យ'));
          return false;
        }
        const totalFixed = Number(data.totalFixedCount || 0);
        if (totalFixed > 0) {
          pushUndoState();
          activeCues = normalizeCuesTiming(data.cues);
          normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
          renderTable();
          renderTimeline();
          checkAllAudioCache();
          if (typeof autoSaveDraft === 'function') {
            autoSaveDraft().catch(() => {});
          }
        }
        const msg = totalFixed > 0
          ? `✨ បានសម្រួលភាសាជីវិតពិតចំនួន ${totalFixed} បន្ទាត់!`
          : '✨ ពាក្យបកប្រែទាំងអស់សមរម្យល្អរួចហើយ!';
        if (statusEl) statusEl.innerText = msg;
        if (typeof showShortcutToast === 'function') showShortcutToast(msg);
        return true;
      } catch (err) {
        if (jobSeq !== videoSelectionSeq) return false;
        alert('កំហុស Server: ' + err.message);
        return false;
      } finally {
        isTranslatingNow = false;
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

    async function startSubtitleOcr(options = {}) {
      if (isOcrRunningNow) {
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ កំពុងស្កេន OCR...');
        }
        return false;
      }
      const video = document.getElementById('mainVideo');
      if (!video.src || video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 0) {
        if (!options.silentSuccess) {
          alert('សូមផ្ទុកវីដេអូ ហើយរង់ចាំឲ្យវារួចរាល់ជាមុនសិន!');
        }
        return false;
      }

      const MAX_OCR_FRAMES = 25000;
      const OCR_BATCH_LEN = 12;
      const OCR_INFLIGHT_LIMIT = 3;
      const intervalSelect = document.getElementById('ocrIntervalSelect');
      const rawIntervalVal = intervalSelect ? intervalSelect.value : 'auto';
      const interval = rawIntervalVal === 'auto'
        ? (video.duration <= 1800 ? 1 : (video.duration <= 5400 ? 1.5 : 2))
        : (Number(rawIntervalVal) || 1);
      const scanRegion = document.getElementById('ocrScanRegion');
      const useSubtitleRegion = !scanRegion || scanRegion.value !== 'full';
      const sampleTimes = [];
      for (let timeSec = 0; timeSec < video.duration; timeSec += interval) {
        sampleTimes.push(timeSec);
      }
      if (sampleTimes.length > MAX_OCR_FRAMES) {
        if (!options.silentSuccess) {
          alert(`វីដេអូវែងពេកសម្រាប់ OCR មួយលើក (កំណត់ ${MAX_OCR_FRAMES.toLocaleString()} frames)។ សូមជ្រើសចន្លោះពេល Auto, 1s, 2s ឬ 3s។`);
        }
        return false;
      }
      if (!options.skipConfirm && !confirm(`Gemini Vision នឹងស្កេនប្រហែល ${sampleTimes.length.toLocaleString()} frame (ចន្លោះ ${interval}s — គាំទ្រវីដេអូ 2-3 ម៉ោងដោយរំលង frame ដដែលស្វ័យប្រវត្តិ)។ បន្តទេ?`)) {
        return false;
      }

      isOcrRunningNow = true;
      const originalTime = video.currentTime;
      const wasPlaying = !video.paused;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const sigCanvas = document.createElement('canvas');
      sigCanvas.width = 96;
      sigCanvas.height = 32;
      const sigContext = sigCanvas.getContext('2d', { willReadFrequently: true });

      const frameSlots = sampleTimes.map(timeSec => ({ timeSec, text: '', reusePrev: false }));
      let capturedCount = 0;
      let completedOcrCount = 0;
      let skippedStaticCount = 0;
      let consecutiveSkips = 0;
      let lastSentSig = null;
      let firstBatchErr = null;
      const inFlightUploads = new Set();
      video.pause();

      const updateOcrStatus = () => {
        const done = Math.min(sampleTimes.length, completedOcrCount + skippedStaticCount);
        const pct = sampleTimes.length > 0 ? Math.min(99, Math.round((done / sampleTimes.length) * 100)) : 0;
        const statusEl = document.getElementById('bottomStatusMsg');
        if (statusEl) {
          statusEl.innerText = `🈶 កំពុងស្កេនអក្សរ OCR: ${done}/${sampleTimes.length} frames (${pct}%${skippedStaticCount > 0 ? ` • រំលងដដែល ${skippedStaticCount}` : ''})`;
        }
      };

      const sourceLangEl = document.getElementById('sourceLangSelect');
      const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';

      const sendBatchWithRetry = async (batchItems) => {
        const payloadFrames = batchItems.map(item => ({
          timeSec: item.timeSec,
          mimeType: 'image/jpeg',
          imageBase64: item.imageBase64
        }));
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise(r => setTimeout(r, 800 * attempt));
            }
            const response = await fetch(`${BACKEND_URL}/api/translation/ocr-frames`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ frames: payloadFrames, sourceLang })
            });
            const data = await response.json();
            if (!response.ok || !data.success || !Array.isArray(data.frames)) {
              const err = new Error((data && data.error) || `OCR request failed (${response.status}).`);
              if (response.status === 401 || response.status === 403 || response.status === 400) {
                err.noRetry = true;
              }
              throw err;
            }
            data.frames.forEach((f, idx) => {
              const slot = batchItems[idx] ? frameSlots[batchItems[idx].slotIdx] : null;
              if (slot) slot.text = typeof f.text === 'string' ? f.text : '';
            });
            completedOcrCount += batchItems.length;
            updateOcrStatus();
            return;
          } catch (err) {
            lastErr = err;
            console.warn(`[OCR] Batch attempt ${attempt + 1} warning:`, err.message);
            if (err && err.noRetry) break;
          }
        }
        throw lastErr || new Error('OCR batch request failed.');
      };

      const enqueueUploadBatch = async (batchItems) => {
        if (!batchItems || batchItems.length === 0) return;
        while (inFlightUploads.size >= OCR_INFLIGHT_LIMIT) {
          await Promise.race(inFlightUploads).catch(() => {});
          if (firstBatchErr) throw firstBatchErr;
        }
        let p;
        p = sendBatchWithRetry(batchItems).catch(err => {
          if (!firstBatchErr) firstBatchErr = err;
        }).finally(() => {
          inFlightUploads.delete(p);
        });
        inFlightUploads.add(p);
      };

      try {
        const maxWidth = useSubtitleRegion ? 960 : 768;
        const jpegQuality = useSubtitleRegion ? 0.78 : 0.72;
        if (!video.videoWidth || !video.videoHeight || !context) {
          throw new Error('មិនអាចអានទំហំវីដេអូសម្រាប់ OCR បានទេ។');
        }
        let sourceY = 0;
        let sourceHeight = video.videoHeight;
        if (useSubtitleRegion) {
          // Cover both 16:9 bottom dialogue (84%-99%) and 9:16 / letterboxed subtitles (56%-95%),
          // instead of the previous 75.4%-85.4% strip that clipped off bottom 16:9 subtitles.
          const maskYEl = document.getElementById('maskYSlider');
          const maskHEl = document.getElementById('maskHSlider');
          const pctY = maskYEl ? parseFloat(maskYEl.value) : subtitleMaskState.yPercent;
          const pctH = maskHEl ? parseFloat(maskHEl.value) : subtitleMaskState.hPercent;
          const safeTopPct = Number.isFinite(pctY) ? Math.max(0, Math.min(95, pctY)) / 100 : 0.78;
          const safeHeightPct = Number.isFinite(pctH) ? Math.max(2, Math.min(60, pctH)) / 100 : 0.08;
          const sliderTopRatio = Math.max(0, Math.min(0.95, safeTopPct));
          const sliderBottomRatio = Math.max(sliderTopRatio + 0.05, Math.min(1, safeTopPct + safeHeightPct));
          const topRatio = Math.min(0.56, sliderTopRatio);
          const bottomRatio = Math.max(0.99, sliderBottomRatio);
          const heightRatio = Math.max(0.15, Math.min(1 - topRatio, bottomRatio - topRatio));
          sourceY = Math.round(video.videoHeight * topRatio);
          sourceHeight = Math.max(1, Math.round(video.videoHeight * heightRatio));
        }
        const scale = Math.min(1, maxWidth / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));

        let pendingBatch = [];
        for (let slotIdx = 0; slotIdx < sampleTimes.length; slotIdx++) {
          if (firstBatchErr) throw firstBatchErr;
          const timeSec = sampleTimes[slotIdx];
          await seekVideoForOcr(video, timeSec);
          context.drawImage(
            video,
            0, sourceY, video.videoWidth, sourceHeight,
            0, 0, canvas.width, canvas.height
          );

          let canReuse = false;
          let curSig = null;
          if (sigContext) {
            sigContext.drawImage(canvas, 0, 0, sigCanvas.width, sigCanvas.height);
            const px = sigContext.getImageData(0, 0, sigCanvas.width, sigCanvas.height).data;
            const totalPixels = sigCanvas.width * sigCanvas.height;
            curSig = new Uint8Array(totalPixels);
            for (let i = 0, p = 0; p < totalPixels; i += 4, p++) {
              curSig[p] = (px[i] + px[i + 1] + px[i + 1] + px[i + 2]) >> 2;
            }
            if (lastSentSig && consecutiveSkips < 2) {
              let sum = 0;
              let maxDiff = 0;
              let changedPixels = 0;
              for (let p = 0; p < totalPixels; p++) {
                const d = Math.abs(curSig[p] - lastSentSig[p]);
                sum += d;
                if (d > maxDiff) maxDiff = d;
                if (d > 14) changedPixels++;
              }
              if ((sum / totalPixels) < 0.7 && maxDiff < 6 && changedPixels <= Math.floor(totalPixels * 0.004)) {
                canReuse = true;
              }
            }
          }

          capturedCount++;
          if (canReuse) {
            frameSlots[slotIdx].reusePrev = true;
            skippedStaticCount++;
            consecutiveSkips++;
            if (capturedCount % 10 === 0) updateOcrStatus();
            continue;
          }

          consecutiveSkips = 0;
          lastSentSig = curSig;
          const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
          pendingBatch.push({
            slotIdx,
            timeSec,
            imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1)
          });

          if (pendingBatch.length >= OCR_BATCH_LEN) {
            const toSend = pendingBatch;
            pendingBatch = [];
            await enqueueUploadBatch(toSend);
          }
        }

        if (pendingBatch.length > 0 && !firstBatchErr) {
          await enqueueUploadBatch(pendingBatch);
        }
        await Promise.all(Array.from(inFlightUploads));
        if (firstBatchErr) throw firstBatchErr;

        // Fill static skipped slots chronologically from immediately preceding OCR result
        for (let i = 0; i < frameSlots.length; i++) {
          if (frameSlots[i].reusePrev) {
            frameSlots[i].text = i > 0 ? frameSlots[i - 1].text : '';
          }
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

        for (const frame of frameSlots) {
          const text = (frame.text || '').replace(/\s+/g, ' ').trim();
          if (current && text === current.text) continue;
          if (current) addCurrent(frame.timeSec);
          if (text) current = { startSec: frame.timeSec, text };
        }
        if (current) {
          const lastTime = frameSlots.length ? frameSlots[frameSlots.length - 1].timeSec : current.startSec;
          addCurrent(Math.min(video.duration, lastTime + interval));
        }
        if (detectedCues.length === 0) {
          throw new Error('មិនបានរកឃើញអក្សរចិននៅលើ frame ដែលបានស្កេនទេ។');
        }
        if (!options.skipConfirm && activeCues.length > 0 && !confirm(`រកឃើញ ${detectedCues.length} បន្ទាត់។ តើជំនួស subtitle បច្ចុប្បន្នទេ?`)) {
          return false;
        }

        pushUndoState();
        activeCues = detectedCues;
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        renderTable();
        renderTimeline();
        updateTranslationState();
        document.getElementById('bottomStatusMsg').innerText =
          `✅ OCR រកឃើញ ${detectedCues.length} បន្ទាត់ (ចន្លោះ ${interval}s • រំលង frame ដដែល ${skippedStaticCount})។`;
        if (!options.silentSuccess) {
          showShortcutToast('🈶 OCR បានបង្កើត subtitle');
        }
        return true;
      } catch (err) {
        document.getElementById('bottomStatusMsg').innerText = '❌ OCR បរាជ័យ៖ ' + err.message;
        if (!options.silentSuccess) {
          alert('OCR បរាជ័យ៖ ' + err.message);
        } else {
          showShortcutToast('❌ OCR បរាជ័យ៖ ' + err.message, 5000);
        }
        return false;
      } finally {
        isOcrRunningNow = false;
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
      const reqSeq = videoSelectionSeq;
      if (activeUploadAbortController) {
        try { activeUploadAbortController.abort(); } catch (_) {}
      }
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      activeUploadAbortController = ctrl;
      const statusEl = document.getElementById('bottomStatusMsg');
      if (statusEl) {
        statusEl.innerText = `⏳ កំពុងផ្ទុកវីដេអូ "${file.name}" ទៅកាន់ Server...`;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
          signal: ctrl ? ctrl.signal : undefined
        });
        const data = await res.json();
        if (reqSeq !== videoSelectionSeq) return '';
        if (res.ok && data && data.success && data.filePath) {
          currentVideoPath = data.filePath;
          syncCachedBgmStemForVideo(currentVideoPath);
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
        if (err && err.name === 'AbortError') return '';
        if (reqSeq !== videoSelectionSeq) return '';
        console.warn('Video upload sync failed:', err.message);
        if (statusEl) statusEl.innerText = `❌ ផ្ទុកវីដេអូបរាជ័យ៖ ${err.message}`;
        showShortcutToast('❌ ផ្ទុកវីដេអូបរាជ័យ៖ ' + err.message);
      } finally {
        if (activeUploadAbortController === ctrl) {
          activeUploadAbortController = null;
        }
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

    function resetSubtitleStateOnVideoSwitch(hadPriorVideo) {
      clearDubAndPlaybackState();
      _exportMediaProbeCache = { videoPath: '', width: 0, height: 0, durationSec: 0, videoBitrateKbps: 0 };
      if (hadPriorVideo && activeCues.length > 0) {
        activeCues = [];
        cachedAudioMap.clear();
        cachedAudioUrls.clear();
        renderTable();
        renderTimeline();
      }
    }

    async function openVideoFile() {
      if (window.electronAPI && typeof window.electronAPI.openFileDialog === 'function') {
        try {
          const selectedPath = await window.electronAPI.openFileDialog({
            filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v'] }]
          });
          if (!selectedPath) return false;

          videoSelectionSeq++;
          if (activeUploadAbortController) {
            try { activeUploadAbortController.abort(); } catch (_) {}
            activeUploadAbortController = null;
          }
          const hadPriorVideo = Boolean(currentVideoPath || lastSelectedVideoFile);
          lastSelectedVideoFile = null;
          currentVideoPath = selectedPath;
          currentSrtPath = '';
          currentDramaInfo = null;
          resetSubtitleStateOnVideoSwitch(hadPriorVideo);
          const fileName = selectedPath.split(/[\\/]/).pop() || selectedPath;
          document.getElementById('currentDramaTitleTag').innerText = fileName;
          document.getElementById('videoTrackTitle').innerText = fileName;
          setVideoSource(`${BACKEND_URL}/api/video-stream?file=` + encodeURIComponent(selectedPath));
          syncCachedBgmStemForVideo(currentVideoPath);
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
      if (typeof pendingVideoSelectResolve === 'function') {
        const prevResolve = pendingVideoSelectResolve;
        pendingVideoSelectResolve = null;
        try { prevResolve(false); } catch (_) {}
      }
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
          cachedAudioUrls.clear();
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
      videoSelectionSeq++;
      if (activeUploadAbortController) {
        try { activeUploadAbortController.abort(); } catch (_) {}
        activeUploadAbortController = null;
      }
      const hadPriorVideo = Boolean(currentVideoPath || lastSelectedVideoFile);
      lastSelectedVideoFile = file;
      currentVideoPath = '';
      currentSrtPath = '';
      currentDramaInfo = null;
      resetSubtitleStateOnVideoSwitch(hadPriorVideo);
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
    const ECO_CPU_STORAGE_KEY = 'eza_eco_cpu_mode';
    const LOGO_OVERLAY_STORAGE_KEY = 'eza_logo_overlay_config';
    const SPONSOR_OVERLAY_STORAGE_KEY = 'eza_sponsor_overlay_config';
    let exportCapabilitiesLoaded = false;
    let cachedSystemProfile = null;
    let defaultExportDirPath = '';
    let lastExportedFilePath = '';

    function isEcoCpuModeActive() {
      const chk = typeof document !== 'undefined' ? document.getElementById('ecoCpuModeCheck') : null;
      if (chk) return Boolean(chk.checked);
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          return localStorage.getItem(ECO_CPU_STORAGE_KEY) === '1';
        }
      } catch (_) {}
      return false;
    }

    function applyEcoCpuSavedState() {
      const chk = typeof document !== 'undefined' ? document.getElementById('ecoCpuModeCheck') : null;
      if (!chk) return;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const saved = localStorage.getItem(ECO_CPU_STORAGE_KEY);
          if (saved === '1' || saved === '0') {
            chk.checked = saved === '1';
          }
        }
      } catch (_) {}
    }

    function onEcoCpuModeToggle() {
      const chk = typeof document !== 'undefined' ? document.getElementById('ecoCpuModeCheck') : null;
      const enabled = Boolean(chk && chk.checked);
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ECO_CPU_STORAGE_KEY, enabled ? '1' : '0');
        }
      } catch (_) {}
      if (enabled) {
        const resEl = document.getElementById('exportResolution');
        if (resEl && resEl.value === '4k') resEl.value = 'source';
      }
      if (typeof renderVmStudioPresetStrip === 'function') {
        try { renderVmStudioPresetStrip(); } catch (_) {}
      }
      if (typeof updateExportPreviewSummary === 'function') {
        try { updateExportPreviewSummary(); } catch (_) {}
      }
    }

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
          || appendAccessTokenToUrl(`${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(stateObj.filePath)}&v=${stateObj.updatedAt || 1}`))
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

    function applySelectedLogoFile(filePath, fileName = '', previewUrl = '', options = {}) {
      if (!filePath && !previewUrl) return;
      const cleanPath = String(filePath || fileName || '').trim();
      const cleanName = fileName || extractFileName(cleanPath);
      const shouldRevoke = options.revokePrevious !== false;
      if (shouldRevoke && logoOverlayState.previewUrl && logoOverlayState.previewUrl !== previewUrl) {
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

    let _logoUploadSeq = 0;

    async function handleLogoFileUpload(e) {
      const file = e && e.target && e.target.files ? e.target.files[0] : null;
      if (e && e.target) e.target.value = '';
      if (!file) return;
      const uploadSeq = ++_logoUploadSeq;
      const prevSnapshot = { ...logoOverlayState };
      const localPreviewUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(file)
        : '';
      if (localPreviewUrl) {
        applySelectedLogoFile('', file.name, localPreviewUrl, { revokePrevious: false });
        logoOverlayState.filePath = '';
        saveLogoOverlayState();
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const data = await res.json().catch(() => null);
        if (uploadSeq !== _logoUploadSeq) {
          if (localPreviewUrl) {
            try { URL.revokeObjectURL(localPreviewUrl); } catch (_) {}
          }
          return;
        }
        if (res.ok && data && data.success && data.filePath) {
          if (prevSnapshot.previewUrl && prevSnapshot.previewUrl !== localPreviewUrl) {
            try { URL.revokeObjectURL(prevSnapshot.previewUrl); } catch (_) {}
          }
          applySelectedLogoFile(data.filePath, file.name, localPreviewUrl);
          return;
        }
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      } catch (err) {
        if (uploadSeq !== _logoUploadSeq) return;
        if (localPreviewUrl) {
          try { URL.revokeObjectURL(localPreviewUrl); } catch (_) {}
        }
        Object.assign(logoOverlayState, prevSnapshot);
        saveLogoOverlayState();
        renderLogoOverlayPreview();
        showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Logo បានទេ៖ ' + err.message);
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

    function applySelectedSponsorFile(filePath, fileName = '', previewUrl = '', options = {}) {
      if (!filePath && !previewUrl) return;
      const cleanPath = String(filePath || fileName || '').trim();
      const cleanName = fileName || extractFileName(cleanPath);
      const shouldRevoke = options.revokePrevious !== false;
      if (shouldRevoke && sponsorOverlayState.previewUrl && sponsorOverlayState.previewUrl !== previewUrl) {
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

    let _sponsorUploadSeq = 0;

    async function handleSponsorFileUpload(e) {
      const file = e && e.target && e.target.files ? e.target.files[0] : null;
      if (e && e.target) e.target.value = '';
      if (!file) return;
      const uploadSeq = ++_sponsorUploadSeq;
      const prevSnapshot = { ...sponsorOverlayState };
      const localPreviewUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(file)
        : '';
      if (localPreviewUrl) {
        applySelectedSponsorFile('', file.name, localPreviewUrl, { revokePrevious: false });
        sponsorOverlayState.filePath = '';
        saveSponsorOverlayState();
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/upload-video?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const data = await res.json().catch(() => null);
        if (uploadSeq !== _sponsorUploadSeq) {
          if (localPreviewUrl) {
            try { URL.revokeObjectURL(localPreviewUrl); } catch (_) {}
          }
          return;
        }
        if (res.ok && data && data.success && data.filePath) {
          if (prevSnapshot.previewUrl && prevSnapshot.previewUrl !== localPreviewUrl) {
            try { URL.revokeObjectURL(prevSnapshot.previewUrl); } catch (_) {}
          }
          applySelectedSponsorFile(data.filePath, file.name, localPreviewUrl);
          return;
        }
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      } catch (err) {
        if (uploadSeq !== _sponsorUploadSeq) return;
        if (localPreviewUrl) {
          try { URL.revokeObjectURL(localPreviewUrl); } catch (_) {}
        }
        Object.assign(sponsorOverlayState, prevSnapshot);
        saveSponsorOverlayState();
        renderSponsorOverlayPreview();
        showShortcutToast('❌ មិនអាចផ្ទុកឯកសារ Sponsor បានទេ៖ ' + err.message);
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
      if (box.dataset && box.dataset.dragBound === '1') return;
      if (box.dataset) box.dataset.dragBound = '1';
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

    function syncExportQuickModePills() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      const videoModeEl = document.getElementById('exportVideoModeSelect');
      const isCopy = Boolean(videoModeEl && videoModeEl.value === 'copy');
      const crActive = typeof copyrightGuardState !== 'undefined' && Boolean(copyrightGuardState && copyrightGuardState.enabled);
      const activeMode = isCopy ? 'copy' : (crActive ? 'copyright' : 'standard');
      document.querySelectorAll('#exportQuickModeGroup .export-mode-card[data-export-mode]').forEach(btn => {
        if (!btn || !btn.classList || typeof btn.getAttribute !== 'function') return;
        btn.classList.toggle('active', btn.getAttribute('data-export-mode') === activeMode);
      });
    }

    function selectExportQuickMode(mode) {
      const target = String(mode || 'standard').toLowerCase();
      const videoModeEl = document.getElementById('exportVideoModeSelect');
      if (target === 'copy') {
        if (videoModeEl) videoModeEl.value = 'copy';
        if (typeof copyrightGuardState !== 'undefined' && copyrightGuardState && copyrightGuardState.enabled && typeof applyCopyrightPreset === 'function') {
          applyCopyrightPreset('off');
        }
      } else if (target === 'copyright') {
        if (videoModeEl) videoModeEl.value = 'burn';
        if (typeof copyrightGuardState !== 'undefined' && (!copyrightGuardState || !copyrightGuardState.enabled) && typeof applyCopyrightPreset === 'function') {
          applyCopyrightPreset('safe');
        }
      } else {
        if (videoModeEl) videoModeEl.value = 'burn';
        if (typeof copyrightGuardState !== 'undefined' && copyrightGuardState && copyrightGuardState.enabled && typeof applyCopyrightPreset === 'function') {
          applyCopyrightPreset('off');
        }
      }
      if (typeof syncExportDubControls === 'function') syncExportDubControls();
      updateExportPreviewSummary();
      return target;
    }

    const CLIENT_MAXRATE_TIERS_KBPS = {
      fast: { '720p': 1100, '1080p': 1600, '4k': 4500 },
      balanced: { '720p': 1400, '1080p': 2200, '4k': 6500 },
      hd: { '720p': 2000, '1080p': 3200, '4k': 9500 },
      ultra: { '720p': 3500, '1080p': 6000, '4k': 16000 }
    };
    let _exportMediaProbeCache = { videoPath: '', width: 0, height: 0, durationSec: 0, videoBitrateKbps: 0 };

    function formatExportSizeLabel(sizeMB) {
      const mb = Math.max(1, Math.round(Number(sizeMB) || 0));
      if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
      return `${mb} MB`;
    }

    function getClientExportEstimate() {
      const videoEl = typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById('mainVideo')
        : null;
      const vidPath = typeof currentVideoPath !== 'undefined' ? String(currentVideoPath || '') : '';
      const hasProbe = vidPath && _exportMediaProbeCache.videoPath === vidPath;
      const rawDur = (hasProbe && _exportMediaProbeCache.durationSec > 0 ? _exportMediaProbeCache.durationSec : 0)
        || (videoEl && Number(videoEl.duration) > 0 ? Number(videoEl.duration) : 0)
        || (typeof currentVideoDuration !== 'undefined' && Number(currentVideoDuration) > 0 ? Number(currentVideoDuration) : 0);
      const srcW = (hasProbe && _exportMediaProbeCache.width > 0 ? _exportMediaProbeCache.width : 0)
        || (videoEl && Number(videoEl.videoWidth) > 0 ? Number(videoEl.videoWidth) : 0);
      const srcH = (hasProbe && _exportMediaProbeCache.height > 0 ? _exportMediaProbeCache.height : 0)
        || (videoEl && Number(videoEl.videoHeight) > 0 ? Number(videoEl.videoHeight) : 0);
      const srcBitrateKbps = hasProbe ? (Number(_exportMediaProbeCache.videoBitrateKbps) || 0) : 0;

      const videoModeEl = typeof document !== 'undefined' ? document.getElementById('exportVideoModeSelect') : null;
      const resEl = typeof document !== 'undefined' ? document.getElementById('exportResolution') : null;
      const qualityEl = typeof document !== 'undefined' ? document.getElementById('exportQualityPreset') : null;
      const fastCopy = Boolean(videoModeEl && videoModeEl.value === 'copy');
      const resolution = resEl && resEl.value ? resEl.value : 'source';
      const rawPreset = qualityEl && qualityEl.value ? qualityEl.value : 'balanced';
      const presetKey = CLIENT_MAXRATE_TIERS_KBPS[rawPreset] ? rawPreset : 'balanced';
      const audioKbps = presetKey === 'ultra' ? 192 : (presetKey === 'hd' ? 160 : 128);

      const crSpeed = (typeof copyrightGuardState !== 'undefined' && copyrightGuardState && copyrightGuardState.enabled && Number(copyrightGuardState.speedPercent) > 0)
        ? Number(copyrightGuardState.speedPercent) / 100
        : 1.0;
      const effDurSec = rawDur > 0 ? (rawDur / crSpeed) : 0;

      if (fastCopy) {
        const estMB = effDurSec > 0 && srcBitrateKbps > 0
          ? Math.round(((srcBitrateKbps + audioKbps) * effDurSec) / 8 / 1024)
          : 0;
        return { mode: 'copy', presetKey, resolution, estimatedSizeMB: estMB, maxSizeMB: estMB, durationSec: effDurSec };
      }

      const tiers = CLIENT_MAXRATE_TIERS_KBPS[presetKey];
      const longEdge = Math.max(srcW, srcH);
      let tier = '1080p';
      if (resolution === '4k' || (resolution === 'source' && longEdge >= 3000)) tier = '4k';
      else if (resolution === '720p' || (resolution === 'source' && longEdge > 0 && longEdge <= 1360)) tier = '720p';
      const tierCap = tiers[tier];
      let maxrateKbps = tierCap;
      if (srcBitrateKbps > 0 && presetKey !== 'ultra') {
        const minFloor = tier === '720p' ? 950 : (tier === '4k' ? 3500 : 1400);
        const mult = presetKey === 'fast' ? 2.0 : (presetKey === 'balanced' ? 2.4 : 3.2);
        maxrateKbps = Math.min(tierCap, Math.max(minFloor, Math.round(srcBitrateKbps * mult)));
      }
      const avgFactor = presetKey === 'fast' ? 0.78 : (presetKey === 'balanced' ? 0.85 : (presetKey === 'hd' ? 0.90 : 0.75));
      const estKbps = Math.max(400, Math.round(maxrateKbps * avgFactor)) + audioKbps;
      const maxKbps = maxrateKbps + audioKbps;
      return {
        mode: 'reencode',
        presetKey,
        resolution,
        maxrateKbps,
        audioKbps,
        durationSec: effDurSec,
        estimatedSizeMB: effDurSec > 0 ? Math.round((estKbps * effDurSec) / 8 / 1024) : 0,
        maxSizeMB: effDurSec > 0 ? Math.round((maxKbps * effDurSec) / 8 / 1024) : 0
      };
    }

    function refreshExportSizeEstimateProbe() {
      const vidPath = typeof currentVideoPath !== 'undefined' ? String(currentVideoPath || '').trim() : '';
      if (!vidPath || typeof fetch !== 'function' || _exportMediaProbeCache.videoPath === vidPath) return;
      const qualityEl = typeof document !== 'undefined' ? document.getElementById('exportQualityPreset') : null;
      const resEl = typeof document !== 'undefined' ? document.getElementById('exportResolution') : null;
      const videoModeEl = typeof document !== 'undefined' ? document.getElementById('exportVideoModeSelect') : null;
      fetch(`${BACKEND_URL}/api/export/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: vidPath,
          qualityPreset: qualityEl ? qualityEl.value : 'balanced',
          resolution: resEl ? resEl.value : 'source',
          fastCopy: Boolean(videoModeEl && videoModeEl.value === 'copy')
        })
      })
        .then(r => r && r.ok ? r.json() : null)
        .then(data => {
          if (data && data.success && data.sourceMedia) {
            _exportMediaProbeCache = {
              videoPath: vidPath,
              width: Number(data.sourceMedia.width) || 0,
              height: Number(data.sourceMedia.height) || 0,
              durationSec: Number(data.sourceMedia.durationSec) || 0,
              videoBitrateKbps: Number(data.sourceMedia.videoBitrateKbps) || 0
            };
            updateExportPreviewSummary();
          }
        })
        .catch(() => {});
    }

    function updateExportReadinessBar() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const bar = document.getElementById('exportReadinessBar');
      if (!bar) return;
      const videoEl = document.getElementById('mainVideo');
      const hasVideo = Boolean((typeof currentVideoPath !== 'undefined' && currentVideoPath) || (videoEl && videoEl.src));
      const cuesList = typeof activeCues !== 'undefined' && Array.isArray(activeCues) ? activeCues : [];
      const cueCount = cuesList.length;
      const readyEngine = typeof getActiveTtsEngine === 'function' ? getActiveTtsEngine() : 'edge';
      const readyCastMode = typeof getActiveCastMode === 'function' ? getActiveCastMode() : 'auto';
      const readyLockedVoice = typeof getSelectedSingleVoice === 'function' ? getSelectedSingleVoice() : '';
      const dubCount = cuesList.filter(c => c && (c.audioUrl || (typeof isCueVoiceCached === 'function' && isCueVoiceCached(c, readyCastMode, readyLockedVoice, readyEngine)))).length;
      const audioModeEl = document.getElementById('exportAudioMode');
      const audioMap = {
        bgm_only: '🎵 BGM + Dub',
        mix_custom: '🎛️ លាយ ៣ ស្រទាប់',
        duck: '🔉 Duck + Dub',
        bg_low: '🔉 18% + Dub',
        dub_only: '🗣️ Dub សុទ្ធ',
        original: '🔇 សំឡេងដើម'
      };
      const audioLabel = audioMap[audioModeEl ? audioModeEl.value : 'bgm_only'] || '🔊 Audio';
      const maskOn = Boolean(document.getElementById('maskToggleCheck')?.checked);
      const hasLogo = Boolean(typeof logoOverlayState !== 'undefined' && logoOverlayState && logoOverlayState.enabled && (logoOverlayState.filePath || logoOverlayState.previewUrl));
      const hasSponsor = Boolean(typeof sponsorOverlayState !== 'undefined' && sponsorOverlayState && sponsorOverlayState.enabled && (sponsorOverlayState.filePath || sponsorOverlayState.previewUrl));
      const crOn = typeof copyrightGuardState !== 'undefined' && Boolean(copyrightGuardState && copyrightGuardState.enabled);
      const est = getClientExportEstimate();
      const presetBadgeMap = { fast: '⚡ Fast', balanced: '⚖️ Balanced', hd: '💎 HD', ultra: '🔥 Ultra' };
      const presetBadge = est.mode === 'copy' ? '⚡ Copy' : (presetBadgeMap[est.presetKey] || '⚖️ Balanced');

      const pills = [
        `<span class="export-ready-pill ${hasVideo ? 'ok' : 'warn'}">${hasVideo ? '🎬 វីដេអូ៖ រួចរាល់' : '⚠️ មិនទាន់រើសវីដេអូ'}</span>`,
        cueCount > 0
          ? `<span class="export-ready-pill ${dubCount > 0 ? 'ok' : 'info'}">💬 អក្សរ ${cueCount} · 🗣️ ${dubCount}</span>`
          : '<span class="export-ready-pill warn">⚠️ គ្មានអក្សររត់</span>',
        `<span class="export-ready-pill info">${audioLabel}</span>`,
        est.estimatedSizeMB > 0
          ? `<span class="export-ready-pill ok" title="ទំហំប៉ាន់ស្មាន (អតិបរមា ~${formatExportSizeLabel(est.maxSizeMB)})">📦 ~${formatExportSizeLabel(est.estimatedSizeMB)} · ${presetBadge}</span>`
          : `<span class="export-ready-pill info">📦 ${presetBadge}</span>`
      ];
      if (maskOn) pills.push('<span class="export-ready-pill info">🌫️ ព្រាល៖ បើក</span>');
      if (hasLogo || hasSponsor) pills.push(`<span class="export-ready-pill info">${hasLogo && hasSponsor ? '🖼️ Logo + Sponsor' : (hasLogo ? '🖼️ Logo' : '🎬 Sponsor')}</span>`);
      pills.push(`<span class="export-ready-pill ${crOn ? 'ok' : ''}">🛡️ CR៖ ${crOn ? 'បើក' : 'បិទ'}</span>`);
      bar.innerHTML = pills.join('');
    }

    function updateExportPreviewSummary() {
      const summaryEl = document.getElementById('exportPreviewSummary');
      if (!summaryEl) return;
      const videoModeEl = document.getElementById('exportVideoModeSelect');
      const est = getClientExportEstimate();
      const estPart = est.estimatedSizeMB > 0
        ? ` · 📦 ប៉ាន់ស្មាន ~${formatExportSizeLabel(est.estimatedSizeMB)} (អតិបរមា ~${formatExportSizeLabel(est.maxSizeMB)})`
        : '';
      if (videoModeEl && videoModeEl.value === 'copy') {
        const copyEst = est.estimatedSizeMB > 0 ? ` · 📦 ~${formatExportSizeLabel(est.estimatedSizeMB)}` : '';
        const modeEl = document.getElementById('exportAudioMode');
        const audioModeVal = modeEl ? modeEl.value : 'bgm_only';
        const wantsBgmStem = audioModeVal === 'bgm_only' || (audioModeVal === 'mix_custom' && audioMixerState.bgmOnPause && audioMixerState.bgmPct > 0);
        const hasAiEngine = typeof audioSeparationCapabilities !== 'undefined' && Boolean(audioSeparationCapabilities.ai);
        const hasAiStemReady = Boolean(currentIsolatedBgmUrl) && typeof isAiSeparationEngineClient === 'function' && isAiSeparationEngineClient(currentIsolatedBgmEngine);
        const vidMins = est.durationSec > 0 ? Math.round(est.durationSec / 60) : 0;
        if (wantsBgmStem && hasAiEngine && !hasAiStemReady && vidMins >= 3) {
          const estUvrMin = Math.max(1, Math.round(vidMins / 6));
          summaryEl.innerText = `⏳ វីដេអូ ${vidMins} នាទីមិនទាន់បំបែកភ្លេង UVR AI ទេ (ត្រូវបំបែក ~${estUvrMin} នាទីសិន មុន Copy -c:v ~15s${copyEst}) · ចង់លឿន 20s ភ្លាម សូមរើស «🔉 Duck + Dub»`;
        } else {
          summaryEl.innerText = `⚡ ប្ដូរតែសំឡេង (-c:v copy · រក្សាវីដេអូដើម 100% មិន Render រូបភាព · ~10–20s${copyEst})`;
        }
      } else {
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
        const crSummary = typeof formatCopyrightSummaryText === 'function' ? formatCopyrightSummaryText() : 'បិទ';
        const crPart = ` · 🛡️ CR៖ ${crSummary}`;
        const presetLabelMap = { fast: 'Fast', balanced: 'Balanced', hd: 'HD', ultra: 'Ultra' };
        const qualityTag = ` · 💎 ${presetLabelMap[est.presetKey] || 'Balanced'} (${est.resolution === 'source' ? 'Original' : est.resolution})`;
        summaryEl.innerText = `ស្ទីល៖ ${styleText} · ផ្ទៃបាំងអក្សរ៖ ${maskEnabled ? maskModeText : 'បិទ'}${overlaySummary}${crPart}${qualityTag}${estPart}`;
        const subModalBadge = document.getElementById('exportModalSubSummary');
        if (subModalBadge) {
          const posName = currentSubPosYPercent <= 18 ? '⬇️ ក្រោម' : (currentSubPosYPercent >= 68 ? '⬆️ លើ' : '⏹️ កណ្តាល');
          const cleanStyle = styleText.split('(')[0].trim();
          subModalBadge.innerText = `${cleanStyle} · ${posName} (${currentSubPosYPercent}%) · ${currentSubFontSize}px`;
        }
      }
      if (typeof renderCopyrightExportRow === 'function') renderCopyrightExportRow();
      syncExportQuickModePills();
      updateExportReadinessBar();
    }

    function onCustomExportOutputDirInput(val) {
      const clean = String(val || '').trim();
      try {
        if (typeof localStorage !== 'undefined') {
          if (clean) localStorage.setItem(EXPORT_OUTPUT_DIR_STORAGE_KEY, clean);
          else localStorage.removeItem(EXPORT_OUTPUT_DIR_STORAGE_KEY);
        }
      } catch (_) {}
      const resetBtn = document.getElementById('btnResetExportDir');
      if (resetBtn) resetBtn.hidden = !clean;
    }

    let pendingInAppFolderResolve = null;

    function closeInAppFolderBrowserModal(selectedPath = '') {
      const modal = document.getElementById('inAppFolderBrowserModal');
      if (modal && modal.style) modal.style.display = 'none';
      if (typeof pendingInAppFolderResolve === 'function') {
        const resFn = pendingInAppFolderResolve;
        pendingInAppFolderResolve = null;
        resFn(selectedPath || '');
      }
    }

    async function loadInAppFolderBrowserPath(targetPath = '', createFolderName = '') {
      const listEl = document.getElementById('inAppFolderBrowserList');
      const pathInput = document.getElementById('inAppFolderBrowserPathInput');
      const shortcutsEl = document.getElementById('inAppFolderBrowserShortcuts');
      if (listEl) {
        listEl.innerHTML = '<div style="padding:18px; color:#94a3b8; text-align:center;">⏳ កំពុងផ្ទុកបញ្ជី Folder...</div>';
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/list-directories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPath: targetPath, createFolderName })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចអាន Folder បានទេ');
        }
        if (pathInput) pathInput.value = data.currentPath || '';
        const upBtn = document.getElementById('inAppFolderBrowserUpBtn');
        if (upBtn) {
          upBtn.disabled = !data.parentPath;
          upBtn.onclick = () => loadInAppFolderBrowserPath(data.parentPath || '');
        }
        if (shortcutsEl) {
          const driveBtns = (Array.isArray(data.drives) ? data.drives : []).map(d =>
            `<button type="button" class="btn-mini" onclick="loadInAppFolderBrowserPath(${escapeHtml(JSON.stringify(d))})">💿 ${escapeHtml(d)}</button>`
          );
          const scBtns = (Array.isArray(data.shortcuts) ? data.shortcuts : []).map(s =>
            `<button type="button" class="btn-mini" onclick="loadInAppFolderBrowserPath(${escapeHtml(JSON.stringify(s.path))})">${escapeHtml(s.label)}</button>`
          );
          shortcutsEl.innerHTML = [...driveBtns, ...scBtns].join('');
        }
        if (listEl) {
          const folders = Array.isArray(data.folders) ? data.folders : [];
          if (folders.length === 0) {
            listEl.innerHTML = '<div style="padding:20px; color:#94a3b8; text-align:center;">📂 មិនមាន Folder រងនៅក្នុងទីតាំងនេះទេ — អ្នកអាចចុច «✅ ជ្រើសរើស Folder នេះ» ឬបង្កើត Folder ថ្មី</div>';
          } else {
            listEl.innerHTML = folders.map(f =>
              `<button type="button" class="top-btn" style="justify-content:flex-start; width:100%; padding:8px 12px; text-align:left; font-size:12.5px;" onclick="loadInAppFolderBrowserPath(${escapeHtml(JSON.stringify(f.path))})">📁 ${escapeHtml(f.name)}</button>`
            ).join('');
          }
        }
      } catch (err) {
        if (listEl) {
          listEl.innerHTML = `<div style="padding:16px; color:#fca5a5; text-align:center;">❌ ${escapeHtml(err.message)}</div>`;
        }
      }
    }

    function openInAppFolderBrowserModal(initialPath = '') {
      if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
        return Promise.resolve('');
      }
      let modal = document.getElementById('inAppFolderBrowserModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'inAppFolderBrowserModal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none; z-index:9999; align-items:center; justify-content:center;';
        modal.innerHTML = `
          <div class="modal-card" style="max-width:580px; width:94%; max-height:82vh; display:flex; flex-direction:column; gap:10px; padding:16px;">
            <div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">
              <span>📁 ជ្រើសរើសទីតាំង Folder (Explorer)</span>
              <button type="button" class="modal-close" onclick="closeInAppFolderBrowserModal('')">✕</button>
            </div>
            <div id="inAppFolderBrowserShortcuts" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
            <div style="display:flex; gap:6px; align-items:center;">
              <button type="button" id="inAppFolderBrowserUpBtn" class="btn-mini" title="ថយទៅ Folder មេ">⬆️ ថយក្រោយ</button>
              <input type="text" id="inAppFolderBrowserPathInput" class="mini-input" style="flex:1;" placeholder="D:\\EZARG\\Exported" onkeydown="if(event.key==='Enter') loadInAppFolderBrowserPath(this.value)">
              <button type="button" class="btn-mini" onclick="loadInAppFolderBrowserPath(document.getElementById('inAppFolderBrowserPathInput').value)">ទៅកាន់</button>
            </div>
            <div id="inAppFolderBrowserList" style="flex:1; min-height:200px; max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:5px; padding:8px; border:1px solid rgba(56,189,248,0.25); border-radius:8px; background:#070c18;"></div>
            <div style="display:flex; gap:6px; align-items:center; justify-content:space-between; flex-wrap:wrap;">
              <div style="display:flex; gap:6px; align-items:center;">
                <input type="text" id="inAppNewFolderInput" class="mini-input" style="width:170px;" placeholder="ឈ្មោះ Folder ថ្មី...">
                <button type="button" class="btn-mini" onclick="const inp=document.getElementById('inAppNewFolderInput'); const cur=document.getElementById('inAppFolderBrowserPathInput').value; if(inp && inp.value.trim()){ loadInAppFolderBrowserPath(cur, inp.value.trim()); inp.value=''; }">➕ បង្កើត Folder</button>
              </div>
              <div style="display:flex; gap:8px;">
                <button type="button" class="top-btn" onclick="closeInAppFolderBrowserModal('')">បោះបង់</button>
                <button type="button" class="btn-export" style="padding:7px 16px;" onclick="closeInAppFolderBrowserModal(document.getElementById('inAppFolderBrowserPathInput').value)">✅ ជ្រើសរើស Folder នេះ</button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      }
      modal.style.display = 'flex';
      const startPath = String(initialPath || getCustomExportOutputDir() || defaultExportDirPath || '').trim();
      loadInAppFolderBrowserPath(startPath);
      return new Promise((resolve) => {
        pendingInAppFolderResolve = resolve;
      });
    }

    async function pickDirectoryWithExplorerFallback(pickerId = 'eza_export_dir') {
      if (window.electronAPI && typeof window.electronAPI.openFolderDialog === 'function') {
        const defaultPath = pickerId === 'eza_export_dir'
          ? String(getCustomExportOutputDir() || defaultExportDirPath || '').trim()
          : '';
        const selected = await window.electronAPI.openFolderDialog(defaultPath ? { defaultPath } : undefined);
        return { path: selected || '', dirHandle: null, canceled: !selected };
      }

      if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
        let dirHandle = null;
        try {
          dirHandle = await window.showDirectoryPicker({ id: pickerId, mode: 'readwrite' });
        } catch (err) {
          if (err && err.name === 'AbortError') {
            return { path: '', dirHandle: null, canceled: true };
          }
          try {
            dirHandle = await window.showDirectoryPicker({ id: pickerId });
          } catch (err2) {
            if (err2 && err2.name === 'AbortError') {
              return { path: '', dirHandle: null, canceled: true };
            }
          }
        }

        if (dirHandle) {
          let markerName = '';
          try {
            markerName = `.eza_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`;
            const fh = await dirHandle.getFileHandle(markerName, { create: true });
            const writable = await fh.createWritable();
            await writable.write('1');
            await writable.close();
          } catch (_) {
            markerName = '';
          }
          const childNames = [];
          if (!markerName && typeof dirHandle.keys === 'function') {
            try {
              for await (const k of dirHandle.keys()) {
                if (k && !String(k).startsWith('.')) childNames.push(String(k));
                if (childNames.length >= 6) break;
              }
            } catch (_) {}
          }
          try {
            const res = await fetch(`${BACKEND_URL}/api/resolve-picked-folder`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                folderName: dirHandle.name || '',
                markerName,
                childNames
              })
            });
            const data = await res.json().catch(() => null);
            if (res.ok && data && data.success && data.folderPath) {
              return { path: data.folderPath, dirHandle, canceled: false };
            }
          } catch (_) {
          } finally {
            if (markerName && typeof dirHandle.removeEntry === 'function') {
              try { await dirHandle.removeEntry(markerName); } catch (_) {}
            }
          }
          return { path: '', dirHandle, canceled: false };
        }
      }

      try {
        const res = await fetch(`${BACKEND_URL}/api/browse-folder`);
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.selected) {
          return { path: data.selected, dirHandle: null, canceled: false };
        }
        if (res.ok && data && data.success && !data.selected) {
          return { path: '', dirHandle: null, canceled: true };
        }
      } catch (_) {}

      const modalSelected = await openInAppFolderBrowserModal();
      return { path: modalSelected || '', dirHandle: null, canceled: !modalSelected };
    }

    async function pickExportOutputFolder() {
      let selected = '';
      try {
        const picked = await pickDirectoryWithExplorerFallback('eza_export_dir');
        if (picked.canceled) return '';
        if (picked.dirHandle && typeof window !== 'undefined') {
          window._customExportDirHandle = picked.dirHandle;
        }
        selected = picked.path || '';
        if (!selected && picked.dirHandle) {
          selected = await openInAppFolderBrowserModal();
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
        if (window.electronAPI && typeof window.electronAPI.openExportFolder === 'function') {
          await window.electronAPI.openExportFolder(target);
          return;
        }
        const res = await fetch(`${BACKEND_URL}/api/export/open-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPath: target })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចបើក Folder បានទេ');
        }
        showShortcutToast(`📂 បានបើក Folder៖ ${data.openedPath || target}`);
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
      const downloadUrl = appendAccessTokenToUrl(`${BACKEND_URL}/api/export/download?file=${encodeURIComponent(target)}`);
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

    function syncExportDubControls(fromPresetChange = false) {
      const modeEl = document.getElementById('exportAudioMode');
      const fitCheck = document.getElementById('exportAutoFitCheck');
      const videoModeEl = document.getElementById('exportVideoModeSelect');
      const isFastCopy = Boolean(videoModeEl && videoModeEl.value === 'copy');
      for (const id of ['exportResolution', 'exportQualityPreset', 'exportEncoder']) {
        const el = document.getElementById(id);
        if (el) el.disabled = isFastCopy;
      }
      if (!modeEl) return;

      if (fromPresetChange) {
        const mode = modeEl.value;
        if (mode === 'bgm_only') {
          audioMixerState.origPct = 0;
          if (audioMixerState.bgmPct <= 0) audioMixerState.bgmPct = 65;
          audioMixerState.bgmOnPause = true;
        } else if (mode === 'duck') {
          if (audioMixerState.origPct <= 0) audioMixerState.origPct = 25;
          if (audioMixerState.bgmPct <= 0) audioMixerState.bgmPct = 55;
          audioMixerState.bgmOnPause = true;
        } else if (mode === 'bg_low') {
          audioMixerState.origPct = 18;
          audioMixerState.bgmPct = 0;
          audioMixerState.bgmOnPause = false;
        } else if (mode === 'dub_only') {
          audioMixerState.origPct = 0;
          audioMixerState.bgmPct = 0;
          audioMixerState.bgmOnPause = false;
        }
        saveAudioMixerState();
        if (typeof applyVocalSuppressionState === 'function') {
          applyVocalSuppressionState(shouldSuppressOrigVocals());
        }
        const v = document.getElementById('mainVideo');
        if (v && typeof syncLiveSourceAudioSuppression === 'function') {
          syncLiveSourceAudioSuppression(v, activeSpeakingCueIdx);
        }
      }

      modeEl.disabled = false;
      const isOriginalOnly = modeEl.value === 'original';
      if (fitCheck) fitCheck.disabled = isOriginalOnly;
      syncAudioMixerUi();
      if (typeof updateExportReadinessBar === 'function') updateExportReadinessBar();
    }

    function refreshExportCapabilities(force = false) {
      if (exportCapabilitiesLoaded && !force) return Promise.resolve(cachedSystemProfile);
      if (typeof fetch !== 'function') return Promise.resolve(null);
      exportCapabilitiesLoaded = true;
      applyEcoCpuSavedState();
      return fetch(`${BACKEND_URL}/api/export/capabilities`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data) return null;
          if (data.maxrateTiers && typeof data.maxrateTiers === 'object') {
            Object.assign(CLIENT_MAXRATE_TIERS_KBPS, data.maxrateTiers);
            updateExportPreviewSummary();
          }
          if (data.systemProfile && typeof data.systemProfile === 'object') {
            cachedSystemProfile = data.systemProfile;
            let savedEcoPref = null;
            try {
              if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
                savedEcoPref = localStorage.getItem(ECO_CPU_STORAGE_KEY);
              }
            } catch (_) {}
            if (savedEcoPref === null && data.systemProfile.isLowSpec) {
              const ecoChk = document.getElementById('ecoCpuModeCheck');
              if (ecoChk) ecoChk.checked = true;
              const concEl = document.getElementById('vmConcurrencySelect');
              if (concEl) concEl.value = String(data.systemProfile.recommendedVmConcurrency || 1);
              const resEl = document.getElementById('exportResolution');
              if (resEl) resEl.value = 'source';
              const qEl = document.getElementById('exportQualityPreset');
              if (qEl) qEl.value = 'fast';
              if (typeof renderVmStudioPresetStrip === 'function') {
                try { renderVmStudioPresetStrip(); } catch (_) {}
              }
              updateExportPreviewSummary();
            }
          }
          const badge = document.getElementById('exportGpuBadge');
          if (badge) {
            let gpuLabel = '🖥️ CPU (libx264 HD)';
            if (data.gpuEncoder === 'h264_nvenc') {
              gpuLabel = '⚡ NVIDIA NVENC រួចរាល់';
            } else if (data.gpuEncoder === 'h264_qsv') {
              gpuLabel = '⚡ Intel QSV រួចរាល់';
            } else if (data.gpuEncoder === 'h264_amf') {
              gpuLabel = '⚡ AMD AMF រួចរាល់';
            }
            const sp = data.systemProfile;
            const specHint = (sp && sp.totalRamGB > 0)
              ? ` · ${sp.totalRamGB}GB RAM / ${sp.cpuCores}T${sp.isLowSpec ? ' (🛡️ ម៉ាស៊ីនតូច)' : ''}`
              : '';
            badge.innerText = `${gpuLabel}${specHint}`;
          }
          return data.systemProfile || null;
        })
        .catch(() => null);
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

      applyEcoCpuSavedState();
      syncExportDubControls();
      renderSponsorOverlayPreview();
      updateExportOutputDirDisplay();
      updateExportPreviewSummary();
      refreshExportSizeEstimateProbe();
      if (currentVideoPath && typeof syncCachedBgmStemForVideo === 'function') {
        syncCachedBgmStemForVideo(currentVideoPath).then(() => updateExportPreviewSummary()).catch(() => {});
      }

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

      refreshExportCapabilities();
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
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      onVideoTimeUpdate();
      if (typeof showLiveSubtitleSampleIfNeeded === 'function') {
        showLiveSubtitleSampleIfNeeded();
      }
      showShortcutToast(isWordPopEnabled ? '🎯 បានបើកអក្សរលោតមកមុខ' : '🎯 បានបិទអក្សរលោតមកមុខ');
    }

    function renderSubtitleMaskPreview() {
      const normalized = normalizeSubtitleMaskState(subtitleMaskState);
      Object.assign(subtitleMaskState, normalized);

      const getEl = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
      const box = getEl('subtitleMaskBox');
      if (box) {
        if (box.classList && typeof box.classList.toggle === 'function') {
          box.classList.toggle('hidden-mask', !subtitleMaskState.enabled);
          box.classList.remove('blackout', 'frosted', 'feathered', 'cinema_bar');
          if (subtitleMaskState.mode === 'black') box.classList.add('blackout');
          else if (subtitleMaskState.mode === 'frosted') box.classList.add('frosted');
          else if (subtitleMaskState.mode === 'cinema_bar') box.classList.add('cinema_bar');
          else if (subtitleMaskState.mode === 'feathered') box.classList.add('feathered');
        }
        if (box.style) {
          box.style.bottom = 'auto';
          box.style.minHeight = '0';
          box.style.top = subtitleMaskState.yPercent + '%';
          box.style.height = subtitleMaskState.hPercent + '%';
          if (subtitleMaskState.mode === 'cinema_bar') {
            box.style.left = '0%';
            box.style.width = '100%';
          } else {
            box.style.left = subtitleMaskState.xPercent + '%';
            box.style.width = subtitleMaskState.wPercent + '%';
          }
          if (typeof box.style.setProperty === 'function') {
            box.style.setProperty('--mask-blur-px', subtitleMaskState.blurSigma + 'px');
          }
        }
      }

      const quickBtn = getEl('quickMaskToggleBtn');
      if (quickBtn) {
        if (quickBtn.classList && typeof quickBtn.classList.toggle === 'function') {
          quickBtn.classList.toggle('active', subtitleMaskState.enabled);
        }
        if (typeof quickBtn.setAttribute === 'function') {
          quickBtn.setAttribute('aria-pressed', subtitleMaskState.enabled ? 'true' : 'false');
        }
        quickBtn.innerText = subtitleMaskState.enabled ? '🌫️ ព្រាលបាំងអក្សរ: បើក' : '🌫️ ព្រាលបាំងអក្សរ: បិទ';
      }

      const chk = getEl('maskToggleCheck');
      if (chk) chk.checked = subtitleMaskState.enabled;
      const modeEl = getEl('maskModeSelect');
      if (modeEl) modeEl.value = subtitleMaskState.mode;
      const tabDot = getEl('maskTabDot');
      if (tabDot) tabDot.hidden = !subtitleMaskState.enabled;

      const sliderPairs = [
        ['maskXSlider', 'maskXVal', subtitleMaskState.xPercent, '%', subtitleMaskState.mode === 'cinema_bar'],
        ['maskYSlider', 'maskYVal', subtitleMaskState.yPercent, '%', false],
        ['maskWSlider', 'maskWVal', subtitleMaskState.wPercent, '%', subtitleMaskState.mode === 'cinema_bar'],
        ['maskHSlider', 'maskHVal', subtitleMaskState.hPercent, '%', false],
        ['maskBlurSlider', 'maskBlurVal', subtitleMaskState.blurSigma, '', subtitleMaskState.mode === 'black' || subtitleMaskState.mode === 'cinema_bar']
      ];
      sliderPairs.forEach(([sliderId, labelId, val, unit, muted]) => {
        const slider = getEl(sliderId);
        if (slider) {
          slider.value = String(val);
          if (slider.parentElement && slider.parentElement.classList && typeof slider.parentElement.classList.toggle === 'function') {
            slider.parentElement.classList.toggle('is-muted', Boolean(muted));
          }
        }
        const badge = getEl(labelId);
        if (badge) badge.innerText = `${val}${unit}`;
      });

      if (typeof updateExportPreviewSummary === 'function') {
        updateExportPreviewSummary();
      }
    }

    let previewAspectMode = 'auto';
    let activePreviewDockTab = 'audio';
    let previewDockCollapsed = false;
    let _previewResizeObserver = null;

    function getPreviewSubtitleScale(explicitHeight = 0) {
      let frameH = Number(explicitHeight) || 0;
      if (frameH <= 0 && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const frame = document.getElementById('previewFrameBox');
        if (frame) {
          frameH = Number(frame.clientHeight) || Number.parseFloat(frame.style && frame.style.height) || 0;
        }
      }
      if (frameH <= 0) return 1;
      return Math.max(0.52, Math.min(1.45, frameH / 480));
    }

    function syncPreviewSubtitleScale(explicitHeight = 0) {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const scale = getPreviewSubtitleScale(explicitHeight);
      const sub = document.getElementById('liveSubtitleText');
      if (sub && sub.style) {
        const basePx = (typeof currentSubFontSize === 'number' && Number.isFinite(currentSubFontSize)) ? currentSubFontSize : 16;
        const scaledPx = scale === 1 ? basePx : Number((basePx * scale).toFixed(1));
        sub.style.fontSize = `${scaledPx}px`;
      }
      const ovBox = document.getElementById('customTextOverlayBox');
      if (ovBox && ovBox.style && typeof customTextOverlayState === 'object' && customTextOverlayState) {
        const ovBasePx = Number(customTextOverlayState.fontSizePx) || 15;
        const ovScaledPx = scale === 1 ? ovBasePx : Number((ovBasePx * scale).toFixed(1));
        ovBox.style.fontSize = `${ovScaledPx}px`;
      }
    }

    function fitPreviewFrameSize() {
      if (typeof document === 'undefined') return;
      const wrap = document.getElementById('videoDropZone');
      const frame = document.getElementById('previewFrameBox') || (typeof document.querySelector === 'function' ? document.querySelector('.video-frame-916') : null);
      if (!wrap || !frame || !frame.style) return;
      if (document.fullscreenElement === frame) {
        frame.style.width = '';
        frame.style.height = '';
        syncPreviewSubtitleScale();
        return;
      }
      const wrapW = Number(wrap.clientWidth) || 0;
      const wrapH = Number(wrap.clientHeight) || 0;
      if (wrapW <= 0 || wrapH <= 0) return;

      const maxW = Math.max(150, wrapW - 24);
      const maxH = Math.max(150, wrapH - 20);
      const v = document.getElementById('mainVideo');
      const hasVideoDims = Boolean(v && v.videoWidth > 0 && v.videoHeight > 0);
      const ratio = previewAspectMode === 'auto'
        ? (hasVideoDims ? (v.videoWidth / v.videoHeight) : (16 / 10))
        : (9 / 16);

      let w = maxW;
      let h = w / ratio;
      if (h > maxH) {
        h = maxH;
        w = h * ratio;
      }
      frame.style.width = `${Math.max(120, Math.round(w))}px`;
      frame.style.height = `${Math.max(120, Math.round(h))}px`;
      syncPreviewSubtitleScale(h);
    }

    function setPreviewAspectMode(mode) {
      previewAspectMode = mode === '9:16' ? '9:16' : 'auto';
      const sel = typeof document !== 'undefined' ? document.getElementById('previewAspectSelect') : null;
      if (sel) sel.value = previewAspectMode;
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      fitPreviewFrameSize();
    }

    function setPreviewDockTab(tabName, options = {}) {
      const allowed = ['audio', 'mask', 'sub', 'text', 'brand', 'copyright'];
      const targetTab = allowed.includes(tabName) ? tabName : 'audio';
      const sameOpenTab = (activePreviewDockTab === targetTab && !previewDockCollapsed);
      if (sameOpenTab && !options.ensureOpen) {
        previewDockCollapsed = true;
      } else {
        activePreviewDockTab = targetTab;
        previewDockCollapsed = Boolean(options.collapsed);
      }

      if (typeof document !== 'undefined') {
        const body = document.getElementById('previewDockBody');
        if (body) body.hidden = previewDockCollapsed;
        const collapseBtn = document.getElementById('previewDockCollapseBtn');
        if (collapseBtn) collapseBtn.innerText = previewDockCollapsed ? '▴' : '▾';

        if (typeof document.querySelectorAll === 'function') {
          document.querySelectorAll('#previewDockTabs .preview-dock-tab').forEach((btn) => {
            const name = typeof btn.getAttribute === 'function' ? btn.getAttribute('data-dock-tab') : '';
            const isAct = !previewDockCollapsed && name === activePreviewDockTab;
            if (btn.classList && typeof btn.classList.toggle === 'function') {
              btn.classList.toggle('active', isAct);
            }
            if (typeof btn.setAttribute === 'function') {
              btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
            }
          });
          document.querySelectorAll('#previewDockBody .preview-dock-panel').forEach((panel) => {
            const name = typeof panel.getAttribute === 'function' ? panel.getAttribute('data-dock-panel') : '';
            const isShow = !previewDockCollapsed && name === activePreviewDockTab;
            panel.hidden = !isShow;
            if (panel.classList && typeof panel.classList.toggle === 'function') {
              panel.classList.toggle('active', isShow);
            }
          });
        }
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => fitPreviewFrameSize());
      } else {
        fitPreviewFrameSize();
      }
      if (!previewDockCollapsed && activePreviewDockTab === 'sub' && typeof showLiveSubtitleSampleIfNeeded === 'function') {
        showLiveSubtitleSampleIfNeeded();
      }
      if (!previewDockCollapsed) {
        if (activePreviewDockTab === 'mask' && typeof setPreviewEditTarget === 'function') {
          setPreviewEditTarget('mask');
        } else if (activePreviewDockTab === 'sub' && typeof setPreviewEditTarget === 'function') {
          setPreviewEditTarget('sub');
        }
      }
    }

    function togglePreviewDockCollapse() {
      previewDockCollapsed = !previewDockCollapsed;
      setPreviewDockTab(activePreviewDockTab, { ensureOpen: !previewDockCollapsed, collapsed: previewDockCollapsed });
    }

    function onMainVideoSurfaceClick(ev) {
      const videoEl = ev && ev.target ? ev.target : document.getElementById('mainVideo');
      if (!videoEl || videoEl.id !== 'mainVideo') return;
      if (!currentVideoPath && !videoEl.currentSrc && !videoEl.src) return;
      togglePlayPause();
    }

    function initPreviewStageObserver() {
      if (typeof document === 'undefined') return;
      const wrap = document.getElementById('videoDropZone');
      if (wrap && typeof ResizeObserver === 'function' && !_previewResizeObserver) {
        _previewResizeObserver = new ResizeObserver(() => {
          cachedTimelineMetrics = null;
          fitPreviewFrameSize();
        });
        _previewResizeObserver.observe(wrap);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', () => {
          cachedTimelineMetrics = null;
          fitPreviewFrameSize();
        });
        if (Number(window.innerWidth) > 0 && window.innerWidth <= 860) {
          setPreviewDockTab(activePreviewDockTab, { collapsed: true });
        }
      }
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('fullscreenchange', () => fitPreviewFrameSize());
      }
      fitPreviewFrameSize();
    }

    function toggleMaskBox(checked) {
      const nextEnabled = typeof checked === 'boolean' ? checked : !subtitleMaskState.enabled;
      subtitleMaskState.enabled = nextEnabled;
      saveSubtitleMaskState();
      renderSubtitleMaskPreview();
      if (nextEnabled && typeof document !== 'undefined') {
        setPreviewDockTab('mask', { ensureOpen: true });
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('🌫️ បានបើកព្រាលបាំងអក្សរ (អូស ឬពង្រីកបង្រួមលើវីដេអូបាន)');
        }
      } else if (typeof showShortcutToast === 'function') {
        showShortcutToast('🌫️ បានបិទព្រាលបាំងអក្សរ');
      }
    }

    function openMaskAdjustPanel() {
      setPreviewDockTab('mask', { ensureOpen: true });
    }

    let currentSubStyle = 'tiktok';
    let currentSubFontSize = 16;
    let currentSubPosYPercent = 8;

    function showLiveSubtitleSampleIfNeeded() {
      if (typeof document === 'undefined') return;
      const sub = document.getElementById('liveSubtitleText');
      if (!sub) return;
      if (!isSubtitleVisible) {
        sub.style.display = 'none';
        return;
      }
      const v = document.getElementById('mainVideo');
      const curSec = v ? (Number(v.currentTime) || 0) : 0;
      const matchedIdx = (Array.isArray(activeCues) && activeCues.length > 0 && typeof findCueIndexAtTime === 'function')
        ? findCueIndexAtTime(activeCues, curSec)
        : -1;
      if (v && !v.paused && matchedIdx !== -1) {
        updateKaraokeSubtitleDOM(sub, activeCues[matchedIdx], matchedIdx, curSec);
        return;
      }
      const sampleCue = (Array.isArray(activeCues) && matchedIdx !== -1 && activeCues[matchedIdx])
        ? activeCues[matchedIdx]
        : (Array.isArray(activeCues) && activeCues.find(c => String(c && (c.translated || c.text) || '').trim()))
          || { startSec: 0, endSec: 2, translated: 'នេះជាអក្សរគំរូសម្រាប់មើលជាមុន ✨', text: 'នេះជាអក្សរគំរូសម្រាប់មើលជាមុន ✨' };
      const midSec = (Number(sampleCue.startSec) || 0) + Math.max(0.4, ((Number(sampleCue.endSec) || 2) - (Number(sampleCue.startSec) || 0)) * 0.45);
      if (typeof updateKaraokeSubtitleDOM === 'function') {
        sub.dataset.karaokeKey = '';
        updateKaraokeSubtitleDOM(sub, sampleCue, matchedIdx !== -1 ? matchedIdx : 0, midSec);
      } else {
        sub.style.display = 'inline-block';
        sub.innerText = String(sampleCue.translated || sampleCue.text || '');
      }
    }

    function toggleSubtitleVisibility(checked) {
      isSubtitleVisible = typeof checked === 'boolean' ? checked : !isSubtitleVisible;
      const chk = typeof document !== 'undefined' ? document.getElementById('subVisibleToggleCheck') : null;
      if (chk) chk.checked = isSubtitleVisible;
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      const sub = typeof document !== 'undefined' ? document.getElementById('liveSubtitleText') : null;
      if (!isSubtitleVisible) {
        if (sub) sub.style.display = 'none';
      } else {
        showLiveSubtitleSampleIfNeeded();
      }
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(isSubtitleVisible ? '👁️ បើកបង្ហាញអក្សរលើ Preview' : '👁️ លាក់អក្សរលើ Preview');
      }
    }

    let currentSubTextColor = '';
    let currentSubOutlineColor = '';

    function syncColorDotChipsToHex(targetHex) {
      const normHex = String(targetHex || '#ffffff').trim().toLowerCase();
      const picker = typeof document !== 'undefined' ? document.getElementById('subCustomColorPicker') : null;
      if (picker) picker.value = normHex;
      const chips = typeof document !== 'undefined' ? document.querySelectorAll('.color-dot-chip:not(.text-ov-color-chip)') : [];
      if (chips && chips.length) {
        chips.forEach(c => {
          const onclickStr = String(c.getAttribute && c.getAttribute('onclick') || '').toLowerCase();
          c.classList.toggle('active', onclickStr.includes(normHex));
        });
      }
    }

    function updateSubPosY(val, options = {}) {
      currentSubPosYPercent = clampMaskNumber(val, 2, 90, 8);
      const box = typeof document !== 'undefined' ? document.getElementById('liveSubtitleBox') : null;
      if (box && box.style) {
        box.style.bottom = `${currentSubPosYPercent}%`;
      }
      const slider = typeof document !== 'undefined' ? document.getElementById('subPosYSlider') : null;
      if (slider) slider.value = String(currentSubPosYPercent);
      const badge = typeof document !== 'undefined' ? document.getElementById('subPosYVal') : null;
      if (badge) badge.innerText = `${currentSubPosYPercent}%`;

      const chips = typeof document !== 'undefined' ? document.querySelectorAll('#subPosBottomBtn, #subPosCenterBtn, #subPosTopBtn') : [];
      if (chips && chips.length) {
        chips.forEach(c => c.classList.remove('active'));
        if (currentSubPosYPercent <= 18) {
          const btn = document.getElementById('subPosBottomBtn');
          if (btn) btn.classList.add('active');
        } else if (currentSubPosYPercent >= 68) {
          const btn = document.getElementById('subPosTopBtn');
          if (btn) btn.classList.add('active');
        } else {
          const btn = document.getElementById('subPosCenterBtn');
          if (btn) btn.classList.add('active');
        }
      }

      if (!options.skipSave && typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      showLiveSubtitleSampleIfNeeded();
      if (typeof updateExportPreviewSummary === 'function') updateExportPreviewSummary();
    }

    function setSubPosPreset(val) {
      updateSubPosY(val);
      const label = val <= 18 ? '⬇️ ខាងក្រោម' : (val >= 68 ? '⬆️ ខាងលើ' : '⏹️ កណ្តាល');
      if (typeof showShortcutToast === 'function') showShortcutToast(`📍 ទីតាំងអក្សរ៖ ${label} (${val}%)`);
    }

    function setSubTextColor(hex) {
      currentSubTextColor = String(hex || '#ffffff').trim();
      const sub = typeof document !== 'undefined' ? document.getElementById('liveSubtitleText') : null;
      if (sub && sub.style) {
        sub.style.color = currentSubTextColor;
      }
      syncColorDotChipsToHex(currentSubTextColor);
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();

      showLiveSubtitleSampleIfNeeded();
      if (typeof updateExportPreviewSummary === 'function') updateExportPreviewSummary();
      if (typeof showShortcutToast === 'function') showShortcutToast(`🎨 ពណ៌អក្សរ៖ ${currentSubTextColor}`);
    }

    function changeSubStyle(style) {
      currentSubStyle = style;
      currentSubTextColor = '';
      const previewStyle = document.getElementById('subStyleSelect');
      if (previewStyle) previewStyle.value = style;
      const sub = document.getElementById('liveSubtitleText');
      if (sub) {
        sub.className = 'subtitle-text-inside style-' + style + (isWordPopEnabled ? '' : ' no-word-pop');
        sub.style.color = '';
      }
      const styleDefaultHexMap = {
        tiktok: '#ffffff',
        tiktok_gold: '#ffd700',
        hormozi: '#00ff66',
        mrbeast: '#ffffff',
        capcut_box: '#090d16',
        drama_red: '#ffffff',
        cinema: '#ffffff',
        pill: '#ffffff',
        neon: '#ffffff'
      };
      syncColorDotChipsToHex(styleDefaultHexMap[style] || '#ffffff');
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      syncPreviewSubtitleScale();
      showLiveSubtitleSampleIfNeeded();
      updateExportPreviewSummary();
      showShortcutToast('✨ ស្ទីល Sub: ' + style.toUpperCase());
    }

    function updateSubFontSize(size) {
      currentSubFontSize = parseInt(size, 10);
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      syncPreviewSubtitleScale();
      const valBadge = typeof document !== 'undefined' ? document.getElementById('subFontSizeVal') : null;
      if (valBadge) valBadge.innerText = `${currentSubFontSize}px`;
      showLiveSubtitleSampleIfNeeded();
      updateExportPreviewSummary();
    }

    function toggleSafeZone(checked) {
      const zone = document.getElementById('safeZoneOverlay');
      const chk = document.getElementById('safeZoneToggle');
      const next = typeof checked === 'boolean'
        ? checked
        : !(zone && zone.style && zone.style.display === 'block');
      if (zone) zone.style.display = next ? 'block' : 'none';
      if (chk) chk.checked = next;
      const headerBtn = document.getElementById('headerSafeZoneBtn');
      if (headerBtn && headerBtn.classList && typeof headerBtn.classList.toggle === 'function') {
        headerBtn.classList.toggle('active', next);
      }
      if (typeof savePreviewSubSettingsState === 'function') savePreviewSubSettingsState();
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(next ? '📱 បើក Safe Zone' : '📱 បិទ Safe Zone');
      }
    }

    function changeMaskMode(mode, options = {}) {
      const nextEnabled = options.autoEnable !== false ? true : subtitleMaskState.enabled;
      subtitleMaskState.mode = normalizeSubtitleMaskState({ ...subtitleMaskState, mode }).mode;
      subtitleMaskState.enabled = nextEnabled;
      saveSubtitleMaskState();
      renderSubtitleMaskPreview();
    }

    function setSubtitleMaskControl(field, rawValue, options = {}) {
      const candidate = {
        ...subtitleMaskState,
        enabled: options.autoEnable !== false ? true : subtitleMaskState.enabled
      };
      if (field === 'w') {
        const nextW = clampMaskNumber(rawValue, 5, 100, candidate.wPercent);
        candidate.wPercent = nextW;
        if (!options.preserveOrigin && candidate.xPercent + nextW > 100) {
          candidate.xPercent = Math.max(0, 100 - nextW);
        } else if (options.preserveOrigin && candidate.xPercent + nextW > 100) {
          candidate.wPercent = Math.max(5, 100 - candidate.xPercent);
        }
      } else if (field === 'h') {
        const nextH = clampMaskNumber(rawValue, 2, 60, candidate.hPercent);
        candidate.hPercent = nextH;
        if (!options.preserveOrigin && candidate.yPercent + nextH > 100) {
          candidate.yPercent = Math.max(0, 100 - nextH);
        } else if (options.preserveOrigin && candidate.yPercent + nextH > 100) {
          candidate.hPercent = Math.max(2, 100 - candidate.yPercent);
        }
      } else if (field === 'x') {
        candidate.xPercent = clampMaskNumber(rawValue, 0, Math.max(0, 100 - candidate.wPercent), candidate.xPercent);
      } else if (field === 'y') {
        candidate.yPercent = clampMaskNumber(rawValue, 0, Math.max(0, 100 - candidate.hPercent), candidate.yPercent);
      } else if (field === 'blur') {
        candidate.blurSigma = clampMaskNumber(rawValue, 2, 40, candidate.blurSigma);
      }

      Object.assign(subtitleMaskState, normalizeSubtitleMaskState(candidate));
      if (!options.skipSave) saveSubtitleMaskState();
      renderSubtitleMaskPreview();
    }

    function resetSubtitleMask() {
      const wasEnabled = subtitleMaskState.enabled;
      Object.assign(subtitleMaskState, { ...DEFAULT_SUBTITLE_MASK_STATE, enabled: wasEnabled });
      saveSubtitleMaskState();
      renderSubtitleMaskPreview();
      if (typeof showShortcutToast === 'function') {
        showShortcutToast('🔄 បានកំណត់ប្រអប់ព្រាលទៅលំនាំដើមវិញ');
      }
    }

    function updateMaskY(val) {
      setSubtitleMaskControl('y', val);
    }

    function updateMaskH(val) {
      setSubtitleMaskControl('h', val);
    }

    let currentPreviewEditTarget = 'mask'; // 'mask' | 'sub'

    function setPreviewEditTarget(target) {
      currentPreviewEditTarget = target === 'sub' ? 'sub' : 'mask';
      const maskBox = typeof document !== 'undefined' ? document.getElementById('subtitleMaskBox') : null;
      const subBox = typeof document !== 'undefined' ? document.getElementById('liveSubtitleBox') : null;
      const btnMask = typeof document !== 'undefined' ? document.getElementById('btnFocusMaskTarget') : null;
      const btnSub = typeof document !== 'undefined' ? document.getElementById('btnFocusSubTarget') : null;

      if (currentPreviewEditTarget === 'mask') {
        if (maskBox) {
          maskBox.style.zIndex = '25';
          if (maskBox.classList) maskBox.classList.add('is-focused');
        }
        if (subBox) {
          subBox.style.zIndex = '14';
          subBox.style.pointerEvents = 'none';
        }
        if (btnMask && btnMask.classList) btnMask.classList.add('active');
        if (btnSub && btnSub.classList) btnSub.classList.remove('active');
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('🎯 មុខងារកែប្រអប់បាំង៖ អាចចុចអូសលើវីដេអូបានដោយសេរី');
        }
      } else {
        if (maskBox) {
          maskBox.style.zIndex = '14';
          if (maskBox.classList) maskBox.classList.remove('is-focused');
        }
        if (subBox) {
          subBox.style.zIndex = '25';
          subBox.style.pointerEvents = 'auto';
        }
        if (btnMask && btnMask.classList) btnMask.classList.remove('active');
        if (btnSub && btnSub.classList) btnSub.classList.add('active');
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('💬 មុខងារកែអក្សរខ្មែរ៖ អាចចុចអូសរំកិលទីតាំងអក្សរលើវីដេអូបាន');
        }
      }
    }

    function updateMaskPresetPillUi(activePreset) {
      if (typeof document === 'undefined') return;
      const presets = ['standard', 'slim', 'tall', 'cinema'];
      for (const p of presets) {
        const cap = p.charAt(0).toUpperCase() + p.slice(1);
        const el = document.getElementById(`maskPreset${cap}Btn`);
        if (el && el.classList && typeof el.classList.toggle === 'function') {
          el.classList.toggle('active', p === activePreset);
        }
      }
    }

    function setMaskPreset(presetName) {
      subtitleMaskState.enabled = true;
      if (presetName === 'slim') {
        subtitleMaskState.mode = 'feathered';
        subtitleMaskState.wPercent = 86;
        subtitleMaskState.hPercent = 6.5;
        subtitleMaskState.xPercent = 7;
        subtitleMaskState.yPercent = 81;
        subtitleMaskState.blurSigma = 14;
      } else if (presetName === 'tall') {
        subtitleMaskState.mode = 'feathered';
        subtitleMaskState.wPercent = 94;
        subtitleMaskState.hPercent = 13.5;
        subtitleMaskState.xPercent = 3;
        subtitleMaskState.yPercent = 74;
        subtitleMaskState.blurSigma = 16;
      } else if (presetName === 'cinema') {
        subtitleMaskState.mode = 'cinema_bar';
        subtitleMaskState.wPercent = 100;
        subtitleMaskState.hPercent = 26;
        subtitleMaskState.xPercent = 0;
        subtitleMaskState.yPercent = 74;
        subtitleMaskState.blurSigma = 12;
      } else {
        // standard - ថ្លាតិច ព្រាល ពេញនិយម
        subtitleMaskState.mode = 'feathered';
        subtitleMaskState.wPercent = 92;
        subtitleMaskState.hPercent = 8.5;
        subtitleMaskState.xPercent = 4;
        subtitleMaskState.yPercent = 78;
        subtitleMaskState.blurSigma = 14;
      }
      Object.assign(subtitleMaskState, normalizeSubtitleMaskState(subtitleMaskState));
      saveSubtitleMaskState();
      renderSubtitleMaskPreview();
      updateMaskPresetPillUi(presetName);
      if (typeof showShortcutToast === 'function') {
        const titles = { standard: '🎬 ស្ដង់ដារ (ថ្លាតិច ព្រាល)', slim: '📏 អក្សរ ១ ជួរ', tall: '📜 អក្សរ ២ ជួរ', cinema: '🎥 របាររោងកុន' };
        showShortcutToast(`✨ បានជ្រើសរើសម៉ូតបាំង៖ ${titles[presetName] || presetName}`);
      }
    }

    function nudgeMask(prop, delta) {
      subtitleMaskState.enabled = true;
      if (prop === 'y') {
        setSubtitleMaskControl('y', subtitleMaskState.yPercent + delta);
      } else if (prop === 'h') {
        setSubtitleMaskControl('h', subtitleMaskState.hPercent + delta);
      } else if (prop === 'w') {
        setSubtitleMaskControl('w', subtitleMaskState.wPercent + delta);
      } else if (prop === 'x') {
        setSubtitleMaskControl('x', subtitleMaskState.xPercent + delta);
      }
      updateMaskPresetPillUi('');
    }

    function alignSubtitleToMask() {
      const maskY = Number(subtitleMaskState.yPercent) || 78;
      const maskH = Number(subtitleMaskState.hPercent) || 8;
      const maskCenterY = maskY + maskH / 2;
      const subHalfHeightPct = Math.min(2.2, maskH * 0.22);
      const targetSubBottom = Math.max(4, Math.min(88, Math.round((100 - (maskCenterY + subHalfHeightPct)) * 2) / 2));
      updateSubPosY(targetSubBottom);
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(`✨ បានតម្រឹមអក្សរខ្មែរចំកណ្តាលប្រអប់បាំង (${targetSubBottom}%)`);
      }
    }

    function initSubtitleBoxInteraction() {
      const box = typeof document !== 'undefined' ? document.getElementById('liveSubtitleBox') : null;
      if (!box || typeof box.addEventListener !== 'function') return;
      if (box.dataset && box.dataset.subDragBound === '1') return;
      if (box.dataset) box.dataset.subDragBound = '1';

      let isDragging = false;
      let startY = 0;
      let initBottomPct = currentSubPosYPercent;

      const beginDrag = (clientY, ev) => {
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        isDragging = true;
        startY = clientY;
        initBottomPct = currentSubPosYPercent;
        if (box.classList) box.classList.add('is-dragging');
      };

      const moveDrag = (clientY, ev) => {
        if (!isDragging) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        const rect = frame.getBoundingClientRect();
        if (!rect.height) return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();

        // Mouse moving down increases clientY -> reduces bottom distance %
        // Mouse moving up decreases clientY -> increases bottom distance %
        const dyPct = ((clientY - startY) / rect.height) * 100;
        const newBottom = clampMaskNumber(initBottomPct - dyPct, 2, 90, 8);
        updateSubPosY(newBottom);
      };

      const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        if (box.classList) box.classList.remove('is-dragging');
        if (typeof showShortcutToast === 'function') {
          showShortcutToast(`📍 ទីតាំងអក្សរ៖ ${currentSubPosYPercent}%`);
        }
      };

      box.addEventListener('mousedown', (e) => beginDrag(e.clientY, e));
      window.addEventListener('mousemove', (e) => moveDrag(e.clientY, e));
      window.addEventListener('mouseup', endDrag);

      box.addEventListener('touchstart', (e) => {
        const touch = e.touches && e.touches[0];
        if (touch) beginDrag(touch.clientY, e);
      }, { passive: false });
      window.addEventListener('touchmove', (e) => {
        const touch = e.touches && e.touches[0];
        if (touch) moveDrag(touch.clientY, e);
      }, { passive: false });
      window.addEventListener('touchend', endDrag);
    }

    function initSubtitleMaskInteraction() {
      const box = typeof document !== 'undefined' ? document.getElementById('subtitleMaskBox') : null;
      if (!box || typeof box.addEventListener !== 'function') return;
      if (box.dataset && box.dataset.maskDragBound === '1') return;
      if (box.dataset) box.dataset.maskDragBound = '1';

      const handle = document.getElementById('subtitleMaskResizeHandle');
      let activeMode = ''; // 'move' | 'resize'
      let startX = 0;
      let startY = 0;
      let initState = { ...subtitleMaskState };

      const beginInteraction = (mode, clientX, clientY, ev) => {
        if (!subtitleMaskState.enabled) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        activeMode = mode;
        startX = clientX;
        startY = clientY;
        initState = { ...subtitleMaskState };
        if (box.classList && typeof box.classList.add === 'function') {
          box.classList.add('is-manipulating');
        }
      };

      const moveInteraction = (clientX, clientY, ev) => {
        if (!activeMode) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        const rect = frame.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();

        const dxPct = ((clientX - startX) / rect.width) * 100;
        const dyPct = ((clientY - startY) / rect.height) * 100;

        if (activeMode === 'move') {
          if (subtitleMaskState.mode !== 'cinema_bar') {
            subtitleMaskState.xPercent = clampMaskNumber(initState.xPercent + dxPct, 0, Math.max(0, 100 - initState.wPercent), initState.xPercent);
          }
          subtitleMaskState.yPercent = clampMaskNumber(initState.yPercent + dyPct, 0, Math.max(0, 100 - initState.hPercent), initState.yPercent);
          Object.assign(subtitleMaskState, normalizeSubtitleMaskState(subtitleMaskState));
          renderSubtitleMaskPreview();
        } else if (activeMode === 'resize') {
          if (subtitleMaskState.mode !== 'cinema_bar') {
            subtitleMaskState.wPercent = clampMaskNumber(initState.wPercent + dxPct, 5, Math.max(5, 100 - initState.xPercent), initState.wPercent);
          }
          subtitleMaskState.hPercent = clampMaskNumber(initState.hPercent + dyPct, 2, Math.min(60, Math.max(2, 100 - initState.yPercent)), initState.hPercent);
          Object.assign(subtitleMaskState, normalizeSubtitleMaskState(subtitleMaskState));
          renderSubtitleMaskPreview();
        }
      };

      const endInteraction = () => {
        if (!activeMode) return;
        activeMode = '';
        if (box.classList && typeof box.classList.remove === 'function') {
          box.classList.remove('is-manipulating');
        }
        saveSubtitleMaskState();
      };

      if (handle && typeof handle.addEventListener === 'function') {
        handle.addEventListener('mousedown', (e) => beginInteraction('resize', e.clientX, e.clientY, e));
        handle.addEventListener('touchstart', (e) => {
          const touch = e.touches && e.touches[0];
          if (touch) beginInteraction('resize', touch.clientX, touch.clientY, e);
        }, { passive: false });
      }

      box.addEventListener('mousedown', (e) => {
        if (handle && (e.target === handle || (typeof handle.contains === 'function' && handle.contains(e.target)))) return;
        beginInteraction('move', e.clientX, e.clientY, e);
      });
      box.addEventListener('touchstart', (e) => {
        if (handle && (e.target === handle || (typeof handle.contains === 'function' && handle.contains(e.target)))) return;
        const touch = e.touches && e.touches[0];
        if (touch) beginInteraction('move', touch.clientX, touch.clientY, e);
      }, { passive: false });

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('mousemove', (e) => moveInteraction(e.clientX, e.clientY, null));
        window.addEventListener('mouseup', endInteraction);
        window.addEventListener('touchmove', (e) => {
          if (!activeMode) return;
          const touch = e.touches && e.touches[0];
          if (touch) moveInteraction(touch.clientX, touch.clientY, e);
        }, { passive: false });
        window.addEventListener('touchend', endInteraction);
        window.addEventListener('touchcancel', endInteraction);
      }
    }

    // Auto-detect speech & timestamps via AI VAD/STT
    async function startSpeechDetection(options = {}) {
      if (isSpeechDetectingNow) {
        if (!options.silentSuccess && typeof showShortcutToast === 'function') {
          showShortcutToast('⏳ AI កំពុងចាប់សំឡេងក្នុងផ្ទៃខាងក្រោយ...');
        }
        return false;
      }
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
      }
      if (!currentVideoPath) {
        await openVideoFile();
        if (!currentVideoPath) return false;
      }
      const sourceLangEl = document.getElementById('sourceLangSelect');
      const sourceLang = sourceLangEl ? sourceLangEl.value : 'auto';
      const sttEngine = getSelectedSttEngine();
      const usingLocalSv = willUseLocalSenseVoice(sourceLang);
      const confirmPromptText = usingLocalSv
        ? '🧠 ម៉ាស៊ីន SenseVoice GPU នឹងស្ដាប់សំឡេងលើកុំព្យូទ័រផ្ទាល់ (លឿន និងមិនអស់ Quota Gemini)។ តើអ្នកចង់ចាប់ផ្ដើមទេ?'
        : 'សំឡេងវីដេអូនឹងត្រូវផ្ញើទៅ Gemini ដើម្បីចាប់ពាក្យនិយាយ (Transcribe AI)។ តើអ្នកចង់បន្តទេ?';
      if (!options.skipConfirm && !confirm(confirmPromptText)) {
        return false;
      }
      isSpeechDetectingNow = true;
      const speechSeq = videoSelectionSeq;
      const speechTargetPath = currentVideoPath;
      const statusMsg = document.getElementById('bottomStatusMsg');
      const progTrack = document.getElementById('speechProgressTrack');
      const progFill = document.getElementById('speechProgressFill');
      if (progTrack) progTrack.style.display = 'block';
      if (progFill) progFill.style.width = '3%';
      statusMsg.innerText = usingLocalSv
        ? '🧠 កំពុងដំណើរការ SenseVoice GPU ចាប់យកនាទី និងពាក្យសំដីក្នុងវីដេអូ... (3%)'
        : '🎙️ កំពុងដំណើរការ AI ចាប់យកនាទី និងពាក្យសំដីមនុស្សនិយាយក្នុងវីដេអូ... (3%)';

      const speechJobId = 'sp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      let speechPollBusy = false;
      let speechPollConsecutiveErrors = 0;
      let speechPollTimer = setInterval(async () => {
        if (speechSeq !== videoSelectionSeq) {
          if (speechPollTimer) { clearInterval(speechPollTimer); speechPollTimer = null; }
          return;
        }
        if (speechPollBusy) return;
        speechPollBusy = true;
        try {
          const pUrl = `${BACKEND_URL}/api/translation/speech-progress?jobId=${encodeURIComponent(speechJobId)}&videoPath=${encodeURIComponent(speechTargetPath || '')}`;
          const pRes = await fetch(pUrl);
          if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
          const pData = await pRes.json();
          if (speechSeq !== videoSelectionSeq) return;
          speechPollConsecutiveErrors = 0;
          if (pData && pData.running) {
            const pct = Math.max(3, Math.min(99, pData.percent || 3));
            if (progFill) progFill.style.width = `${pct}%`;
            if (statusMsg && pData.statusText) {
              statusMsg.innerText = `🎙️ ${pData.statusText}`;
            }
          }
        } catch (_) {
          speechPollConsecutiveErrors++;
          if (speechPollConsecutiveErrors >= 6 && speechPollTimer) {
            clearInterval(speechPollTimer);
            speechPollTimer = null;
          }
        } finally {
          speechPollBusy = false;
        }
      }, 1000);

      try {
        const { res, data } = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/auto-detect-speech`,
          {
            jobId: speechJobId,
            videoPath: speechTargetPath,
            sourceLang,
            sttEngine,
            isolateVocals: true,
            castMode: getActiveCastMode(),
            fixedVoice: getSelectedSingleVoice()
          },
          {
            maxRetries: 4,
            retryDelayMs: 3500,
            onRetryStatus: (attempt) => {
              if (speechSeq === videoSelectionSeq && statusMsg) {
                statusMsg.innerText = `⏳ AI កំពុងបញ្ចប់ការចាប់សំឡេងក្នុងផ្ទៃខាងក្រោយ... កំពុងទាញយកលទ្ធផលបន្ត (${attempt}/4)...`;
              }
            }
          }
        );
        if (speechSeq !== videoSelectionSeq) return false;
        if (!res.ok || !data || !data.success) throw new Error((data && data.error) || 'មិនអាចចាប់សំឡេងបាន។');
        if (!Array.isArray(data.cues) || data.cues.length === 0) {
          throw new Error('មិនបានរកឃើញពាក្យនិយាយទេ។');
        }
        if (data.activeChunkCount >= 4 && data.failedChunkCount >= Math.ceil(data.activeChunkCount * 0.6)) {
          throw new Error(`មាន ${data.failedChunkCount}/${data.activeChunkCount} ដុំបរាជ័យបណ្ដាញ/API — មិនអាចទទួលយកលទ្ធផលមិនគ្រប់បានទេ។ សូមសាកល្បងម្ដងទៀត។`);
        }

        if (progFill) progFill.style.width = '100%';
        activeCues = normalizeCuesTiming(data.cues);
        normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
        renderTable();
        renderTimeline();
        checkAllAudioCache();
        const engineTag = data.sttEngine === 'sensevoice' ? ' · 🧠 SenseVoice GPU' : ' · ☁️ Gemini';
        const skipInfo = data.skippedSilentChunks > 0 ? ` • រំលងផ្នែកស្ងាត់ ${data.skippedSilentChunks} ដុំ` : '';
        const failInfo = data.failedChunkCount > 0 ? ` ⚠️ មាន ${data.failedChunkCount} ដុំបរាជ័យបណ្ដាញ` : '';
        statusMsg.innerText = `✅ បានរកឃើញ និងចាប់យកនាទីសំឡេងមនុស្សចំនួន ${activeCues.length} បន្ទាត់${engineTag}!${skipInfo}${failInfo} (100%)`;
        if (data.failedChunkCount > 0 && typeof showShortcutToast === 'function') {
          showShortcutToast(`⚠️ សម្គាល់៖ មាន ${data.failedChunkCount} ដុំមិនអាចចាប់សំឡេងបាន (បញ្ហាបណ្ដាញ)`, 5500);
        }
        if (!options.silentSuccess) {
          alert('🎉 ជោគជ័យ! បានចាប់យកសំឡេងមនុស្សនិយាយចំនួន ' + activeCues.length + ' បន្ទាត់។ ចុច 🌐 TRANSLATE ដើម្បីបកប្រែ subtitle។');
        }
        if (activeCues[0]) selectCueRow(0);
        return true;
      } catch (err) {
        statusMsg.innerText = '❌ កំហុស៖ ' + err.message;
        alert('កំហុស Server: ' + err.message);
        return false;
      } finally {
        isSpeechDetectingNow = false;
        if (speechPollTimer) {
          clearInterval(speechPollTimer);
          speechPollTimer = null;
        }
        if (progTrack) {
          setTimeout(() => {
            progTrack.style.display = 'none';
            if (progFill) progFill.style.width = '0%';
          }, 3000);
        }
      }
    }

    let exportPollInterval = null;
    let isExportingNow = false;

    async function waitForExportCompletionViaProgress(statusMsg, progFill, exportRunId = activeExportRunId) {
      const deadline = Date.now() + 15 * 60 * 1000;
      let idleMissCount = 0;
      while (Date.now() < deadline) {
        if (exportRunId !== activeExportRunId) {
          return { success: false, cancelled: true };
        }
        try {
          const pRes = await fetch(`${BACKEND_URL}/api/export/progress`);
          const pData = await pRes.json();
          if (exportRunId !== activeExportRunId) {
            return { success: false, cancelled: true };
          }
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
              if (pData.phase === 'idle' || (pData.phase === 'done' && !pData.outputFile)) {
                idleMissCount++;
                if (idleMissCount >= 3) {
                  return { success: false, error: 'ការតភ្ជាប់ Export ត្រូវបានកាត់ផ្ដាច់ ឬ Server ត្រូវបានបិទបើកឡើងវិញ។' };
                }
              }
            } else {
              idleMissCount = 0;
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
      if (isExportingNow) return;
      if (vmIsRunning) {
        showShortcutToast('⏳ Video Manager កំពុង Export វីដេអូ — សូមរង់ចាំឬបញ្ឈប់ជាមុនសិន');
        return;
      }
      if (!currentVideoPath) {
        await ensureVideoReadyOnServer();
      }
      if (!currentVideoPath) return alert('សូមផ្ទុកវីដេអូជាមុនសិន!');
      if (activeCues.length === 0) return alert('សូមផ្ទុកបន្ទាត់អក្សររត់ជាមុនសិន!');

      const exportRunId = ++activeExportRunId;
      isExportingNow = true;
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

      const subtitleMaskPayload = getSubtitleAndMaskExportPayload();

      const audioModeEl = document.getElementById('exportAudioMode');
      const autoFitEl = document.getElementById('exportAutoFitCheck');
      const resEl = document.getElementById('exportResolution');
      const qualityEl = document.getElementById('exportQualityPreset');
      const encoderEl = document.getElementById('exportEncoder');
      const videoModeEl = document.getElementById('exportVideoModeSelect');

      const fastCopy = Boolean(videoModeEl && videoModeEl.value === 'copy');
      const audioMixMode = audioModeEl ? audioModeEl.value : 'duck';
      const includeDubAudio = audioMixMode !== 'original';
      const autoFitTiming = Boolean(autoFitEl ? autoFitEl.checked : true);
      const resolution = resEl ? resEl.value : 'source';
      const qualityPreset = qualityEl ? qualityEl.value : 'balanced';
      const encoder = encoderEl ? encoderEl.value : 'auto';
      const outputDir = getCustomExportOutputDir();

      const v = document.getElementById('mainVideo');
      const videoDuration = (Number.isFinite(v?.duration) && v.duration > 0)
        ? v.duration
        : ((Number.isFinite(currentVideoDuration) && currentVideoDuration > 0) ? currentVideoDuration : 120);

      // Start polling export progress
      clearInterval(exportPollInterval);
      let exportPollBusy = false;
      let exportPollErrs = 0;
      const exportUiStartedAt = Date.now();
      exportPollInterval = setInterval(async () => {
        if (exportRunId !== activeExportRunId) {
          clearInterval(exportPollInterval);
          exportPollInterval = null;
          return;
        }
        if (exportPollBusy) return;
        exportPollBusy = true;
        try {
          const pRes = await fetch(`${BACKEND_URL}/api/export/progress`);
          if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
          const pData = await pRes.json();
          if (exportRunId !== activeExportRunId) return;
          exportPollErrs = 0;
          if (pData) {
            const pct = Number.isFinite(pData.percent) ? pData.percent : null;
            if (progFill && pct !== null) progFill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
            const progress = pct !== null ? ` (${pct}%)` : '';
            const speed = pData.phase === 'encoding' && pData.speed ? ` · ${pData.speed}` : '';
            const elapsedSecTotal = Math.max(0, Math.floor((Date.now() - exportUiStartedAt) / 1000));
            const waitMins = Math.floor(elapsedSecTotal / 60);
            const waitSecs = elapsedSecTotal % 60;
            const waitFmt = `${String(waitMins).padStart(2, '0')}:${String(waitSecs).padStart(2, '0')}`;
            const elapsed = pData.phase === 'encoding' && pData.timeStr
              ? ` · ${pData.timeStr}`
              : (pData.phase === 'audio' ? ` · ⏱️ ${waitFmt}` : '');
            const phaseLabel = pData.statusText || '⚡ កំពុងដុតអក្សររត់ និង Render HD';
            if (statusMsg) statusMsg.innerText = `${phaseLabel}${progress}${speed}${elapsed}`;
          }
        } catch (_) {
          exportPollErrs++;
          if (exportPollErrs >= 4 && statusMsg) {
            statusMsg.innerText = `⚠️ កំពុងសាកល្បងភ្ជាប់ Server ឡើងវិញ (${exportPollErrs})...`;
          }
          if (exportPollErrs >= 30 && exportPollInterval) {
            clearInterval(exportPollInterval);
            exportPollInterval = null;
            isExportingNow = false;
            if (startBtn) startBtn.disabled = false;
            if (cancelBtn) cancelBtn.style.display = 'none';
            if (statusMsg) {
              statusMsg.innerText = '❌ បាត់ការតភ្ជាប់ទៅ Server បណ្ដោះអាសន្ន — សូមពិនិត្យស្ថានភាព Server ហើយចុច Export ម្ដងទៀត';
            }
          }
        } finally {
          exportPollBusy = false;
        }
      }, 450);

      const finalizeExportUi = (resData) => {
        if (exportRunId !== activeExportRunId) return;
        if (resData && resData.success) {
          lastExportedFilePath = resData.outputFile || '';
          if (progFill) progFill.style.width = '100%';
          const dubNote = resData.dubbedCueCount > 0 ? ` · AI Dubbing ${resData.dubbedCueCount} បន្ទាត់` : '';
          const droppedNote = resData.droppedDubCount > 0 ? ` (⚠️ ខ្វះសំឡេង ${resData.droppedDubCount} បន្ទាត់)` : '';
          const sizeNote = Number(resData.fileSize) > 0
            ? ` · ${resData.fileSize >= 1024 * 1024 * 1024 ? (resData.fileSize / 1024 / 1024 / 1024).toFixed(2) + ' GB' : Math.max(1, Math.round(resData.fileSize / 1024 / 1024)) + ' MB'}`
            : '';
          const metaNote = resData.encoder ? ` (${resData.encoder}, ${resData.exportTime || ''}${sizeNote})` : sizeNote;
          if (statusMsg) statusMsg.innerText = `✅ Export ជោគជ័យ${dubNote}${droppedNote}${metaNote}: ${resData.outputFile}`;
          if (openFileBtn) openFileBtn.hidden = false;
          if (dlMp4Btn) dlMp4Btn.hidden = false;
          showShortcutToast(resData.droppedDubCount > 0 ? `⚠️ Export រួចរាល់ តែខ្វះសំឡេង ${resData.droppedDubCount} បន្ទាត់` : `🎉 Export HD រួចរាល់!`);
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
            ...subtitleMaskPayload,
            includeDubAudio,
            autoGenerateMissingTts: includeDubAudio,
            autoFitTiming,
            ensureAiBgm: true,
            ...getAudioMixExportPayload(audioMixMode),
            ttsEngine: getActiveTtsEngine(),
            castMode: lockedCastMode,
            fixedVoice: lockedFixedVoice,
            voicePitch: currentCustomVoicePitch !== null ? currentCustomVoicePitch : undefined,
            voiceRate: currentCustomVoiceRate !== null ? currentCustomVoiceRate : undefined,
            strictVoice: true,
            qualityPreset,
            resolution,
            encoder,
            fastCopy,
            ecoCpu: isEcoCpuModeActive(),
            burnSubtitles: !fastCopy && (typeof isSubtitleVisible === 'boolean' ? isSubtitleVisible : true),
            outputDir,
            ...getSponsorExportPayload(),
            antiCopyright: getCopyrightExportPayload()
          })
        });
        let data = null;
        try {
          data = await res.json();
        } catch (parseErr) {
          const st = Number(res && res.status) || 0;
          if (st === 524 || st === 504 || st === 503 || st === 522 || st >= 500) {
            data = await waitForExportCompletionViaProgress(statusMsg, progFill, exportRunId);
          } else {
            throw parseErr;
          }
        }
        if (res && (res.status === 524 || res.status === 504 || res.status === 503 || res.status === 522) && (!data || !data.success)) {
          data = await waitForExportCompletionViaProgress(statusMsg, progFill, exportRunId);
        }
        if (exportRunId === activeExportRunId) {
          clearInterval(exportPollInterval);
          exportPollInterval = null;
          finalizeExportUi(data);
        }
      } catch (err) {
        if (exportRunId === activeExportRunId) {
          clearInterval(exportPollInterval);
          exportPollInterval = null;
          let recovered = null;
          if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String((err && err.message) || ''))) {
            try {
              const chk = await fetch(`${BACKEND_URL}/api/export/progress`);
              const chkData = await chk.json().catch(() => null);
              if (chkData && (chkData.running || (chkData.phase === 'done' && chkData.outputFile))) {
                recovered = await waitForExportCompletionViaProgress(statusMsg, progFill, exportRunId);
              }
            } catch (_) {}
          }
          if (exportRunId !== activeExportRunId) return;
          if (recovered && (recovered.success || recovered.cancelled)) {
            finalizeExportUi(recovered);
          } else {
            if (progTrack) progTrack.hidden = true;
            const finalMsg = (recovered && recovered.error) || err.message;
            if (statusMsg) statusMsg.innerText = '❌ កំហុស Server: ' + finalMsg;
            alert('❌ កំហុស Server: ' + finalMsg);
          }
        }
      } finally {
        if (exportRunId === activeExportRunId) {
          isExportingNow = false;
          if (startBtn) startBtn.disabled = false;
          if (cancelBtn) cancelBtn.style.display = 'none';
        }
      }
    }

    async function cancelActiveExport() {
      if (confirm('តើអ្នកចង់បោះបង់ការ Export នេះមែនទេ?')) {
        activeExportRunId++;
        isExportingNow = false;
        clearInterval(exportPollInterval);
        exportPollInterval = null;
        try {
          await fetch(`${BACKEND_URL}/api/export/cancel`, { method: 'POST' });
        } catch (_) {}
        const startBtn = document.getElementById('btnStartExport');
        const cancelBtn = document.getElementById('btnCancelExport');
        const progTrack = document.getElementById('exportProgressTrack');
        if (startBtn) startBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (progTrack) progTrack.hidden = true;
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

    function toggleRespanKeyVisibility(forceVisible) {
      const input = document.getElementById('respanApiKeyInput');
      const btn = document.getElementById('respanKeyEyeBtn');
      if (!input) return;
      const show = typeof forceVisible === 'boolean' ? forceVisible : (input.type === 'password');
      input.type = show ? 'text' : 'password';
      if (btn) {
        btn.innerText = show ? '🙈' : '👁️';
        btn.setAttribute('aria-label', show ? 'លាក់ Respan Key' : 'បង្ហាញ Respan Key');
      }
    }

    let cachedRespanSnapshot = null;

    function renderRouterRespanStrip(respanData) {
      const snap = respanData && typeof respanData === 'object' ? respanData : cachedRespanSnapshot;
      if (respanData && typeof respanData === 'object') {
        cachedRespanSnapshot = respanData;
      }
      if (!snap) return;

      const statusEl = document.getElementById('routerRespanStatusText');
      const role = snap.role || 'assist';
      const hasKey = Boolean(snap.hasKey);
      const modelLabel = snap.model || 'openai/gpt-6.2-sol:free';
      const reqs = Number(snap.totalRequests) || 0;
      const latTxt = snap.lastLatencyMs ? ` · ${formatRouterMs(snap.lastLatencyMs)}` : '';

      if (statusEl) {
        if (!hasKey) {
          statusEl.innerText = `⚪ មិនទាន់ដាក់ Key (${modelLabel})`;
          statusEl.style.color = '#94a3b8';
        } else if (role === 'off') {
          statusEl.innerText = `⏸️ បិទ (${snap.keyHint || 'Key Saved'})`;
          statusEl.style.color = '#94a3b8';
        } else if (snap.lastStatus === 'rate_limited') {
          const cd = formatRouterCooldownRemaining(snap.cooldownRemainingMs);
          statusEl.innerText = `⏳ Cooldown ${cd || ''} (${modelLabel})`;
          statusEl.style.color = '#fcd34d';
        } else if (snap.isStreaming) {
          statusEl.innerText = `● កំពុងបកប្រែ... · ${reqs} req (${modelLabel})`;
          statusEl.style.color = '#6ee7b7';
        } else if (snap.lastStatus === 'error') {
          statusEl.innerText = `⚠️ ${snap.lastError || 'មានបញ្ហាតភ្ជាប់'} (${snap.keyHint || ''})`;
          statusEl.style.color = '#fda4af';
        } else {
          const roleTxt = role === 'primary' ? '⚡ រត់ Respan មុន' : '🤝 ជួយ Gemini';
          statusEl.innerText = `🟢 ${roleTxt} · ${snap.keyHint || 'Key Ready'} · ${reqs} req${latTxt}`;
          statusEl.style.color = '#6ee7b7';
        }
      }

      const roleBtns = [
        ['btnRespanRolePrimary', 'primary'],
        ['btnRespanRoleAssist', 'assist'],
        ['btnRespanRoleOff', 'off']
      ];
      roleBtns.forEach(([id, val]) => {
        const b = document.getElementById(id);
        if (b && b.classList) b.classList.toggle('active', role === val);
      });

      const editBtn = document.getElementById('btnRouterRespanEdit');
      if (editBtn) {
        editBtn.innerText = hasKey ? '🔑 កែ Key' : '🔑 ដាក់ Key';
      }
    }

    async function refreshRouterRespanStatus() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/respan`);
        const data = await res.json();
        if (res.ok && data && data.success) {
          renderRouterRespanStrip(data);
          return data;
        }
      } catch (_) {}
      return null;
    }

    async function toggleRouterRespanPanel(forceState) {
      const panel = document.getElementById('routerRespanPanel');
      if (!panel) return;
      const shouldOpen = typeof forceState === 'boolean' ? forceState : panel.hidden;
      panel.hidden = !shouldOpen;
      if (shouldOpen) {
        const addPanel = document.getElementById('routerAddPanel');
        const batchPanel = document.getElementById('routerBatchPanel');
        if (addPanel) addPanel.hidden = true;
        if (batchPanel) batchPanel.hidden = true;
      }
      toggleRespanKeyVisibility(false);
      if (!shouldOpen) return;

      const snap = (await refreshRouterRespanStatus()) || cachedRespanSnapshot || {};
      const keyInput = document.getElementById('respanApiKeyInput');
      const hintEl = document.getElementById('respanKeyHintText');
      const baseInput = document.getElementById('respanBaseUrlInput');
      const modelInput = document.getElementById('respanModelInput');
      const roleSelect = document.getElementById('respanRoleSelect');
      const feedbackEl = document.getElementById('respanPanelFeedback');
      if (feedbackEl) feedbackEl.innerText = '';
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = snap.hasKey
          ? `រក្សាទុករួច (${snap.keyHint}) — ទុកទំនេរបើមិនប្ដូរ`
          : 'បិទភ្ជាប់ Respan API Key...';
      }
      if (hintEl) {
        hintEl.hidden = !snap.hasKey;
        hintEl.innerText = snap.hasKey ? `(កំពុងរក្សា ${snap.keyHint})` : '';
      }
      if (baseInput) baseInput.value = snap.baseUrl || 'https://gateway.respan.ai/v1';
      if (modelInput) modelInput.value = snap.model || 'openai/gpt-6.2-sol:free';
      if (roleSelect) roleSelect.value = snap.role || 'assist';
      if (keyInput && typeof keyInput.focus === 'function') keyInput.focus();
    }

    async function saveRouterRespanConfig(event) {
      if (event) event.preventDefault();
      const keyInput = document.getElementById('respanApiKeyInput');
      const baseInput = document.getElementById('respanBaseUrlInput');
      const modelInput = document.getElementById('respanModelInput');
      const roleSelect = document.getElementById('respanRoleSelect');
      const feedbackEl = document.getElementById('respanPanelFeedback');
      const saveBtn = document.getElementById('respanPanelSaveBtn');
      const payload = {
        baseUrl: baseInput ? String(baseInput.value || '').trim() : '',
        model: modelInput ? String(modelInput.value || '').trim() : '',
        role: roleSelect ? String(roleSelect.value || 'assist') : 'assist'
      };
      const nextKey = keyInput ? String(keyInput.value || '').trim() : '';
      if (nextKey) payload.apiKey = nextKey;

      if (saveBtn) saveBtn.disabled = true;
      if (feedbackEl) {
        feedbackEl.style.color = '#bae6fd';
        feedbackEl.innerText = '⏳ កំពុងរក្សាទុក Respan GPT-6.2 SOL...';
      }
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/respan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចរក្សាទុក Respan API Key បានទេ');
        }
        renderRouterRespanStrip(data);
        if (keyInput) keyInput.value = '';
        toggleRouterRespanPanel(false);
        const msg = data.hasKey
          ? `✅ រក្សាទុក GPT-6.2 SOL (${data.keyHint}) រួចរាល់!`
          : '✅ បានរក្សាទុកការកំណត់ Respan Gateway!';
        setRouterSidebarStatus(msg);
        showShortcutToast(msg);
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.style.color = '#fda4af';
          feedbackEl.innerText = '❌ ' + err.message;
        }
        setRouterSidebarStatus(err.message, true);
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    async function setRouterRespanRole(role) {
      const nextRole = ['assist', 'primary', 'off'].includes(role) ? role : 'assist';
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/respan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: nextRole })
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចប្ដូររបៀប Respan បានទេ');
        }
        renderRouterRespanStrip(data);
        const label = nextRole === 'assist'
          ? '🤝 GPT-6.2 SOL: ជួយ Gemini ព្រមគ្នា (មិនជំនួសទេ)'
          : (nextRole === 'primary' ? '⚡ GPT-6.2 SOL: រត់ Respan មុន (Gemini បម្រុង)' : '⏸️ GPT-6.2 SOL: បិទបណ្ដោះអាសន្ន');
        setRouterSidebarStatus(label);
        showShortcutToast(label);
        if (!data.hasKey && nextRole !== 'off') {
          toggleRouterRespanPanel(true);
        }
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      }
    }

    async function clearRouterRespanKey() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/respan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearKey: true })
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចលុប Key បានទេ');
        }
        renderRouterRespanStrip(data);
        toggleRouterRespanPanel(false);
        setRouterSidebarStatus('🗑️ បានលុប Respan API Key ចេញរួចរាល់');
        showShortcutToast('🗑️ បានលុប Respan API Key');
      } catch (err) {
        setRouterSidebarStatus(err.message, true);
      }
    }

    async function testRouterRespanConnection() {
      const btn = document.getElementById('btnRouterRespanTest');
      const panelBtn = document.getElementById('respanPanelTestBtn');
      const feedbackEl = document.getElementById('respanPanelFeedback');
      const keyInput = document.getElementById('respanApiKeyInput');
      const baseInput = document.getElementById('respanBaseUrlInput');
      const modelInput = document.getElementById('respanModelInput');
      if (btn) btn.disabled = true;
      if (panelBtn) panelBtn.disabled = true;
      if (feedbackEl) {
        feedbackEl.style.color = '#bae6fd';
        feedbackEl.innerText = '⚡ កំពុងតេស្ត Respan GPT-6.2 SOL...';
      }
      setRouterSidebarStatus('⚡ កំពុងតេស្ត Respan GPT-6.2 SOL...');
      try {
        const payload = {};
        if (keyInput && keyInput.value.trim()) payload.apiKey = keyInput.value.trim();
        if (baseInput && baseInput.value.trim()) payload.baseUrl = baseInput.value.trim();
        if (modelInput && modelInput.value.trim()) payload.model = modelInput.value.trim();
        const res = await fetch(`${BACKEND_URL}/api/config/respan/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data && data.respan) renderRouterRespanStrip(data.respan);
        if (!res.ok || !data.success) {
          throw new Error((data && data.error) || 'តេស្តបរាជ័យ');
        }
        if (data.healthy) {
          const msg = `✅ GPT-6.2 SOL OK (${data.latencyMs}ms)${data.modelReply ? ' · ' + data.modelReply : ''}`;
          if (feedbackEl) {
            feedbackEl.style.color = '#6ee7b7';
            feedbackEl.innerText = msg;
          }
          setRouterSidebarStatus(msg);
          showShortcutToast(`✅ Respan GPT-6.2 SOL OK (${data.latencyMs}ms)`);
        } else {
          const errMsg = `⚠️ GPT-6.2 SOL: ${data.error || 'បរាជ័យ'} (${data.latencyMs}ms)`;
          if (feedbackEl) {
            feedbackEl.style.color = '#fda4af';
            feedbackEl.innerText = errMsg;
          }
          setRouterSidebarStatus(errMsg, true);
          showShortcutToast(errMsg);
        }
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.style.color = '#fda4af';
          feedbackEl.innerText = '❌ ' + err.message;
        }
        setRouterSidebarStatus(err.message, true);
      } finally {
        if (btn) btn.disabled = false;
        if (panelBtn) panelBtn.disabled = false;
      }
    }

    function toggleRouterAddPanel(forceState, editAccount = null) {
      const panel = document.getElementById('routerAddPanel');
      if (!panel) return;
      const shouldOpen = typeof forceState === 'boolean' ? forceState : panel.hidden;
      panel.hidden = !shouldOpen;
      if (shouldOpen) {
        const batchPanel = document.getElementById('routerBatchPanel');
        const respanPanel = document.getElementById('routerRespanPanel');
        if (batchPanel) batchPanel.hidden = true;
        if (respanPanel) respanPanel.hidden = true;
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
        const respanPanel = document.getElementById('routerRespanPanel');
        if (respanPanel) respanPanel.hidden = true;
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

    let routerOpenSeq = 0;

    async function openRouterSidebar() {
      const openSeq = ++routerOpenSeq;
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
      await Promise.all([syncRouterModelMode(), refreshGeminiAccounts(), refreshRouterRespanStatus()]);
      if (openSeq !== routerOpenSeq || currentAppView !== 'router') return;

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
      const respanPanel = document.getElementById('routerRespanPanel');
      const studioPane = document.getElementById('studioViewPane');
      if (sidebar) sidebar.hidden = true;
      if (addPanel) addPanel.hidden = true;
      if (batchPanel) batchPanel.hidden = true;
      if (respanPanel) respanPanel.hidden = true;
      if (studioPane && currentAppView !== 'video-manager') {
        studioPane.style.display = 'flex';
      }
      if (currentAppView === 'router') {
        currentAppView = 'studio';
        setActiveSidebarNav('studio');
      }
      if (currentAppView === 'studio') {
        if (typeof fitPreviewFrameSize === 'function') fitPreviewFrameSize();
        if (typeof renderTimeline === 'function') renderTimeline();
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
      if (data && data.respan) renderRouterRespanStrip(data.respan);
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
      if (backendData && backendData.respan && !source.respan) {
        source.respan = backendData.respan;
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
        if (data && data.respan) renderRouterRespanStrip(data.respan);

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

        if (data.accounts.length === 0 && !(data.respan && data.respan.enabled) && !options.silent) {
          const batchPanelEl = document.getElementById('routerBatchPanel');
          if (!batchPanelEl || batchPanelEl.hidden) {
            toggleRouterAddPanel(true);
          }
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
        name: String(formData.get('name') || '').trim() || 'Gemini Key',
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
    let vmQueueFilterMode = 'all';
    let vmViewMode = 'list';
    let vmSetupCollapsed = false;
    let vmBatchStartedAt = 0;
    let vmLastBatchElapsedMs = 0;
    let vmElapsedTimerId = null;
    let vmActiveRunTotal = 0;
    let vmActiveRunConcurrency = 2;
    const vmThumbCache = new Map();
    const vmThumbPendingKeys = new Set();
    let vmThumbWorkerChain = Promise.resolve();

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
        if (cues[i] && cues[i]._userEdited) continue;
        const orig = String(cues[i].text || '').trim();
        if (!orig) continue;
        const trans = String(cues[i].translated || '').trim();
        const numericOnly = /^[\d\s.,!?\-'"()…]+$/.test(orig);
        if (target === 'km' && /[\u1780-\u17FF]/.test(trans) && !KM_LEAKED_SCRIPT_RE.test(trans)) {
          continue;
        }
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

    function formatVmDurationClock(ms) {
      const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const pad = n => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function formatVmDurationKhmer(ms) {
      const totalSec = Math.max(1, Math.round(Number(ms || 0) / 1000));
      if (totalSec < 60) return `${totalSec} វិ`;
      const totalMin = Math.floor(totalSec / 60);
      const remSec = totalSec % 60;
      if (totalMin < 60) {
        return remSec > 0 && totalMin < 5 ? `${totalMin} នាទី ${remSec} វិ` : `${totalMin} នាទី`;
      }
      const hrs = Math.floor(totalMin / 60);
      const remMin = totalMin % 60;
      return remMin > 0 ? `${hrs} ម៉ោង ${remMin} នាទី` : `${hrs} ម៉ោង`;
    }

    function getVmItemTimerText(item, nowMs = Date.now()) {
      if (!item) return '';
      if (item.status === 'running' && item.startedAt) {
        return `⏱️ ${formatVmDurationClock(nowMs - item.startedAt)}`;
      }
      if ((item.status === 'done' || item.status === 'error') && item.elapsedMs > 0) {
        return `⏱️ ${formatVmDurationKhmer(item.elapsedMs)}`;
      }
      return '';
    }

    function computeVmBatchTimeText(nowMs = Date.now()) {
      const doneItems = vmQueue.filter(i => i.status === 'done');
      if (vmIsRunning && vmBatchStartedAt > 0) {
        const elapsedMs = Math.max(0, nowMs - vmBatchStartedAt);
        const totalTargets = Math.max(1, vmActiveRunTotal || vmQueue.filter(i => i.selected).length || vmQueue.length);
        const targetSubset = vmQueue.filter(i => i.status === 'running' || i.status === 'done' || i.status === 'pending');
        const activeList = targetSubset.length > 0 ? targetSubset.slice(0, totalTargets) : vmQueue;
        const pctAvg = activeList.length > 0
          ? activeList.reduce((acc, it) => acc + (Number(it.progress) || 0), 0) / activeList.length
          : 0;
        const completedTimed = doneItems.filter(i => i.elapsedMs > 0);
        const remainingCount = Math.max(0, totalTargets - doneItems.length);
        let etaMs = 0;
        if (completedTimed.length > 0 && remainingCount > 0) {
          const avgItemMs = completedTimed.reduce((a, b) => a + b.elapsedMs, 0) / completedTimed.length;
          etaMs = Math.max(2000, (avgItemMs * remainingCount) / Math.max(1, vmActiveRunConcurrency));
        } else if (pctAvg >= 8 && pctAvg < 99.5) {
          etaMs = Math.max(2000, (elapsedMs / (pctAvg / 100)) * (1 - (pctAvg / 100)));
        }
        const elapsedClock = formatVmDurationClock(elapsedMs);
        return etaMs > 0
          ? `⏱️ ដើរបាន ${elapsedClock} · ⏳ នៅសល់ ~${formatVmDurationKhmer(etaMs)}`
          : `⏱️ ដើរបាន ${elapsedClock}`;
      }
      if (!vmIsRunning && vmLastBatchElapsedMs > 0 && doneItems.length > 0) {
        return `✅ ចប់សរុប ${formatVmDurationKhmer(vmLastBatchElapsedMs)}`;
      }
      return '';
    }

    function updateVmLiveTimersUi() {
      const nowMs = Date.now();
      const batchBadge = document.getElementById('vmBatchTimeBadge');
      if (batchBadge) {
        const txt = computeVmBatchTimeText(nowMs);
        batchBadge.hidden = !txt;
        if (txt) batchBadge.innerText = txt;
      }
      const container = document.getElementById('vmQueueContainer');
      if (container && typeof container.querySelectorAll === 'function') {
        const spans = container.querySelectorAll('[data-vm-timer-id]');
        if (spans && typeof spans.forEach === 'function') {
          spans.forEach(sp => {
            const rawId = sp && typeof sp.getAttribute === 'function' ? Number(sp.getAttribute('data-vm-timer-id')) : 0;
            const item = rawId ? vmQueue.find(x => x.id === rawId) : null;
            if (!item) return;
            const tText = getVmItemTimerText(item, nowMs);
            if (tText) {
              sp.hidden = false;
              sp.innerText = tText;
            } else {
              sp.hidden = true;
            }
          });
        }
      }
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
      const pending = vmQueue.filter(i => !i.status || i.status === 'pending').length;

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
          summaryEl.innerText = `⚡ កំពុងធ្វើព្រមគ្នា ${running} · ✅ រួចរាល់: ${done}/${total} · ⏳ នៅសល់: ${pending}` + (errored ? ` · ❌ បរាជ័យ: ${errored}` : '');
        } else if (done === total && total > 0) {
          summaryEl.innerText = `✅ បានបញ្ចប់គ្រប់ ${done} វីដេអូ! ចុច ⬇️ ទាញយក ឬ 📂 បើក Folder ដើម្បីមើល MP4 ទាំងអស់។`;
        } else {
          summaryEl.innerText = `📋 ទាំងអស់: ${total} (ធីក ${selected}) · ✅ រួចរាល់: ${done} · ⏳ នៅសល់: ${pending}` + (errored ? ` · ❌ បរាជ័យ: ${errored}` : '');
        }
      }

      if (startBtn) {
        startBtn.disabled = vmIsRunning || selected === 0;
        startBtn.innerText = vmIsRunning ? '⚡ កំពុងដំណើរការ...' : '🚀 ចាប់ផ្ដើម Auto ទាំងអស់';
      }
      if (stopBtn) {
        stopBtn.style.display = vmIsRunning ? 'inline-flex' : 'none';
      }
      const openDoneBtn = document.getElementById('btnVmOpenDoneFolder');
      const dlAllBtn = document.getElementById('btnVmDownloadAll');
      const dlAllToolBtn = document.getElementById('btnVmDownloadAllTool');
      const hasCompletedExports = vmQueue.some(i => i.status === 'done' && (i.exportUrl || i.exportOutputFile));
      if (openDoneBtn) {
        openDoneBtn.style.display = (hasCompletedExports && !vmIsRunning) ? 'inline-flex' : 'none';
      }
      if (dlAllBtn) {
        dlAllBtn.style.display = (hasCompletedExports && !vmIsRunning) ? 'inline-flex' : 'none';
        dlAllBtn.innerText = `⬇️ ទាញយក MP4 ទាំងអស់ (${done})`;
      }
      if (dlAllToolBtn) {
        dlAllToolBtn.style.display = (hasCompletedExports && !vmIsRunning) ? 'inline-flex' : 'none';
        dlAllToolBtn.innerText = `⬇️ MP4 ទាំងអស់ (${done})`;
      }
      const retryBtn = document.getElementById('btnVmRetryFailed');
      if (retryBtn) {
        retryBtn.hidden = errored === 0;
        retryBtn.disabled = vmIsRunning || errored === 0;
        retryBtn.innerText = errored > 0 ? `🔁 ធ្វើបរាជ័យឡើងវិញ (${errored})` : '🔁 ធ្វើបរាជ័យឡើងវិញ';
      }
      const badgeTotal = document.getElementById('vmQueueTotalBadge');
      if (badgeTotal) badgeTotal.innerText = String(total);
      const countIds = {
        vmCountAll: total,
        vmCountPending: pending,
        vmCountRunning: running,
        vmCountDone: done,
        vmCountError: errored
      };
      for (const [id, val] of Object.entries(countIds)) {
        const el = document.getElementById(id);
        if (el) el.innerText = String(val);
      }
      updateVideoManagerTopBadge();
      updateVmLiveTimersUi();
    }

    function getVmThumbKey(item) {
      if (!item) return '';
      if (item.videoPath) return `path:${normalizePathKey(item.videoPath)}`;
      if (item.fileObj && item.fileObj.name) return `file:${item.fileObj.name.toLowerCase()}:${Number(item.fileSize || item.fileObj.size || 0)}`;
      return '';
    }

    function enqueueVmThumbnail(item, rowIndex = -1) {
      if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return;
      if (vmIsRunning) return;
      const resolvedIdx = rowIndex >= 0 ? rowIndex : vmQueue.indexOf(item);
      const lowMemThumbCap = isEcoCpuModeActive() || Boolean(cachedSystemProfile && cachedSystemProfile.isLowSpec);
      if (lowMemThumbCap ? (vmQueue.length > 16 && resolvedIdx >= 10) : (vmQueue.length > 36 && resolvedIdx >= 24)) return;
      const thumbKey = getVmThumbKey(item);
      if (!thumbKey || vmThumbCache.has(thumbKey) || vmThumbPendingKeys.has(thumbKey)) return;
      if (!item.videoPath && !item.fileObj) return;
      vmThumbPendingKeys.add(thumbKey);

      vmThumbWorkerChain = vmThumbWorkerChain.catch(() => {}).then(async () => {
        if (vmIsRunning || typeof document.createElement !== 'function') return;
        let objUrl = '';
        let video = null;
        try {
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.crossOrigin = 'anonymous';
          if (item.fileObj && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            objUrl = URL.createObjectURL(item.fileObj);
            video.src = objUrl;
          } else if (item.videoPath) {
            video.src = appendAccessTokenToUrl(`${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(item.videoPath)}`);
          } else {
            return;
          }

          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('thumb timeout')), 4500);
            const cleanup = () => clearTimeout(timer);
            video.onloadeddata = () => {
              const dur = Number(video.duration) || 0;
              const seekTo = dur > 1.2 ? Math.min(1.5, dur * 0.25) : 0.05;
              if (Math.abs((video.currentTime || 0) - seekTo) < 0.05) {
                cleanup();
                resolve();
              } else {
                video.onseeked = () => { cleanup(); resolve(); };
                try { video.currentTime = seekTo; } catch (_) { cleanup(); resolve(); }
              }
            };
            video.onerror = () => { cleanup(); reject(new Error('thumb load failed')); };
          });

          const canvas = document.createElement('canvas');
          const vw = video.videoWidth || 160;
          const vh = video.videoHeight || 90;
          const maxW = 160;
          const scale = Math.min(1, maxW / Math.max(1, vw));
          canvas.width = Math.max(64, Math.round(vw * scale));
          canvas.height = Math.max(40, Math.round(vh * scale));
          const ctx = canvas.getContext && canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
            if (dataUrl && dataUrl.startsWith('data:image/')) {
              vmThumbCache.set(thumbKey, dataUrl);
              const container = document.getElementById('vmQueueContainer');
              if (container && typeof container.querySelectorAll === 'function') {
                container.querySelectorAll('.vm-thumb-box').forEach(box => {
                  if (box && box.getAttribute && box.getAttribute('data-thumb-key') === thumbKey) {
                    box.innerHTML = `<img class="vm-thumb-img" src="${dataUrl}" alt="">`;
                  }
                });
              }
            }
          }
        } catch (_) {
        } finally {
          try { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } } catch (_) {}
          if (objUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(objUrl); } catch (_) {}
          }
          vmThumbPendingKeys.delete(thumbKey);
        }
      });
    }

    function getFilteredVideoManagerItems() {
      const searchEl = document.getElementById('vmQueueSearch');
      const query = searchEl ? String(searchEl.value || '').trim().toLowerCase() : '';
      return vmQueue.filter(item => {
        const st = item.status || 'pending';
        if (vmQueueFilterMode !== 'all' && st !== vmQueueFilterMode) return false;
        if (query) {
          const hay = `${item.name || ''} ${item.ep || ''} ${item.videoPath || ''}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });
    }

    function setVideoManagerFilter(mode = 'all') {
      const allowed = new Set(['all', 'pending', 'running', 'done', 'error']);
      vmQueueFilterMode = allowed.has(mode) ? mode : 'all';
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('#vmFilterPills .vm-filter-pill[data-filter]').forEach(btn => {
          if (btn && btn.classList && typeof btn.getAttribute === 'function') {
            btn.classList.toggle('active', btn.getAttribute('data-filter') === vmQueueFilterMode);
          }
        });
      }
      renderVideoManagerQueue();
    }

    function toggleVideoManagerViewMode() {
      vmViewMode = vmViewMode === 'grid' ? 'list' : 'grid';
      const btn = document.getElementById('btnVmViewMode');
      if (btn) {
        btn.innerText = vmViewMode === 'grid' ? '📋 បញ្ជី' : '🗂️ កាត';
      }
      const container = document.getElementById('vmQueueContainer');
      if (container && container.classList && typeof container.classList.toggle === 'function') {
        container.classList.toggle('is-grid', vmViewMode === 'grid');
      }
    }

    function toggleVideoManagerSetup(forceCollapsed) {
      vmSetupCollapsed = typeof forceCollapsed === 'boolean' ? forceCollapsed : !vmSetupCollapsed;
      const panel = document.getElementById('vmSetupPanel');
      if (panel && panel.classList && typeof panel.classList.toggle === 'function') {
        panel.classList.toggle('is-collapsed', vmSetupCollapsed);
      }
      const btn = document.getElementById('btnVmToggleSetup');
      if (btn) {
        btn.innerText = vmSetupCollapsed ? '⚙️ បង្ហាញការកំណត់ ▾' : '⚙️ លាក់ការកំណត់ ▴';
      }
    }

    function resetVideoManagerFilter() {
      const searchEl = document.getElementById('vmQueueSearch');
      if (searchEl) searchEl.value = '';
      setVideoManagerFilter('all');
    }

    function renderVideoManagerQueue() {
      const container = document.getElementById('vmQueueContainer');
      if (!container) {
        updateVideoManagerTopBadge();
        return;
      }
      const prevScrollTop = Number(container.scrollTop) || 0;
      if (container.classList && typeof container.classList.toggle === 'function') {
        container.classList.toggle('is-grid', vmViewMode === 'grid');
      }

      if (vmQueue.length === 0) {
        container.innerHTML = '<div class="vm-empty" onclick="pickBatchVideoFiles()"><span class="vm-empty-icon" style="font-size:34px;">🎬 📁</span><strong style="color:#f1f5f9; font-size:14px;">ចុចទីនេះដើម្បីរើសវីដេអូ ឬទាញវីដេអូ/Folder មកទម្លាក់ត្រង់នេះ</strong><small style="color:#94a3b8; font-size:11.5px; max-width:480px; line-height:1.4;">គាំទ្រការជ្រើសវីដេអូ + .SRT ច្រើនព្រមគ្នា ឬទម្លាក់ Folder ទាំងមូល (MP4 / MOV / MKV) · តម្រៀបភាគដោយស្វ័យប្រវត្តិ</small><div class="vm-empty-action-group" style="margin-top:8px; display:flex; gap:10px; flex-wrap:wrap; justify-content:center;"><button type="button" class="btn-mini" style="padding:6px 14px; font-weight:700; color:#38bdf8; border-color:#38bdf8;" onclick="event.stopPropagation(); pickBatchVideoFiles()">🎬 រើស Files វីដេអូ (Explorer)</button><button type="button" class="btn-mini" style="padding:6px 14px; font-weight:700; color:#e2e8f0; border-color:#64748b;" onclick="event.stopPropagation(); pickBatchVideoFolder()">📁 រើស Folder ទាំងមូល (Explorer)</button></div></div>';
        updateVideoManagerProgressUi();
        return;
      }

      const visibleItems = getFilteredVideoManagerItems();
      if (visibleItems.length === 0) {
        container.innerHTML = '<div class="vm-empty" onclick="resetVideoManagerFilter()"><span class="vm-empty-icon" style="font-size:22px;">🔍</span><strong style="color:#f1f5f9; font-size:13px;">មិនមានវីដេអូត្រូវតាមការស្វែងរក ឬតម្រងនេះទេ</strong><small style="color:#38bdf8;">ចុចទីនេះដើម្បីបង្ហាញវីដេអូទាំងអស់ឡើងវិញ</small></div>';
        updateVideoManagerProgressUi();
        return;
      }

      container.innerHTML = visibleItems.map((item, visibleIdx) => {
        const globalIdx = vmQueue.indexOf(item);
        const displayNum = globalIdx >= 0 ? (globalIdx + 1) : 1;
        const safeName = escapeHtml(item.name || `Video ${displayNum}`);
        const epTag = item.ep ? `<span class="vm-pill">${escapeHtml(item.ep)}</span>` : '';
        const pct = Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0)));
        const statusBadge = item.status === 'done'
          ? '<span class="vm-pill done vm-status-pill">✅ រួចរាល់</span>'
          : (item.status === 'running'
            ? `<span class="vm-pill warn vm-status-pill">⚡ កំពុងធ្វើ (${pct}%)</span>`
            : (item.status === 'error'
              ? '<span class="vm-pill warn vm-status-pill" style="color:#fca5a5; border-color:#ef4444;">❌ បរាជ័យ</span>'
              : '<span class="vm-pill vm-status-pill">⏳ នៅសល់</span>'));
        const hasSrtReady = Boolean(item.srtPath || item.hasLocalSrt);
        const srtTag = hasSrtReady
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
        const itemTimeStr = getVmItemTimerText(item);
        const timeTag = `<span class="vm-item-time" data-vm-timer-id="${item.id}"${itemTimeStr ? '' : ' hidden'}>${escapeHtml(itemTimeStr)}</span>`;
        const exportBtn = item.exportUrl
          ? `<a class="btn-mini" href="${escapeHtml(resolveBackendUrl(item.exportUrl))}" download title="ទាញយក MP4 នេះ">⬇️ MP4</a>`
          : '';
        const revealBtn = (item.exportOutputFile || item.exportUrl) && item.status === 'done'
          ? `<button type="button" class="btn-mini" onclick="openSingleExportItem(${item.id})" title="បើកមើលទីតាំង MP4 ក្នុង Windows Explorer">📁 ទីតាំង</button>`
          : '';
        const canOpenInStudio = Boolean(item.videoPath || item.fileObj || (Array.isArray(item.cues) && item.cues.length > 0));
        const openDisabled = canOpenInStudio ? '' : ' disabled';
        const runItemDisabled = vmIsRunning ? ' disabled' : '';
        const removeDisabled = item.status === 'running' ? ' disabled' : '';
        const checkedAttr = item.selected ? ' checked' : '';
        const runIcon = item.status === 'error' ? '🔁' : '▶️';
        const runTitle = item.status === 'error' ? 'សាកល្បងវីដេអូនេះម្ដងទៀត' : 'ដំណើរការតែវីដេអូនេះ';
        const thumbKey = getVmThumbKey(item);
        const cachedThumb = thumbKey ? vmThumbCache.get(thumbKey) : '';
        if (thumbKey && !cachedThumb) enqueueVmThumbnail(item, visibleIdx);
        const thumbHtml = cachedThumb
          ? `<img class="vm-thumb-img" src="${cachedThumb}" alt="">`
          : `<span class="vm-thumb-fallback">${escapeHtml(item.ep ? ('EP ' + item.ep) : ('#' + displayNum))}</span>`;
        const firstSampleCue = Array.isArray(item.cues) && item.cues.length > 0
          ? String(item.cues[0].translated || item.cues[0].text || '').trim()
          : '';
        const sampleHtml = firstSampleCue
          ? `<div class="vm-row-sample" title="${escapeHtml(firstSampleCue)}">💬 ${escapeHtml(firstSampleCue)}</div>`
          : '';

        return `<div class="vm-row" data-vm-row-id="${item.id}" data-status="${escapeHtml(item.status || 'pending')}">`
          + `<input type="checkbox"${checkedAttr} onchange="toggleVideoManagerItemSelect(${item.id}, this.checked)" ${vmIsRunning && item.status === 'running' ? 'disabled' : ''}>`
          + `<div class="vm-thumb-box" data-thumb-key="${escapeHtml(thumbKey)}">${thumbHtml}</div>`
          + `<div style="min-width:0;">`
            + `<div class="vm-row-name" title="${safeName}">${displayNum}. ${safeName}</div>`
            + `<div class="vm-row-meta">${epTag}${statusBadge}${timeTag}${srtTag}${cueTag}${dubTag}</div>`
            + sampleHtml
          + `</div>`
          + `<div class="vm-row-status">`
            + `<div class="vm-status-text" title="${escapeHtml(item.error || item.stageText || '')}">${escapeHtml(item.error ? ('❌ ' + item.error) : (item.stageText || 'រង់ចាំ Auto'))}</div>`
            + `<div class="vm-mini-bar"><div class="vm-mini-bar-fill" style="width:${pct}%;"></div></div>`
          + `</div>`
          + `<div class="vm-row-actions">`
            + exportBtn
            + revealBtn
            + `<button type="button" class="btn-mini" onclick="runSingleVideoManagerItem(${item.id})"${runItemDisabled} title="${runTitle}">${runIcon}</button>`
            + `<button type="button" class="btn-mini" onclick="openVideoManagerItemInStudio(${item.id})"${openDisabled} title="បើកមើល Preview និងកែលម្អិតក្នុង Studio">🎬 Studio</button>`
            + `<button type="button" class="btn-mini" onclick="removeVideoManagerItem(${item.id})"${removeDisabled} title="ដកចេញ">✕</button>`
          + `</div>`
        + `</div>`;
      }).join('');

      container.scrollTop = prevScrollTop;
      updateVideoManagerProgressUi();
    }

    function renderVmStudioPresetStrip() {
      const el = document.getElementById('vmStudioPresetSummary');
      if (!el) return;
      const parts = [];
      const origPct = Number(audioMixerState?.origPct ?? 0);
      const bgmPct = Number(audioMixerState?.bgmPct ?? 85);
      const dubPct = Number(audioMixerState?.dubPct ?? 100);
      if (origPct <= 0 && bgmPct > 0 && dubPct > 0) parts.push(`🎼 BGM ${bgmPct}% + Dub ${dubPct}%`);
      else if (origPct <= 0 && bgmPct <= 0) parts.push(`🗣️ Dub សុទ្ធ ${dubPct}%`);
      else parts.push(`🔊 ដើម ${origPct}% · BGM ${bgmPct}% · Dub ${dubPct}%`);

      const subStyleEl = document.getElementById('subStyleSelect');
      const subStyleMap = { tiktok: 'TikTok', gold_cinema: 'Gold Cinema', outline: 'Outline', yellow: 'ខ្សែរឿងលឿង', clean: 'សុទ្ធ' };
      const subVisible = typeof isSubtitleVisible === 'boolean' ? isSubtitleVisible : true;
      if (subVisible) {
        parts.push(`✨ Sub: ${subStyleMap[subStyleEl?.value] || subStyleEl?.value || 'TikTok'}`);
      } else {
        parts.push('✨ Sub: បិទ');
      }

      if (typeof subtitleMaskState === 'object' && subtitleMaskState && subtitleMaskState.enabled) {
        parts.push('🌫️ បាំងចិន: បើក');
      } else {
        parts.push('🌫️ បាំងចិន: បិទ');
      }

      if (typeof customTextOverlayState === 'object' && customTextOverlayState && customTextOverlayState.enabled && String(customTextOverlayState.text || '').trim()) {
        const cleanTxt = String(customTextOverlayState.text).trim().slice(0, 18);
        parts.push(`✍️ "${cleanTxt}"`);
      }

      const resEl = document.getElementById('exportResolution');
      const qEl = document.getElementById('exportQualityPreset');
      const qVal = (qEl && qEl.value) || 'balanced';
      const qTag = qVal === 'fast' ? '⚡ Fast' : (qVal === 'hd' ? '✨ HD' : (qVal === 'ultra' ? '💎 Ultra' : '⚖️ Balanced'));
      parts.push(`🎬 ${(resEl && resEl.value) || 'source'} (${qTag})`);
      if (isEcoCpuModeActive()) parts.push('🛡️ សន្សំ CPU');
      el.innerText = `⚙️ កំណត់ពី Studio (ជាប់គ្រប់វីដេអូ)៖ ${parts.join(' · ')}`;
    }

    function applyVideoManagerModePreset({ concurrency = '2', ecoMode = false, toastText = '' } = {}) {
      const concEl = document.getElementById('vmConcurrencySelect');
      if (concEl) concEl.value = String(concurrency);
      const ttsChk = document.getElementById('vmGenerateTtsCheck');
      if (ttsChk) ttsChk.checked = true;
      const draftChk = document.getElementById('vmSaveDraftCheck');
      if (draftChk) draftChk.checked = true;
      const bgmChk = document.getElementById('vmIsolateBgmCheck');
      if (bgmChk) bgmChk.checked = false;
      const expChk = document.getElementById('vmAutoExportCheck');
      if (expChk) expChk.checked = true;
      const resEl = document.getElementById('exportResolution');
      if (resEl) resEl.value = 'source';
      const qEl = document.getElementById('exportQualityPreset');
      if (qEl) qEl.value = 'fast';
      const encEl = document.getElementById('exportEncoder');
      if (encEl) encEl.value = 'auto';
      const ecoChk = document.getElementById('ecoCpuModeCheck');
      if (ecoChk) ecoChk.checked = Boolean(ecoMode);
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ECO_CPU_STORAGE_KEY, ecoMode ? '1' : '0');
        }
      } catch (_) {}
      if (typeof updateExportSizeEstimate === 'function') {
        try { updateExportSizeEstimate(); } catch (_) {}
      }
      syncVideoManagerOptionUi();
      if (toastText) showShortcutToast(toastText);
    }

    function applyVideoManagerEcoPreset() {
      applyVideoManagerModePreset({
        concurrency: '1',
        ecoMode: true,
        toastText: '🛡️ បានបើកម៉ូដម៉ាស៊ីនតូច (x1 ម្ដងមួយ · Fast + ទំហំដើម · សន្សំ CPU & RAM ~50%)!'
      });
    }

    function applyVideoManagerTurboPreset() {
      applyVideoManagerModePreset({
        concurrency: '4',
        ecoMode: false,
        toastText: '⚡ បានបើកម៉ូដលឿន Turbo (x4 ព្រមគ្នា · Fast Export GPU/CPU) — សមស្របសម្រាប់ 50-100 វីដេអូ!'
      });
    }

    function syncVideoManagerOptionUi() {
      const autoExport = document.getElementById('vmAutoExportCheck');
      const dirBtn = document.getElementById('vmExportDirBtn');
      const openBtn = document.getElementById('vmOpenExportDirBtn');
      const exportOn = !autoExport || Boolean(autoExport.checked);
      if (dirBtn) {
        dirBtn.style.display = 'inline-flex';
        dirBtn.style.opacity = exportOn ? '1' : '0.6';
      }
      if (openBtn) {
        openBtn.style.display = 'inline-flex';
      }
      renderVmStudioPresetStrip();
    }

    function onVideoManagerDragOver(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const c = document.getElementById('vmQueueContainer');
      if (c) c.classList.add('is-drag-over');
    }

    function onVideoManagerDragLeave(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const c = document.getElementById('vmQueueContainer');
      if (c) c.classList.remove('is-drag-over');
    }

    async function readDroppedEntryFiles(entry) {
      if (!entry) return [];
      if (entry.isFile) {
        return await new Promise(resolve => {
          entry.file(
            f => resolve(f ? [f] : []),
            () => resolve([])
          );
        });
      }
      if (entry.isDirectory && typeof entry.createReader === 'function') {
        const reader = entry.createReader();
        const collected = [];
        while (true) {
          const batch = await new Promise(resolve => reader.readEntries(resolve, () => resolve([])));
          if (!Array.isArray(batch) || batch.length === 0) break;
          for (const child of batch) {
            const sub = await readDroppedEntryFiles(child);
            collected.push(...sub);
          }
        }
        return collected;
      }
      return [];
    }

    async function onVideoManagerDrop(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const c = document.getElementById('vmQueueContainer');
      if (c) c.classList.remove('is-drag-over');
      let files = [];
      const dtItems = Array.from((e && e.dataTransfer && e.dataTransfer.items) || []);
      const hasEntries = dtItems.some(it => typeof it.webkitGetAsEntry === 'function');
      if (hasEntries) {
        for (const it of dtItems) {
          const entry = it.webkitGetAsEntry();
          if (entry) {
            files.push(...await readDroppedEntryFiles(entry));
          }
        }
      }
      if (files.length === 0) {
        files = Array.from((e && e.dataTransfer && e.dataTransfer.files) || []);
      }
      if (files.length === 0) return;
      const added = await ingestBrowserFilesToVideoManager(files);
      if (added > 0) {
        showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
      }
    }

    // ==================== UNIFIED SIDEBAR NAVIGATION & ADMIN ROUTER LOCK ====================
    let currentAppView = 'studio';
    const ROUTER_USER_LOCKED_STORAGE_KEY = 'eza_router_user_locked';
    const ROUTER_ADMIN_PIN_STORAGE_KEY = 'eza_router_admin_pin';
    const DEFAULT_ROUTER_ADMIN_PIN = '1688';
    let routerUserLockedState = false;
    let routerAdminPinState = DEFAULT_ROUTER_ADMIN_PIN;
    let systemIsPackagedClient = true;
    let pendingRouterPinModalMode = null;
    let pendingRouterPinResolve = null;
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
      const hubLockBtn = document.getElementById('hubRouterLockToggleBtn');
      if (hubLockBtn) {
        hubLockBtn.innerText = locked ? '🔓 បើកបង្ហាញ Router វិញ' : '🔒 លាក់ Router ពី User';
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
          const active = btnMode === normalized;
          if (btn.classList && typeof btn.classList.toggle === 'function') {
            btn.classList.toggle('active', active);
          }
          if (active && typeof btn.scrollIntoView === 'function') {
            try { btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (_) {}
          }
        });
      }
      const isCompactViewport = typeof window !== 'undefined' && Number(window.innerWidth) > 0 && window.innerWidth <= 860;
      if (isCompactViewport && typeof setPreviewDockTab === 'function') {
        if (normalized === 'split') {
          setPreviewDockTab(activePreviewDockTab, { collapsed: true });
        } else if (normalized === 'player') {
          setPreviewDockTab(activePreviewDockTab, { ensureOpen: true, collapsed: false });
        }
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => fitPreviewFrameSize());
      } else {
        fitPreviewFrameSize();
      }
      return normalized;
    }

    function jumpToActiveCue() {
      const targetIdx = (typeof activeSpeakingCueIdx === 'number' && activeSpeakingCueIdx >= 0 && activeSpeakingCueIdx < activeCues.length)
        ? activeSpeakingCueIdx
        : ((typeof selectedCueIndex === 'number' && selectedCueIndex >= 0 && selectedCueIndex < activeCues.length) ? selectedCueIndex : 0);
      if (!activeCues.length) {
        if (typeof showShortcutToast === 'function') showShortcutToast('មិនទាន់មានបន្ទាត់ Subtitle ទេ');
        return false;
      }
      const tr = document.querySelector(`tr[data-cue-index="${targetIdx}"]`);
      if (tr && typeof tr.scrollIntoView === 'function') {
        try {
          tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_) {
          tr.scrollIntoView();
        }
        return true;
      }
      const statusSel = document.getElementById('scriptStatusFilter');
      const searchInput = document.getElementById('scriptSearch');
      let refilterNeeded = false;
      if (statusSel && statusSel.value !== 'all') {
        statusSel.value = 'all';
        refilterNeeded = true;
      }
      if (searchInput && searchInput.value) {
        searchInput.value = '';
        refilterNeeded = true;
      }
      if (refilterNeeded) {
        renderTable();
        const retryTr = document.querySelector(`tr[data-cue-index="${targetIdx}"]`);
        if (retryTr && typeof retryTr.scrollIntoView === 'function') {
          try { retryTr.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { retryTr.scrollIntoView(); }
          return true;
        }
      }
      return false;
    }

    function applyRouterUserLockState(pinValue) {
      const pin = String(pinValue || '').trim() || getRouterAdminPin();
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
      showShortcutToast('🔒 បានលាក់ផ្ទាំង Router ពី User (ចុចផ្លាក PRO ៥ ដង ឬ Ctrl+Alt+R ដើម្បីបើកវិញ)');
      return true;
    }

    async function applyRouterAdminUnlockState() {
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

    function settlePendingRouterPinModal(result) {
      const resolver = pendingRouterPinResolve;
      pendingRouterPinResolve = null;
      pendingRouterPinModalMode = null;
      if (typeof resolver === 'function') resolver(Boolean(result));
    }

    function closeRouterAdminPinModal() {
      const modal = document.getElementById('routerAdminPinModal');
      if (modal && modal.style) modal.style.display = 'none';
      const errEl = document.getElementById('routerPinModalError');
      if (errEl) errEl.innerText = '';
      settlePendingRouterPinModal(false);
    }

    function openRouterAdminPinModal(mode = 'unlock', initialValue = '') {
      const modal = document.getElementById('routerAdminPinModal');
      const input = document.getElementById('routerPinModalInput');
      if (!modal || !input) return Promise.resolve(false);
      settlePendingRouterPinModal(false);
      pendingRouterPinModalMode = mode === 'lock' ? 'lock' : 'unlock';
      const isLockMode = pendingRouterPinModalMode === 'lock';
      const titleEl = document.getElementById('routerPinModalTitle');
      const descEl = document.getElementById('routerPinModalDesc');
      const errEl = document.getElementById('routerPinModalError');
      const submitBtn = document.getElementById('routerPinModalSubmitBtn');
      const resetBtn = document.getElementById('routerPinResetDefaultBtn');
      if (titleEl) {
        titleEl.innerText = isLockMode
          ? '🔒 កំណត់ Admin PIN សម្រាប់លាក់ Router'
          : '🔑 បញ្ចូល Admin PIN ដើម្បីបើក Router Manager';
      }
      if (descEl) {
        descEl.innerText = isLockMode
          ? 'កំណត់លេខកូដ Admin PIN សម្រាប់ដោះសោ Router Manager វិញ។'
          : 'សូមបញ្ចូលលេខកូដ Admin PIN ដើម្បីគ្រប់គ្រង Router Manager។';
      }
      if (submitBtn) submitBtn.innerText = isLockMode ? '🔒 លាក់ Router' : '🔓 បើក Router';
      if (resetBtn && resetBtn.style) {
        resetBtn.style.display = (!isLockMode && !systemIsPackagedClient) ? '' : 'none';
      }
      if (errEl) errEl.innerText = '';
      input.type = isLockMode ? 'text' : 'password';
      input.value = isLockMode ? String(initialValue || getRouterAdminPin()) : '';
      if (modal.style) modal.style.display = 'flex';
      setTimeout(() => {
        try { input.focus(); if (isLockMode && typeof input.select === 'function') input.select(); } catch (_) {}
      }, 20);
      return new Promise((resolve) => {
        pendingRouterPinResolve = resolve;
      });
    }

    async function submitRouterAdminPinModal() {
      const input = document.getElementById('routerPinModalInput');
      const errEl = document.getElementById('routerPinModalError');
      const modal = document.getElementById('routerAdminPinModal');
      const mode = pendingRouterPinModalMode || 'unlock';
      const entered = input ? String(input.value || '').trim() : '';

      if (mode === 'lock') {
        const pin = entered || getRouterAdminPin();
        if (modal && modal.style) modal.style.display = 'none';
        if (errEl) errEl.innerText = '';
        applyRouterUserLockState(pin);
        settlePendingRouterPinModal(true);
        return true;
      }

      const expectedPin = getRouterAdminPin();
      if (!entered || entered !== expectedPin) {
        if (errEl) {
          errEl.innerText = '❌ លេខកូដ Admin PIN មិនត្រឹមត្រូវទេ';
        }
        showShortcutToast('❌ លេខកូដ Admin PIN មិនត្រឹមត្រូវទេ');
        if (input && typeof input.focus === 'function') input.focus();
        return false;
      }

      if (modal && modal.style) modal.style.display = 'none';
      if (errEl) errEl.innerText = '';
      closeMobileConnectModal();
      settlePendingRouterPinModal(true);
      await applyRouterAdminUnlockState();
      return true;
    }

    async function resetRouterAdminPinToDefault() {
      if (systemIsPackagedClient) return false;
      routerAdminPinState = DEFAULT_ROUTER_ADMIN_PIN;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_ADMIN_PIN_STORAGE_KEY, DEFAULT_ROUTER_ADMIN_PIN);
        }
      } catch (_) {}
      const modal = document.getElementById('routerAdminPinModal');
      if (modal && modal.style) modal.style.display = 'none';
      const errEl = document.getElementById('routerPinModalError');
      if (errEl) errEl.innerText = '';
      closeMobileConnectModal();
      settlePendingRouterPinModal(true);
      await applyRouterAdminUnlockState();
      showShortcutToast('🔄 បានស្ដារ Admin PIN លំនាំដើម និងបើក Router Manager');
      return true;
    }

    function lockRouterForUserMode(customPin = '') {
      const explicitPin = String(customPin || '').trim();
      if (explicitPin) {
        return applyRouterUserLockState(explicitPin);
      }
      const modal = document.getElementById('routerAdminPinModal');
      const modalInput = document.getElementById('routerPinModalInput');
      if (modal && modalInput) {
        openRouterAdminPinModal('lock', getRouterAdminPin());
        return false;
      }
      let pin = '';
      if (typeof prompt === 'function') {
        const currentPin = getRouterAdminPin();
        const entered = prompt('🔒 កំណត់លេខកូដ Admin PIN សម្រាប់បើក Router វិញ (ចុច OK ដើម្បីប្រើលេខកូដនេះ)៖', currentPin);
        if (entered === null) return false;
        pin = String(entered || '').trim() || currentPin;
      }
      return applyRouterUserLockState(pin);
    }

    async function unlockRouterAdminMode(providedPin = '') {
      const expectedPin = getRouterAdminPin();
      let entered = String(providedPin || '').trim();
      if (!entered) {
        const modal = document.getElementById('routerAdminPinModal');
        const modalInput = document.getElementById('routerPinModalInput');
        if (modal && modalInput) {
          return openRouterAdminPinModal('unlock');
        }
        if (typeof prompt === 'function') {
          const raw = prompt('🔑 បញ្ចូលលេខកូដ Admin PIN ដើម្បីបើកគ្រប់គ្រង Router Manager៖', '');
          if (raw === null) return false;
          entered = String(raw || '').trim();
        }
      }
      if (entered !== expectedPin) {
        showShortcutToast('❌ លេខកូដ Admin PIN មិនត្រឹមត្រូវទេ');
        return false;
      }
      await applyRouterAdminUnlockState();
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
      const routerBatch = document.getElementById('routerBatchPanel');
      const vmPane = document.getElementById('videoManagerModal');
      const studioPane = document.getElementById('studioViewPane');
      if (routerPane) routerPane.hidden = true;
      if (routerAdd) routerAdd.hidden = true;
      if (routerBatch) routerBatch.hidden = true;
      if (vmPane && vmPane.style) vmPane.style.display = 'none';
      if (studioPane && studioPane.style) studioPane.style.display = 'flex';
      currentAppView = 'studio';
      setActiveSidebarNav('studio');
      if (typeof fitPreviewFrameSize === 'function') fitPreviewFrameSize();
      if (typeof renderTimeline === 'function') renderTimeline();
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
        const vmStt = document.getElementById('vmSttEngineSelect');
        if (srcEl && vmSrc) vmSrc.value = srcEl.value || 'auto';
        if (vmStt) vmStt.value = getSelectedSttEngine();
        if (vmVoice) {
          const singleChoice = getSelectedSingleVoice();
          vmVoice.innerHTML = renderVoiceOptionsHtml(singleChoice);
          vmVoice.value = singleChoice;
        }
      }
      syncVideoManagerOptionUi();
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
      if (currentAppView === 'studio') {
        if (typeof fitPreviewFrameSize === 'function') fitPreviewFrameSize();
        if (typeof renderTimeline === 'function') renderTimeline();
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
      vmBatchStartedAt = 0;
      vmLastBatchElapsedMs = 0;
      renderVideoManagerQueue();
    }

    function extractEpisodeNumber(fileName) {
      const stem = String(fileName || '').replace(/\.[^.]+$/, '').trim();
      const tagged = stem.match(/(?:ep|episode|e|ភាគ|第)[\s._-]*(\d{1,4})/i);
      if (tagged) return parseInt(tagged[1], 10);
      const paren = stem.match(/\((\d{1,4})\)/);
      if (paren) return parseInt(paren[1], 10);
      const cleaned = stem
        .replace(/\b(?:480|720|1080|1440|2160|4320)p\b/gi, ' ')
        .replace(/\b[248]k\b/gi, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ');
      const trailing = cleaned.match(/[._\s-](\d{1,4})\s*$/);
      if (trailing) return parseInt(trailing[1], 10);
      const match = cleaned.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }

    function sortVideoManagerQueueNaturally() {
      vmQueue.sort((a, b) => {
        const epA = extractEpisodeNumber(a.ep || a.name);
        const epB = extractEpisodeNumber(b.ep || b.name);
        if (epA !== null && epB !== null && epA !== epB) {
          return epA - epB;
        }
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
      renderVideoManagerQueue();
      showShortcutToast('🔃 បានតម្រៀបវីដេអូតាមលំដាប់លេខភាគ');
    }

    function appendBatchItems(rawItems) {
      if (!Array.isArray(rawItems) || rawItems.length === 0) return 0;
      const existingPaths = new Set(vmQueue.map(item => normalizePathKey(item.videoPath)).filter(Boolean));
      const existingBrowserKeys = new Set(
        vmQueue
          .filter(item => !item.videoPath)
          .map(item => `${String(item.name || '').trim().toLowerCase()}|${Number(item.fileSize || 0)}`)
      );
      let added = 0;

      for (const raw of rawItems) {
        if (!raw) continue;
        const videoPath = String(raw.videoPath || '').trim();
        const key = normalizePathKey(videoPath);
        if (key) {
          if (existingPaths.has(key)) continue;
          existingPaths.add(key);
        } else {
          const bName = String(raw.videoName || raw.name || '').trim().toLowerCase();
          const bSize = Number(raw.fileObj && raw.fileObj.size) || 0;
          const bKey = `${bName}|${bSize}`;
          if (bName && existingBrowserKeys.has(bKey)) continue;
          if (bName) existingBrowserKeys.add(bKey);
        }

        const srtPath = String(raw.srtPath || '').trim();
        const initialCues = Array.isArray(raw.cues) ? raw.cues : [];
        const hasLocalSrt = Boolean(raw.hasLocalSrt || (!srtPath && initialCues.length > 0));
        const draftInfo = raw.draftInfo || null;
        const extractedEpNum = extractEpisodeNumber(raw.ep || raw.videoName || raw.name || videoPath);
        const epLabel = raw.ep ? String(raw.ep) : (extractedEpNum !== null ? String(extractedEpNum) : '');
        vmQueue.push({
          id: vmNextItemId++,
          selected: true,
          name: String(raw.videoName || raw.name || extractFileName(videoPath) || 'Video'),
          ep: epLabel,
          epNum: extractedEpNum,
          videoPath,
          srtPath,
          hasLocalSrt,
          fileObj: raw.fileObj || null,
          fileSize: Number(raw.fileObj && raw.fileObj.size) || 0,
          cues: initialCues,
          draftInfo,
          status: 'pending',
          stageText: (srtPath || hasLocalSrt)
            ? 'រកឃើញ .srt · រង់ចាំ Auto'
            : (draftInfo && draftInfo.cueCount ? `រកឃើញ Draft (${draftInfo.cueCount}) · រង់ចាំ` : 'រង់ចាំ AI Transcribe + Auto'),
          progress: 0,
          error: '',
          bgmUrl: '',
          exportUrl: '',
          exportOutputFile: '',
          dubReady: false
        });
        added++;
      }

      vmQueue.sort((a, b) => {
        const epA = extractEpisodeNumber(a.ep || a.name);
        const epB = extractEpisodeNumber(b.ep || b.name);
        if (epA !== null && epB !== null && epA !== epB) {
          return epA - epB;
        }
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
      if (added > 0 && vmQueueFilterMode !== 'all') {
        setVideoManagerFilter('all');
      } else {
        renderVideoManagerQueue();
      }
      return added;
    }

    async function addDramaEpisodesToVideoManager(episodes) {
      const valid = Array.isArray(episodes) ? episodes.filter(ep => ep && ep.videoPath) : [];
      if (valid.length === 0) return 0;
      const paths = valid.map(ep => ep.videoPath);
      try {
        const res = await fetch(`${BACKEND_URL}/api/inspect-videos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: paths })
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.success && Array.isArray(data.items) && data.items.length > 0) {
          const epByPath = new Map(valid.map(ep => [normalizePathKey(ep.videoPath), ep]));
          return appendBatchItems(data.items.map(it => {
            const ep = epByPath.get(normalizePathKey(it.videoPath));
            return {
              ...it,
              ep: (ep && ep.ep) || '',
              name: (ep && (ep.video || ep.name)) || it.videoName,
              srtPath: it.srtPath || (ep && ep.srtPath) || ''
            };
          }));
        }
      } catch (_) {}
      return appendBatchItems(valid.map(ep => ({
        ep: ep.ep || '',
        name: ep.video || ep.name || extractFileName(ep.videoPath),
        videoPath: ep.videoPath,
        srtPath: ep.srtPath || ''
      })));
    }

    async function ingestBrowserFilesToVideoManager(rawFiles) {
      const files = Array.from(rawFiles || []);
      if (files.length === 0) return 0;

      const videoExtRe = /\.(mp4|mkv|mov|webm|m4v)$/i;
      const srtExtRe = /\.srt$/i;
      const diskVideoPaths = [];
      const browserVideos = [];
      const srtByStem = new Map();

      for (const file of files) {
        if (!file || !file.name) continue;
        if (srtExtRe.test(file.name)) {
          const stem = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
          if (stem && !srtByStem.has(stem)) srtByStem.set(stem, file);
          continue;
        }
        if (!videoExtRe.test(file.name)) continue;
        const diskPath = typeof file.path === 'string' && file.path ? file.path.trim() : '';
        if (diskPath) {
          diskVideoPaths.push(diskPath);
        } else {
          browserVideos.push(file);
        }
      }

      if (browserVideos.length > 0 && !isMobileOrRemoteClient() && typeof fetch === 'function') {
        try {
          const res = await fetch(`${BACKEND_URL}/api/resolve-local-files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: browserVideos.map(f => ({ name: f.name, size: Number(f.size) || 0 }))
            })
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data && data.success && data.resolvedPaths && typeof data.resolvedPaths === 'object') {
            const remaining = [];
            for (const file of browserVideos) {
              const lookupKey = `${String(file.name || '').toLowerCase()}|${Number(file.size) || 0}`;
              const resolvedDiskPath = data.resolvedPaths[lookupKey];
              if (resolvedDiskPath) {
                diskVideoPaths.push(resolvedDiskPath);
              } else {
                remaining.push(file);
              }
            }
            browserVideos.length = 0;
            browserVideos.push(...remaining);
          }
        } catch (_) {}
      }

      let added = 0;
      if (diskVideoPaths.length > 0) {
        added += await addVideoPathsToManager(diskVideoPaths);
      }

      if (browserVideos.length > 0) {
        const uploadItems = [];
        for (const file of browserVideos) {
          const stem = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
          const matchedSrt = srtByStem.get(stem) || null;
          let parsedCues = [];
          if (matchedSrt && typeof matchedSrt.text === 'function' && typeof parseSrtText === 'function') {
            try {
              parsedCues = normalizeCuesTiming(parseSrtText(await matchedSrt.text()));
            } catch (_) { parsedCues = []; }
          }
          uploadItems.push({
            videoName: file.name,
            videoPath: '',
            srtPath: '',
            hasLocalSrt: parsedCues.length > 0,
            cues: parsedCues,
            fileObj: file
          });
        }
        added += appendBatchItems(uploadItems);
      } else if (files.length > 0 && diskVideoPaths.length === 0) {
        showShortcutToast('⚠️ សូមជ្រើសឯកសារវីដេអូ (.mp4 / .mov / .mkv / .webm)!');
      }
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
      if (window.electronAPI && typeof window.electronAPI.openFilesDialog === 'function') {
        try {
          const paths = await window.electronAPI.openFilesDialog({
            filters: [
              { name: 'វីដេអូ & Subtitle (MP4, MKV, MOV, WebM, SRT)', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'srt'] },
              { name: 'ឯកសារទាំងអស់ (*.*)', extensions: ['*'] }
            ]
          });
          if (Array.isArray(paths) && paths.length > 0) {
            const added = await addVideoPathsToManager(paths);
            if (added > 0) showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
          }
          return;
        } catch (err) {
          console.warn('[VideoManager] Native multi-file dialog fallback:', err.message);
        }
      }

      const fileInput = document.getElementById('batchVideoFilesInput');
      if (fileInput) fileInput.click();
    }

    async function handleBatchVideoUpload(event) {
      const files = Array.from(event?.target?.files || []);
      if (event?.target) event.target.value = '';
      if (files.length === 0) return;
      const added = await ingestBrowserFilesToVideoManager(files);
      if (added > 0) {
        showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
      }
    }

    async function handleBatchFolderUpload(event) {
      const files = Array.from(event?.target?.files || []);
      if (event?.target) event.target.value = '';
      if (files.length === 0) return;
      const added = await ingestBrowserFilesToVideoManager(files);
      if (added > 0) {
        showShortcutToast(`📁 បានបន្ថែម ${added} វីដេអូពី Folder ទៅក្នុង Video Manager`);
      }
    }

    async function pickBatchVideoFolder() {
      if (isMobileOrRemoteClient()) {
        const folderInput = document.getElementById('batchFolderFilesInput');
        if (folderInput) folderInput.click();
        return;
      }
      try {
        const picked = await pickDirectoryWithExplorerFallback('eza_batch_folder');
        if (picked.canceled) return;
        let selectedFolder = picked.path || '';

        if (!selectedFolder && picked.dirHandle && typeof picked.dirHandle.values === 'function') {
          const handleFiles = [];
          for await (const entry of picked.dirHandle.values()) {
            if (entry && entry.kind === 'file' && typeof entry.getFile === 'function') {
              try {
                handleFiles.push(await entry.getFile());
              } catch (_) {}
            }
          }
          if (handleFiles.length > 0) {
            const added = await ingestBrowserFilesToVideoManager(handleFiles);
            if (added > 0) {
              showShortcutToast(`📁 បានបន្ថែម ${added} វីដេអូពី "${picked.dirHandle.name || 'Folder'}"`);
            }
            return;
          }
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
        const added = await addDramaEpisodesToVideoManager(episodes);
        showShortcutToast(`📁 បានបន្ថែម ${added} វីដេអូពី "${drama.name || selectedFolder}"`);
      } catch (err) {
        const folderInput = document.getElementById('batchFolderFilesInput');
        if (folderInput) {
          folderInput.click();
          return;
        }
        showShortcutToast('❌ មិនអាចស្កេន Folder បានទេ៖ ' + err.message);
      }
    }

    async function loadVideoManagerFromPathInput() {
      const input = document.getElementById('vmFolderPathInput');
      const rawPath = input ? String(input.value || '').trim().replace(/^["']+|["']+$/g, '') : '';
      if (!rawPath) {
        showShortcutToast('⚠️ សូមបញ្ចូល Path Folder ឬ File វីដេអូជាមុនសិន!');
        return;
      }
      if (/\.(mp4|mkv|mov|webm|m4v)$/i.test(rawPath)) {
        const added = await addVideoPathsToManager([rawPath]);
        if (added > 0) {
          if (input) input.value = '';
          showShortcutToast(`🎬 បានបន្ថែម ${added} វីដេអូទៅក្នុង Video Manager`);
        } else {
          showShortcutToast('⚠️ រកមិនឃើញឯកសារវីដេអូនៅ Path នេះទេ!');
        }
        return;
      }
      try {
        const scanRes = await fetch(`${BACKEND_URL}/api/scan-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: rawPath })
        });
        const drama = await scanRes.json().catch(() => null);
        if (!scanRes.ok || !drama) {
          throw new Error((drama && drama.error) || 'រកមិនឃើញ Folder នេះទេ');
        }
        const episodes = Array.isArray(drama.episodes) ? drama.episodes.filter(ep => ep.videoPath) : [];
        if (episodes.length === 0) {
          showShortcutToast('⚠️ មិនឃើញឯកសារវីដេអូក្នុង Folder នេះទេ។');
          return;
        }
        const added = await addDramaEpisodesToVideoManager(episodes);
        if (input) input.value = '';
        showShortcutToast(`📁 បានបន្ថែម ${added} វីដេអូពី "${drama.name || rawPath}"`);
      } catch (err) {
        showShortcutToast('❌ ' + err.message);
      }
    }

    async function loadCurrentDramaIntoVideoManager() {
      const episodes = Array.isArray(currentDramaInfo?.episodes)
        ? currentDramaInfo.episodes.filter(ep => ep.videoPath)
        : [];
      if (episodes.length > 0) {
        const added = await addDramaEpisodesToVideoManager(episodes);
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
      const sttEngine = normalizeClientSttEngine(document.getElementById('vmSttEngineSelect')?.value || getSelectedSttEngine());
      const ttsEngine = 'edge';
      const castMode = 'single';
      const fixedVoice = normalizeVoicePresetId(document.getElementById('vmDefaultVoiceSelect')?.value || getSelectedSingleVoice());
      const concurrency = Math.max(1, Math.min(6, parseInt(document.getElementById('vmConcurrencySelect')?.value || '4', 10) || 4));
      const generateTts = document.getElementById('vmGenerateTtsCheck')?.checked !== false;
      const saveDraft = document.getElementById('vmSaveDraftCheck')?.checked !== false;
      const isolateBgm = Boolean(document.getElementById('vmIsolateBgmCheck')?.checked);
      const autoExport = Boolean(document.getElementById('vmAutoExportCheck')?.checked);
      const rawAudioMode = isolateBgm && audioMixerState.origPct <= 0
        ? 'bgm_only'
        : (document.getElementById('exportAudioMode')?.value || 'duck');
      const exportAudioMode = !generateTts && rawAudioMode === 'dub_only' ? 'original' : rawAudioMode;
      const fastCopy = document.getElementById('exportVideoModeSelect')?.value === 'copy';
      const exportSnapshot = {
        subtitleMaskPayload: getSubtitleAndMaskExportPayload(),
        autoFitTiming: document.getElementById('exportAutoFitCheck')?.checked !== false,
        audioMixPayload: getAudioMixExportPayload(exportAudioMode),
        resolution: document.getElementById('exportResolution')?.value || 'source',
        qualityPreset: document.getElementById('exportQualityPreset')?.value || 'balanced',
        encoder: document.getElementById('exportEncoder')?.value || 'auto',
        fastCopy,
        ecoCpu: isEcoCpuModeActive(),
        burnSubtitles: !fastCopy,
        outputDir: getCustomExportOutputDir(),
        sponsorPayload: getSponsorExportPayload(),
        copyrightPayload: getCopyrightExportPayload()
      };
      return {
        sourceLang,
        targetLang,
        ttsEngine,
        castMode,
        fixedVoice,
        concurrency,
        generateTts,
        saveDraft,
        isolateBgm,
        autoExport,
        sttEngine,
        exportSnapshot
      };
    }

    function stopVideoManagerBatch() {
      if (!vmIsRunning) return;
      vmAbortRequested = true;
      if (typeof fetch === 'function') {
        fetch(`${BACKEND_URL}/api/export/cancel`, { method: 'POST' }).catch(() => {});
      }
      showShortcutToast('⏹️ កំពុងស្នើសុំបញ្ឈប់ក្រោយបញ្ចប់ជំហានបច្ចុប្បន្ន...');
    }

    async function openVideoManagerItemInStudio(itemId) {
      const item = vmQueue.find(entry => entry.id === itemId);
      if (!item) return;

      const reqSeq = ++videoSelectionSeq;
      if (activeUploadAbortController) {
        try { activeUploadAbortController.abort(); } catch (_) {}
        activeUploadAbortController = null;
      }

      let loadedCues = Array.isArray(item.cues) && item.cues.length > 0 ? item.cues.map(c => ({ ...c })) : [];
      if (loadedCues.length === 0 && item.srtPath) {
        try {
          const res = await fetch(`${BACKEND_URL}/api/load-srt-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: item.srtPath })
          });
          const data = await res.json();
          if (reqSeq !== videoSelectionSeq) return;
          if (res.ok && data.success && Array.isArray(data.cues)) {
            loadedCues = data.cues;
          } else if (typeof showShortcutToast === 'function') {
            showShortcutToast('⚠️ មិនអាចផ្ទុកឯកសារ SRT ពី Video Manager បានទេ');
          }
        } catch (err) {
          if (reqSeq !== videoSelectionSeq) return;
          console.warn('[VideoManager] Open cue load failed:', err.message);
          if (typeof showShortcutToast === 'function') {
            showShortcutToast('⚠️ ផ្ទុក SRT បរាជ័យ៖ ' + err.message);
          }
        }
      }
      if (reqSeq !== videoSelectionSeq) return;

      if (currentDramaInfo && Array.isArray(currentDramaInfo.episodes) && item.videoPath) {
        const matchedEp = currentDramaInfo.episodes.find(ep => normalizePathKey(ep.videoPath) === normalizePathKey(item.videoPath));
        if (matchedEp) {
          loadDramaData(currentDramaInfo, matchedEp, loadedCues);
          closeVideoManagerModal();
          return;
        }
      }

      if (loadedCues.length === 0 && !item.srtPath && item.videoPath && item.draftInfo && item.draftInfo.draftKey) {
        try {
          const dRes = await fetch(`${BACKEND_URL}/api/drafts/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draftKey: item.draftInfo.draftKey })
          });
          const dData = await dRes.json().catch(() => null);
          if (dRes.ok && dData && dData.success && dData.draft && Array.isArray(dData.draft.cues)) {
            loadedCues = dData.draft.cues;
          }
        } catch (_) {}
      }
      if (reqSeq !== videoSelectionSeq) return;

      clearDubAndPlaybackState();
      cachedAudioMap.clear();
      cachedAudioUrls.clear();
      undoStack = [];
      redoStack = [];
      currentVideoPath = item.videoPath || '';
      currentSrtPath = item.srtPath || '';
      currentDramaInfo = null;
      lastSelectedVideoFile = item.fileObj || null;
      if (currentVideoPath) {
        setVideoSource(`${BACKEND_URL}/api/video-stream?file=${encodeURIComponent(currentVideoPath)}`);
      } else if (item.fileObj && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blobUrl = URL.createObjectURL(item.fileObj);
        activeObjectUrl = blobUrl;
        setVideoSource(blobUrl);
      } else {
        setVideoSource('');
      }
      activeCues = normalizeCuesTiming(loadedCues);
      normalizeActiveCuesForCastMode(activeCues, getActiveCastMode(), getSelectedSingleVoice());
      const titleTag = document.getElementById('currentDramaTitleTag');
      const trackTitle = document.getElementById('videoTrackTitle');
      if (titleTag) titleTag.innerText = item.name || extractFileName(currentVideoPath);
      if (trackTitle) trackTitle.innerText = item.name || extractFileName(currentVideoPath);
      closeVideoManagerModal();
      renderTable();
      renderTimeline();
      checkAllAudioCache();
      updateTranslationState();
      if (typeof updateVoiceReadyBadge === 'function') updateVoiceReadyBadge();
      if (currentVideoPath) syncCachedBgmStemForVideo(currentVideoPath);
    }

    function updateVmRowDomInPlace(item) {
      const container = document.getElementById('vmQueueContainer');
      if (!container || typeof container.querySelector !== 'function') return false;
      const row = container.querySelector(`.vm-row[data-vm-row-id="${item.id}"]`);
      if (!row) return false;
      const pct = Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0)));
      if (typeof row.setAttribute === 'function') {
        row.setAttribute('data-status', String(item.status || 'pending'));
      }
      const pill = row.querySelector('.vm-status-pill');
      if (pill) {
        pill.className = item.status === 'done'
          ? 'vm-pill done vm-status-pill'
          : (item.status === 'running' || item.status === 'error'
            ? 'vm-pill warn vm-status-pill'
            : 'vm-pill vm-status-pill');
        if (pill.style) {
          pill.style.color = item.status === 'error' ? '#fca5a5' : '';
          pill.style.borderColor = item.status === 'error' ? '#ef4444' : '';
        }
        pill.innerText = item.status === 'done'
          ? '✅ រួចរាល់'
          : (item.status === 'running'
            ? `⚡ កំពុងធ្វើ (${pct}%)`
            : (item.status === 'error' ? '❌ បរាជ័យ' : '⏳ នៅសល់'));
      }
      const statusEl = row.querySelector('.vm-status-text');
      if (statusEl) {
        const msg = item.error ? ('❌ ' + item.error) : (item.stageText || 'រង់ចាំ Auto');
        statusEl.innerText = msg;
        if (typeof statusEl.setAttribute === 'function') statusEl.setAttribute('title', msg);
      }
      const barFill = row.querySelector('.vm-mini-bar-fill');
      if (barFill && barFill.style) {
        barFill.style.width = `${pct}%`;
      }
      updateVideoManagerProgressUi();
      return true;
    }

    function patchVmRow(item, stageText, progress, status = 'running') {
      const prevStatus = item.status;
      item.status = status;
      if (status === 'running' && !item.startedAt) {
        item.startedAt = Date.now();
        item.finishedAt = 0;
        item.elapsedMs = 0;
      } else if ((status === 'done' || status === 'error') && item.startedAt) {
        item.finishedAt = Date.now();
        item.elapsedMs = Math.max(0, item.finishedAt - item.startedAt);
      }
      if (stageText !== undefined) item.stageText = stageText;
      if (typeof progress === 'number') item.progress = progress;

      const statusChanged = prevStatus !== status;
      const needsStructuralRender = statusChanged && (status === 'done' || status === 'error' || vmQueueFilterMode !== 'all');
      if (!needsStructuralRender && updateVmRowDomInPlace(item)) {
        return;
      }
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

      if (cues.length === 0 && !item.srtPath && item.videoPath && item.draftInfo && item.draftInfo.draftKey) {
        patchVmRow(item, '💾 កំពុងផ្ទុកពី Draft...', 20);
        try {
          const dRes = await fetch(`${BACKEND_URL}/api/drafts/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draftKey: item.draftInfo.draftKey })
          });
          const dData = await dRes.json().catch(() => null);
          if (dRes.ok && dData && dData.success && dData.draft && Array.isArray(dData.draft.cues) && dData.draft.cues.length > 0) {
            cues = normalizeCuesTiming(dData.draft.cues);
            patchVmRow(item, `📄 ផ្ទុកពី Draft (${cues.length} បន្ទាត់)`, 36);
          }
        } catch (_) {}
      }

      if (cues.length === 0 && !item.srtPath && item.videoPath) {
        patchVmRow(item, '🔍 កំពុងស្វែងរក .SRT ជាប់វីដេអូ...', 24);
        const companionSrt = await findCompanionSrtFile(item.videoPath);
        if (companionSrt) {
          item.srtPath = companionSrt.filePath;
          cues = normalizeCuesTiming(companionSrt.cues);
          patchVmRow(item, `📄 រកឃើញ SRT ស្វ័យប្រវត្តិ (${companionSrt.fileName})`, 27);
        }
      }

      if (cues.length === 0) {
        patchVmRow(item, '🎙️ AI កំពុងស្តាប់សំឡេង & កាត់បន្ទាត់... (3%)', 28);
        const vmSpeechJobId = `vm_${item.id || 'x'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        let vmPollBusy = false;
        let vmPollErrs = 0;
        let vmSpeechTimer = setInterval(async () => {
          if (vmPollBusy) return;
          vmPollBusy = true;
          try {
            const pUrl = `${BACKEND_URL}/api/translation/speech-progress?jobId=${encodeURIComponent(vmSpeechJobId)}&videoPath=${encodeURIComponent(item.videoPath || '')}`;
            const pRes = await fetch(pUrl);
            if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
            const pData = await pRes.json();
            vmPollErrs = 0;
            if (pData && pData.running) {
              const mapped = 28 + Math.round(((pData.percent || 0) / 100) * 20);
              patchVmRow(item, `🎙️ ${pData.statusText || 'កំពុងចាប់សំឡេង AI...'}`, mapped);
            }
          } catch (_) {
            vmPollErrs++;
            if (vmPollErrs >= 8 && vmSpeechTimer) {
              clearInterval(vmSpeechTimer);
              vmSpeechTimer = null;
            }
          } finally {
            vmPollBusy = false;
          }
        }, 1200);
        try {
          const { res: speechRes, data: speechData } = await postJsonWithTunnelRecovery(
            `${BACKEND_URL}/api/translation/auto-detect-speech`,
            {
              jobId: vmSpeechJobId,
              videoPath: item.videoPath,
              sourceLang: config.sourceLang,
              sttEngine: config.sttEngine || getSelectedSttEngine(),
              isolateVocals: true,
              castMode: config.castMode,
              fixedVoice: config.fixedVoice
            },
            { maxRetries: 4, retryDelayMs: 3500 }
          );
          if (!speechRes.ok || !speechData.success || !Array.isArray(speechData.cues) || speechData.cues.length === 0) {
            throw new Error(speechData.error || 'AI មិនអាចចាប់សំឡេងក្នុងវីដេអូនេះបានទេ');
          }
          if (speechData.activeChunkCount >= 4 && speechData.failedChunkCount >= Math.ceil(speechData.activeChunkCount * 0.6)) {
            throw new Error(`ចាប់សំឡេងខ្វះដុំ (${speechData.failedChunkCount}/${speechData.activeChunkCount} ដុំបរាជ័យបណ្ដាញ)`);
          }
          cues = normalizeCuesTiming(speechData.cues);
          if (speechData.failedChunkCount > 0) {
            patchVmRow(item, `⚠️ រកឃើញ ${cues.length} បន្ទាត់ (${speechData.failedChunkCount} ដុំបរាជ័យ)`, 49);
          }
        } finally {
          clearInterval(vmSpeechTimer);
        }
      }

      item.cues = cues;
      checkAbort();

      if (cuesNeedTranslation(cues, config.targetLang)) {
        patchVmRow(item, `🌐 កំពុងបកប្រែ (${cues.length} បន្ទាត់)...`, 50);
        const rawSpeedMode = getTranslationSpeedMode();
        const speedMode = (Number(config.batchCount) >= 10 && rawSpeedMode === 'auto') ? 'fast' : rawSpeedMode;
        const { res: trRes, data: trData } = await postJsonWithTunnelRecovery(
          `${BACKEND_URL}/api/translation/translate-cues`,
          {
            cues,
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            videoPath: item.videoPath,
            castMode: config.castMode,
            fixedVoice: config.fixedVoice,
            speedMode
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
              fixedVoice: config.fixedVoice,
              speedMode
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
          .map((cue, idx) => (isCueSpeakableForTts(cue, config.targetLang) ? {
            index: idx,
            text: String(cue.translated || cue.text || '').trim(),
            voice: normalizeVoicePresetId(cue.voice),
            engine: config.ttsEngine
          } : null))
          .filter(Boolean);

        if (ttsItems.length > 0) {
          const batchChunkSize = 64;
          let ttsDone = 0;
          let ttsSucceeded = 0;

          const perVideoTtsConcurrency = Math.max(6, Math.min(20, Math.floor(20 / Math.max(1, config.concurrency || 2))));
          for (let start = 0; start < ttsItems.length; start += batchChunkSize) {
            checkAbort();
            const slice = ttsItems.slice(start, start + batchChunkSize);
            patchVmRow(item, `🎙️ បង្កើតសំឡេង ${ttsDone}/${ttsItems.length}...`, 60 + Math.round((ttsDone / ttsItems.length) * 28));
            const batchRes = await synthesizeTtsBatchSlice(slice, {
              concurrency: perVideoTtsConcurrency,
              strictVoice: true,
              fixedVoice: config.castMode === 'single' ? config.fixedVoice : ''
            });
            ttsDone += slice.length;
            ttsSucceeded += batchRes.count;
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
          const runExportJob = vmExportChain.catch(() => {}).then(async () => {
            if (vmAbortRequested) {
              throw new Error('បានបញ្ឈប់ដោយអ្នកប្រើ');
            }
            patchVmRow(item, '🎬 កំពុង Export វីដេអូ MP4...', 97);
            const snap = config.exportSnapshot || null;
            const rawVmAudioMode = config.isolateBgm && audioMixerState.origPct <= 0
              ? 'bgm_only'
              : (document.getElementById('exportAudioMode')?.value || 'duck');
            const safeVmAudioMode = !config.generateTts && rawVmAudioMode === 'dub_only' ? 'original' : rawVmAudioMode;
            const expBody = snap ? {
              videoPath: item.videoPath,
              cues,
              duration: Number(item.durationSec) || 0,
              ...snap.subtitleMaskPayload,
              includeDubAudio: config.generateTts,
              autoGenerateMissingTts: config.generateTts,
              autoFitTiming: snap.autoFitTiming,
              ...snap.audioMixPayload,
              ttsEngine: config.ttsEngine,
              castMode: config.castMode,
              fixedVoice: config.fixedVoice,
              ...(currentCustomVoicePitch !== null ? { voicePitch: currentCustomVoicePitch } : {}),
              ...(currentCustomVoiceRate !== null ? { voiceRate: currentCustomVoiceRate } : {}),
              strictVoice: true,
              resolution: snap.resolution,
              qualityPreset: snap.qualityPreset,
              encoder: snap.encoder,
              fastCopy: snap.fastCopy,
              ecoCpu: Boolean(snap.ecoCpu),
              burnSubtitles: snap.burnSubtitles,
              outputDir: snap.outputDir,
              ...snap.sponsorPayload,
              antiCopyright: snap.copyrightPayload
            } : {
              videoPath: item.videoPath,
              cues,
              duration: Number(item.durationSec) || 0,
              ...getSubtitleAndMaskExportPayload(),
              includeDubAudio: config.generateTts,
              autoGenerateMissingTts: config.generateTts,
              autoFitTiming: document.getElementById('exportAutoFitCheck')?.checked !== false,
              ...getAudioMixExportPayload(safeVmAudioMode),
              ttsEngine: config.ttsEngine,
              castMode: config.castMode,
              fixedVoice: config.fixedVoice,
              ...(currentCustomVoicePitch !== null ? { voicePitch: currentCustomVoicePitch } : {}),
              ...(currentCustomVoiceRate !== null ? { voiceRate: currentCustomVoiceRate } : {}),
              strictVoice: true,
              resolution: document.getElementById('exportResolution')?.value || 'source',
              qualityPreset: document.getElementById('exportQualityPreset')?.value || 'balanced',
              encoder: document.getElementById('exportEncoder')?.value || 'auto',
              fastCopy: document.getElementById('exportVideoModeSelect')?.value === 'copy',
              ecoCpu: isEcoCpuModeActive(),
              burnSubtitles: document.getElementById('exportVideoModeSelect')?.value !== 'copy' && (typeof isSubtitleVisible === 'boolean' ? isSubtitleVisible : true),
              outputDir: getCustomExportOutputDir(),
              ...getSponsorExportPayload(),
              antiCopyright: getCopyrightExportPayload()
            };
            const vmExportRunId = ++activeExportRunId;
            const expRes = await fetch(`${BACKEND_URL}/api/export/video`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(expBody)
            });
            let expData = null;
            try {
              expData = await expRes.json();
            } catch (parseErr) {
              const st = Number(expRes && expRes.status) || 0;
              if (st === 524 || st === 504 || st === 503 || st === 522 || st >= 500) {
                expData = await waitForExportCompletionViaProgress(null, null, vmExportRunId);
              } else {
                throw parseErr;
              }
            }
            if (!expData || !expData.success || (!expRes.ok && !expData.outputFile)) {
              throw new Error((expData && expData.error) || 'Export MP4 បរាជ័យ');
            }
            item.exportOutputFile = expData.outputFile || '';
            item.exportUrl = expData.downloadUrl
              ? resolveBackendUrl(expData.downloadUrl)
              : (expData.outputFile
                ? appendAccessTokenToUrl(`${BACKEND_URL}/api/export/download?file=${encodeURIComponent(expData.outputFile)}`)
                : '');
            syncVideoManagerOptionUi();
          });
          vmExportChain = runExportJob.catch(() => {});
          runExportJob.then(resolve, reject);
        });
      }
      checkAbort();

      const finalBadge = item.exportUrl ? '✅ រួចរាល់ + MP4!' : '✅ បកប្រែ + សំឡេងរួចរាល់!';
      patchVmRow(item, finalBadge, 100, 'done');
    }

    async function startVideoManagerBatch(customQueue = null) {
      if (vmIsRunning) return;
      if (isExportingNow) {
        showShortcutToast('⏳ Studio កំពុង Export វីដេអូ — សូមរង់ចាំបន្តិចសិន');
        return;
      }
      let runQueue;
      if (Array.isArray(customQueue)) {
        runQueue = customQueue.filter(Boolean);
      } else {
        const targets = vmQueue.filter(item => item.selected && item.status !== 'done');
        runQueue = targets.length > 0 ? targets : vmQueue.filter(item => item.selected);
      }
      if (runQueue.length === 0) {
        showShortcutToast('⚠️ សូមធីកជ្រើសវីដេអូយ៉ាងតិច ១ ដើម្បីដំណើរការ!');
        return;
      }

      const config = readVideoManagerConfig();
      const runConfig = { ...config, batchCount: runQueue.length };
      vmIsRunning = true;
      vmAbortRequested = false;
      vmBatchStartedAt = Date.now();
      vmLastBatchElapsedMs = 0;
      vmActiveRunTotal = runQueue.length;
      vmActiveRunConcurrency = config.concurrency || 2;
      if (vmElapsedTimerId) {
        clearInterval(vmElapsedTimerId);
        vmElapsedTimerId = null;
      }
      if (typeof setInterval === 'function') {
        vmElapsedTimerId = setInterval(() => {
          if (!vmIsRunning) return;
          updateVmLiveTimersUi();
        }, 1000);
      }
      try {
        runQueue.forEach(item => {
          item.status = 'pending';
          item.error = '';
          item.stageText = '⏳ រង់ចាំជួរព្រមគ្នា...';
          item.progress = 0;
          item.startedAt = 0;
          item.finishedAt = 0;
          item.elapsedMs = 0;
        });
        renderVideoManagerQueue();

        let cursor = 0;
        const poolSize = Math.min(config.concurrency, runQueue.length);
        const workers = Array.from({ length: poolSize }, async () => {
          while (cursor < runQueue.length && !vmAbortRequested) {
            const item = runQueue[cursor++];
            if (!item) break;
            try {
              await processVideoManagerItem(item, runConfig);
            } catch (err) {
              item.error = err.message || 'បរាជ័យ';
              patchVmRow(item, item.error, item.progress || 0, vmAbortRequested ? 'pending' : 'error');
            }
          }
        });

        await Promise.all(workers);
      } finally {
        if (vmElapsedTimerId) {
          clearInterval(vmElapsedTimerId);
          vmElapsedTimerId = null;
        }
        if (vmBatchStartedAt > 0) {
          vmLastBatchElapsedMs = Math.max(0, Date.now() - vmBatchStartedAt);
        }
        vmIsRunning = false;
        renderVideoManagerQueue();
      }

      const completed = runQueue.filter(item => item.status === 'done').length;
      const failed = runQueue.filter(item => item.status === 'error').length;
      const elapsedNote = vmLastBatchElapsedMs > 0 ? ` (${formatVmDurationKhmer(vmLastBatchElapsedMs)})` : '';
      const toastMsg = vmAbortRequested
        ? `⏹️ បានបញ្ឈប់! សម្រេចបាន ${completed}/${runQueue.length} វីដេអូ`
        : (failed === 0
          ? `✅ Video Manager: បានបញ្ចប់គ្រប់ ${completed} វីដេអូ${elapsedNote} ដោយជោគជ័យ!`
          : `⚠️ Video Manager: សម្រេច ${completed}/${runQueue.length} · បរាជ័យ ${failed}`);
      showShortcutToast(toastMsg);
      const bottomEl = document.getElementById('bottomStatusMsg');
      if (bottomEl) bottomEl.innerText = toastMsg;
    }

    async function runSingleVideoManagerItem(itemId) {
      if (vmIsRunning) return false;
      const item = vmQueue.find(entry => entry.id === itemId);
      if (!item) return false;
      item.selected = true;
      item.status = 'pending';
      item.error = '';
      await startVideoManagerBatch([item]);
      return item.status === 'done';
    }

    async function retryFailedVideoManagerItems() {
      if (vmIsRunning) return false;
      const failedItems = vmQueue.filter(item => item.status === 'error');
      if (failedItems.length === 0) {
        showShortcutToast('✅ មិនមានវីដេអូដែលបរាជ័យទេ!');
        return false;
      }
      failedItems.forEach(item => {
        item.selected = true;
        item.status = 'pending';
        item.error = '';
      });
      await startVideoManagerBatch(failedItems);
      return true;
    }

    async function downloadOrOpenAllCompletedVideos() {
      const doneItems = vmQueue.filter(item => item && item.status === 'done' && (item.exportUrl || item.exportOutputFile));
      if (doneItems.length === 0) {
        const anyRunning = vmQueue.some(item => item && item.status === 'running');
        if (anyRunning) {
          showShortcutToast('⏳ វីដេអូកំពុងដំណើរការ — សូមរង់ចាំឲ្យចប់រួចរាល់សិន!');
        } else {
          showShortcutToast('⚠️ មិនទាន់មានវីដេអូដែល Export រួចរាល់នៅឡើយទេ!');
        }
        return;
      }

      const isDesktopElectron = Boolean(window.electronAPI && typeof window.electronAPI.openExportFolder === 'function');
      if (isDesktopElectron && !isMobileOrRemoteClient()) {
        try {
          await openExportFolder(getCustomExportOutputDir());
          showShortcutToast(`📁 បានបើក Folder MP4 ទាំងអស់ (${doneItems.length} វីដេអូ) ក្នុង Explorer!`);
          return;
        } catch (_) {}
      }

      let count = 0;
      for (const item of doneItems) {
        if (item.exportUrl) {
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = resolveBackendUrl(item.exportUrl);
            a.download = item.name ? (item.name.replace(/\.[^.]+$/, '') + '_KhmerDub.mp4') : 'Video_KhmerDub.mp4';
            if (document.body && typeof document.body.appendChild === 'function') {
              document.body.appendChild(a);
              a.click();
              a.remove();
            } else if (typeof a.click === 'function') {
              a.click();
            }
          }, count * 350);
          count++;
        }
      }
      if (count > 0) {
        showShortcutToast(`⬇️ កំពុងទាញយក ${count} វីដេអូ MP4...`);
      } else {
        await openExportFolder(getCustomExportOutputDir());
      }
    }

    async function openSingleExportItem(itemId) {
      const item = vmQueue.find(entry => entry.id === itemId);
      if (!item) return;
      if (item.exportOutputFile) {
        try {
          await openExportFolder(item.exportOutputFile);
          return;
        } catch (_) {}
      }
      if (item.exportUrl) {
        const a = document.createElement('a');
        a.href = resolveBackendUrl(item.exportUrl);
        a.download = item.name ? (item.name.replace(/\.[^.]+$/, '') + '_KhmerDub.mp4') : 'Video_KhmerDub.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }

    function filterTable() {
      renderTable();
    }

    // Keyboard Shortcuts Handler
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const pinModal = document.getElementById('routerAdminPinModal');
        if (pinModal && pinModal.style && pinModal.style.display === 'flex') {
          closeRouterAdminPinModal();
          return;
        }
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

      // Ctrl+Alt+R (Chrome-safe) or Ctrl+Shift+R (Electron): Admin Router Unlock / Toggle
      if ((e.ctrlKey || e.metaKey) && (e.altKey || e.shiftKey) && (e.key === 'r' || e.key === 'R')) {
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
      if (typeof renderCustomTextOverlayUi === 'function') renderCustomTextOverlayUi();
      if (typeof initCustomTextOverlayDrag === 'function') initCustomTextOverlayDrag();
      renderSubtitleMaskPreview();
      initSubtitleMaskInteraction();
      initSubtitleBoxInteraction();
      initPreviewStageObserver();
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
      clearTimeout(cloneRecordStopTimeout);
      if (cloneMediaRecorder && cloneMediaRecorder.state === 'recording') {
        try {
          cloneMediaRecorder.onstop = null;
          if (cloneMediaRecorder.stream) cloneMediaRecorder.stream.getTracks().forEach(t => t.stop());
          cloneMediaRecorder.stop();
        } catch (_) {}
      }
      cloneMediaRecorder = null;
      const recBtn = document.getElementById('btnRecordCloneMic');
      if (recBtn) recBtn.innerText = '🎙️ ថតសំឡេងតាម Mic';
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
      if (!confirm('ប្រព័ន្ធនឹងទាញយកម៉ូដែល Seed-VC AI (~3–4GB) មករក្សាទុកក្នុងម៉ាស៊ីន ដើម្បីប្រើ Clone សំឡេងដោយផ្ទាល់ (ឥតគិតថ្លៃ)។ តើអ្នកចង់ចាប់ផ្ដើមដំឡើងឥឡូវនេះទេ?')) {
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
      if (isOpeningCloneMic) {
        isOpeningCloneMic = false;
        if (btn) btn.innerText = '🎙️ ថតសំឡេងតាម Mic';
        if (statusEl) statusEl.innerText = 'បានបោះបង់ការបើក Mic។';
        return;
      }
      if (cloneMediaRecorder && cloneMediaRecorder.state === 'recording') {
        clearTimeout(cloneRecordStopTimeout);
        try { cloneMediaRecorder.stop(); } catch (_) {}
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return alert('Browser/Device នេះមិនគាំទ្រការថតតាម Mic ទេ។');
      }
      isOpeningCloneMic = true;
      let micStream = null;
      try {
        if (btn) btn.innerText = '⏳ កំពុងបើក Mic...';
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!isOpeningCloneMic) {
          micStream.getTracks().forEach(t => t.stop());
          return;
        }
        isOpeningCloneMic = false;
        cloneRecordedChunks = [];
        const recorder = new MediaRecorder(micStream);
        cloneMediaRecorder = recorder;
        const stopTracks = () => {
          if (micStream) {
            micStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
            micStream = null;
          }
        };
        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) cloneRecordedChunks.push(ev.data);
        };
        recorder.onerror = () => {
          clearTimeout(cloneRecordStopTimeout);
          stopTracks();
          if (cloneMediaRecorder === recorder) cloneMediaRecorder = null;
          if (btn) btn.innerText = '🎙️ ថតសំឡេងតាម Mic';
          if (statusEl) statusEl.innerText = '❌ កំហុសការថត Mic។';
        };
        recorder.onstop = async () => {
          clearTimeout(cloneRecordStopTimeout);
          stopTracks();
          const mimeType = recorder.mimeType || 'audio/webm';
          if (cloneMediaRecorder === recorder) cloneMediaRecorder = null;
          if (btn) btn.innerText = '🎙️ ថតសំឡេងតាម Mic';
          const blob = new Blob(cloneRecordedChunks, { type: mimeType });
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
        recorder.start();
        if (btn) btn.innerText = '⏹️ បញ្ឈប់ការថត (និយាយ 5–15s)';
        if (statusEl) statusEl.innerText = '🔴 កំពុងថតសំឡេង (អតិបរមា 20 វិនាទី)...';
        cloneRecordStopTimeout = setTimeout(() => {
          if (recorder && recorder.state === 'recording') {
            recorder.stop();
          }
        }, 20000);
      } catch (err) {
        isOpeningCloneMic = false;
        if (micStream) {
          micStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        }
        cloneMediaRecorder = null;
        if (btn) btn.innerText = '🎙️ ថតសំឡេងតាម Mic';
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
    const _QR_GF_EXP = new Uint8Array(512);
    const _QR_GF_LOG = new Uint8Array(256);
    (() => {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        _QR_GF_EXP[i] = x;
        _QR_GF_EXP[i + 255] = x;
        _QR_GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
    })();

    function _qrGfMul(a, b) {
      return (a === 0 || b === 0) ? 0 : _QR_GF_EXP[_QR_GF_LOG[a] + _QR_GF_LOG[b]];
    }

    function _qrRsRemainder(dataBytes, ecCount) {
      let gen = [1];
      for (let i = 0; i < ecCount; i++) {
        const next = new Array(gen.length + 1).fill(0);
        const factor = _QR_GF_EXP[i];
        for (let j = 0; j < gen.length; j++) {
          next[j] ^= gen[j];
          next[j + 1] ^= _qrGfMul(gen[j], factor);
        }
        gen = next;
      }
      const res = new Uint8Array(ecCount);
      for (let i = 0; i < dataBytes.length; i++) {
        const factor = dataBytes[i] ^ res[0];
        for (let k = 0; k < ecCount - 1; k++) res[k] = res[k + 1];
        res[ecCount - 1] = 0;
        if (factor !== 0) {
          for (let j = 0; j < ecCount; j++) {
            res[j] ^= _qrGfMul(gen[j + 1], factor);
          }
        }
      }
      return Array.from(res);
    }

    function encodeQrMatrix(textStr) {
      const text = String(textStr || 'http://127.0.0.1:3001');
      let utf8Bytes;
      if (typeof TextEncoder !== 'undefined') {
        utf8Bytes = Array.from(new TextEncoder().encode(text));
      } else {
        utf8Bytes = [];
        for (let i = 0; i < text.length; i++) {
          let code = text.charCodeAt(i);
          if (code < 0x80) utf8Bytes.push(code);
          else if (code < 0x800) utf8Bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const lo = text.charCodeAt(++i);
            const cp = 0x10000 + (((code - 0xd800) << 10) | (lo - 0xdc00));
            utf8Bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          } else {
            utf8Bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
          }
        }
      }
      // ISO/IEC 18004 Versions 1-9, ECC Level L: [ver, dataCodewords, ecPerBlock, blocks, alignCoords]
      const SPECS = [
        [1, 19, 7, 1, []],
        [2, 34, 10, 1, [6, 18]],
        [3, 55, 15, 1, [6, 22]],
        [4, 80, 20, 1, [6, 26]],
        [5, 108, 26, 1, [6, 30]],
        [6, 136, 18, 2, [6, 34]],
        [7, 156, 20, 2, [6, 22, 38]],
        [8, 194, 24, 2, [6, 24, 42]],
        [9, 232, 30, 2, [6, 26, 46]]
      ];
      let spec = SPECS.find(s => utf8Bytes.length <= s[1] - 2);
      if (!spec) {
        spec = SPECS[SPECS.length - 1];
        utf8Bytes = utf8Bytes.slice(0, spec[1] - 2);
      }
      const [ver, totalDataCw, ecPerBlock, numBlocks, alignCoords] = spec;
      const size = ver * 4 + 17;

      const bits = [];
      const pushBits = (val, len) => {
        for (let b = len - 1; b >= 0; b--) bits.push((val >>> b) & 1);
      };
      pushBits(0b0100, 4); // Byte mode
      pushBits(utf8Bytes.length, 8);
      for (const byteVal of utf8Bytes) pushBits(byteVal, 8);
      const maxDataBits = totalDataCw * 8;
      for (let t = 0; t < 4 && bits.length < maxDataBits; t++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      let padIdx = 0;
      while (bits.length < maxDataBits) {
        pushBits(padIdx % 2 === 0 ? 0xec : 0x11, 8);
        padIdx++;
      }

      const dataCw = [];
      for (let i = 0; i < bits.length; i += 8) {
        let v = 0;
        for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
        dataCw.push(v);
      }

      const blockSize = totalDataCw / numBlocks;
      const dataBlocks = [];
      const ecBlocks = [];
      for (let b = 0; b < numBlocks; b++) {
        const blk = dataCw.slice(b * blockSize, (b + 1) * blockSize);
        dataBlocks.push(blk);
        ecBlocks.push(_qrRsRemainder(blk, ecPerBlock));
      }
      const finalCw = [];
      for (let i = 0; i < blockSize; i++) {
        for (let b = 0; b < numBlocks; b++) finalCw.push(dataBlocks[b][i]);
      }
      for (let i = 0; i < ecPerBlock; i++) {
        for (let b = 0; b < numBlocks; b++) finalCw.push(ecBlocks[b][i]);
      }

      const grid = Array.from({ length: size }, () => Array(size).fill(0));
      const isFunc = Array.from({ length: size }, () => Array(size).fill(false));
      const setFn = (r, c, val) => {
        if (r >= 0 && r < size && c >= 0 && c < size) {
          grid[r][c] = val ? 1 : 0;
          isFunc[r][c] = true;
        }
      };
      const drawFinder = (r0, c0) => {
        for (let dr = -1; dr <= 7; dr++) {
          for (let dc = -1; dc <= 7; dc++) {
            const rr = r0 + dr;
            const cc = c0 + dc;
            if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
            const onBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const dark = onBox && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
            setFn(rr, cc, dark ? 1 : 0);
          }
        }
      };
      drawFinder(0, 0);
      drawFinder(0, size - 7);
      drawFinder(size - 7, 0);

      for (const r0 of alignCoords) {
        for (const c0 of alignCoords) {
          if (isFunc[r0][c0]) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
              setFn(r0 + dr, c0 + dc, dark ? 1 : 0);
            }
          }
        }
      }

      for (let i = 8; i < size - 8; i++) {
        if (!isFunc[6][i]) setFn(6, i, i % 2 === 0 ? 1 : 0);
        if (!isFunc[i][6]) setFn(i, 6, i % 2 === 0 ? 1 : 0);
      }
      setFn(size - 8, 8, 1);

      // Reserve format info modules
      for (let i = 0; i <= 8; i++) {
        if (i !== 6) {
          isFunc[8][i] = true;
          isFunc[i][8] = true;
        }
      }
      for (let i = 0; i < 8; i++) isFunc[8][size - 1 - i] = true;
      for (let i = 0; i < 7; i++) isFunc[size - 1 - i][8] = true;

      if (ver >= 7) {
        let vRem = ver << 12;
        for (let b = 17; b >= 12; b--) {
          if ((vRem >>> b) & 1) vRem ^= 0x1f25 << (b - 12);
        }
        const vInfo = (ver << 12) | vRem;
        for (let i = 0; i < 18; i++) {
          const bit = (vInfo >>> i) & 1;
          const a = Math.floor(i / 3);
          const b = size - 11 + (i % 3);
          setFn(a, b, bit);
          setFn(b, a, bit);
        }
      }

      // Place codeword bits in zigzag scan
      const allBits = [];
      for (const cw of finalCw) {
        for (let b = 7; b >= 0; b--) allBits.push((cw >>> b) & 1);
      }
      let bitIdx = 0;
      let upward = true;
      for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
        if (rightCol === 6) rightCol = 5;
        for (let step = 0; step < size; step++) {
          const r = upward ? (size - 1 - step) : step;
          for (let offset = 0; offset < 2; offset++) {
            const c = rightCol - offset;
            if (!isFunc[r][c]) {
              grid[r][c] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            }
          }
        }
        upward = !upward;
      }

      const maskFn = [
        (r, c) => (r + c) % 2 === 0,
        (r) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
      ];

      const applyMaskAndFormat = (targetGrid, maskId) => {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (!isFunc[r][c] && maskFn[maskId](r, c)) targetGrid[r][c] ^= 1;
          }
        }
        const fmtData = (0b01 << 3) | maskId; // ECC L = 01
        let rem = fmtData << 10;
        for (let b = 14; b >= 10; b--) {
          if ((rem >>> b) & 1) rem ^= 0x537 << (b - 10);
        }
        const fmtBits = ((fmtData << 10) | rem) ^ 0x5412;
        for (let i = 0; i <= 5; i++) targetGrid[8][i] = (fmtBits >>> (14 - i)) & 1;
        targetGrid[8][7] = (fmtBits >>> 8) & 1;
        targetGrid[8][8] = (fmtBits >>> 7) & 1;
        targetGrid[7][8] = (fmtBits >>> 6) & 1;
        for (let i = 0; i <= 5; i++) targetGrid[5 - i][8] = (fmtBits >>> (5 - i)) & 1;
        for (let i = 0; i < 7; i++) targetGrid[size - 1 - i][8] = (fmtBits >>> (14 - i)) & 1;
        for (let i = 0; i < 8; i++) targetGrid[8][size - 8 + i] = (fmtBits >>> (7 - i)) & 1;
      };

      const scoreGrid = (g) => {
        let penalty = 0;
        for (let r = 0; r < size; r++) {
          let run = 1;
          for (let c = 1; c < size; c++) {
            if (g[r][c] === g[r][c - 1]) run++;
            else { if (run >= 5) penalty += 3 + (run - 5); run = 1; }
          }
          if (run >= 5) penalty += 3 + (run - 5);
        }
        for (let c = 0; c < size; c++) {
          let run = 1;
          for (let r = 1; r < size; r++) {
            if (g[r][c] === g[r - 1][c]) run++;
            else { if (run >= 5) penalty += 3 + (run - 5); run = 1; }
          }
          if (run >= 5) penalty += 3 + (run - 5);
        }
        for (let r = 0; r < size - 1; r++) {
          for (let c = 0; c < size - 1; c++) {
            const s = g[r][c] + g[r + 1][c] + g[r][c + 1] + g[r + 1][c + 1];
            if (s === 0 || s === 4) penalty += 3;
          }
        }
        return penalty;
      };

      let bestMask = 0;
      let bestScore = Infinity;
      let bestGrid = null;
      for (let m = 0; m < 8; m++) {
        const cand = grid.map(row => row.slice());
        applyMaskAndFormat(cand, m);
        const s = scoreGrid(cand);
        if (s < bestScore) {
          bestScore = s;
          bestMask = m;
          bestGrid = cand;
        }
      }
      return bestGrid || grid;
    }

    function buildVisualQrSvg(urlText) {
      const str = String(urlText || 'http://127.0.0.1:3001');
      const grid = encodeQrMatrix(str);
      const size = grid.length;
      const cell = 4;
      const quiet = 4 * cell;
      const viewDim = size * cell + quiet * 2;
      let rects = '';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (grid[r][c]) {
            rects += `<rect x="${c * cell + quiet}" y="${r * cell + quiet}" width="${cell}" height="${cell}" fill="#0f172a"/>`;
          }
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewDim} ${viewDim}" width="116" height="116" shape-rendering="crispEdges" role="img" aria-label="QR ${escapeHtml(str)}"><rect width="${viewDim}" height="${viewDim}" rx="6" fill="#ffffff"/>${rects}</svg>`;
    }

    const DISMISSED_MAINTENANCE_BANNER_KEY = 'eza_dismissed_maint_banner_v1';
    let currentSupportContactUrl = 'https://t.me/ezapro_support';

    function dismissMaintenanceAnnouncementBanner() {
      const bar = document.getElementById('maintenanceAnnouncementBar');
      const txt = document.getElementById('maintenanceAnnouncementText');
      const currentText = txt ? String(txt.innerText || '').replace(/^📢\s*/, '').trim() : '';
      try {
        if (currentText && typeof sessionStorage !== 'undefined' && sessionStorage) {
          sessionStorage.setItem(DISMISSED_MAINTENANCE_BANNER_KEY, currentText);
        }
      } catch (_) {}
      if (bar) bar.style.display = 'none';
    }

    function applyMaintenanceAnnouncementBanner(bannerText) {
      const bar = document.getElementById('maintenanceAnnouncementBar');
      const txt = document.getElementById('maintenanceAnnouncementText');
      const clean = String(bannerText || '').trim();
      if (!bar || !txt) return;
      if (clean) {
        let dismissed = '';
        try {
          if (typeof sessionStorage !== 'undefined' && sessionStorage) {
            dismissed = sessionStorage.getItem(DISMISSED_MAINTENANCE_BANNER_KEY) || '';
          }
        } catch (_) {}
        if (dismissed === clean) {
          bar.style.display = 'none';
          return;
        }
        txt.innerText = `📢 ${clean}`;
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
    }

    let cloudLicenseHeartbeatTimer = null;

    function formatCommercialPlanBadgeText(planId, priceUsd, expiresAt) {
      const pid = String(planId || '').toLowerCase();
      if (pid === 'yearly_50') return '👑 $50/ឆ្នាំ · VIP';
      if (pid === 'monthly_10') return '💎 $10/ខែ';
      if (pid === 'quarterly_25') return '⚡ $25/3ខែ';
      if (pid === 'trial_7') return '🎁 សាកល្បង 7 ថ្ងៃ';
      if (pid === 'lifetime' || (!expiresAt && !pid)) return '♾️ Lifetime';
      if (Number(priceUsd) > 0) return `💎 $${priceUsd}`;
      return '🎫 Licensed';
    }

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
      const nextLocked = Boolean(routerLocked);
      routerUserLockedState = nextLocked;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(ROUTER_USER_LOCKED_STORAGE_KEY, nextLocked ? '1' : '0');
        }
      } catch (_) {}
      syncRouterLockUi();
      if (nextLocked && currentAppView === 'router') {
        switchAppView('studio');
      }
    }

    function updateCustomerLicenseUi(info) {
      const box = document.getElementById('customerCloudLicenseSection');
      if (!box) return;
      if (!info) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      if (info.supportContact) {
        currentSupportContactUrl = String(info.supportContact).trim() || currentSupportContactUrl;
      }
      const nameEl = document.getElementById('hubCustLicenseName');
      const keyEl = document.getElementById('hubCustLicenseKey');
      const expEl = document.getElementById('hubCustLicenseExpiry');
      const planEl = document.getElementById('hubCustLicensePlan');
      const daysEl = document.getElementById('hubCustLicenseDaysLeft');
      const slotsEl = document.getElementById('hubCustMachineSlots');
      const expNoticeEl = document.getElementById('hubCustExpiringNotice');

      if (nameEl) nameEl.innerText = info.customerName || 'Licensed User';
      if (keyEl) keyEl.innerText = info.maskedKey || '-';
      if (expEl) {
        expEl.innerText = info.expiresAt
          ? new Date(info.expiresAt).toLocaleDateString('en-GB')
          : 'Lifetime';
      }
      if (planEl) {
        planEl.innerText = formatCommercialPlanBadgeText(info.planId, info.priceUsd, info.expiresAt);
      }
      if (daysEl) {
        if (!info.expiresAt) {
          daysEl.innerText = 'ពេញមួយជីវិត';
        } else {
          const days = typeof info.remainingDays === 'number'
            ? info.remainingDays
            : Math.max(0, Math.ceil((Number(info.expiresAt) - Date.now()) / 86400000));
          daysEl.innerText = `${days} ថ្ងៃ`;
          daysEl.style.color = days <= 5 ? '#fbbf24' : '#38bdf8';
        }
      }
      if (slotsEl) {
        const bound = Math.max(1, Number(info.boundCount || 1));
        const maxM = Math.max(bound, Number(info.maxMachines || 1));
        slotsEl.innerText = `${bound} / ${maxM}`;
      }
      if (expNoticeEl) {
        const days = info.expiresAt
          ? (typeof info.remainingDays === 'number' ? info.remainingDays : Math.ceil((Number(info.expiresAt) - Date.now()) / 86400000))
          : null;
        expNoticeEl.style.display = (info.expiringSoon || (days !== null && days > 0 && days <= 5)) ? 'block' : 'none';
      }
    }

    async function copyMachineIdFromElement(elementId) {
      const el = document.getElementById(elementId);
      const hwid = el ? String(el.innerText || '').trim() : '';
      if (!hwid) return '';
      let copied = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(hwid);
          copied = true;
        }
      } catch (_) {}
      if (!copied && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
          const ta = document.createElement('textarea');
          ta.value = hwid;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          if (typeof document.execCommand === 'function') document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }
      showShortcutToast(`📋 បានចម្លង Machine ID៖ ${hwid}`);
      return hwid;
    }

    function copyGateMachineId() {
      return copyMachineIdFromElement('gateMachineIdText');
    }

    function copyHubMachineId() {
      return copyMachineIdFromElement('hubCurrentMachineId');
    }

    async function openCustomerSupportLink() {
      const target = String(currentSupportContactUrl || 'https://t.me/ezapro_support').trim();
      try {
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.openExternalLink === 'function' && /^https?:|^mailto:/i.test(target)) {
          await window.electronAPI.openExternalLink(target);
          return;
        }
        if (typeof window !== 'undefined' && typeof window.open === 'function' && /^https?:|^mailto:/i.test(target)) {
          window.open(target, '_blank', 'noopener,noreferrer');
          return;
        }
      } catch (_) {}
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(target);
        }
      } catch (_) {}
      showShortcutToast(`💬 ទំនាក់ទំនងជំនួយ Admin៖ ${target}`);
    }

    async function downloadSupportDiagnosticsBundle() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/diagnostics/bundle`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof document !== 'undefined') {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = objUrl;
          a.download = `eza-pro-support-${stamp}.txt`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
        } else if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.revealSupportLogs === 'function') {
          await window.electronAPI.revealSupportLogs();
        }
        showShortcutToast('🛠️ បានទាញយកឯកសារ Log ជំនួយរួចរាល់ (មិនមានលាតត្រដាង API Key ទេ)');
        return text;
      } catch (err) {
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.revealSupportLogs === 'function') {
          try { await window.electronAPI.revealSupportLogs(); return ''; } catch (_) {}
        }
        showShortcutToast('❌ មិនអាចទាញយក Log ជំនួយបានទេ៖ ' + err.message);
        return '';
      }
    }

    async function retryAccessGateCheck() {
      const errEl = document.getElementById('gateErrorMsg');
      if (errEl) errEl.innerText = '⏳ កំពុងពិនិត្យតភ្ជាប់ Server ម្ដងទៀត...';
      const data = await refreshSystemHubModal();
      if (!data && errEl) {
        errEl.innerText = '❌ មិនអាចភ្ជាប់ប្រព័ន្ធខាងក្នុងបានទេ។ សូមរង់ចាំបន្តិច ឬបិទបើកកម្មវិធីម្ដងទៀត។';
      }
    }

    const BYOK_DISMISSED_SESSION_KEY = 'eza_byok_prompt_dismissed_v1';

    async function openExternalSiteUrl(url) {
      try {
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.openExternalLink === 'function') {
          await window.electronAPI.openExternalLink(url);
          return true;
        }
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(url, '_blank', 'noopener,noreferrer');
          return true;
        }
      } catch (_) {}
      showShortcutToast(`🌐 បើកវេបសាយ៖ ${url}`);
      return false;
    }

    function openGoogleAiStudioKeyPage() {
      return openExternalSiteUrl('https://aistudio.google.com/apikey');
    }

    function openRespanPlatformKeyPage() {
      return openExternalSiteUrl('https://platform.respan.ai');
    }

    function openByokSetupModal() {
      if (isRouterLockedForUsers()) return;
      const modal = document.getElementById('byokSetupModal');
      const statusEl = document.getElementById('byokQuickStatusMsg');
      if (!modal) return;
      if (statusEl) statusEl.innerText = '';
      modal.style.display = 'flex';
    }

    function closeByokSetupModal(rememberDismiss = false) {
      const modal = document.getElementById('byokSetupModal');
      if (modal) modal.style.display = 'none';
      if (rememberDismiss) {
        try {
          if (typeof sessionStorage !== 'undefined' && sessionStorage) {
            sessionStorage.setItem(BYOK_DISMISSED_SESSION_KEY, '1');
          }
        } catch (_) {}
      }
    }

    async function submitByokQuickSetup() {
      const inputEl = document.getElementById('byokQuickKeysInput');
      const statusEl = document.getElementById('byokQuickStatusMsg');
      const submitBtn = document.getElementById('byokQuickSubmitBtn');
      const rawText = inputEl ? String(inputEl.value || '').trim() : '';
      if (!rawText) {
        if (statusEl) statusEl.innerText = 'សូមបិទភ្ជាប់ (Paste) Gemini API Key (AIzaSy...) យ៉ាងតិច ១ គ្រាប់សិន។';
        return false;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (statusEl) {
        statusEl.style.color = '#38bdf8';
        statusEl.innerText = '⏳ កំពុងរក្សាទុក និងតេស្ត API Key...';
      }
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
            throw new Error(result.error || 'មិនអាចបញ្ចូល API Key បានទេ។');
          }
        }
        if (inputEl) inputEl.value = '';
        routerTopologySignature = '';
        await refreshGeminiAccounts();
        if ((result.addedCount || 0) > 0 && typeof testAllGeminiAccounts === 'function') {
          Promise.resolve(testAllGeminiAccounts()).catch(() => {});
        }
        closeByokSetupModal(true);
        const okMsg = `✅ បានដាក់ Gemini API Key ចំនួន ${result.addedCount || 1} រួចរាល់! អាចចាប់ផ្ដើមប្រើបានភ្លាម!`;
        const bottomEl = document.getElementById('bottomStatusMsg');
        if (bottomEl) bottomEl.innerText = okMsg;
        showShortcutToast(okMsg);
        return true;
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = '#fca5a5';
          statusEl.innerText = '❌ ' + err.message;
        }
        return false;
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    async function maybeShowFirstRunApiKeyHint() {
      if (isRouterLockedForUsers()) return;
      try {
        const data = await fetchMergedGeminiAccounts();
        if (data && Array.isArray(data.accounts) && data.accounts.length === 0 && !(data.respan && data.respan.enabled)) {
          const bottomEl = document.getElementById('bottomStatusMsg');
          const msg = '💡 ជំហានដំបូង៖ សូមដាក់ Free Gemini Key ឬ Respan GPT-6.2 SOL Key មុនចាប់ផ្ដើមបកប្រែ AI!';
          if (bottomEl) bottomEl.innerText = msg;
          showShortcutToast(msg);
          let dismissed = false;
          try {
            if (typeof sessionStorage !== 'undefined' && sessionStorage) {
              dismissed = sessionStorage.getItem(BYOK_DISMISSED_SESSION_KEY) === '1';
            }
          } catch (_) {}
          if (!dismissed) openByokSetupModal();
        }
      } catch (_) {}
    }

    function openLicenseKeyPromptFromHub() {
      closeMobileConnectModal();
      const gate = document.getElementById('accessGateOverlay');
      const errEl = document.getElementById('gateErrorMsg');
      const cancelBtn = document.getElementById('gateCancelSwitchBtn');
      const inputEl = document.getElementById('gateAccessCodeInput');
      if (cancelBtn && cancelBtn.style) cancelBtn.style.display = 'flex';
      if (errEl) errEl.innerText = 'សូមបញ្ចូល License Key ថ្មីរបស់អ្នក (ចុច ✕ ដើម្បីត្រឡប់ក្រោយ)។';
      if (gate && gate.style) gate.style.display = 'flex';
      if (inputEl && typeof inputEl.focus === 'function') {
        try { inputEl.focus(); } catch (_) {}
      }
    }

    function cancelLicenseKeySwitchPrompt() {
      const gate = document.getElementById('accessGateOverlay');
      const cancelBtn = document.getElementById('gateCancelSwitchBtn');
      const errEl = document.getElementById('gateErrorMsg');
      if (cancelBtn && cancelBtn.style) cancelBtn.style.display = 'none';
      if (gate && gate.style) gate.style.display = 'none';
      if (errEl) errEl.innerText = '';
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
          if (data && data.supportContact) {
            currentSupportContactUrl = String(data.supportContact).trim() || currentSupportContactUrl;
          }
          if (data && typeof data.maintenanceBanner === 'string') {
            applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
          }
          if (data && typeof data.routerLocked === 'boolean') {
            applyRemoteRouterControl(data.routerLocked);
          }
          if (res.ok && data && data.valid) {
            if (data.accessToken) saveVerifiedAccessToken(data.accessToken);
            if (data.cloudLicenseInfo) updateCustomerLicenseUi(data.cloudLicenseInfo);
            return;
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
      systemIsPackagedClient = hubData.isPackagedClient !== false;
      const resetPinBtn = document.getElementById('routerPinResetDefaultBtn');
      if (resetPinBtn && resetPinBtn.style) {
        resetPinBtn.style.display = systemIsPackagedClient ? 'none' : '';
      }
      const gateHwid = document.getElementById('gateMachineIdText');
      if (gateHwid && hubData.machineId) gateHwid.innerText = hubData.machineId;
      if (hubData.supportContact) {
        currentSupportContactUrl = String(hubData.supportContact).trim() || currentSupportContactUrl;
      }
      const verEl = document.getElementById('hubAppVersionText');
      if (verEl) {
        const verStr = (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.version) || hubData.appVersion || '1.0.0';
        verEl.innerText = `v${String(verStr).replace(/^v/i, '')}`;
      }

      if (hubData.isPackagedClient) {
        const adminSec = document.getElementById('systemHubAdminSection');
        if (adminSec) adminSec.style.display = 'none';
        const routerLockBtn = document.getElementById('routerLockUserBtn');
        if (routerLockBtn) routerLockBtn.style.display = 'none';
      }

      if (hubData.cloudLicenseEnforced) {
        updateCustomerLicenseUi(hubData.cloudLicensed ? hubData.cloudLicenseInfo : null);
        applyRemoteRouterControl(Boolean(hubData.routerDefaultLocked));
        startCloudLicenseHeartbeat();
        try {
          const vRes = await fetch(`${BACKEND_URL}/api/config/verify-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recheck', token: getSavedAccessToken() })
          });
          const vData = await vRes.json();
          if (vData && vData.supportContact) {
            currentSupportContactUrl = String(vData.supportContact).trim() || currentSupportContactUrl;
          }
          if (vData && typeof vData.maintenanceBanner === 'string' && vData.maintenanceBanner) {
            applyMaintenanceAnnouncementBanner(vData.maintenanceBanner);
          }
          if (vData && vData.downloadUrl) applyGateDownloadLink(vData.downloadUrl);
          if (vData && typeof vData.routerLocked === 'boolean') applyRemoteRouterControl(vData.routerLocked);
          if (vRes.ok && vData && vData.valid) {
            if (vData.accessToken) saveVerifiedAccessToken(vData.accessToken);
            if (vData.cloudLicenseInfo) updateCustomerLicenseUi(vData.cloudLicenseInfo);
            gate.style.display = 'none';
            maybeShowFirstRunApiKeyHint();
            return;
          }
          const errEl = document.getElementById('gateErrorMsg');
          if (errEl && vData && vData.reason !== 'missing_key' && vData.error) {
            errEl.innerText = vData.error;
          }
        } catch (netErr) {
          const errEl = document.getElementById('gateErrorMsg');
          if (errEl) errEl.innerText = '❌ មិនអាចតភ្ជាប់ផ្ទៀងផ្ទាត់ License បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចចុច «ពិនិត្យម្ដងទៀត»។';
        }
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
        if (typeof data.routerLocked === 'boolean') applyRemoteRouterControl(data.routerLocked);
        if (inputEl) inputEl.value = '';
        if (errEl) errEl.innerText = '';
        const cancelBtn = document.getElementById('gateCancelSwitchBtn');
        if (cancelBtn && cancelBtn.style) cancelBtn.style.display = 'none';
        if (gate) gate.style.display = 'none';
        if (typeof refreshVoicesAndPresets === 'function') {
          Promise.resolve(refreshVoicesAndPresets()).catch(() => {});
        }
        if (typeof refreshAudioCapabilities === 'function') {
          Promise.resolve(refreshAudioCapabilities()).catch(() => {});
        }
        if (typeof refreshSpeechCapabilities === 'function') {
          Promise.resolve(refreshSpeechCapabilities()).catch(() => {});
        }
        if (typeof refreshExportCapabilities === 'function') {
          Promise.resolve(refreshExportCapabilities()).catch(() => {});
        }
        if (typeof refreshSystemHubModal === 'function') {
          Promise.resolve(refreshSystemHubModal()).catch(() => {});
        }
        maybeShowFirstRunApiKeyHint();
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
        applyRemoteRouterControl(false);
        applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
        await syncAccessGateOverlay(data);
        return data;
      } catch (_) {
        return null;
      }
    }

    async function toggleRouterLockFromHub() {
      const nextLocked = !isRouterLockedForUsers();
      const statusMsg = document.getElementById('hubAdminStatusMsg');
      try {
        const res = await fetch(`${BACKEND_URL}/api/config/system-hub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routerDefaultLocked: nextLocked })
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចកែស្ថានភាព Router បានទេ');
        }
        routerUserLockedState = nextLocked;
        try {
          if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
            localStorage.setItem(ROUTER_USER_LOCKED_STORAGE_KEY, nextLocked ? '1' : '0');
          }
        } catch (_) {}
        syncRouterLockUi();
        if (nextLocked && currentAppView === 'router') {
          switchAppView('studio');
        }
        const msg = nextLocked ? '🔒 បានលាក់ផ្ទាំង Router ពី User រួចរាល់' : '🔓 បានបើកបង្ហាញផ្ទាំង Router វិញរួចរាល់';
        if (statusMsg) statusMsg.innerText = msg;
        showShortcutToast(msg);
        return data;
      } catch (err) {
        if (statusMsg) statusMsg.innerText = '❌ ' + err.message;
        showShortcutToast('❌ ' + err.message);
        return null;
      }
    }

    async function saveSystemHubConfig() {
      const accessChk = document.getElementById('hubUserAccessCheck');
      const codeInput = document.getElementById('hubUserAccessCodeInput');
      const bannerInput = document.getElementById('hubMaintenanceBannerInput');
      const statusMsg = document.getElementById('hubAdminStatusMsg');
      const payload = {
        userAccessEnabled: Boolean(accessChk && accessChk.checked),
        maintenanceBanner: bannerInput ? String(bannerInput.value || '').trim() : ''
      };
      const nextCode = codeInput ? String(codeInput.value || '').trim() : '';
      if (nextCode) payload.userAccessCode = nextCode;

      try {
        if (statusMsg) statusMsg.innerText = '⏳ កំពុងរក្សាទុក...';
        const res = await fetch(`${BACKEND_URL}/api/config/system-hub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'មិនអាចរក្សាទុកការកំណត់បានទេ');
        }
        if (codeInput) codeInput.value = '';
        applyMaintenanceAnnouncementBanner(data.maintenanceBanner);
        if (statusMsg) statusMsg.innerText = '✅ បានរក្សាទុកការកំណត់ System Hub!';
        showShortcutToast('✅ បានរក្សាទុកការកំណត់ System Hub!');
        return data;
      } catch (err) {
        if (statusMsg) statusMsg.innerText = '❌ ' + err.message;
        showShortcutToast('❌ ' + err.message);
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

    // =========================================================================
    // ANTI-COPYRIGHT PROTECTION GUARD (Live Preview WYSIWYG + Export Payload)
    // =========================================================================
    const COPYRIGHT_GUARD_STORAGE_KEY = 'eza_copyright_guard_v1';

    function getDefaultCopyrightGuardState() {
      return {
        enabled: false,
        preset: 'off',
        mirror: false,
        zoomPercent: 100,
        colorShift: 'none',
        vignette: false,
        speedPercent: 100,
        pitchPct: 0,
        stripMetadata: true
      };
    }

    let copyrightGuardState = getDefaultCopyrightGuardState();

    function normalizeCopyrightGuardState(raw = {}) {
      const base = getDefaultCopyrightGuardState();
      const src = raw && typeof raw === 'object' ? raw : {};
      const zoom = Math.round(Number(src.zoomPercent));
      const speed = Math.round(Number(src.speedPercent));
      const pitch = Math.round(Number(src.pitchPct !== undefined ? src.pitchPct : src.pitchTenths));
      const rawColor = String(src.colorShift || 'none').toLowerCase();
      const colorAlias = { vivid: 'cinema_crisp', warm: 'warm_vivid', cool: 'bright_pop' };
      const color = colorAlias[rawColor] || rawColor;
      const preset = String(src.preset || 'off').toLowerCase();
      return {
        enabled: Boolean(src.enabled),
        preset: ['off', 'safe', 'strong', 'custom'].includes(preset) ? preset : 'custom',
        mirror: Boolean(src.mirror),
        zoomPercent: Number.isFinite(zoom) ? Math.min(125, Math.max(100, zoom)) : base.zoomPercent,
        colorShift: ['none', 'warm_vivid', 'cinema_crisp', 'bright_pop'].includes(color) ? color : 'none',
        vignette: Boolean(src.vignette),
        speedPercent: Number.isFinite(speed) ? Math.min(115, Math.max(95, speed)) : base.speedPercent,
        pitchPct: Number.isFinite(pitch) ? Math.min(12, Math.max(-12, pitch)) : base.pitchPct,
        stripMetadata: src.stripMetadata === undefined ? true : Boolean(src.stripMetadata)
      };
    }

    function saveCopyrightGuardState() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(COPYRIGHT_GUARD_STORAGE_KEY, JSON.stringify(copyrightGuardState));
        }
      } catch (_) {}
    }

    function formatCopyrightSummaryText() {
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      if (!st.enabled) return 'បិទ';
      const colorLabels = { warm_vivid: 'Warm', cinema_crisp: 'Cinema', bright_pop: 'Bright' };
      const parts = [];
      if (st.mirror) parts.push('Mirror');
      if (st.zoomPercent > 100) parts.push(`Zoom ${st.zoomPercent}%`);
      if (st.colorShift !== 'none') parts.push(colorLabels[st.colorShift] || st.colorShift);
      if (st.vignette) parts.push('Vignette');
      if (st.speedPercent !== 100) parts.push(`${(st.speedPercent / 100).toFixed(2)}x`);
      if (st.pitchPct !== 0) parts.push(`Pitch ${st.pitchPct > 0 ? '+' : ''}${st.pitchPct}%`);
      if (st.stripMetadata) parts.push('Clean Meta');
      return parts.length ? parts.join(' · ') : 'សកម្ម (Default)';
    }

    function applyCopyrightPreviewTransform() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const video = document.getElementById('mainVideo');
      const frame = document.getElementById('previewFrame')
        || (typeof document.querySelector === 'function' ? document.querySelector('.video-frame-916') : null);
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      if (!st.enabled) {
        if (video && video.style) {
          video.style.transform = '';
          video.style.filter = '';
        }
        if (frame && frame.classList) frame.classList.remove('has-cr-vignette');
        return;
      }
      if (video && video.style) {
        const transforms = [];
        if (st.mirror) transforms.push('scaleX(-1)');
        const zoomScale = st.zoomPercent / 100;
        if (zoomScale > 1.001) transforms.push(`scale(${zoomScale.toFixed(2)})`);
        video.style.transform = transforms.join(' ');

        const filterMap = {
          none: '',
          warm_vivid: 'contrast(1.06) saturate(1.10) brightness(1.02) sepia(0.05)',
          cinema_crisp: 'contrast(1.10) saturate(1.14) brightness(0.98)',
          bright_pop: 'contrast(1.05) saturate(1.12) brightness(1.04)'
        };
        video.style.filter = filterMap[st.colorShift] || '';
      }
      if (frame && frame.classList) {
        frame.classList.toggle('has-cr-vignette', Boolean(st.vignette));
      }
    }

    function syncVideoPlaybackRate() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const video = document.getElementById('mainVideo');
      if (!video) return;
      const sel = document.getElementById('speedSelect');
      const baseRate = sel ? (parseFloat(sel.value) || 1) : 1;
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      const crRate = st.enabled ? (st.speedPercent / 100) : 1;
      const combined = Math.max(0.5, Math.min(2.5, Number((baseRate * crRate).toFixed(3))));
      try {
        video.playbackRate = combined;
      } catch (_) {}
      if (typeof currentDubAudio !== 'undefined' && currentDubAudio && !currentDubAudio.paused) {
        try {
          const slotFactor = Number(currentDubAudio._slotFitFactor) || 1;
          currentDubAudio.playbackRate = Math.max(0.75, Math.min(1.65, Number((combined * slotFactor).toFixed(2))));
        } catch (_) {}
      }
      if (typeof bgmAudio !== 'undefined' && bgmAudio && !bgmAudio.paused) {
        try {
          bgmAudio.playbackRate = combined;
        } catch (_) {}
      }
    }

    function renderCopyrightExportRow() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      const statusText = document.getElementById('exportCrStatusText');
      const safeBtn = document.getElementById('exportCrSafeBtn');
      const summary = formatCopyrightSummaryText();
      if (statusText) {
        statusText.innerText = st.enabled ? `🛡️ ការពារ Copyright៖ ${summary}` : '🛡️ ការពារ Copyright៖ បិទ';
        if (statusText.classList) statusText.classList.toggle('active', st.enabled);
      }
      if (safeBtn) {
        safeBtn.innerText = st.enabled ? '⭕ បិទ CR' : '✨ បើកស្តង់ដារ CR';
        if (typeof safeBtn.setAttribute === 'function') {
          safeBtn.setAttribute('onclick', st.enabled
            ? "applyCopyrightPreset('off'); updateExportPreviewSummary();"
            : "applyCopyrightPreset('safe'); updateExportPreviewSummary();");
        }
      }
    }

    function renderCopyrightGuardUi() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      const toggleBtn = document.getElementById('quickCrToggleBtn');
      const badge = document.getElementById('crStatusBadge');
      const dot = document.getElementById('crTabDot');
      if (toggleBtn) {
        if (toggleBtn.classList) toggleBtn.classList.toggle('active', st.enabled);
        toggleBtn.innerText = st.enabled ? '🛡️ ការពារ Copyright៖ បើក (ON)' : '🛡️ ការពារ Copyright៖ បិទ';
      }
      if (badge) {
        if (badge.classList) badge.classList.toggle('active', st.enabled);
        badge.innerText = st.enabled ? formatCopyrightSummaryText() : 'បិទ';
      }
      if (dot) dot.hidden = !st.enabled;

      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.cr-preset-btn[data-cr-preset]').forEach(btn => {
          if (!btn || typeof btn.getAttribute !== 'function' || !btn.classList) return;
          const key = btn.getAttribute('data-cr-preset');
          const activePreset = st.enabled ? st.preset : 'off';
          btn.classList.toggle('active', key === activePreset);
        });
      }

      const mirrorChk = document.getElementById('crMirrorCheck');
      if (mirrorChk) mirrorChk.checked = st.mirror;
      const vigChk = document.getElementById('crVignetteCheck');
      if (vigChk) vigChk.checked = st.vignette;
      const metaChk = document.getElementById('crStripMetaCheck');
      if (metaChk) metaChk.checked = st.stripMetadata;
      const colorSel = document.getElementById('crColorSelect');
      if (colorSel) colorSel.value = st.colorShift;

      const zoomSlider = document.getElementById('crZoomSlider');
      if (zoomSlider) zoomSlider.value = String(st.zoomPercent);
      const zoomVal = document.getElementById('crZoomVal');
      if (zoomVal) zoomVal.innerText = `${st.zoomPercent}%`;

      const speedSlider = document.getElementById('crSpeedSlider');
      if (speedSlider) speedSlider.value = String(st.speedPercent);
      const speedVal = document.getElementById('crSpeedVal');
      if (speedVal) speedVal.innerText = `${(st.speedPercent / 100).toFixed(2)}x`;

      const pitchSlider = document.getElementById('crPitchSlider');
      if (pitchSlider) pitchSlider.value = String(st.pitchPct);
      const pitchVal = document.getElementById('crPitchVal');
      if (pitchVal) pitchVal.innerText = `${st.pitchPct > 0 ? '+' : ''}${st.pitchPct}%`;

      renderCopyrightExportRow();
    }

    function applyCopyrightPreset(presetName) {
      const mode = String(presetName || 'off').toLowerCase();
      if (mode === 'safe') {
        copyrightGuardState = normalizeCopyrightGuardState({
          enabled: true,
          preset: 'safe',
          mirror: false,
          zoomPercent: 104,
          colorShift: 'warm_vivid',
          vignette: false,
          speedPercent: 103,
          pitchPct: 0,
          stripMetadata: true
        });
      } else if (mode === 'strong') {
        copyrightGuardState = normalizeCopyrightGuardState({
          enabled: true,
          preset: 'strong',
          mirror: true,
          zoomPercent: 107,
          colorShift: 'cinema_crisp',
          vignette: true,
          speedPercent: 105,
          pitchPct: -4,
          stripMetadata: true
        });
      } else {
        copyrightGuardState = getDefaultCopyrightGuardState();
      }
      saveCopyrightGuardState();
      renderCopyrightGuardUi();
      applyCopyrightPreviewTransform();
      syncVideoPlaybackRate();
      return copyrightGuardState;
    }

    function toggleCopyrightGuard() {
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      if (!st.enabled) {
        const isNeutral = !st.mirror && st.zoomPercent === 100 && st.colorShift === 'none'
          && !st.vignette && st.speedPercent === 100 && st.pitchPct === 0;
        if (isNeutral) {
          return applyCopyrightPreset('safe');
        }
        copyrightGuardState = { ...st, enabled: true };
      } else {
        copyrightGuardState = { ...st, enabled: false };
      }
      saveCopyrightGuardState();
      renderCopyrightGuardUi();
      applyCopyrightPreviewTransform();
      syncVideoPlaybackRate();
      if (typeof updateExportPreviewSummary === 'function') updateExportPreviewSummary();
      return copyrightGuardState;
    }

    function setCopyrightControl(field, value) {
      const next = { ...normalizeCopyrightGuardState(copyrightGuardState) };
      if (field === 'mirror' || field === 'vignette' || field === 'stripMetadata') {
        next[field] = Boolean(value);
      } else if (field === 'colorShift') {
        next.colorShift = String(value || 'none');
      } else if (field === 'zoomPercent' || field === 'speedPercent' || field === 'pitchPct') {
        next[field] = Number(value);
      }
      const hasAnyTransform = next.mirror || next.vignette || next.zoomPercent > 100
        || next.colorShift !== 'none' || next.speedPercent !== 100 || next.pitchPct !== 0;
      if (hasAnyTransform || (field === 'stripMetadata' && next.stripMetadata)) {
        next.enabled = true;
      }
      next.preset = 'custom';
      copyrightGuardState = normalizeCopyrightGuardState(next);
      saveCopyrightGuardState();
      renderCopyrightGuardUi();
      applyCopyrightPreviewTransform();
      syncVideoPlaybackRate();
      if (typeof updateExportPreviewSummary === 'function') updateExportPreviewSummary();
      return copyrightGuardState;
    }

    function getCopyrightExportPayload() {
      const st = normalizeCopyrightGuardState(copyrightGuardState);
      const active = Boolean(st.enabled);
      return {
        enabled: active,
        preset: active ? st.preset : 'off',
        mirror: active && Boolean(st.mirror),
        zoomPercent: active ? Math.max(0, st.zoomPercent - 100) : 0,
        colorShift: active ? st.colorShift : 'none',
        vignette: active && Boolean(st.vignette),
        speedRate: active ? Number((st.speedPercent / 100).toFixed(2)) : 1,
        audioPitchPct: active ? st.pitchPct : 0,
        stripMetadata: active ? Boolean(st.stripMetadata) : false
      };
    }

    function initCopyrightGuard() {
      try {
        if (typeof localStorage !== 'undefined') {
          const saved = localStorage.getItem(COPYRIGHT_GUARD_STORAGE_KEY);
          if (saved) {
            copyrightGuardState = normalizeCopyrightGuardState(JSON.parse(saved));
          }
        }
      } catch (_) {}
      if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const speedSel = document.getElementById('speedSelect');
        if (speedSel && typeof speedSel.addEventListener === 'function' && (!speedSel.dataset || !speedSel.dataset.crHooked)) {
          if (speedSel.dataset) speedSel.dataset.crHooked = '1';
          speedSel.addEventListener('change', () => syncVideoPlaybackRate());
        }
      }
      renderCopyrightGuardUi();
      applyCopyrightPreviewTransform();
      syncVideoPlaybackRate();
    }

    const PREVIEW_SUB_SETTINGS_STORAGE_KEY = 'eza_preview_sub_settings_v1';
    const CUSTOM_TEXT_OVERLAY_STORAGE_KEY = 'eza_custom_text_overlay_v1';

    function savePreviewSubSettingsState() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          const safeZoneEl = typeof document !== 'undefined' ? document.getElementById('safeZoneOverlay') : null;
          const payload = {
            subStyle: currentSubStyle || 'tiktok',
            subFontSize: Number.isFinite(Number(currentSubFontSize)) ? Number(currentSubFontSize) : 16,
            subPosYPercent: Number.isFinite(Number(currentSubPosYPercent)) ? Number(currentSubPosYPercent) : 8,
            subTextColor: typeof currentSubTextColor === 'string' ? currentSubTextColor : '',
            subVisible: typeof isSubtitleVisible === 'boolean' ? isSubtitleVisible : true,
            wordPop: typeof isWordPopEnabled === 'boolean' ? isWordPopEnabled : true,
            aspectMode: previewAspectMode === '9:16' ? '9:16' : 'auto',
            safeZone: Boolean(safeZoneEl && safeZoneEl.style && safeZoneEl.style.display === 'block')
          };
          localStorage.setItem(PREVIEW_SUB_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
        }
      } catch (_) {}
    }

    function initPreviewSubSettings() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage || typeof localStorage.getItem !== 'function') return;
        const raw = localStorage.getItem(PREVIEW_SUB_SETTINGS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;

        if (typeof parsed.subStyle === 'string' && parsed.subStyle.trim()) {
          currentSubStyle = parsed.subStyle.trim();
        }
        if (Number.isFinite(Number(parsed.subFontSize))) {
          currentSubFontSize = Math.min(32, Math.max(10, Math.round(Number(parsed.subFontSize))));
        }
        if (Number.isFinite(Number(parsed.subPosYPercent))) {
          currentSubPosYPercent = clampMaskNumber(parsed.subPosYPercent, 2, 90, 8);
        }
        if (typeof parsed.subTextColor === 'string') {
          currentSubTextColor = parsed.subTextColor.trim();
        }
        if (typeof parsed.subVisible === 'boolean') {
          isSubtitleVisible = parsed.subVisible;
        }
        if (typeof parsed.wordPop === 'boolean') {
          isWordPopEnabled = parsed.wordPop;
        }
        if (parsed.aspectMode === '9:16' || parsed.aspectMode === 'auto') {
          previewAspectMode = parsed.aspectMode;
        }

        if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
          const styleSel = document.getElementById('subStyleSelect');
          if (styleSel) styleSel.value = currentSubStyle;
          const fontSlider = document.getElementById('subFontSizeSlider');
          if (fontSlider) fontSlider.value = String(currentSubFontSize);
          const fontVal = document.getElementById('subFontSizeVal');
          if (fontVal) fontVal.innerText = `${currentSubFontSize}px`;
          const visChk = document.getElementById('subVisibleToggleCheck');
          if (visChk) visChk.checked = isSubtitleVisible;
          const wpChk = document.getElementById('wordPopToggleCheck');
          if (wpChk) wpChk.checked = isWordPopEnabled;
          const aspectSel = document.getElementById('previewAspectSelect');
          if (aspectSel) aspectSel.value = previewAspectMode;
          const sub = document.getElementById('liveSubtitleText');
          if (sub) {
            sub.className = 'subtitle-text-inside style-' + currentSubStyle + (isWordPopEnabled ? '' : ' no-word-pop');
            sub.style.color = currentSubTextColor || '';
            if (!isSubtitleVisible) sub.style.display = 'none';
          }
          if (currentSubTextColor) syncColorDotChipsToHex(currentSubTextColor);
          updateSubPosY(currentSubPosYPercent, { skipSave: true });
          if (parsed.safeZone) {
            const zone = document.getElementById('safeZoneOverlay');
            const szChk = document.getElementById('safeZoneToggle');
            const hdrBtn = document.getElementById('headerSafeZoneBtn');
            if (zone && zone.style) zone.style.display = 'block';
            if (szChk) szChk.checked = true;
            if (hdrBtn && hdrBtn.classList && hdrBtn.classList.add) hdrBtn.classList.add('active');
          }
          syncPreviewSubtitleScale();
        }
      } catch (_) {}
    }

    function getDefaultCustomTextOverlayState() {
      return {
        enabled: false,
        text: '',
        xPercent: 0.5,
        yPercent: 0.08,
        fontSizePx: 15,
        textColor: '#ffffff',
        bgStyle: 'pill',
        opacityPercent: 95
      };
    }

    function normalizeCustomTextOverlayState(raw) {
      const base = getDefaultCustomTextOverlayState();
      if (!raw || typeof raw !== 'object') return base;
      const text = String(raw.text == null ? '' : raw.text).replace(/\r\n?/g, '\n').slice(0, 140);
      const xNum = Number(raw.xPercent);
      const yNum = Number(raw.yPercent);
      const fNum = Number(raw.fontSizePx);
      const opNum = Number(raw.opacityPercent);
      const allowedBg = ['pill', 'outline', 'gold_box', 'clean'];
      const bgStyle = allowedBg.includes(String(raw.bgStyle || '')) ? String(raw.bgStyle) : 'pill';
      const colorRaw = String(raw.textColor || '#ffffff').trim();
      return {
        enabled: Boolean(raw.enabled),
        text,
        xPercent: Number.isFinite(xNum) ? Math.min(0.96, Math.max(0.04, Number(xNum.toFixed(4)))) : 0.5,
        yPercent: Number.isFinite(yNum) ? Math.min(0.97, Math.max(0.03, Number(yNum.toFixed(4)))) : 0.08,
        fontSizePx: Number.isFinite(fNum) ? Math.min(32, Math.max(10, Math.round(fNum))) : 15,
        textColor: /^#[0-9a-fA-F]{3,6}$/.test(colorRaw) ? colorRaw : '#ffffff',
        bgStyle,
        opacityPercent: Number.isFinite(opNum) ? Math.min(100, Math.max(25, Math.round(opNum))) : 95
      };
    }

    let customTextOverlayState = getDefaultCustomTextOverlayState();

    function saveCustomTextOverlayState() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(CUSTOM_TEXT_OVERLAY_STORAGE_KEY, JSON.stringify(normalizeCustomTextOverlayState(customTextOverlayState)));
        }
      } catch (_) {}
    }

    function getCustomTextOverlayExportPayload() {
      const st = normalizeCustomTextOverlayState(customTextOverlayState);
      const cleanText = st.text.trim();
      if (!st.enabled || !cleanText) {
        return { enabled: false, text: '' };
      }
      return {
        enabled: true,
        text: cleanText,
        xPercent: st.xPercent,
        yPercent: st.yPercent,
        fontSizePx: st.fontSizePx,
        textColor: st.textColor,
        bgStyle: st.bgStyle,
        opacityPercent: st.opacityPercent
      };
    }

    function renderCustomTextOverlayUi(options = {}) {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const st = normalizeCustomTextOverlayState(customTextOverlayState);
      customTextOverlayState = st;
      const cleanText = st.text.trim();
      const visible = Boolean(st.enabled && cleanText);

      const box = document.getElementById('customTextOverlayBox');
      const span = document.getElementById('customTextOverlaySpan');
      if (box) {
        box.hidden = !visible;
        if (box.style) {
          box.style.display = visible ? 'inline-block' : 'none';
          box.style.left = `${(st.xPercent * 100).toFixed(2)}%`;
          box.style.top = `${(st.yPercent * 100).toFixed(2)}%`;
          box.style.color = st.bgStyle === 'gold_box' ? '#090d16' : st.textColor;
          box.style.opacity = String(Number((st.opacityPercent / 100).toFixed(2)));
        }
        if (box.classList && typeof box.classList.remove === 'function') {
          box.classList.remove('bg-pill', 'bg-outline', 'bg-gold_box', 'bg-clean');
          box.classList.add(`bg-${st.bgStyle}`);
        }
      }
      if (span) {
        span.innerText = cleanText;
      }
      syncPreviewSubtitleScale();

      const toggleBtn = document.getElementById('quickTextOverlayToggleBtn');
      if (toggleBtn) {
        if (toggleBtn.classList && typeof toggleBtn.classList.toggle === 'function') {
          toggleBtn.classList.toggle('active', visible);
        }
        toggleBtn.innerText = visible ? '✍️ អក្សរលើវីដេអូ៖ បើក (ON)' : '✍️ អក្សរលើវីដេអូ៖ បិទ';
      }
      const tabDot = document.getElementById('textTabDot');
      if (tabDot) tabDot.hidden = !visible;

      if (!options.skipInputSync) {
        const inputEl = document.getElementById('customTextOverlayInput');
        if (inputEl && inputEl.value !== st.text) inputEl.value = st.text;
      }
      const bgSel = document.getElementById('customTextBgStyleSelect');
      if (bgSel) bgSel.value = st.bgStyle;
      const sizeSlider = document.getElementById('customTextSizeSlider');
      if (sizeSlider) sizeSlider.value = String(st.fontSizePx);
      const sizeVal = document.getElementById('customTextSizeVal');
      if (sizeVal) sizeVal.innerText = `${st.fontSizePx}px`;
      const opSlider = document.getElementById('customTextOpacitySlider');
      if (opSlider) opSlider.value = String(st.opacityPercent);
      const opVal = document.getElementById('customTextOpacityVal');
      if (opVal) opVal.innerText = `${st.opacityPercent}%`;
      const picker = document.getElementById('customTextColorPicker');
      if (picker) picker.value = st.textColor.toLowerCase();
      if (typeof document.querySelectorAll === 'function') {
        const targetHex = st.textColor.toLowerCase();
        document.querySelectorAll('.text-ov-color-chip').forEach(c => {
          if (!c || !c.classList) return;
          const hex = String((c.dataset && c.dataset.hex) || (c.getAttribute && c.getAttribute('data-hex')) || '').toLowerCase();
          c.classList.toggle('active', hex === targetHex);
        });
      }
    }

    function toggleCustomTextOverlay(forceVal) {
      const st = normalizeCustomTextOverlayState(customTextOverlayState);
      const next = typeof forceVal === 'boolean' ? forceVal : !st.enabled;
      if (next && !st.text.trim()) {
        setPreviewDockTab('text', { ensureOpen: true });
        focusCustomTextInput();
        if (typeof showShortcutToast === 'function') {
          showShortcutToast('✍️ សូមសរសេរអក្សរដែលចង់ដាក់លើវីដេអូជាមុនសិន');
        }
        return false;
      }
      customTextOverlayState = normalizeCustomTextOverlayState({ ...st, enabled: next });
      saveCustomTextOverlayState();
      renderCustomTextOverlayUi();
      if (typeof showShortcutToast === 'function') {
        showShortcutToast(next ? '✍️ បានដាក់អក្សរលើវីដេអូ (ជាប់រហូតគ្រប់ភាគ)' : '✍️ បានលាក់/ដកអក្សរពីលើវីដេអូ');
      }
      return next;
    }

    function clearCustomTextOverlay() {
      customTextOverlayState = normalizeCustomTextOverlayState({
        ...customTextOverlayState,
        enabled: false,
        text: ''
      });
      saveCustomTextOverlayState();
      renderCustomTextOverlayUi();
      if (typeof showShortcutToast === 'function') {
        showShortcutToast('🗑️ បានដកអក្សរចេញពីលើវីដេអូ');
      }
    }

    function onCustomTextOverlayInput(val) {
      const nextText = String(val == null ? '' : val);
      const hasContent = Boolean(nextText.trim());
      customTextOverlayState = normalizeCustomTextOverlayState({
        ...customTextOverlayState,
        text: nextText,
        enabled: hasContent
      });
      saveCustomTextOverlayState();
      renderCustomTextOverlayUi({ skipInputSync: true });
    }

    function setCustomTextOverlayControl(field, value) {
      const next = { ...normalizeCustomTextOverlayState(customTextOverlayState) };
      if (field === 'bgStyle') next.bgStyle = String(value || 'pill');
      else if (field === 'textColor') next.textColor = String(value || '#ffffff');
      else if (field === 'fontSizePx') next.fontSizePx = Number(value);
      else if (field === 'opacityPercent') next.opacityPercent = Number(value);
      if (next.text.trim()) next.enabled = true;
      customTextOverlayState = normalizeCustomTextOverlayState(next);
      saveCustomTextOverlayState();
      renderCustomTextOverlayUi();
    }

    function setCustomTextPresetPos(preset) {
      const map = {
        'top-left': [0.22, 0.08],
        'top-center': [0.5, 0.08],
        'top-right': [0.78, 0.08],
        'center': [0.5, 0.48],
        'bottom-center': [0.5, 0.88]
      };
      const coords = map[preset] || [0.5, 0.08];
      customTextOverlayState = normalizeCustomTextOverlayState({
        ...customTextOverlayState,
        xPercent: coords[0],
        yPercent: coords[1],
        enabled: Boolean(customTextOverlayState.text.trim()) || customTextOverlayState.enabled
      });
      saveCustomTextOverlayState();
      renderCustomTextOverlayUi();
    }

    function focusCustomTextInput() {
      setPreviewDockTab('text', { ensureOpen: true });
      const inputEl = typeof document !== 'undefined' ? document.getElementById('customTextOverlayInput') : null;
      if (inputEl && typeof inputEl.focus === 'function') {
        inputEl.focus();
      }
    }

    function initCustomTextOverlayDrag() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      const box = document.getElementById('customTextOverlayBox');
      if (!box || typeof box.addEventListener !== 'function') return;
      if (box.dataset && box.dataset.textDragBound === '1') return;
      if (box.dataset) box.dataset.textDragBound = '1';

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let initXPct = 0.5;
      let initYPct = 0.08;

      const beginDrag = (clientX, clientY, ev) => {
        if (ev && ev.target && ev.target.classList && ev.target.classList.contains('custom-text-remove-chip')) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        dragging = true;
        startX = clientX;
        startY = clientY;
        initXPct = customTextOverlayState.xPercent;
        initYPct = customTextOverlayState.yPercent;
        if (box.classList) box.classList.add('is-dragging');
      };

      const moveDrag = (clientX, clientY, ev) => {
        if (!dragging) return;
        const frame = box.parentElement;
        if (!frame || typeof frame.getBoundingClientRect !== 'function') return;
        const rect = frame.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        const dx = (clientX - startX) / rect.width;
        const dy = (clientY - startY) / rect.height;
        customTextOverlayState = normalizeCustomTextOverlayState({
          ...customTextOverlayState,
          xPercent: initXPct + dx,
          yPercent: initYPct + dy
        });
        renderCustomTextOverlayUi({ skipInputSync: true });
      };

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        if (box.classList) box.classList.remove('is-dragging');
        saveCustomTextOverlayState();
      };

      box.addEventListener('mousedown', (e) => beginDrag(e.clientX, e.clientY, e));
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY, null));
        window.addEventListener('mouseup', endDrag);
        box.addEventListener('touchstart', (e) => {
          const t = e.touches && e.touches[0];
          if (t) beginDrag(t.clientX, t.clientY, e);
        }, { passive: false });
        window.addEventListener('touchmove', (e) => {
          if (!dragging) return;
          const t = e.touches && e.touches[0];
          if (t) moveDrag(t.clientX, t.clientY, e);
        }, { passive: false });
        window.addEventListener('touchend', endDrag);
        window.addEventListener('touchcancel', endDrag);
      }
    }

    function initCustomTextOverlay() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          const saved = localStorage.getItem(CUSTOM_TEXT_OVERLAY_STORAGE_KEY);
          if (saved) {
            customTextOverlayState = normalizeCustomTextOverlayState(JSON.parse(saved));
          }
        }
      } catch (_) {}
      renderCustomTextOverlayUi();
      initCustomTextOverlayDrag();
    }

    loadSavedAudioMixerState();
    initPreviewSubSettings();
    initCustomTextOverlay();
    initCopyrightGuard();
    renderTable();
    if (typeof fetch === 'function') {
      refreshSystemHubModal().catch(() => {});
    }

    if (typeof window !== 'undefined') {
      window.toggleVoiceTunerPanel = toggleVoiceTunerPanel;
      window.onVoiceRateSliderInput = onVoiceRateSliderInput;
      window.onVoicePitchSliderInput = onVoicePitchSliderInput;
      window.resetVoiceTuningToPreset = resetVoiceTuningToPreset;
      window.previewTunedVoice = previewTunedVoice;
      window.applyTunedVoiceToAllCues = applyTunedVoiceToAllCues;
      window.applyNarratorTuningPreset = applyNarratorTuningPreset;
      window.getEffectiveVoiceProsody = getEffectiveVoiceProsody;
      window.syncVoiceTunerUiToCurrentVoice = syncVoiceTunerUiToCurrentVoice;
      window.previewVoice = previewVoice;
      window.previewCurrentVoice = previewCurrentVoice;
      window.setPreviewEditTarget = setPreviewEditTarget;
      window.setMaskPreset = setMaskPreset;
      window.nudgeMask = nudgeMask;
      window.alignSubtitleToMask = alignSubtitleToMask;
      window.onSttEngineChange = onSttEngineChange;
      window.getSelectedSttEngine = getSelectedSttEngine;
      window.refreshSpeechCapabilities = refreshSpeechCapabilities;
      window.toggleCustomTextOverlay = toggleCustomTextOverlay;
      window.clearCustomTextOverlay = clearCustomTextOverlay;
      window.onCustomTextOverlayInput = onCustomTextOverlayInput;
      window.setCustomTextOverlayControl = setCustomTextOverlayControl;
      window.setCustomTextPresetPos = setCustomTextPresetPos;
      window.focusCustomTextInput = focusCustomTextInput;
      window.getCustomTextOverlayExportPayload = getCustomTextOverlayExportPayload;
      window.downloadOrOpenAllCompletedVideos = downloadOrOpenAllCompletedVideos;
      window.openSingleExportItem = openSingleExportItem;
      window.sortVideoManagerQueueNaturally = sortVideoManagerQueueNaturally;
      window.extractEpisodeNumber = extractEpisodeNumber;
      window.pickBatchVideoFiles = pickBatchVideoFiles;
      window.pickBatchVideoFolder = pickBatchVideoFolder;
      window.startVideoManagerBatch = startVideoManagerBatch;
      window.stopVideoManagerBatch = stopVideoManagerBatch;
      window.openVideoManagerModal = openVideoManagerModal;
      window.closeVideoManagerModal = closeVideoManagerModal;
      window.toggleVideoManagerSetup = toggleVideoManagerSetup;
      window.toggleVideoManagerViewMode = toggleVideoManagerViewMode;
      window.setVideoManagerFilter = setVideoManagerFilter;
      window.toggleSelectAllVideoManager = toggleSelectAllVideoManager;
      window.clearVideoManagerQueue = clearVideoManagerQueue;
      window.retryFailedVideoManagerItems = retryFailedVideoManagerItems;
      window.renderVideoManagerQueue = renderVideoManagerQueue;
      window.loadCurrentDramaIntoVideoManager = loadCurrentDramaIntoVideoManager;
      window.loadVideoManagerFromPathInput = loadVideoManagerFromPathInput;
      window.pickExportOutputFolder = pickExportOutputFolder;
      window.openExportFolder = openExportFolder;
      window.closeInAppFolderBrowserModal = closeInAppFolderBrowserModal;
      window.loadInAppFolderBrowserPath = loadInAppFolderBrowserPath;
      window.openInAppFolderBrowserModal = openInAppFolderBrowserModal;
      window.applyVideoManagerTurboPreset = applyVideoManagerTurboPreset;
      window.applyVideoManagerEcoPreset = applyVideoManagerEcoPreset;
      window.onEcoCpuModeToggle = onEcoCpuModeToggle;
      window.toggleRouterRespanPanel = toggleRouterRespanPanel;
      window.toggleRespanKeyVisibility = toggleRespanKeyVisibility;
      window.saveRouterRespanConfig = saveRouterRespanConfig;
      window.setRouterRespanRole = setRouterRespanRole;
      window.clearRouterRespanKey = clearRouterRespanKey;
      window.testRouterRespanConnection = testRouterRespanConnection;
      window.openRespanPlatformKeyPage = openRespanPlatformKeyPage;
      window.openLicenseKeyPromptFromHub = openLicenseKeyPromptFromHub;
      window.copyHubMachineId = copyHubMachineId;
      window.cancelLicenseKeySwitchPrompt = cancelLicenseKeySwitchPrompt;
    }


  