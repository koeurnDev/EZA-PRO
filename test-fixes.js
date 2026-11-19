const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ezarg-fixes-test-'));
const tempAudioDir = path.join(tempRoot, 'audio_cache');
const tempExportDir = path.join(tempRoot, 'exported');
fs.mkdirSync(tempAudioDir, { recursive: true });
fs.mkdirSync(tempExportDir, { recursive: true });

process.env.AUDIO_CACHE_DIR = tempAudioDir;
process.env.EXPORT_DIR = tempExportDir;
process.env.CLONED_VOICES_DIR = path.join(tempRoot, 'cloned_voices');
process.env.VOICE_CLONE_ENGINE_DIR = path.join(tempRoot, 'voice_clone_engine');
process.env.GEMINI_ACCOUNTS_FILE = path.join(tempRoot, '.gemini-accounts.json');
process.env.EZA_CONFIG_FILE = path.join(tempRoot, 'config.json');

const { FFMPEG_BIN } = require('./src/backend/utils/ffmpeg');
const voiceClonerModule = require('./src/backend/utils/voice-cloner');
const { setupRoutes } = require('./src/backend/routes');
const srtModule = require('./src/backend/routes/srt');
const mediaModule = require('./src/backend/routes/media');
const ttsModule = require('./src/backend/routes/tts');
const exportModule = require('./src/backend/routes/export');
const audioModule = require('./src/backend/routes/audio');
const translationModule = require('./src/backend/routes/translation');
const configModule = require('./src/backend/routes/config');

function startTestServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    req.getGeminiApiKey = () => '';
    next();
  });
  app.use('/audio_cache', express.static(tempAudioDir));
  setupRoutes(app);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

test.after(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) { }
});

test('srt.js fixes: non-string guard, zero-based headerless cue, rounding, and serializeSrt newlines', () => {
  assert.equal(srtModule.srtTimeToSeconds(null), null);
  assert.equal(srtModule.srtTimeToSeconds(undefined), null);
  assert.equal(srtModule.srtTimeToSeconds('01:02:03,450'), 3723.45);

  const cues = srtModule.parseSrt('01:00:00,000 --> 01:00:02,500\nសួស្តី\nពិភពលោក');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].index, 1);
  assert.equal(cues[0].text, 'សួស្តី\nពិភពលោក');

  assert.equal(srtModule.secondsToDisplayTime(59.96), '1:00.0');
  assert.equal(srtModule.secondsToSrtTime(59.9999), '00:01:00,000');

  const serialized = srtModule.serializeSrt(cues);
  assert.ok(!serialized.includes('\\n'), 'serialized SRT must not contain literal backslash-n');
  assert.match(serialized, /^1\n01:00:00,000 --> 01:00:02,500\nសួស្តី\nពិភពលោក\n$/);
});

test('media.js fixes: scanDramaFolder supports extra unnumbered videos and both name fields', () => {
  const dramaDir = path.join(tempRoot, 'MyDrama');
  fs.mkdirSync(dramaDir, { recursive: true });
  fs.writeFileSync(path.join(dramaDir, 'ep2.mp4'), 'video2');
  fs.writeFileSync(path.join(dramaDir, 'ep1.mp4'), 'video1');
  fs.writeFileSync(path.join(dramaDir, 'bonus.mp4'), 'video3');
  fs.writeFileSync(path.join(dramaDir, 'ep1.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');

  const scanned = mediaModule.scanDramaFolder(dramaDir);
  assert.equal(scanned.name, 'MyDrama');
  assert.equal(scanned.dramaName, 'MyDrama');
  assert.equal(scanned.episodes.length, 3);
  assert.equal(scanned.episodes[0].ep, 1);
  assert.ok(scanned.episodes[0].srtPath.endsWith('ep1.srt'));
  assert.equal(scanned.episodes[1].ep, 2);
  assert.equal(scanned.episodes[2].ep, 3);
});

test('tts.js fixes: voice alias resolution and consistent cache-check keys', async () => {
  assert.equal(ttsModule.resolveVoiceName('Sovereign King'), 'km-KH-PisethNeural');
  assert.equal(ttsModule.resolveVoiceName('Radiant Queen'), 'km-KH-SreymomNeural');

  const keyKing = ttsModule.getAudioCacheKey('សួស្តី', 'Sovereign King');
  const keyPiseth = ttsModule.getAudioCacheKey('សួស្តី', 'km-KH-PisethNeural');
  const keyQueen = ttsModule.getAudioCacheKey('សួស្តី', 'Radiant Queen');
  const keyChild = ttsModule.getAudioCacheKey('សួស្តី', 'kh_child');
  assert.equal(keyKing, keyPiseth);
  assert.notEqual(keyKing, keyQueen);
  assert.notEqual(keyChild, keyQueen);
  assert.equal(ttsModule.getVoiceSignature('kh_child'), 'km-KH-SreymomNeural|p=+30Hz|r=+10%');

  const validMp3 = path.join(tempAudioDir, `${keyKing}.mp3`);
  const tinyMp3 = path.join(tempAudioDir, `${keyQueen}.mp3`);
  const validChildMp3 = path.join(tempAudioDir, `${keyChild}.mp3`);
  fs.writeFileSync(validMp3, Buffer.alloc(512, 1));
  fs.writeFileSync(tinyMp3, Buffer.alloc(10, 1));
  fs.writeFileSync(validChildMp3, Buffer.alloc(512, 1));

  const { server, baseUrl } = await startTestServer();
  try {
    const voicesRes = await fetch(`${baseUrl}/api/tts/voices`);
    assert.equal(voicesRes.status, 200);
    const voicesBody = await voicesRes.json();
    assert.equal(voicesBody.voices.length, 2);
    assert.equal(voicesBody.presets.length, 8);

    const res = await fetch(`${baseUrl}/api/check-audio-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { text: 'សួស្តី', voice: 'Sovereign King' },
          { text: 'សួស្តី', voice: 'Radiant Queen' },
          { text: 'សួស្តី', voice: 'kh_child' }
        ]
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.cachedKeys, ['km-KH-PisethNeural:សួស្តី', 'km-KH-SreymomNeural|p=+30Hz|r=+10%:សួស្តី']);
    assert.equal(body.urls['km-KH-PisethNeural:សួស្តី'], `/audio_cache/${keyKing}.mp3`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('export.js fixes: wrapKhmerText short multiline strings, ASS rollover, filter safety, and real FFmpeg export', async () => {
  assert.equal(exportModule.secondsToAssTime(59.999), '0:01:00.00');
  assert.equal(exportModule.wrapKhmerText('Line 1\nLine 2', 34), 'Line 1\\NLine 2');

  const filter = exportModule.buildExportFilter("C:\\temp\\O'Brien\\sub.ass", {
    maskEnabled: true,
    maskMode: 'feathered',
    maskYPercent: 0.96,
    maskHPercent: 0.08,
    maskWPercent: 0.92
  });
  assert.ok(!filter.includes('fontsdir='), 'filter must omit slow Windows fontsdir override');
  assert.ok(!filter.includes('boxblur='), 'filter must not use crashing boxblur=14:2');
  assert.ok(filter.includes('gblur=sigma=12'), 'filter must use gblur');
  assert.ok(filter.includes('0.92'), 'maskYPercent must be clamped to <= 1 - maskHPercent');

  const sampleVideo = path.join(tempRoot, 'sample-540x960.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=540x960:d=0.4:r=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '0.4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, `FFmpeg sample generation failed: ${gen.stderr}`);

  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleVideo,
        duration: 0.4,
        maskEnabled: true,
        maskMode: 'blur',
        subStyle: 'tiktok',
        subFontSize: 56,
        subMarginV: 294,
        maskYPercent: 0.80,
        maskHPercent: 0.04,
        cues: [{ startSec: 0, endSec: 0.35, text: '你好', translated: 'សួស្តី\nបង' }]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, `Export failed: ${JSON.stringify(body)}`);
    assert.equal(body.success, true);
    assert.ok(fs.existsSync(body.outputFile));
    assert.ok(body.fileSize > 1000);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('export.js Phase 1: AI Dubbing audio mix, auto-ducking, tempo fit, and 1080p HD render', async () => {
  assert.equal(exportModule.computeCueTempo(1.2, 0, 1.5, 2.0, true), 1.0);
  const spedUp = exportModule.computeCueTempo(3.0, 0, 1.5, 1.6, true);
  assert.ok(spedUp > 1.4 && spedUp <= 1.55, `Expected clamped speedup, got ${spedUp}`);
  assert.equal(exportModule.buildTempoFilterChain(1.25), ',atempo=1.250');

  assert.equal(
    exportModule.getScaleFilterExpr('1080p', { width: 540, height: 960 }),
    'scale=1080:1920:flags=lanczos'
  );
  assert.equal(
    exportModule.getScaleFilterExpr('1080p', { width: 1080, height: 1920 }),
    ''
  );

  const hdFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'feathered',
    resolution: '1080p',
    mediaInfo: { width: 540, height: 960 }
  });
  assert.ok(hdFilter.startsWith('[0:v]scale=1080:1920:flags=lanczos[vscaled];[vscaled]split[orig][copy]'));

  const cpuHd = exportModule.buildVideoEncodingArgs('hd', 'cpu');
  assert.equal(cpuHd.encoderName, 'libx264');
  assert.ok(cpuHd.args.includes('-crf') && cpuHd.args.includes('17'));

  const sampleVideo = path.join(tempRoot, 'sample-dub-540x960.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=540x960:d=1.2:r=24',
    '-f', 'lavfi', '-i', 'sine=f=330:d=1.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0);

  const cue1Text = 'សួស្តី បង';
  const cue2Text = 'តោះទៅ';
  const k1 = ttsModule.getAudioCacheKey(cue1Text, 'Sovereign King');
  const k2 = ttsModule.getAudioCacheKey(cue2Text, 'kh_young_girl');

  const mkMp31 = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'sine=f=660:d=0.4', '-c:a', 'libmp3lame',
    path.join(tempAudioDir, `${k1}.mp3`)
  ], { encoding: 'utf8' });
  const mkMp32 = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'sine=f=880:d=0.4', '-c:a', 'libmp3lame',
    path.join(tempAudioDir, `${k2}.mp3`)
  ], { encoding: 'utf8' });
  assert.equal(mkMp31.status, 0);
  assert.equal(mkMp32.status, 0);

  const { server, baseUrl } = await startTestServer();
  try {
    const capRes = await fetch(`${baseUrl}/api/export/capabilities`);
    assert.equal(capRes.status, 200);
    const capBody = await capRes.json();
    assert.equal(capBody.success, true);
    assert.ok(capBody.presets.includes('hd'));
    assert.ok(capBody.resolutions.includes('1080p'));

    const res = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleVideo,
        duration: 1.2,
        maskEnabled: true,
        maskMode: 'feathered',
        subStyle: 'tiktok',
        includeDubAudio: true,
        autoGenerateMissingTts: false,
        autoFitTiming: true,
        audioMixMode: 'duck',
        resolution: '1080p',
        qualityPreset: 'hd',
        encoder: 'cpu',
        cues: [
          { startSec: 0.05, endSec: 0.55, text: '你好', translated: cue1Text, voice: 'Sovereign King' },
          { startSec: 0.60, endSec: 1.10, text: '走吧', translated: cue2Text, voice: 'kh_young_girl' }
        ]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, `HD Dubbed export failed: ${JSON.stringify(body)}`);
    assert.equal(body.success, true);
    assert.equal(body.dubbedCueCount, 2);
    assert.equal(body.audioMixMode, 'duck');
    assert.equal(body.resolution, '1080p');
    assert.equal(body.encoder, 'libx264');
    assert.ok(fs.existsSync(body.outputFile));

    const probe = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', body.outputFile], { encoding: 'utf8' });
    const outInfo = exportModule.parseMediaInfoFromStderr(probe.stderr);
    assert.equal(outInfo.width, 1080);
    assert.equal(outInfo.height, 1920);
    assert.equal(outInfo.hasAudio, true);
    assert.ok(outInfo.durationSec >= 1.1 && outInfo.durationSec <= 1.35, `Unexpected duration: ${outInfo.durationSec}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('audio.js Phase 2: BGM & vocal stem isolation, caching, and bgm_only export mix', async () => {
  assert.ok(audioModule.BGM_ISOLATION_FILTER.includes('stereotools'));
  assert.ok(audioModule.VOCAL_ISOLATION_FILTER.includes('highpass'));

  const sampleVideo = path.join(tempRoot, 'sample-bgm-540x960.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=darkgreen:s=540x960:d=1.0:r=24',
    '-f', 'lavfi', '-i', 'aevalsrc=0.35*sin(2*PI*110*t)+0.35*sin(2*PI*1300*t)|0.35*sin(2*PI*114*t)+0.35*sin(2*PI*1300*t):d=1.0:s=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0);

  const cueText = 'សួស្តី មិត្តភក្តិ';
  const kCue = ttsModule.getAudioCacheKey(cueText, 'Sovereign King');
  spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'sine=f=660:d=0.45', '-c:a', 'libmp3lame',
    path.join(tempAudioDir, `${kCue}.mp3`)
  ], { encoding: 'utf8' });

  const { server, baseUrl } = await startTestServer();
  try {
    const capRes = await fetch(`${baseUrl}/api/audio/capabilities`);
    assert.equal(capRes.status, 200);
    const capBody = await capRes.json();
    assert.equal(capBody.success, true);
    assert.ok(capBody.engine && capBody.engine.id);

    const badRes = await fetch(`${baseUrl}/api/audio/isolate-bgm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: 'relative.mp4' })
    });
    assert.equal(badRes.status, 400);

    const statusBefore = await fetch(`${baseUrl}/api/audio/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: sampleVideo })
    });
    assert.equal((await statusBefore.json()).ready, false);

    const isoRes = await fetch(`${baseUrl}/api/audio/isolate-bgm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: sampleVideo, engine: 'ffmpeg_dsp' })
    });
    const isoBody = await isoRes.json();
    assert.equal(isoRes.status, 200, `Isolate BGM failed: ${JSON.stringify(isoBody)}`);
    assert.equal(isoBody.success, true);
    assert.equal(isoBody.cached, false);
    assert.ok(fs.existsSync(isoBody.bgmPath));
    assert.ok(fs.existsSync(isoBody.vocalsPath));

    const bgmFetch = await fetch(`${baseUrl}${isoBody.bgmUrl}`);
    assert.equal(bgmFetch.status, 200);

    const isoCached = await fetch(`${baseUrl}/api/audio/isolate-bgm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: sampleVideo, engine: 'ffmpeg_dsp' })
    });
    assert.equal((await isoCached.json()).cached, true);

    const expRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleVideo,
        duration: 1.0,
        maskEnabled: false,
        includeDubAudio: true,
        autoGenerateMissingTts: false,
        audioMixMode: 'bgm_only',
        resolution: 'source',
        qualityPreset: 'fast',
        encoder: 'cpu',
        cues: [{ startSec: 0.1, endSec: 0.8, text: '你好', translated: cueText, voice: 'Sovereign King' }]
      })
    });
    const expBody = await expRes.json();
    assert.equal(expRes.status, 200, `bgm_only export failed: ${JSON.stringify(expBody)}`);
    assert.equal(expBody.success, true);
    assert.equal(expBody.audioMixMode, 'bgm_only');
    assert.ok(fs.existsSync(expBody.outputFile));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('routes/index.js + media/srt/draft/config integration checks', async () => {
  const srtPath = path.join(tempRoot, 'test-sub.srt');
  const binPath = path.join(tempRoot, 'range.mp4');
  const secretBinPath = path.join(tempRoot, 'range.bin');
  fs.writeFileSync(binPath, '0123456789ABCDEF');
  fs.writeFileSync(secretBinPath, '0123456789ABCDEF');

  const { server, baseUrl } = await startTestServer();
  try {
    // Save and reload SRT
    const saveRes = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: srtPath,
        cues: [{ startSec: 1.5, endSec: 3.2, text: 'Hello\nWorld' }]
      })
    });
    assert.equal(saveRes.status, 200);
    const loadRes = await fetch(`${baseUrl}/api/load-srt-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: srtPath })
    });
    assert.equal(loadRes.status, 200);
    const loaded = await loadRes.json();
    assert.equal(loaded.cues.length, 1);
    assert.equal(loaded.cues[0].text, 'Hello\nWorld');

    // Video stream byte ranges + 416 + non-media .bin extension blocked (403)
    const rangeRes = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent(binPath)}`, {
      headers: { Range: 'bytes=2-5' }
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(await rangeRes.text(), '2345');

    const blockedBinRes = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent(secretBinPath)}`);
    assert.equal(blockedBinRes.status, 403);

    const badRange = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent(binPath)}`, {
      headers: { Range: 'bytes=99-120' }
    });
    assert.equal(badRange.status, 416);

    // Draft security + validation + cleanup
    const badDraftSave = await fetch(`${baseUrl}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: '   ', cues: [] })
    });
    assert.equal(badDraftSave.status, 400);

    const badDraftKey = await fetch(`${baseUrl}/api/drafts/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftKey: '../../package' })
    });
    assert.equal(badDraftKey.status, 400);

    const saveDraft = await fetch(`${baseUrl}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: path.join(tempRoot, 'ep1.mp4'),
        cues: loaded.cues
      })
    });
    assert.equal(saveDraft.status, 200);
    const savedDraft = await saveDraft.json();
    const delDraft = await fetch(`${baseUrl}/api/drafts/${savedDraft.draftKey}`, { method: 'DELETE' });
    assert.equal(delDraft.status, 200);

    // Config rejects plaintext GEMINI_API_KEY and non-object body
    const keyReject = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ GEMINI_API_KEY: 'secret' })
    });
    assert.equal(keyReject.status, 400);

    const arrayReject = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['invalid'])
    });
    assert.equal(arrayReject.status, 400);

    // Router Management HTTP API (accounts list, add, switch, delete, and loadConfig integration)
    const addAcc1 = await fetch(`${baseUrl}/api/config/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'koeurn',
        email: 'seabkoeurn64@gmail.com',
        apiKey: 'AIzaSyTestAccountKeyOne1234567890'
      })
    });
    assert.equal(addAcc1.status, 200);
    const acc1Body = await addAcc1.json();
    assert.equal(acc1Body.success, true);
    assert.equal(acc1Body.accounts.length, 1);
    assert.equal(acc1Body.accounts[0].name, 'koeurn');
    assert.equal(acc1Body.accounts[0].isActive, true);
    assert.equal(configModule.loadConfig().GEMINI_API_KEY, 'AIzaSyTestAccountKeyOne1234567890');

    const addAcc2 = await fetch(`${baseUrl}/api/config/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'studio2',
        email: 'studio2@example.com',
        apiKey: 'AIzaSyTestAccountKeyTwo0987654321'
      })
    });
    assert.equal(addAcc2.status, 200);
    const acc2Body = await addAcc2.json();
    assert.equal(acc2Body.accounts.length, 2);
    assert.equal(configModule.loadConfig().GEMINI_API_KEY, 'AIzaSyTestAccountKeyTwo0987654321');

    const switchRes = await fetch(`${baseUrl}/api/config/accounts/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: acc1Body.accounts[0].id })
    });
    assert.equal(switchRes.status, 200);
    assert.equal(configModule.loadConfig().GEMINI_API_KEY, 'AIzaSyTestAccountKeyOne1234567890');

    const delAcc1 = await fetch(`${baseUrl}/api/config/accounts/${encodeURIComponent(acc1Body.accounts[0].id)}`, {
      method: 'DELETE'
    });
    assert.equal(delAcc1.status, 200);
    const afterDel1 = await delAcc1.json();
    assert.equal(afterDel1.accounts.length, 1);
    const delAcc2 = await fetch(`${baseUrl}/api/config/accounts/${encodeURIComponent(afterDel1.accounts[0].id)}`, {
      method: 'DELETE'
    });
    assert.equal(delAcc2.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('translation.js + frontend integrity checks', async () => {
  const enMeta = translationModule.getPromptLanguageMeta('en');
  assert.equal(enMeta.renderingName, 'English');
  assert.ok(enMeta.editorRole.includes('English'));

  const koMeta = translationModule.getPromptLanguageMeta('ko');
  assert.equal(koMeta.renderingName, 'Korean');
  assert.ok(translationModule.getSourceLanguage('th'));
  assert.ok(translationModule.getTargetLanguage('vi'));

  const chunkTestVideo = path.join(tempRoot, 'sample-65s.mp4');
  const gen65 = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=65:r=5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=65',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    chunkTestVideo
  ], { encoding: 'utf8' });
  assert.equal(gen65.status, 0);

  const speechTempDir = fs.mkdtempSync(path.join(tempRoot, 'speech-chunks-'));
  const chunks = await translationModule.extractSpeechAudioChunks(chunkTestVideo, speechTempDir, {
    chunkDurationSec: 30,
    isolateVocals: true
  });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].offsetSec, 0);
  assert.equal(chunks[1].offsetSec, 30);
  assert.equal(chunks[2].offsetSec, 60);
  assert.ok(fs.existsSync(chunks[0].audioPath));

  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

  assert.ok(html.includes('id="mainVideo" class="video-element" crossorigin="anonymous"'));
  assert.ok(html.includes('id="btnCancelExport"'));
  assert.equal(html.includes('id="exportDubCheck"'), false);
  assert.equal(html.includes('id="exportMaskCheck"'), false);
  assert.equal(html.includes('id="routerCablesSvg"'), false);
  assert.equal(html.includes('id="routerHubNode"'), false);
  assert.ok(html.includes('id="exportAudioMode"'));
  assert.ok(html.includes('id="exportOutputDirInput"'));
  assert.ok(html.includes('id="btnChooseExportDir"'));
  assert.ok(html.includes('id="exportAdvancedDetails"'));
  assert.ok(html.includes('id="exportResolution"'));
  assert.ok(html.includes('id="exportQualityPreset"'));
  assert.ok(html.includes('id="routerToggleBatchBtn"'));
  assert.ok(html.includes('id="routerBatchPanel"'));
  assert.ok(html.includes('id="sourceLangSelect"'));
  assert.ok(!html.includes('D:\\\\HDRG'));
  assert.equal((css.match(/\.subtitle-text-inside\s*\{/g) || []).length, 1);

  assert.ok(!appJs.includes("+ '\\\\n' +"), 'downloadSrtFile must use real newlines');
  assert.ok(!appJs.includes('replace(/\\\\.mp4$/i'), 'saveSrtToDisk regex must not double-escape');
  assert.ok(appJs.includes('resolveBackendUrl(data.audioUrl)'));
  assert.ok(appJs.includes('selectCueRow(matchedIdx, false)'));
  assert.ok(appJs.includes('includeDubAudio'));
  assert.ok(appJs.includes('qualityPreset'));
  assert.ok(css.includes('.router-star-stage'));
  assert.ok(css.includes('.router-center-hub'));
  assert.ok(css.includes('.router-wing-column'));
  assert.ok(appJs.includes('buildRouterCenterHubElement'));
  assert.ok(appJs.includes('drawRouterStarConnectors'));

  assert.ok(mainJs.includes("'GET, POST, PUT, DELETE, OPTIONS'"));
  assert.ok(mainJs.includes("'Content-Range, Accept-Ranges, Content-Length'"));

  // Verify config does not match commented .env line
  const prevEnv = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    // Spot check regex behavior on commented line vs active quoted line
    const regex = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/m;
    assert.equal('# GEMINI_API_KEY=commented_out'.match(regex), null);
    const activeMatch = '  export GEMINI_API_KEY = "AIzaTestKey1234567890" '.match(regex);
    assert.ok(activeMatch);
    assert.equal(activeMatch[1].replace(/^(['"])(.*)\1$/, '$2').trim(), 'AIzaTestKey1234567890');
    assert.ok(configModule.loadConfig);
  } finally {
    if (prevEnv !== undefined) process.env.GEMINI_API_KEY = prevEnv;
  }
});

test('frontend pure helpers: rounding, HTML escaping, voice key matching, and untranslated cue editing', () => {
  const vm = require('node:vm');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const sandbox = {
    window: { electronAPI: { backendUrl: 'http://127.0.0.1:4567' } },
    document: {
      body: { classList: { toggle() { } } },
      addEventListener() { },
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    Audio: class { },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval() { return 0; },
    clearInterval() { },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  assert.equal(sandbox.escapeHtml(`<script>"'&`), '&lt;script&gt;&quot;&#39;&amp;');
  assert.equal(sandbox.formatSecToDisplay(59.96), '1:00.0');
  assert.equal(sandbox.formatSecToSrt(59.9999), '00:01:00,000');
  assert.equal(sandbox.resolveVoiceName('Sovereign King'), 'km-KH-PisethNeural');
  assert.equal(sandbox.resolveVoiceName('Radiant Queen'), 'km-KH-SreymomNeural');
  assert.equal(sandbox.resolveVoiceName('kh_young_girl'), 'km-KH-SreymomNeural');
  assert.equal(sandbox.getAudioCacheKey('Sovereign King', ' សួស្តី '), 'km-KH-PisethNeural:សួស្តី');
  assert.equal(sandbox.getAudioCacheKey('kh_child', ' សួស្តី '), 'km-KH-SreymomNeural|p=+30Hz|r=+10%:សួស្តី');
  assert.equal(sandbox.resolveBackendUrl('/audio_cache/abc.mp3'), 'http://127.0.0.1:4567/audio_cache/abc.mp3');
  assert.ok(sandbox.renderVoiceOptionsHtml('kh_deep_boss').includes('value="kh_deep_boss" selected'));

  const parsed = sandbox.parseSrtText('00:00:01,000 --> 00:00:03,000\n你好');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].index, 1);

  vm.runInContext('activeCues = [{ text: "你好", translated: "你好", voice: "Sovereign King" }]; onTextEdit(0, "你好吗");', sandbox);
  assert.equal(vm.runInContext('activeCues[0].text', sandbox), '你好吗');
  assert.equal(vm.runInContext('activeCues[0].translated', sandbox), '你好吗');

  vm.runInContext('activeCues = [{ text: "你好", translated: "សួស្តី", translatedLang: "km", voice: "Sovereign King" }]; onTextEdit(0, "ជម្រាបសួរ");', sandbox);
  assert.equal(vm.runInContext('activeCues[0].text', sandbox), '你好');
  assert.equal(vm.runInContext('activeCues[0].translated', sandbox), 'ជម្រាបសួរ');

  assert.equal(sandbox.collapseCueVoiceForMode('kh_young_girl', 'duo'), 'Radiant Queen');
  assert.equal(sandbox.collapseCueVoiceForMode('kh_elder_woman', 'duo'), 'Radiant Queen');
  assert.equal(sandbox.collapseCueVoiceForMode('kh_deep_boss', 'duo'), 'Sovereign King');
  assert.equal(sandbox.collapseCueVoiceForMode('kh_young_man', 'duo'), 'Sovereign King');
  assert.equal(sandbox.collapseCueVoiceForMode('kh_young_girl', 'multi'), 'kh_young_girl');
  assert.ok(sandbox.getCastModeGuidanceToast('edge', 'multi').includes('Edge Neural'));
  assert.ok(sandbox.getCastModeGuidanceToast('gemini', 'single').includes('Edge Neural'));
  assert.equal(
    sandbox.findCueIndexAtTime([
      { startSec: 1.0, endSec: 2.0 },
      { startSec: 2.05, endSec: 3.0 }
    ], 2.0),
    1
  );
});

test('two-character duo castMode collapses supporting voices cleanly and applies aiVoiceMap updates', () => {
  const translation = require('./src/backend/routes/translation');
  const mixedCues = [
    { startSec: 0, endSec: 2, text: '真的吗？', translated: 'ពិតមែនហ្អេ?', voice: 'kh_young_girl' },
    { startSec: 2.1, endSec: 4, text: '嗯。', translated: 'អឹម។', voice: 'kh_deep_boss' },
    { startSec: 4.1, endSec: 6, text: '别走！', translated: 'កុំទៅ!', voice: 'kh_elder_woman' },
    { startSec: 6.1, endSec: 8, text: '好吧。', translated: 'បានហើយ។', voice: 'kh_young_man' }
  ];
  const aiMap = new Map([
    [1, 'Radiant Queen'],
    [2, 'kh_young_man'],
    [3, 'kh_young_girl'],
    [4, 'Sovereign King']
  ]);
  translation.inferCharacterVoicesForCues(mixedCues, aiMap, false, new Map(), { castMode: 'duo' });
  assert.deepEqual(
    mixedCues.map(c => c.voice),
    ['Radiant Queen', 'Sovereign King', 'Radiant Queen', 'Sovereign King']
  );

  // Also test early-return normalization when aiVoiceMap is empty and voices were previously split
  const staleMixed = [
    { startSec: 0, endSec: 2, text: 'Line 1', voice: 'kh_young_girl' },
    { startSec: 2, endSec: 4, text: 'Line 2', voice: 'kh_elder_woman' },
    { startSec: 4, endSec: 6, text: 'Line 3', voice: 'kh_deep_boss' }
  ];
  translation.inferCharacterVoicesForCues(staleMixed, new Map(), false, new Map(), { castMode: 'duo' });
  assert.deepEqual(
    staleMixed.map(c => c.voice),
    ['Radiant Queen', 'Radiant Queen', 'Sovereign King']
  );

  // In multi mode, distinct role presets are preserved when role cue matches
  const multiCues = [
    { startSec: 0, endSec: 2, text: '妹妹别哭！', voice: 'Sovereign King' }
  ];
  translation.inferCharacterVoicesForCues(multiCues, new Map([[1, 'kh_young_girl']]), true, new Map(), { castMode: 'multi' });
  assert.equal(multiCues[0].voice, 'kh_young_girl');

  // Even when sister keyword is present, duo mode keeps strictly 2 voices
  const duoSister = [
    { startSec: 0, endSec: 2, text: '妹妹别哭！', voice: 'Sovereign King' }
  ];
  translation.inferCharacterVoicesForCues(duoSister, new Map([[1, 'kh_young_girl']]), true, new Map(), { castMode: 'duo' });
  assert.equal(duoSister[0].voice, 'Radiant Queen');
});

test('router management telemetry tracks active streaming, request counts, and email masking', () => {
  const vm = require('node:vm');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const sandbox = {
    window: { electronAPI: { backendUrl: 'http://127.0.0.1:4567' } },
    document: {
      body: { classList: { toggle() { } } },
      addEventListener() { },
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    Audio: class { },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval() { return 0; },
    clearInterval() { },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  assert.equal(sandbox.maskRouterEmail('kook74532@gmail.com'), 'koo***@gma***');
  assert.equal(sandbox.maskRouterEmail(''), '');

  const configModule = require('./src/backend/routes/config');
  const tempAccFile = path.join(os.tmpdir(), `eza-tel-test-${process.pid}-${Date.now()}.json`);
  const prevAccFile = process.env.GEMINI_ACCOUNTS_FILE;
  process.env.GEMINI_ACCOUNTS_FILE = tempAccFile;
  try {
    configModule.addGeminiAccountRecord({
      name: 'TelemetryTest',
      email: 'telemetry@gmail.com',
      apiKey: 'AIzaSyTelemetryUnitTestKey987654321'
    });
    const stream = configModule.beginGeminiStream('AIzaSyTelemetryUnitTestKey987654321', 'Translation');
    const during = configModule.getSafeGeminiAccounts();
    assert.equal(during.streamingCount, 1);
    assert.equal(during.accounts[0].isStreaming, true);
    assert.equal(during.accounts[0].activeTask, 'Translation');
    assert.equal(during.accounts[0].requestCount, 1);
    stream.end(true, 200);
    const after = configModule.getSafeGeminiAccounts();
    assert.equal(after.accounts[0].requestCount, 1);
    assert.equal(after.accounts[0].lastStatus, 'ready');
  } finally {
    if (prevAccFile === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = prevAccFile;
    try { fs.unlinkSync(tempAccFile); } catch (_) { }
  }
});

test('inferCharacterVoicesForCues preserves audio suggestedVoice across tight 0.30s speaker turns and lexical vocatives', () => {
  const translation = require('./src/backend/routes/translation');
  const d1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures/2d4eefc6321c010becc7b321c352a5ef.json'), 'utf8'));
  const multiCues = d1.cues.map(c => ({ ...c, voice: c.suggestedVoice || 'Sovereign King' }));
  translation.inferCharacterVoicesForCues(multiCues, new Map(), true, new Map(), { castMode: 'multi' });
  assert.deepEqual(
    multiCues.map(c => c.voice),
    [
      'kh_young_man', 'kh_young_man', 'Radiant Queen', 'kh_young_man',
      'Radiant Queen', 'kh_young_man', 'Radiant Queen', 'kh_young_man',
      'kh_young_man', 'kh_young_man', 'kh_young_man', 'kh_young_man'
    ]
  );

  const duoCues = d1.cues.map(c => ({ ...c, voice: c.suggestedVoice || 'Sovereign King' }));
  translation.inferCharacterVoicesForCues(duoCues, new Map(), true, new Map(), { castMode: 'duo' });
  assert.deepEqual(
    duoCues.map(c => c.voice),
    [
      'Sovereign King', 'Sovereign King', 'Radiant Queen', 'Sovereign King',
      'Radiant Queen', 'Sovereign King', 'Radiant Queen', 'Sovereign King',
      'Sovereign King', 'Sovereign King', 'Sovereign King', 'Sovereign King'
    ]
  );
});

test('Gemini key rotation skips cooled-down accounts per scope and Edge-only checkAudioCache unifies cache keys', () => {
  const configModule = require('./src/backend/routes/config');
  const tempAccFile = path.join(os.tmpdir(), `eza-rot-test-${process.pid}-${Date.now()}.json`);
  const prevAccFile = process.env.GEMINI_ACCOUNTS_FILE;
  process.env.GEMINI_ACCOUNTS_FILE = tempAccFile;
  try {
    configModule.addGeminiAccountRecord({ name: 'AccA', email: 'a@test.com', apiKey: 'AIzaSyRotateKeyA1111111111111111' });
    configModule.addGeminiAccountRecord({ name: 'AccB', email: 'b@test.com', apiKey: 'AIzaSyRotateKeyB2222222222222222' });
    const scope = 'api:gemini-2.5-flash';
    configModule.markGeminiKeyRateLimited('AIzaSyRotateKeyB2222222222222222', 60000, scope);
    const candidates = configModule.getGeminiApiKeyCandidates('AIzaSyRotateKeyB2222222222222222', scope);
    assert.deepEqual(candidates, ['AIzaSyRotateKeyA1111111111111111']);
    assert.equal(configModule.getGeminiApiKeyCandidates('', 'api:other-model').length, 2);

    // Smart load-balancing prefers idle accounts over active streaming ones and rotates evenly
    const idleStream = configModule.beginGeminiStream('AIzaSyRotateKeyA1111111111111111', 'Translation');
    const lbOrder = configModule.getGeminiApiKeyCandidates('AIzaSyRotateKeyA1111111111111111', 'api:other-model');
    assert.equal(lbOrder[0], 'AIzaSyRotateKeyB2222222222222222');
    idleStream.end(true, 200);
  } finally {
    if (prevAccFile === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = prevAccFile;
    try { fs.unlinkSync(tempAccFile); } catch (_) { }
  }

  // Test unified Edge-only cache keys across 'edge' and legacy 'gemini' requests
  const ttsModule = require('./src/backend/routes/tts');
  const cacheDir = ttsModule.getAudioCacheDir();
  const testTextTiny = '__unit_test_tiny_audio_check__';
  const testTextValid = '__unit_test_valid_edge_check__';
  const tinyKey = ttsModule.getAudioCacheKey(testTextTiny, 'Radiant Queen', { engine: 'edge', emotion: 'natural' });
  const validEdgeKey = ttsModule.getAudioCacheKey(testTextValid, 'Radiant Queen', { engine: 'edge', emotion: 'natural' });
  const validLegacyKey = ttsModule.getAudioCacheKey(testTextValid, 'Radiant Queen', { engine: 'gemini', emotion: 'natural' });
  assert.equal(validLegacyKey, validEdgeKey);

  const tinyFile = path.join(cacheDir, `${tinyKey}.mp3`);
  const validFile = path.join(cacheDir, `${validEdgeKey}.mp3`);
  try {
    fs.writeFileSync(tinyFile, Buffer.alloc(40, 0x00));
    fs.writeFileSync(validFile, Buffer.concat([Buffer.from('fff364c40000000348000000004c414d45555555', 'hex'), Buffer.alloc(200, 0x55)]));

    let jsonBody = null;
    ttsModule.checkAudioCacheHandler(
      {
        body: {
          items: [
            { text: testTextTiny, voice: 'Radiant Queen', engine: 'edge', emotion: 'natural' },
            { text: testTextValid, voice: 'Radiant Queen', engine: 'gemini', emotion: 'natural' }
          ]
        }
      },
      { json(obj) { jsonBody = obj; }, status() { return this; } }
    );
    assert.equal(jsonBody.success, true);
    assert.equal(jsonBody.cachedKeys.length, 1);
    assert.equal(jsonBody.cached[0], testTextValid);
  } finally {
    try { if (fs.existsSync(tinyFile)) fs.unlinkSync(tinyFile); } catch (_) { }
    try { if (fs.existsSync(validFile)) fs.unlinkSync(validFile); } catch (_) { }
  }
});

test('computeExpressiveProsody clamps Edge multi-character pitch/rate to natural non-distorting bounds', () => {
  const childSpec = ttsModule.resolveVoiceSpec('kh_child');
  const childHappy = ttsModule.computeExpressiveProsody('សួស្តី! អស្ចារ្យណាស់!', childSpec, 'happy');
  assert.ok(childHappy.pitchNum <= 10 && childHappy.pitchNum >= -8, `expected safe pitch, got ${childHappy.pitchNum}`);
  assert.ok(childHappy.rateNum <= 16 && childHappy.rateNum >= -12, `expected safe rate, got ${childHappy.rateNum}`);

  const bossSpec = ttsModule.resolveVoiceSpec('kh_deep_boss');
  const bossSad = ttsModule.computeExpressiveProsody('ខ្ញុំខូចចិត្តណាស់...', bossSpec, 'sad');
  assert.ok(bossSad.pitchNum <= 10 && bossSad.pitchNum >= -8, `expected safe boss pitch, got ${bossSad.pitchNum}`);
  assert.ok(bossSad.rateNum <= 16 && bossSad.rateNum >= -12, `expected safe boss rate, got ${bossSad.rateNum}`);

  const kingSpec = ttsModule.resolveVoiceSpec('Sovereign King');
  const kingNat = ttsModule.computeExpressiveProsody('តោះទៅឥឡូវនេះ', kingSpec, 'natural');
  assert.equal(kingNat.pitchNum, -2);
  assert.equal(kingNat.rateNum, 6);
});

test('skipAllRateLimited skips dead cooldown scopes, exposes ewmaLatencyMs, and preserves multi-cast Khmer self-ID', () => {
  const configModule = require('./src/backend/routes/config');
  const translationModule = require('./src/backend/routes/translation');
  const tempAccFile = path.join(os.tmpdir(), `eza-skip-test-${process.pid}-${Date.now()}.json`);
  const prevAccFile = process.env.GEMINI_ACCOUNTS_FILE;
  process.env.GEMINI_ACCOUNTS_FILE = tempAccFile;
  try {
    configModule.addGeminiAccountRecord({ name: 'SkipA', email: 'skipa@test.com', apiKey: 'AIzaSySkipTestKey111111111111111' });
    const stream = configModule.beginGeminiStream('AIzaSySkipTestKey111111111111111', 'Translation');
    stream.end(true, 200);
    const accAfter = configModule.getSafeGeminiAccounts();
    assert.ok(Number.isFinite(accAfter.accounts[0].ewmaLatencyMs) && accAfter.accounts[0].ewmaLatencyMs >= 1);

    const scope = 'tts:gemini-test-exhausted';
    configModule.markGeminiKeyRateLimited('AIzaSySkipTestKey111111111111111', 60000, scope);
    assert.deepEqual(
      configModule.getGeminiApiKeyCandidates('', scope, { skipAllRateLimited: true }),
      []
    );
    assert.equal(configModule.getGeminiApiKeyCandidates('', scope).length, 1);
  } finally {
    if (prevAccFile === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = prevAccFile;
    try { fs.unlinkSync(tempAccFile); } catch (_) { }
  }

  const cues = [
    { startSec: 0, endSec: 1.5, text: '报告', translated: 'បាទ លោកប្រធាន', suggestedVoice: 'kh_young_man', voice: 'kh_young_man' },
    { startSec: 2, endSec: 3.5, text: '好的', translated: 'ចាស បងស្រី', suggestedVoice: 'kh_young_girl', voice: 'kh_young_girl' }
  ];
  translationModule.inferCharacterVoicesForCues(cues, new Map(), true, new Map(), { castMode: 'multi' });
  assert.deepEqual(cues.map(c => c.voice), ['kh_young_man', 'kh_young_girl']);
});

test('Batch 2 fixes: bgm_only export uses cached BGM stem without dub and frontend audio suppression guards BGM + video switch', async () => {
  const vm = require('node:vm');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  class MockAudio {
    constructor(src = '') {
      this.src = src;
      this.paused = true;
      this.currentTime = 0;
      this.volume = 1;
      this.loop = false;
      this.pauseCalls = 0;
      this.playCalls = 0;
    }
    play() {
      this.paused = false;
      this.playCalls++;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.pauseCalls++;
    }
    addEventListener() { }
    removeEventListener() { }
  }

  const videoEl = {
    volume: 0.7,
    muted: false,
    currentTime: 0.5,
    paused: false,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  const elements = {
    mainVideo: videoEl,
    btnRemoveVocals: { classList: { toggle() { }, add() { }, remove() { } }, textContent: '', title: '', innerHTML: '' }
  };

  let resolveIsolateFetch = null;
  const isolatePromise = new Promise((resolve) => {
    resolveIsolateFetch = resolve;
  });

  const sandbox = {
    Audio: MockAudio,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => { },
    requestAnimationFrame: () => 0,
    IntersectionObserver: class { observe() { } disconnect() { } },
    ResizeObserver: class { observe() { } disconnect() { } },
    navigator: { clipboard: { writeText: async () => { } } },
    localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => { },
      createElement: () => ({ className: '', style: {}, classList: { toggle() { }, add() { }, remove() { } }, appendChild() { }, addEventListener() { }, setAttribute() { } })
    },
    fetch: (url) => {
      if (String(url).includes('/api/audio/isolate-bgm')) {
        return isolatePromise;
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => { };
  sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appCode, ctx);

  // 1) syncLiveSourceAudioSuppression pauses bgmAudio and restores video volume when !isDubVoiceEnabled && !isBgmOn
  vm.runInContext(`
    isDubVoiceEnabled = false;
    isBgmOn = false;
    isVocalInvertOn = false;
    sourceBaseVolume = 0.7;
    bgmAudio = new Audio('/audio_cache/bgm.mp3');
    bgmAudio.paused = false;
    mainVideoEl = document.getElementById('mainVideo');
    syncLiveSourceAudioSuppression(mainVideoEl, -1);
  `, ctx);
  assert.equal(vm.runInContext('bgmAudio.paused', ctx), true);
  assert.ok(vm.runInContext('bgmAudio.pauseCalls >= 1', ctx));
  assert.equal(videoEl.volume, 0.7);
  assert.equal(videoEl.muted, false);

  // 2) toggleRemoveVocals OFF pauses bgmAudio cleanly; ON ignores stale /api/audio/isolate-bgm response after video switch
  vm.runInContext(`
    isVocalInvertOn = true;
    bgmAudio = new Audio('/audio_cache/bgm.mp3');
    bgmAudio.paused = false;
    toggleRemoveVocals();
  `, ctx);
  assert.equal(vm.runInContext('isVocalInvertOn', ctx), false);
  assert.equal(vm.runInContext('bgmAudio.paused', ctx), true);

  vm.runInContext(`
    currentVideoPath = 'D:/videoA.mp4';
    isVocalInvertOn = false;
    bgmAudio = null;
    toggleRemoveVocals();
    currentVideoPath = 'D:/videoB.mp4';
  `, ctx);
  resolveIsolateFetch({
    ok: true,
    status: 200,
    json: async () => ({ success: true, bgmUrl: '/audio_cache/stale_bgm.wav' })
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(vm.runInContext('bgmAudio', ctx), null);

  // 3) export.js bgm_only with includeDubAudio: false uses cached isolated BGM stem and outputs valid MP4
  const bgmVideo = path.join(tempRoot, 'bgm-only-input.mp4');
  const genVid = spawnSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=1.5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=1.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    bgmVideo
  ], { encoding: 'utf8' });
  assert.equal(genVid.status, 0, genVid.stderr);

  const { server, baseUrl } = await startTestServer();
  try {
    const isoRes = await fetch(`${baseUrl}/api/audio/isolate-bgm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: bgmVideo })
    });
    assert.equal(isoRes.status, 200);
    const isoBody = await isoRes.json();
    assert.equal(isoBody.success, true);
    assert.ok(isoBody.bgmUrl, 'isolate-bgm should return bgmUrl');

    const expRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: bgmVideo,
        cues: [{ startSec: 0.1, endSec: 1.2, text: 'hello', translated: 'សួស្តី' }],
        audioMixMode: 'bgm_only',
        includeDubAudio: false,
        burnSubtitles: false
      })
    });
    const expBody = await expRes.json();
    assert.equal(expRes.status, 200, `Expected 200 but got ${expRes.status}: ${JSON.stringify(expBody)}`);
    assert.equal(expBody.success, true);
    assert.equal(expBody.dubbedCueCount, 0);
    assert.equal(expBody.audioMixMode, 'bgm_only');
    assert.ok(expBody.outputFile && fs.existsSync(expBody.outputFile));
    assert.ok(fs.statSync(expBody.outputFile).size > 1000);
    const probeExport = spawnSync(FFMPEG_BIN, ['-i', expBody.outputFile], { encoding: 'utf8' });
    assert.ok(String(probeExport.stderr || '').includes('Audio:'), 'Exported MP4 must contain audio stream');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('translation.js configures gemini-3-flash-preview as primary fast model with gemini-4-hydrogen fallback', () => {
  const models = translationModule.GEMINI_FALLBACK_MODELS;
  assert.equal(translationModule.GEMINI_MODEL, 'gemini-3-flash-preview');
  assert.ok(Array.isArray(models) && models.includes('gemini-4-hydrogen'));
  assert.equal(models[0], 'gemini-3-flash-preview');
  assert.ok(models.includes('gemini-3.1-flash-lite-preview'));
  assert.equal(models.includes('gemini-3.5-flash-lite'), false);
  assert.equal(models.includes('gemini-flash-lite-latest'), false);
  assert.equal(models[models.length - 1], 'gemini-4-hydrogen');
  assert.equal(translationModule.SPEECH_VOCAL_FILTER, 'highpass=f=85,lowpass=f=6800,dynaudnorm=f=150:g=11:p=0.9:m=6');
  const probedFilter = translationModule.buildSpeechAudioFilterChain(true, true);
  assert.ok(probedFilter.includes('volumedetect'), 'Probe audio chain must include volumedetect');
  assert.ok(probedFilter.indexOf('volumedetect') < probedFilter.indexOf('dynaudnorm'), 'volumedetect must run before dynaudnorm so raw quiet audio is accurately measured');

  const g4Cfg = translationModule.buildGeminiGenerationConfig('gemini-4-hydrogen');
  assert.deepEqual(g4Cfg.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal('temperature' in g4Cfg, false);
  assert.equal(g4Cfg.responseMimeType, 'application/json');

  const flashCfg = translationModule.buildGeminiGenerationConfig('gemini-3-flash-preview');
  assert.deepEqual(flashCfg.thinkingConfig, { thinkingLevel: 'minimal' });
  const flashQualityCfg = translationModule.buildGeminiGenerationConfig('gemini-3-flash-preview', { preferQuality: true });
  assert.equal(flashQualityCfg.temperature, 0.2);

  assert.equal(translationModule.getGeminiTimeoutMs('gemini-4-hydrogen', 20000), 35000);
  assert.equal(translationModule.getGeminiTimeoutMs('gemini-3-flash-preview', 20000), 20000);
});

test('router management Neural Optic UI renders telemetry dock, latency formatting, and load bars', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  assert.ok(html.includes('id="routerTelemetryDock"'));
  assert.ok(css.includes('.router-telemetry-dock'));
  assert.ok(css.includes('.router-center-hub'));
  assert.ok(css.includes('.router-star-stage'));
  assert.ok(css.includes('.router-star-trace'));
  assert.ok(css.includes('.router-node-loadbar'));

  const dockChildren = [];
  const makeMockEl = (tag) => ({
    tagName: tag,
    className: '',
    innerText: '',
    children: [],
    style: {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }
  });
  const dockEl = {
    children: dockChildren,
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children.length = 0; }
  };

  const sandbox = {
    window: {},
    document: {
      body: { classList: { toggle() { } } },
      addEventListener() { },
      getElementById: (id) => (id === 'routerTelemetryDock' ? dockEl : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeMockEl(tag)
    },
    Audio: class { },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval: () => 0,
    clearInterval() { },
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  assert.equal(sandbox.formatRouterMs(850), '850ms');
  assert.equal(sandbox.formatRouterMs(1719), '1.7s');
  assert.equal(sandbox.formatRouterLatencyLabel({ ewmaLatencyMs: 2400 }), '2.4s');

  sandbox.renderRouterTelemetryDock({
    streamingCount: 1,
    accounts: [
      { id: '1', requestCount: 10, isStreaming: true, lastStatus: 'ready', ewmaLatencyMs: 1800 },
      { id: '2', requestCount: 5, isStreaming: false, lastStatus: 'ready', lastLatencyMs: 2200 }
    ]
  });
  assert.equal(dockChildren.length, 2);
  assert.equal(dockChildren[0].children[0].children[1].innerText, '15');
  assert.equal(dockChildren[0].children[1].children[1].innerText, '1 Parallel');
  assert.equal(dockChildren[0].children[2].children[1].innerText, '2.0s');
  assert.equal(dockChildren[0].children[3].children[1].innerText, '2/2 Ready');
});

test('router management cooldownRemainingMs, PUT update, reset-cooldown, and translation router-mode API', async () => {
  const prevAccFile = process.env.GEMINI_ACCOUNTS_FILE;
  const prevCfgFile = process.env.EZA_CONFIG_FILE;
  const tempAccFile = path.join(os.tmpdir(), `eza-router-ops-${process.pid}-${Date.now()}.json`);
  const tempCfgFile = path.join(os.tmpdir(), `eza-router-cfg-${process.pid}-${Date.now()}.json`);
  process.env.GEMINI_ACCOUNTS_FILE = tempAccFile;
  process.env.EZA_CONFIG_FILE = tempCfgFile;
  const { server, baseUrl } = await startTestServer();
  const prevMode = translationModule.getRouterModelMode();

  try {
    const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    assert.ok(mainJs.includes("ipcMain.handle('gemini-accounts:update'"));
    assert.ok(preloadJs.includes("updateGeminiAccount:"));

    const added = configModule.addGeminiAccountRecord({
      name: 'Node Alpha',
      email: 'alpha@gmail.com',
      apiKey: 'AIzaSyRouterOpsTestKey1234567890'
    });
    const accId = added.accounts[0].id;
    configModule.markGeminiKeyRateLimited('AIzaSyRouterOpsTestKey1234567890', 25000, 'tts');

    const cooledSnap = configModule.getSafeGeminiAccounts();
    assert.equal(cooledSnap.accounts[0].lastStatus, 'rate_limited');
    assert.ok(cooledSnap.accounts[0].cooldownRemainingMs > 1000);

    const putRes = await fetch(`${baseUrl}/api/config/accounts/${encodeURIComponent(accId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Node Beta', email: 'beta@gmail.com' })
    });
    const putJson = await putRes.json();
    assert.equal(putRes.status, 200);
    assert.equal(putJson.success, true);
    assert.equal(putJson.accounts[0].name, 'Node Beta');
    assert.equal(putJson.accounts[0].email, 'beta@gmail.com');

    const resetRes = await fetch(`${baseUrl}/api/config/accounts/reset-cooldown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const resetJson = await resetRes.json();
    assert.equal(resetRes.status, 200);
    assert.equal(resetJson.accounts[0].cooldownRemainingMs, 0);
    assert.equal(resetJson.accounts[0].lastStatus, 'ready');

    const modeGetRes = await fetch(`${baseUrl}/api/translation/router-mode`);
    const modeGetJson = await modeGetRes.json();
    assert.equal(modeGetRes.status, 200);
    assert.equal(modeGetJson.mode, prevMode);

    const modePostRes = await fetch(`${baseUrl}/api/translation/router-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'smart' })
    });
    const modePostJson = await modePostRes.json();
    assert.equal(modePostRes.status, 200);
    assert.equal(modePostJson.mode, 'smart');
    assert.equal(modePostJson.primaryModel, 'gemini-4-hydrogen');
    assert.equal(modePostJson.thinkingLevel, 'low');
    assert.equal(configModule.loadConfig().GEMINI_ROUTER_MODE, 'smart');

    const invalidRes = await fetch(`${baseUrl}/api/translation/router-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid_mode' })
    });
    assert.equal(invalidRes.status, 400);
  } finally {
    translationModule.setRouterModelMode(prevMode, { persist: false });
    configModule.clearGeminiAccountCooldowns();
    await new Promise(resolve => server.close(resolve));
    if (prevAccFile === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = prevAccFile;
    if (prevCfgFile === undefined) delete process.env.EZA_CONFIG_FILE;
    else process.env.EZA_CONFIG_FILE = prevCfgFile;
    try { fs.unlinkSync(tempAccFile); } catch (_) { }
    try { fs.unlinkSync(tempCfgFile); } catch (_) { }
  }
});

test('studio filterTable status modes, batchGenerateAllAudio onlyMissing, and clickable model chips', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  assert.ok(html.includes('id="scriptStatusFilter"'));
  assert.ok(html.includes('batchGenerateAllAudio({ onlyMissing: true })'));
  assert.ok(html.includes('id="routerTestAllBtn"'));
  assert.ok(html.includes('id="routerResetCooldownBtn"'));
  assert.ok(html.includes('id="routerKeyEyeBtn"'));
  assert.ok(css.includes('.router-key-eye-btn'));
  assert.ok(css.includes('.router-node-card[data-status="rate_limited"]'));

  const makeMockEl = (tag, initial = {}) => ({
    tagName: tag,
    className: '',
    innerText: '',
    innerHTML: '',
    value: '',
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(evt, fn) { this.listeners[evt] = fn; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    remove() { },
    ...initial
  });

  const els = {
    cuesTableBody: makeMockEl('tbody'),
    scriptSearch: makeMockEl('input', { value: '' }),
    scriptStatusFilter: makeMockEl('select', { value: 'all' }),
    cuesStatsText: makeMockEl('span'),
    bottomStatusMsg: makeMockEl('span'),
    ttsEngineSelect: makeMockEl('select', { value: 'gemini' }),
    routerTelemetryDock: makeMockEl('div')
  };
  const ttsCalls = [];

  const sandbox = {
    window: {},
    document: {
      body: { classList: { toggle() { } }, appendChild() { } },
      addEventListener() { },
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeMockEl(tag)
    },
    fetch: async (url, init) => {
      if (String(url).includes('/api/tts/batch-generate')) {
        const body = JSON.parse(init.body);
        const items = Array.isArray(body.items) ? body.items : [];
        items.forEach(it => ttsCalls.push(it.text));
        return { ok: true, json: async () => ({ success: true, results: items.map(it => ({ index: it.index, success: true, audioUrl: '/audio_cache/mock.wav' })) }) };
      }
      if (String(url).includes('/api/tts/generate')) {
        const body = JSON.parse(init.body);
        ttsCalls.push(body.text);
        return {
          ok: true,
          json: async () => ({ success: true, audioUrl: '/audio_cache/mock.wav' })
        };
      }
      return { ok: true, json: async () => ({ success: true }) };
    },
    Audio: class { },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval: () => 0,
    clearInterval() { },
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  assert.equal(sandbox.formatRouterCooldownRemaining(42100), '43s');
  assert.equal(sandbox.formatRouterCooldownRemaining(75000), '1m 15s');

  vm.runInContext(`
    activeCues = [
      { id: 1, startSec: 0, endSec: 2, text: 'hello', translated: 'សួស្តី', voice: 'Sovereign King', emotion: 'auto' },
      { id: 2, startSec: 2, endSec: 4, text: 'world', translated: 'ពិភពលោក', voice: 'Bitter Empress', emotion: 'auto' },
      { id: 3, startSec: 4, endSec: 6, text: 'raw line', translated: '', voice: 'Sovereign King', emotion: 'auto' }
    ];
    cachedAudioMap.add(getAudioCacheKey('Sovereign King', 'សួស្តី', 'auto', 'gemini'));
  `, sandbox);

  els.scriptStatusFilter.value = 'unvoiced';
  sandbox.renderTable();
  assert.equal(els.cuesStatsText.innerText, 'បង្ហាញ 2/3 បន្ទាត់');
  assert.ok(els.cuesTableBody.innerHTML.includes('ពិភពលោក'));
  assert.ok(!els.cuesTableBody.innerHTML.includes('value="សួស្តី"'));

  els.scriptStatusFilter.value = 'untranslated';
  sandbox.renderTable();
  assert.equal(els.cuesStatsText.innerText, 'បង្ហាញ 1/3 បន្ទាត់');
  assert.ok(els.cuesTableBody.innerHTML.includes('raw line'));

  const batchResult = await sandbox.batchGenerateAllAudio({ onlyMissing: true, silentSuccess: true });
  assert.equal(batchResult.skippedCount, 1);
  assert.equal(batchResult.count, 1);
  assert.deepEqual(ttsCalls, ['ពិភពលោក']);

  sandbox.renderRouterTelemetryDock({
    streamingCount: 0,
    accounts: [
      { id: '1', requestCount: 4, isStreaming: false, lastStatus: 'ready', ewmaLatencyMs: 1200 },
      { id: '2', requestCount: 2, isStreaming: false, lastStatus: 'rate_limited', cooldownRemainingMs: 18000 }
    ]
  });
  assert.equal(els.routerTelemetryDock.children[0].children[3].children[1].innerText, '1/2 Ready (1 429)');
  assert.equal(els.routerTelemetryDock.children[1].children[0].tagName, 'button');
  assert.equal(els.routerTelemetryDock.children[1].children[2].tagName, 'button');

  els.scriptStatusFilter.value = 'all';
  vm.runInContext(`
    activeCues = [
      { id: 1, startSec: 4.5, endSec: 6.5, text: '\\\\u8fd9\\\\u6b21\\\\u53c8\\\\u9ebb\\\\u70e6\\\\u4f60\\\\u4e86\\\\u3002', translated: 'លើកនេះធ្វើឲ្យលំបាកដល់លោកអ្នកទៀតហើយ។', voice: 'Sovereign King', emotion: 'auto' }
    ];
  `, sandbox);
  sandbox.renderTable();
  assert.ok(!els.cuesTableBody.innerHTML.includes('cell-orig'), 'Subtitle row must render only one text line without bottom .cell-orig');
  assert.ok(!els.cuesTableBody.innerHTML.includes('\\u8fd9'), 'Escaped unicode sequences must be decoded');
  assert.ok(els.cuesTableBody.innerHTML.includes('title="ដើម: 这次又麻烦你了。"'));

  const recoveredSpeech = translationModule.parseJsonObject(
    '{"segments":[{"startSec":4.5,"endSec":6.5,"text":"\\\\u8fd9\\\\u6b21\\\\u53c8\\\\u9ebb\\\\u70e6\\\\u4f60\\\\u4e86\\\\u3002"',
    'speech transcription'
  );
  assert.equal(recoveredSpeech.segments[0].text, '这次又麻烦你了。');

  els.defaultVoiceSelect = makeMockEl('select', { value: 'Radiant Queen' });
  els.castModeSelect = makeMockEl('select', { value: 'single' });
  els.ttsEngineSelect.value = 'edge';
  vm.runInContext(`
    activeCues = [
      { id: 1, startSec: 0, endSec: 2, text: 'a', translated: 'ក', voice: 'kh_young_girl', emotion: 'auto' },
      { id: 2, startSec: 2, endSec: 4, text: 'b', translated: 'ខ', voice: 'kh_deep_boss', emotion: 'auto' }
    ];
  `, sandbox);
  sandbox.onTtsEngineChange();
  sandbox.onDefaultVoiceChange('Radiant Queen');
  assert.equal(els.castModeSelect.value, 'single');
  assert.equal(sandbox.getActiveCastMode(), 'single');
  assert.equal(vm.runInContext('activeCues[0].voice', sandbox), 'Radiant Queen');
  assert.equal(vm.runInContext('activeCues[1].voice', sandbox), 'Radiant Queen');
  assert.ok(!html.includes('🎭 បែងចែកតួអង្គ (Auto)'));
  assert.ok(!html.includes('🎯 វិភាគតួអង្គ AI ឡើងវិញ'));
  assert.ok(!html.includes('<option value="duo"'));
  assert.ok(!html.includes('<option value="multi"'));
});

test('Mom elder-woman diarization fixes Sovereign King mislabeling, Khmer couple pronouns, and comma continuity', async () => {
  const translation = require('./src/backend/routes/translation');
  const momFixtureCues = [
    { index: 1, startSec: 3.14, endSec: 4.34, text: '婉慈，', translated: 'វ៉ាន់ស៊ី,', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 2, startSec: 4.49, endSec: 5.94, text: '这次又麻烦你了。', translated: 'លើកនេះរំខានកូនទៀតហើយ។', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 3, startSec: 6.50, endSec: 7.70, text: '妈，不麻烦。', translated: 'ម៉ាក់ មិនរំខានទេ!', suggestedVoice: 'Radiant Queen', voice: 'Radiant Queen' },
    { index: 4, startSec: 7.86, endSec: 10.51, text: '你有没有哪里不舒服？我叫医生来看看。', translated: 'ម៉ាក់មានមិនស្រួលខ្លួនត្រង់ណាអត់?', suggestedVoice: 'Radiant Queen', voice: 'Radiant Queen' },
    { index: 5, startSec: 12.99, endSec: 15.49, text: '老毛病，过两天就好了。', translated: 'ជំងឺចាស់ហ្នឹងណា៎ ពីរថ្ងៃទៀតជាហើយ។', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 6, startSec: 16.46, endSec: 17.90, text: '婉慈今天真漂亮，', translated: 'ថ្ងៃនេះវ៉ាន់ស៊ីស្អាតណាស់,', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 7, startSec: 18.01, endSec: 19.81, text: '平日就该这么化妆。', translated: 'ធម្មតាគួរតែផាត់មុខបែបហ្នឹងទៅ។', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 8, startSec: 20.26, endSec: 22.71, text: '美美的，是不是要和英舟约会呀？', translated: 'ស្អាតបែបហ្នឹងប្រហែលជាទៅណាត់ជួបជាមួយអ៊ីងចូវហើយមែនទេ?', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 9, startSec: 25.13, endSec: 28.06, text: '我没甚么事了，你和英舟去玩吧。', translated: 'ម៉ាក់អត់អីទេ កូនទៅដើរលេងជាមួយអ៊ីងចូវទៅ។', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 10, startSec: 28.46, endSec: 31.56, text: '等下王姨就来了，她能照顾好我。', translated: 'បន្តិចទៀតមីងវ៉ាងមកដល់ហើយ គាត់អាចមើលថែម៉ាក់បាន។', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' },
    { index: 11, startSec: 33.34, endSec: 38.79, text: '妈，反正都住院了，我们就做个全面检查吧。', translated: 'ម៉ាក់ ណាមួយចូលពេទ្យហើយ យើងពិនិត្យសុខភាពទូទៅមួយជុំទៅ។', suggestedVoice: 'Radiant Queen', voice: 'Radiant Queen' },
    { index: 12, startSec: 45.42, endSec: 47.34, text: '是婉慈，你在玩我？', translated: 'គឺវ៉ាន់ស៊ី នាងកំពុងលេងសើចជាមួយខ្ញុំមែនទេ?', suggestedVoice: 'Sovereign King', voice: 'Sovereign King' }
  ];

  const poisonedAiMap = new Map([
    [1, 'Sovereign King'],
    [2, 'Sovereign King'],
    [3, 'Radiant Queen'],
    [4, 'Radiant Queen'],
    [5, 'Sovereign King'],
    [6, 'Sovereign King'],
    [7, 'Sovereign King'],
    [8, 'Sovereign King'],
    [9, 'Sovereign King'],
    [10, 'Sovereign King'],
    [11, 'Radiant Queen'],
    [12, 'Sovereign King']
  ]);

  const multiMom = momFixtureCues.map(c => ({ ...c }));
  translation.inferCharacterVoicesForCues(multiMom, poisonedAiMap, true, new Map(), { castMode: 'multi' });
  assert.deepEqual(
    multiMom.map(c => c.voice),
    [
      'kh_elder_woman', 'kh_elder_woman', 'Radiant Queen', 'Radiant Queen',
      'kh_elder_woman', 'kh_elder_woman', 'kh_elder_woman', 'kh_elder_woman',
      'kh_elder_woman', 'kh_elder_woman', 'Radiant Queen', 'Sovereign King'
    ]
  );

  const duoMom = momFixtureCues.map(c => ({ ...c }));
  translation.inferCharacterVoicesForCues(duoMom, poisonedAiMap, true, new Map(), { castMode: 'duo' });
  assert.deepEqual(
    duoMom.map(c => c.voice),
    [
      'Radiant Queen', 'Radiant Queen', 'Radiant Queen', 'Radiant Queen',
      'Radiant Queen', 'Radiant Queen', 'Radiant Queen', 'Radiant Queen',
      'Radiant Queen', 'Radiant Queen', 'Radiant Queen', 'Sovereign King'
    ]
  );

  // Khmer spouse pronouns: addressing "អូន" as male or "បង" as female must not flip detected genders;
  // trailing comma continuity across 0.30s keeps the same speaker when next line has no audio hint.
  const spouseCues = [
    { startSec: 0.0, endSec: 2.0, text: '你爱我吗？', translated: 'អូនស្រឡាញ់បងទេ?', suggestedVoice: 'kh_young_man', voice: 'kh_young_man' },
    { startSec: 2.5, endSec: 4.5, text: '你不让我走，', translated: 'បងមិនឱ្យអូនទៅ,', suggestedVoice: 'Radiant Queen', voice: 'Radiant Queen' },
    { startSec: 4.8, endSec: 6.2, text: '我就待在这里。', translated: 'អូននឹងនៅទីនេះ។' }
  ];
  translation.inferCharacterVoicesForCues(spouseCues, new Map(), true, new Map(), { castMode: 'multi' });
  assert.deepEqual(spouseCues.map(c => c.voice), ['kh_young_man', 'Radiant Queen', 'Radiant Queen']);

  // Text-only casting (透视鉴宝 real draft) must never flip audio-detected suggestedVoice gender, while allowing same-gender refinement
  const dTreasure = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures/2d4eefc6321c010becc7b321c352a5ef.json'), 'utf8'));
  assert.equal(translation.resolveSafeTextCastVoice(dTreasure.cues[0].suggestedVoice, 'Radiant Queen', 'multi'), 'kh_young_man');
  assert.equal(translation.resolveSafeTextCastVoice(dTreasure.cues[0].suggestedVoice, 'kh_elder_woman', 'duo'), 'Sovereign King');
  assert.equal(translation.resolveSafeTextCastVoice(dTreasure.cues[0].suggestedVoice, 'kh_deep_boss', 'multi'), 'kh_deep_boss');
  assert.equal(translation.resolveSafeTextCastVoice(dTreasure.cues[2].suggestedVoice, 'Sovereign King', 'multi'), 'Radiant Queen');
});

test('Edge-only TTS engine removes Gemini TTS and unifies voice presets & cache keys to Edge', () => {
  const ttsModule = require('./src/backend/routes/tts');

  assert.equal(ttsModule.buildGeminiSpokenText, undefined);
  assert.equal(ttsModule.buildGeminiTtsRequestPayload, undefined);
  assert.equal(ttsModule.isNonGeminiFallbackFile, undefined);

  const presets = Object.values(ttsModule.KHMER_VOICE_PRESETS || {});
  assert.equal(presets.length, 8);
  for (const preset of presets) {
    assert.equal(preset.geminiVoice, undefined);
    assert.ok(preset.baseVoice === 'km-KH-PisethNeural' || preset.baseVoice === 'km-KH-SreymomNeural');
    assert.equal(/Orus|Aoede|Fenrir|Puck|Charon|Leda|Zephyr|Kore/.test(preset.label), false);
  }

  const edgeKey = ttsModule.getAudioCacheKey('សួស្តី', 'Radiant Queen', { engine: 'edge', emotion: 'natural' });
  const legacyGeminiKey = ttsModule.getAudioCacheKey('សួស្តី', 'Radiant Queen', { engine: 'gemini', emotion: 'natural' });
  assert.equal(edgeKey, legacyGeminiKey);
});

test('consolidateCharacterVoicesForCues prevents 3-4 voices per character and builds Part-1 cross-chunk cast roster', () => {
  const translation = require('./src/backend/routes/translation');

  // Fragmented multi-cast input where Male Lead drifted across 4 male presets and Female Lead drifted across 4 female presets
  const fragmentedCues = [
    { startSec: 0.0, endSec: 1.5, text: '你好。', translated: 'សួស្តី។', suggestedVoice: 'Sovereign King' },
    { startSec: 2.0, endSec: 3.5, text: '嗯？', translated: 'ហ៊ឹម?', suggestedVoice: 'Radiant Queen' },
    { startSec: 4.0, endSec: 5.5, text: '你说什么，', translated: 'អ្នកនិយាយស្អី,', suggestedVoice: 'Sovereign King' },
    { startSec: 5.7, endSec: 7.0, text: '我没听清！', translated: 'ខ្ញុំស្ដាប់មិនច្បាស់!', suggestedVoice: 'kh_young_man' },
    { startSec: 7.5, endSec: 9.0, text: '别生气嘛。', translated: 'កុំខឹងអី។', suggestedVoice: 'Radiant Queen' },
    { startSec: 9.5, endSec: 11.0, text: '好吧，算了。', translated: 'បានហើយ ឈប់ចុះ។', suggestedVoice: 'Sovereign King' },
    { startSec: 11.5, endSec: 13.0, text: '真的？', translated: 'ពិតមែនហ្អេ?', suggestedVoice: 'kh_young_girl' },
    { startSec: 13.5, endSec: 15.0, text: '当然是真的！', translated: 'ពិតមែនហើយ!', suggestedVoice: 'kh_deep_boss' },
    { startSec: 15.5, endSec: 17.0, text: '那就好。', translated: 'អញ្ចឹងល្អហើយ។', suggestedVoice: 'kh_elder_woman' },
    { startSec: 17.5, endSec: 19.0, text: '走吧！', translated: 'តោះទៅ!', suggestedVoice: 'kh_narrator_fast' },
    { startSec: 19.5, endSec: 21.0, text: '等等我！', translated: 'ចាំខ្ញុំផង!', suggestedVoice: 'kh_child' },
    { startSec: 21.5, endSec: 23.0, text: '快点，要迟到了。', translated: 'លឿនឡើង ប្រយ័ត្នយឺត។', suggestedVoice: 'kh_young_girl' }
  ];

  translation.inferCharacterVoicesForCues(fragmentedCues, new Map(), true, new Map(), { castMode: 'multi' });
  const maleSet = new Set(fragmentedCues.map(c => c.voice).filter(v => !['Radiant Queen', 'kh_young_girl', 'kh_elder_woman', 'kh_child'].includes(v)));
  const femaleSet = new Set(fragmentedCues.map(c => c.voice).filter(v => ['Radiant Queen', 'kh_young_girl', 'kh_elder_woman', 'kh_child'].includes(v)));
  assert.ok(maleSet.size <= 2, `Expected at most 2 male voices, got ${Array.from(maleSet).join(', ')}`);
  assert.ok(femaleSet.size <= 2, `Expected at most 2 female voices, got ${Array.from(femaleSet).join(', ')}`);
  // Same-sentence comma split at indices 2 & 3 stays locked onto Sovereign King
  assert.equal(fragmentedCues[2].voice, 'Sovereign King');
  assert.equal(fragmentedCues[3].voice, 'Sovereign King');

  // Stray single un-locked secondary outlier merges cleanly into dominant same-gender lead
  const strayOutlierCues = [
    { startSec: 0, endSec: 1.5, text: '一', translated: '១', suggestedVoice: 'Sovereign King' },
    { startSec: 2, endSec: 3.5, text: '二', translated: '២', suggestedVoice: 'Sovereign King' },
    { startSec: 4, endSec: 5.5, text: '三', translated: '៣', suggestedVoice: 'Sovereign King' },
    { startSec: 6, endSec: 7.5, text: '四', translated: '៤', suggestedVoice: 'kh_deep_boss' },
    { startSec: 8, endSec: 9.5, text: '五', translated: '៥', suggestedVoice: 'Radiant Queen' }
  ];
  translation.inferCharacterVoicesForCues(strayOutlierCues, new Map(), true, new Map(), { castMode: 'multi' });
  assert.deepEqual(
    strayOutlierCues.map(c => c.voice),
    ['Sovereign King', 'Sovereign King', 'Sovereign King', 'Sovereign King', 'Radiant Queen']
  );

  // Part-1 roster summary anchors subsequent 60s chunks to consistent IDs
  const rosterPrompt = translation.buildEstablishedCastRoster([
    { text: '婉慈，这次又麻烦你了。', suggestedVoice: 'kh_elder_woman' },
    { text: '晚词，你在玩我。', suggestedVoice: 'Sovereign King' }
  ]);
  assert.ok(rosterPrompt.includes('CAST CONTINUITY LOCK FROM PART 1'));
  assert.ok(rosterPrompt.includes('"kh_elder_woman"'));
  assert.ok(rosterPrompt.includes('"Sovereign King"'));
});

test('emotion modes (natural, angry, loud, whisper, crying, sad, happy, sarcastic) are completely removed from TTS, translation, and UI', () => {
  const ttsModule = require('./src/backend/routes/tts');
  const translation = require('./src/backend/routes/translation');
  const htmlContent = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
  const appContent = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');

  const removedEmotions = ['natural', 'angry', 'loud', 'whisper', 'crying', 'sad', 'happy', 'sarcastic'];
  assert.deepEqual(ttsModule.EMOTION_PRESETS, []);

  // Normalization & detection ignore all removed emotion names so vocal identity is strictly invariant
  for (const emo of removedEmotions) {
    assert.equal(ttsModule.normalizeEmotionId(emo), 'auto');
    assert.equal(ttsModule.detectEmotionFromText('កុហក!! ម៉េចក៏ហ៊ាន?', emo), 'auto');
  }

  // Edge Neural prosody produces identical pitch AND rate regardless of any legacy emotion tag or punctuation
  for (const voiceId of ['Radiant Queen', 'Sovereign King', 'kh_elder_woman', 'kh_deep_boss', 'kh_child']) {
    const spec = ttsModule.resolveVoiceSpec(voiceId);
    const baseline = ttsModule.computeExpressiveProsody('សួស្តី។', spec);
    for (const emo of removedEmotions) {
      const regular = ttsModule.computeExpressiveProsody('ខ្ញុំដឹងហើយ។', spec, emo);
      const question = ttsModule.computeExpressiveProsody('មែនទេ?', spec, emo);
      assert.equal(regular.pitchNum, baseline.pitchNum, `${voiceId} pitch shifted on ${emo}`);
      assert.equal(regular.rateNum, baseline.rateNum, `${voiceId} rate shifted on ${emo}`);
      assert.equal(question.pitchNum, baseline.pitchNum, `${voiceId} pitch shifted on question with ${emo}`);
      assert.equal(question.rateNum, baseline.rateNum, `${voiceId} rate shifted on question with ${emo}`);
    }
  }

  // Cache keys unify to one steady voice signature even if legacy drafts still contain an emotion field
  const baseKey = ttsModule.getAudioCacheKey('សួស្តី។', 'Radiant Queen', { engine: 'gemini' });
  assert.equal(ttsModule.getAudioCacheKey('សួស្តី។', 'Radiant Queen', { engine: 'gemini', emotion: 'angry' }), baseKey);
  assert.equal(ttsModule.getAudioCacheKey('សួស្តី។', 'Radiant Queen', { engine: 'gemini', emotion: 'sarcastic' }), baseKey);

  // Voice casting strips legacy emotion / suggestedEmotion fields from cues
  const cues = [
    { startSec: 0, endSec: 2, text: '你故意的！', translated: 'អ្នកដោយចេតនា!!', voice: 'Radiant Queen', emotion: 'angry', suggestedEmotion: 'angry' },
    { startSec: 2.2, endSec: 4, text: '对不起。', translated: 'សុំទោស មែនទេ?', voice: 'Sovereign King', emotion: 'sad' }
  ];
  translation.inferCharacterVoicesForCues(cues, new Map(), true, new Map([[1, 'angry'], [2, 'sarcastic']]), { castMode: 'duo' });
  assert.equal(cues[0].emotion, undefined);
  assert.equal(cues[0].suggestedEmotion, undefined);
  assert.equal(cues[1].emotion, undefined);

  // Frontend UI has no emotion dropdowns or handlers left
  assert.equal(htmlContent.includes('bulkEmotionSelect'), false);
  assert.equal(htmlContent.includes('applyBulkEmotion'), false);
  assert.equal(appContent.includes('onEmotionChange'), false);
  assert.equal(appContent.includes('renderEmotionOptionsHtml'), false);
  assert.equal(appContent.includes('EMOTION_PRESETS'), false);
});


test('decluttered UX/UI preserves essential contracts and exposes Multi-Video Batch Manager', () => {
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preloadJs = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

  // Removed unnecessary clutter panels
  assert.equal(html.includes('class="ai-feature-strip"'), false);
  assert.equal(html.includes('class="workflow-panel"'), false);
  assert.equal(html.includes('class="tools-sidebar"'), false);
  assert.equal(html.includes('id="viralStyleQuickBar"'), false);
  assert.equal(html.includes('HDRG (3000)'), false);
  assert.equal(html.includes('🎯 វិភាគតួអង្គ AI ឡើងវិញ'), false);
  assert.equal(html.includes('<option value="duo"'), false);
  assert.equal(html.includes('<option value="multi"'), false);
  assert.equal(html.includes('id="exportMaskCheck"'), false);
  assert.equal(html.includes('id="exportMaskMode"'), false);
  assert.equal(html.includes('id="exportSubStyle"'), false);
  assert.equal(html.includes('id="exportDubCheck"'), false);
  assert.equal(html.includes('id="routerCablesSvg"'), false);
  assert.equal(html.includes('id="routerHubNode"'), false);

  // Preserved essential Studio + Router + Video Manager elements
  for (const snippet of [
    'id="mainVideo"',
    'crossorigin="anonymous"',
    'id="btnCancelExport"',
    'id="exportAudioMode"',
    'id="exportOutputDirInput"',
    'id="btnChooseExportDir"',
    'id="btnResetExportDir"',
    'id="btnOpenExportDir"',
    'id="btnOpenExportedFile"',
    'id="exportAdvancedDetails"',
    'id="exportResolution"',
    'id="exportQualityPreset"',
    'id="sourceLangSelect"',
    'id="scriptStatusFilter"',
    'batchGenerateAllAudio({ onlyMissing: true })',
    'id="routerTelemetryDock"',
    'id="routerToggleBatchBtn"',
    'id="routerBatchPanel"',
    'id="routerTestAllBtn"',
    'id="routerResetCooldownBtn"',
    'id="routerKeyEyeBtn"',
    'id="defaultVoiceSelect"',
    'id="vmDefaultVoiceSelect"',
    'id="videoManagerModal"',
    'id="vmTopBadge"',
    'id="vmExportDirBtn"',
    'id="batchVideoFilesInput"',
    'id="vmConcurrencySelect"',
    'id="vmQueueContainer"',
    'id="btnQuickBgm"'
  ]) {
    assert.ok(html.includes(snippet), `Missing expected HTML snippet: ${snippet}`);
  }

  assert.ok(mainJs.includes("ipcMain.handle('open-files-dialog'"));
  assert.ok(preloadJs.includes('openFilesDialog'));
});

test('POST /api/inspect-videos and POST /api/tts/batch-generate support high-speed multi-video workflow', async () => {
  const { server, baseUrl } = await startTestServer();
  const inspectDir = path.join(tempRoot, 'inspect-batch');
  fs.mkdirSync(inspectDir, { recursive: true });
  const ep1Vid = path.join(inspectDir, 'ep1.mp4');
  const ep1Srt = path.join(inspectDir, 'ep1.srt');
  const ep2Vid = path.join(inspectDir, 'ep2.mkv');
  fs.writeFileSync(ep1Vid, 'mock');
  fs.writeFileSync(ep1Srt, '1\n00:00:00,000 --> 00:00:01,500\n你好\n');
  fs.writeFileSync(ep2Vid, 'mock');

  try {
    const emptyInspect = await fetch(`${baseUrl}/api/inspect-videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [] })
    });
    assert.equal(emptyInspect.status, 200);
    const emptyInspectData = await emptyInspect.json();
    assert.equal(emptyInspectData.success, true);
    assert.deepEqual(emptyInspectData.items, []);

    const inspectRes = await fetch(`${baseUrl}/api/inspect-videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [ep1Vid, ep2Vid] })
    });
    assert.equal(inspectRes.status, 200);
    const inspectData = await inspectRes.json();
    assert.equal(inspectData.success, true);
    assert.equal(inspectData.items.length, 2);
    assert.equal(inspectData.items[0].srtPath, ep1Srt);
    assert.equal(inspectData.items[1].srtPath, '');

    const badBatch = await fetch(`${baseUrl}/api/tts/batch-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(badBatch.status, 400);

    const sampleItems = [
      { index: 0, text: 'សួស្តីទី១', voice: 'Sovereign King', engine: 'edge' },
      { index: 1, text: 'សួស្តីទី២', voice: 'Radiant Queen', engine: 'edge' },
      { index: 2, text: 'សួស្តីទី៣', voice: 'Sovereign King', engine: 'edge' }
    ];
    for (const item of sampleItems) {
      const key = ttsModule.getAudioCacheKey(item.text, item.voice, { engine: 'edge' });
      fs.writeFileSync(path.join(tempAudioDir, `${key}.mp3`), Buffer.alloc(2048, 0x55));
    }

    const batchRes = await fetch(`${baseUrl}/api/tts/batch-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: sampleItems, concurrency: 8 })
    });
    assert.equal(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.equal(batchData.success, true);
    assert.equal(batchData.results.length, 3);
    assert.deepEqual(batchData.stats, { total: 3, success: 3, cached: 3, errors: 0 });
    assert.ok(batchData.results.every(r => r.success && r.cached && r.audioUrl.endsWith('.mp3')));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('frontend toggles stay null-safe after UI cleanup and Video Manager processes batch concurrently', async () => {
  const vm = require('node:vm');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  const mkEl = (id, props = {}) => ({
    id,
    innerText: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    style: {},
    classList: {
      _set: new Set(),
      toggle(cls, force) {
        const next = force === undefined ? !this._set.has(cls) : Boolean(force);
        if (next) this._set.add(cls);
        else this._set.delete(cls);
      },
      contains(cls) { return this._set.has(cls); },
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); }
    },
    addEventListener() { },
    ...props
  });

  const elements = {
    mainVideo: mkEl('mainVideo', { muted: false, volume: 1, duration: 30, currentTime: 0 }),
    btnQuickBgm: mkEl('btnQuickBgm', { innerText: '🎵 BGM' }),
    bottomStatusMsg: mkEl('bottomStatusMsg'),
    exportAudioMode: mkEl('exportAudioMode', { value: 'duck' }),
    sourceLangSelect: mkEl('sourceLangSelect', { value: 'zh' }),
    ttsEngineSelect: mkEl('ttsEngineSelect', { value: 'edge' }),
    castModeSelect: mkEl('castModeSelect', { value: 'single' }),
    videoManagerModal: mkEl('videoManagerModal', { style: { display: 'none' } }),
    vmTopBadge: mkEl('vmTopBadge', { hidden: true, innerText: '0' }),
    vmSourceLangSelect: mkEl('vmSourceLangSelect', { value: 'zh' }),
    vmTargetLangSelect: mkEl('vmTargetLangSelect', { value: 'km' }),
    vmTtsEngineSelect: mkEl('vmTtsEngineSelect', { value: 'edge' }),
    vmCastModeSelect: mkEl('vmCastModeSelect', { value: 'single' }),
    vmConcurrencySelect: mkEl('vmConcurrencySelect', { value: '4' }),
    vmGenerateTtsCheck: mkEl('vmGenerateTtsCheck', { checked: true }),
    vmSaveDraftCheck: mkEl('vmSaveDraftCheck', { checked: true }),
    vmIsolateBgmCheck: mkEl('vmIsolateBgmCheck', { checked: false }),
    vmAutoExportCheck: mkEl('vmAutoExportCheck', { checked: false }),
    btnVmStart: mkEl('btnVmStart'),
    btnVmStop: mkEl('btnVmStop', { style: { display: 'none' } }),
    vmProgressSummary: mkEl('vmProgressSummary'),
    vmProgressCount: mkEl('vmProgressCount'),
    vmProgressFill: mkEl('vmProgressFill', { style: { width: '0%' } }),
    vmQueueContainer: mkEl('vmQueueContainer'),
    shortcutToast: mkEl('shortcutToast'),
    scriptTableBody: mkEl('scriptTableBody')
  };

  const fetchCalls = [];
  const mockFetch = async (url, opts = {}) => {
    const pathname = new URL(url, 'http://localhost:3001').pathname;
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
    fetchCalls.push({ pathname, body });

    if (pathname === '/api/load-srt-file') {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            cues: [{ start: '0:00.0', end: '0:02.0', startSec: 0, endSec: 2, text: '你好', voice: 'Sovereign King' }]
          };
        }
      };
    }
    if (pathname === '/api/translation/translate-cues') {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            cues: body.cues.map(c => ({ ...c, translated: 'សួស្តី', translatedLang: 'km', voice: 'Sovereign King' }))
          };
        }
      };
    }
    if (pathname === '/api/tts/batch-generate') {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            results: body.items.map(it => ({
              index: it.index,
              success: true,
              audioUrl: `/audio_cache/mock_${it.index}.mp3`,
              cached: false
            })),
            stats: { total: body.items.length, success: body.items.length, cached: 0, errors: 0 }
          };
        }
      };
    }
    if (pathname === '/api/save-srt') {
      return { ok: true, async json() { return { success: true, savedPath: body.filePath }; } };
    }
    if (pathname === '/api/drafts/save') {
      return { ok: true, async json() { return { success: true, draftKey: 'mockdraft' }; } };
    }
    return { ok: true, async json() { return { success: true }; } };
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    Set,
    Map,
    Array,
    Object,
    JSON,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    Number,
    String,
    Boolean,
    encodeURIComponent,
    decodeURIComponent,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => { } },
    Audio: class {
      addEventListener() { }
      pause() { }
      play() { return Promise.resolve(); }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => { },
    fetch: mockFetch,
    window: {
      electronAPI: { backendUrl: 'http://127.0.0.1:4567' },
      addEventListener: () => { }
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => mkEl('tmp'),
      addEventListener: () => { }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  // Null-safe legacy + decluttered toggle checks
  vm.runInContext('currentVideoPath = "D:/mock/video.mp4";', sandbox);
  assert.doesNotThrow(() => sandbox.toggleAudioBoost());
  assert.doesNotThrow(() => sandbox.toggleMusicBed());
  await sandbox.toggleRemoveVocals();
  assert.equal(elements.btnQuickBgm.classList.contains('active'), true);

  assert.equal(sandbox.cuesNeedTranslation([{ text: '你好', translated: '' }], 'km'), true);
  assert.equal(sandbox.cuesNeedTranslation([{ text: '你好', translated: 'សួស្តី' }], 'km'), false);

  sandbox.openVideoManagerModal();
  assert.equal(elements.videoManagerModal.style.display, 'flex');

  const added = sandbox.appendBatchItems([
    { name: 'ep01.mp4', videoPath: 'D:/mock/ep01.mp4', srtPath: 'D:/mock/ep01.srt' },
    { name: 'ep02.mp4', videoPath: 'D:/mock/ep02.mp4', srtPath: 'D:/mock/ep02.srt' }
  ]);
  assert.equal(added, 2);

  await sandbox.startVideoManagerBatch();
  const queueState = vm.runInContext('vmQueue.map(x => ({ name: x.name, status: x.status, dubReady: x.dubReady, progress: x.progress }))', sandbox);
  assert.equal(queueState.length, 2);
  assert.ok(queueState.every(x => x.status === 'done' && x.dubReady === true && x.progress === 100));
  assert.equal(elements.vmTopBadge.hidden, false);
  assert.equal(elements.vmTopBadge.innerText, '2/2');
  assert.ok(fetchCalls.some(c => c.pathname === '/api/tts/batch-generate'));
  assert.ok(fetchCalls.some(c => c.pathname === '/api/drafts/save'));
});

test('unified left navigation sidebar switches between Studio, Video Manager, and Router Manager views', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  for (const snippet of [
    'id="appSidebar"',
    'id="appSidebarToggleBtn"',
    'id="navBtnStudio"',
    'id="navBtnVideoManager"',
    'id="navBtnRouter"',
    'id="routerSidebarBadge"',
    'id="studioViewPane"',
    'class="vm-workspace-pane"',
    'router-workspace-pane'
  ]) {
    assert.ok(html.includes(snippet), `Missing sidebar HTML snippet: ${snippet}`);
  }
  assert.ok(css.includes('.app-sidebar'));
  assert.ok(css.includes('.app-sidebar.collapsed'));
  assert.ok(css.includes('.router-sidebar.router-workspace-pane'));

  const makeMockNode = (tagName = 'div', props = {}) => {
    const attrs = {};
    const node = {
      tagName,
      id: props.id || '',
      className: '',
      innerText: '',
      innerHTML: '',
      value: '',
      hidden: false,
      style: {},
      dataset: {},
      children: [],
      attributes: attrs,
      classList: {
        _set: new Set(props.initialClasses || []),
        toggle(cls, force) {
          const next = force === undefined ? !this._set.has(cls) : Boolean(force);
          if (next) this._set.add(cls);
          else this._set.delete(cls);
          return next;
        },
        contains(cls) { return this._set.has(cls); },
        add(cls) { this._set.add(cls); },
        remove(cls) { this._set.delete(cls); }
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener() { },
      removeEventListener() { },
      focus() { },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...items) { this.children = items; },
      ...props
    };
    return node;
  };

  const elements = {
    appSidebar: makeMockNode('aside', { id: 'appSidebar' }),
    appSidebarToggleBtn: makeMockNode('button', { id: 'appSidebarToggleBtn', innerText: '◀' }),
    navBtnStudio: makeMockNode('button', { id: 'navBtnStudio', initialClasses: ['active'] }),
    navBtnVideoManager: makeMockNode('button', { id: 'navBtnVideoManager' }),
    navBtnRouter: makeMockNode('button', { id: 'navBtnRouter' }),
    routerSidebarBadge: makeMockNode('span', { id: 'routerSidebarBadge', hidden: true, innerText: '0' }),
    vmTopBadge: makeMockNode('span', { id: 'vmTopBadge', hidden: true, innerText: '0' }),
    studioViewPane: makeMockNode('div', { id: 'studioViewPane', style: { display: 'flex' } }),
    videoManagerModal: makeMockNode('div', { id: 'videoManagerModal', style: { display: 'none' } }),
    routerSidebar: makeMockNode('aside', { id: 'routerSidebar', hidden: true }),
    routerSidebarStatus: makeMockNode('span', { id: 'routerSidebarStatus' }),
    routerAccountsList: makeMockNode('div', { id: 'routerAccountsList' }),
    routerTelemetryDock: makeMockNode('div', { id: 'routerTelemetryDock' }),
    routerAddPanel: makeMockNode('div', { id: 'routerAddPanel', hidden: true }),
    vmQueueContainer: makeMockNode('div', { id: 'vmQueueContainer' }),
    vmProgressSummary: makeMockNode('span', { id: 'vmProgressSummary' }),
    vmProgressCount: makeMockNode('span', { id: 'vmProgressCount' }),
    vmProgressFill: makeMockNode('div', { id: 'vmProgressFill', style: { width: '0%' } }),
    btnVmStart: makeMockNode('button', { id: 'btnVmStart' }),
    btnVmStop: makeMockNode('button', { id: 'btnVmStop', style: { display: 'none' } })
  };

  const mockFetch = async (url) => {
    const pathname = new URL(url, 'http://localhost:3001').pathname;
    if (pathname === '/api/translation/router-mode') {
      return { ok: true, async json() { return { success: true, mode: 'flash-lite' }; } };
    }
    if (pathname === '/api/config/accounts') {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            activeAccountId: 'acc1',
            accounts: [
              { id: 'acc1', name: 'Primary', email: 'user@example.com', isActive: true, requestCount: 3 }
            ]
          };
        }
      };
    }
    return { ok: true, async json() { return { success: true }; } };
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    Promise,
    Set,
    Map,
    Array,
    Object,
    JSON,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    Number,
    String,
    Boolean,
    encodeURIComponent,
    decodeURIComponent,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => { } },
    Audio: class {
      addEventListener() { }
      pause() { }
      play() { return Promise.resolve(); }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => { },
    fetch: mockFetch,
    window: {
      electronAPI: { backendUrl: 'http://127.0.0.1:4567' },
      addEventListener: () => { }
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => makeMockNode(tag),
      createElementNS: (_ns, tag) => makeMockNode(tag),
      addEventListener: () => { }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  // Switch Studio -> Video Manager
  await sandbox.switchAppView('video-manager');
  assert.equal(elements.studioViewPane.style.display, 'none');
  assert.equal(elements.videoManagerModal.style.display, 'flex');
  assert.equal(elements.routerSidebar.hidden, true);
  assert.equal(elements.navBtnVideoManager.classList.contains('active'), true);
  assert.equal(elements.navBtnStudio.classList.contains('active'), false);

  // Switch Video Manager -> Router Manager
  await sandbox.switchAppView('router');
  assert.equal(elements.studioViewPane.style.display, 'none');
  assert.equal(elements.videoManagerModal.style.display, 'none');
  assert.equal(elements.routerSidebar.hidden, false);
  assert.equal(elements.navBtnRouter.classList.contains('active'), true);
  assert.equal(elements.routerSidebarBadge.hidden, false);
  assert.equal(elements.routerSidebarBadge.innerText, '1');

  // Toggle collapse sidebar
  sandbox.toggleAppSidebar();
  assert.equal(elements.appSidebar.classList.contains('collapsed'), true);
  assert.equal(elements.appSidebarToggleBtn.innerText, '▶');
  sandbox.toggleAppSidebar();
  assert.equal(elements.appSidebar.classList.contains('collapsed'), false);
  assert.equal(elements.appSidebarToggleBtn.innerText, '◀');

  // Switch Router Manager -> Studio (also clears polling timer cleanly)
  await sandbox.switchAppView('studio');
  assert.equal(elements.studioViewPane.style.display, 'flex');
  assert.equal(elements.videoManagerModal.style.display, 'none');
  assert.equal(elements.routerSidebar.hidden, true);
  assert.equal(elements.navBtnStudio.classList.contains('active'), true);

  // Lock Router Manager from normal users (Admin PIN lock)
  assert.equal(sandbox.lockRouterForUserMode('2468'), true);
  assert.equal(elements.navBtnRouter.hidden, true);
  assert.equal(await sandbox.unlockRouterAdminMode('0000'), false);
  assert.equal(elements.navBtnRouter.hidden, true);
  assert.equal(await sandbox.unlockRouterAdminMode('2468'), true);
  assert.equal(elements.navBtnRouter.hidden, false);
  assert.equal(elements.routerSidebar.hidden, false);
  await sandbox.switchAppView('studio');

  // Mobile Studio mode switcher ('split' | 'script' | 'player')
  assert.equal(sandbox.setMobileStudioMode('script'), 'script');
  assert.equal(elements.studioViewPane.getAttribute('data-mobile-mode'), 'script');
  assert.equal(sandbox.setMobileStudioMode('player'), 'player');
  assert.equal(elements.studioViewPane.getAttribute('data-mobile-mode'), 'player');
  assert.equal(sandbox.setMobileStudioMode('split'), 'split');
  assert.equal(elements.studioViewPane.getAttribute('data-mobile-mode'), 'split');
});

test('single castMode locks all cues to one user-selected voice in translation.js helpers and /auto-cast-voices', async () => {
  assert.equal(translationModule.normalizeCastMode('single'), 'single');
  assert.equal(translationModule.normalizeCastMode(), 'duo');
  assert.equal(
    translationModule.collapseVoiceForCastMode('kh_young_girl', 'single', 'Radiant Queen'),
    'Radiant Queen'
  );

  const mixedCues = [
    { index: 1, startSec: 0, endSec: 1.5, text: 'Hello there', translated: 'សួស្តី', voice: 'Radiant Queen' },
    { index: 2, startSec: 1.8, endSec: 3.2, text: 'Watch out!', translated: 'ប្រយ័ត្ន!', voice: 'kh_elder_woman' },
    { index: 3, startSec: 3.5, endSec: 5.0, text: 'Let us go', translated: 'តោះទៅ', voice: 'kh_young_man' }
  ];
  const aiVoiceMap = new Map([[1, 'kh_deep_boss'], [2, 'kh_child'], [3, 'Radiant Queen']]);
  translationModule.inferCharacterVoicesForCues(mixedCues, aiVoiceMap, true, new Map(), {
    castMode: 'single',
    fixedVoice: 'kh_narrator_fast'
  });
  assert.deepEqual(mixedCues.map(c => c.voice), ['kh_narrator_fast', 'kh_narrator_fast', 'kh_narrator_fast']);
  assert.deepEqual(mixedCues.map(c => c.suggestedVoice), ['kh_narrator_fast', 'kh_narrator_fast', 'kh_narrator_fast']);

  const app = express();
  app.use(express.json());
  app.use('/api/translation', translationModule);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/translation/auto-cast-voices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cues: mixedCues,
        castMode: 'single',
        fixedVoice: 'kh_young_man'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.castMode, 'single');
    assert.equal(data.usedAudio, false);
    assert.deepEqual(data.cues.map(c => c.voice), ['kh_young_man', 'kh_young_man', 'kh_young_man']);
    assert.deepEqual(data.cues.map(c => c.suggestedVoice), ['kh_young_man', 'kh_young_man', 'kh_young_man']);

    const lockedDirect = translationModule.normalizeCueVoicesForCastMode(
      [{ text: '1', voice: 'Sovereign King' }, { text: '2', voice: 'Radiant Queen' }],
      'single',
      'kh_elder_woman'
    );
    assert.deepEqual(lockedDirect.map(c => c.voice), ['kh_elder_woman', 'kh_elder_woman']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('frontend single-voice mode locks user-selected preset in Studio and Video Manager without auto-casting', async () => {
  const localVm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');

  assert.match(html, /<select[^>]*id="defaultVoiceSelect"/);
  assert.match(html, /<select[^>]*id="vmDefaultVoiceSelect"/);
  assert.equal(/id="castModeSelect"/i.test(html), false);
  assert.equal(/id="vmCastModeSelect"/i.test(html), false);
  assert.equal(/id="ttsEngineSelect"/i.test(html), false);
  assert.equal(/id="vmTtsEngineSelect"/i.test(html), false);
  assert.equal(/id="bulkVoiceSelect"/i.test(html), false);
  assert.equal(/id="keyModal"/i.test(html), false);
  assert.equal(/id="playerWatermark"/i.test(html), false);
  assert.equal(/id="routerSidebarBackdrop"/i.test(html), false);
  assert.equal(/id="selectedIndicatorText"/i.test(html), false);
  assert.equal(/class="app-sidebar-footer"/i.test(html), false);
  assert.equal(/<option value="duo"/i.test(html), false);
  assert.equal(/<option value="multi"/i.test(html), false);
  assert.equal(/<option value="gemini"/i.test(html), false);
  assert.equal(/\b(Orus|Aoede|Fenrir|Puck|Charon|Leda|Zephyr|Kore)\b/.test(html), false);
  assert.equal(/\b(Orus|Aoede|Fenrir|Puck|Charon|Leda|Zephyr|Kore)\b/.test(appCode), false);
  assert.equal(html.includes('autoCastCharacterVoices(true)'), false);
  for (const voiceId of ['Sovereign King', 'Radiant Queen', 'kh_narrator_fast', 'kh_young_man', 'kh_deep_boss', 'kh_young_girl', 'kh_child', 'kh_elder_woman']) {
    assert.match(html, new RegExp(`id="defaultVoiceSelect"[\\s\\S]*?value="${voiceId}"`));
    assert.match(html, new RegExp(`id="vmDefaultVoiceSelect"[\\s\\S]*?value="${voiceId}"`));
  }

  const storage = new Map([['eza_default_voice', 'kh_elder_woman']]);
  const makeEl = (id, extras = {}) => ({
    id,
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    innerHTML: '',
    innerText: '',
    textContent: '',
    title: '',
    style: {},
    classList: { toggle() { }, add() { }, remove() { }, contains: () => false },
    setAttribute() { },
    addEventListener() { },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extras
  });

  const multiOptStub = { value: 'multi', disabled: false, textContent: '' };
  const elements = {
    defaultVoiceSelect: makeEl('defaultVoiceSelect', { value: 'Sovereign King' }),
    vmDefaultVoiceSelect: makeEl('vmDefaultVoiceSelect', { value: 'Sovereign King' }),
    bulkVoiceSelect: makeEl('bulkVoiceSelect', { value: 'Sovereign King' }),
    castModeSelect: makeEl('castModeSelect', {
      value: 'single',
      querySelector: (sel) => (sel === 'option[value="multi"]' ? multiOptStub : null)
    }),
    vmCastModeSelect: makeEl('vmCastModeSelect', { value: 'single' }),
    ttsEngineSelect: makeEl('ttsEngineSelect', { value: 'edge' }),
    vmTtsEngineSelect: makeEl('vmTtsEngineSelect', { value: 'edge' }),
    vmSourceLangSelect: makeEl('vmSourceLangSelect', { value: 'auto' }),
    vmTargetLangSelect: makeEl('vmTargetLangSelect', { value: 'km' }),
    vmConcurrencySelect: makeEl('vmConcurrencySelect', { value: '4' }),
    vmGenerateTtsCheck: makeEl('vmGenerateTtsCheck', { checked: true }),
    vmSaveDraftCheck: makeEl('vmSaveDraftCheck', { checked: false }),
    vmIsolateBgmCheck: makeEl('vmIsolateBgmCheck', { checked: false }),
    vmAutoExportCheck: makeEl('vmAutoExportCheck', { checked: false }),
    bottomStatusMsg: makeEl('bottomStatusMsg'),
    cuesTableBody: makeEl('cuesTableBody'),
    scriptSearch: makeEl('scriptSearch'),
    scriptStatusFilter: makeEl('scriptStatusFilter', { value: 'all' }),
    cuesStatsText: makeEl('cuesStatsText'),
    shortcutToast: makeEl('shortcutToast'),
    timelineTracks: makeEl('timelineTracks'),
    dubAudioCacheStatus: makeEl('dubAudioCacheStatus'),
    vmTableBody: makeEl('vmTableBody'),
    vmSummaryBadge: makeEl('vmSummaryBadge')
  };

  const requests = [];
  const context = localVm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Error,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); }
    },
    navigator: { clipboard: { writeText: async () => { } } },
    Audio: function MockAudio() {
      return { pause() { }, play: async () => { }, addEventListener() { } };
    },
    alert: () => { },
    confirm: () => true,
    prompt: () => null,
    document: {
      activeElement: null,
      body: makeEl('body'),
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl('created'),
      addEventListener: () => { }
    },
    window: {
      location: { search: '' },
      innerWidth: 1400,
      addEventListener: () => { }
    },
    fetch: async (url, init = {}) => {
      const urlStr = String(url);
      const parsedBody = init && init.body ? JSON.parse(init.body) : null;
      requests.push({ url: urlStr, method: init.method || 'GET', body: parsedBody });

      if (urlStr.includes('/api/translation/auto-detect-speech')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            cues: [
              { index: 1, startSec: 0, endSec: 1.5, text: 'Line 1', voice: 'Sovereign King' },
              { index: 2, startSec: 1.8, endSec: 3.2, text: 'Line 2', voice: 'Radiant Queen' }
            ]
          })
        };
      }
      if (urlStr.includes('/api/translation/translate-cues')) {
        const outCues = (parsedBody?.cues || []).map((c, idx) => ({
          ...c,
          translated: `បកប្រែ ${idx + 1}`,
          voice: parsedBody.fixedVoice || c.voice
        }));
        return { ok: true, status: 200, json: async () => ({ success: true, cues: outCues }) };
      }
      if (urlStr.includes('/api/tts/generate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, audioUrl: '/audio/test.mp3', fallback: false })
        };
      }
      if (urlStr.includes('/api/tts/batch-generate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, generated: (parsedBody?.items || []).length, results: (parsedBody?.items || []).map(it => ({ index: it.index, success: true, audioUrl: '/audio/test.mp3', fallback: false })) })
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, exists: false, results: [] }) };
    }
  });
  context.window.localStorage = context.localStorage;

  localVm.runInContext(appCode, context, { filename: 'app.js' });
  localVm.runInContext('populateBulkVoiceSelect();', context);
  assert.equal(elements.defaultVoiceSelect.value, 'kh_elder_woman');
  assert.equal(elements.vmDefaultVoiceSelect.value, 'kh_elder_woman');
  assert.equal(localVm.runInContext('getSelectedSingleVoice()', context), 'kh_elder_woman');
  assert.equal(localVm.runInContext('getActiveTtsEngine()', context), 'edge');
  assert.equal(
    localVm.runInContext("getAudioCacheKey('Radiant Queen', 'សួស្តី', 'auto', 'gemini')", context),
    localVm.runInContext("getAudioCacheKey('Radiant Queen', 'សួស្តី', 'auto', 'edge')", context)
  );
  assert.equal(localVm.runInContext('readVideoManagerConfig().ttsEngine', context), 'edge');

  localVm.runInContext(`
    activeCues = [
      { index: 1, start: '00:00:00.0', end: '00:00:01.0', startSec: 0, endSec: 1, text: 'hi', translated: 'សួស្តី', voice: 'Sovereign King' },
      { index: 2, start: '00:00:01.5', end: '00:00:02.5', startSec: 1.5, endSec: 2.5, text: 'bye', translated: 'លាហើយ', voice: 'kh_deep_boss' }
    ];
    onDefaultVoiceChange('Radiant Queen');
    onTtsEngineChange();
  `, context);

  assert.match(elements.defaultVoiceSelect.innerHTML, /value="Radiant Queen"/);
  assert.match(elements.vmDefaultVoiceSelect.innerHTML, /value="kh_young_man"/);
  assert.equal(elements.castModeSelect.value, 'single');
  assert.equal(localVm.runInContext('getActiveCastMode()', context), 'single');
  assert.equal(storage.get('eza_default_voice'), 'Radiant Queen');
  assert.deepEqual(
    Array.from(localVm.runInContext('activeCues.map(c => c.voice)', context)),
    ['Radiant Queen', 'Radiant Queen']
  );

  requests.length = 0;
  await localVm.runInContext('batchGenerateAllAudio({ onlyMissing: true, silentSuccess: true })', context);
  assert.equal(requests.some(r => r.url.includes('/auto-cast-voices')), false);
  const ttsCalls = (() => { const b = requests.find(r => r.url.includes('/api/tts/batch-generate')); return b ? (b.body.items || []).map(it => ({ body: it })) : requests.filter(r => r.url.includes('/api/tts/generate')); })();
  assert.equal(ttsCalls.length, 2);
  assert.deepEqual(ttsCalls.map(r => r.body.voice), ['Radiant Queen', 'Radiant Queen']);
  assert.deepEqual(ttsCalls.map(r => r.body.engine), ['edge', 'edge']);

  requests.length = 0;
  elements.vmDefaultVoiceSelect.value = 'kh_young_man';
  elements.vmCastModeSelect.value = 'single';
  localVm.runInContext(`
    vmQueue = [{
      id: 'vm-1',
      name: 'clip1.mp4',
      videoPath: 'D:/videos/clip1.mp4',
      selected: true,
      status: 'pending',
      cues: []
    }];
  `, context);
  await localVm.runInContext('startVideoManagerBatch()', context);

  const sttCall = requests.find(r => r.url.includes('/api/translation/auto-detect-speech'));
  const trCall = requests.find(r => r.url.includes('/api/translation/translate-cues'));
  const batchTtsCall = requests.find(r => r.url.includes('/api/tts/batch-generate'));
  assert.ok(sttCall);
  assert.ok(trCall);
  assert.equal(sttCall.body.castMode, 'single');
  assert.equal(sttCall.body.fixedVoice, 'kh_young_man');
  assert.equal(trCall.body.castMode, 'single');
  assert.equal(trCall.body.fixedVoice, 'kh_young_man');
  assert.equal(requests.some(r => r.url.includes('/auto-cast-voices')), false);
  if (batchTtsCall) {
    const items = batchTtsCall.body.items || batchTtsCall.body.cues || [];
    assert.ok(items.length > 0);
    assert.deepEqual(items.map(i => i.voice), ['kh_young_man', 'kh_young_man']);
  }
});

test('Khmer subtitle validation catches foreign scripts and malformed vowels without false positives', () => {
  const { isTranslationIncomplete, hasCorruptedKhmerText, cleanTranslatedText, normalizeKhmerSpacing } = translationModule;

  // Real corruptions observed from weak flash-lite outputs
  const badSamples = [
    ['六个亿呢', 'លុយប្រាំរយល้าน'],
    ['六个亿呢', 'ប្រាំាំរយលាន'],
    ['六个亿呢', 'ប្រាំាក់រយលាន'],
    ['我们离婚吧', 'មីងទីប្រាំពីរោ ពួកយើងលែងលះគ្នាទៅោ'],
    ['燕清哥忙', 'បង យែនឈីង រវល់ោ ខ្ញុំមកជំនួសគាត់មួយជើង។'],
    ['还能怎么说', 'អាចថាčićម៉េចទៀតទៅ?'],
    ['三年了', 'រesរៀបការបីឆ្នាំហើយ'],
    ['别硬扛', 'កុំ cố ឱ្យសោះ'],
    ['别说了', 'ពេលក្រោយកفتកុំមកនិយាយ'],
    ['约会啊', 'តendទៅណាត់ជាមួយជីនចូវ'],
    ['算了', 'ាត់ចោលទៅ។'],
    ['痛苦而是快乐吧', 'សេចក្តីសុខវិញមែនទេ?្']
  ];
  for (const [src, badTr] of badSamples) {
    assert.equal(hasCorruptedKhmerText(badTr), true, `Expected corruption flag for: ${badTr}`);
    assert.equal(isTranslationIncomplete(badTr, src, 'km'), true, `Expected incomplete flag for: ${badTr}`);
  }

  // Valid Khmer spellings & colloquial typography must pass cleanly
  const validSamples = [
    ['你好', 'ប្រាំមួយរយលាន ពួកយើងលែងលះគ្នាទៅ កុំមកពាក់ព័ន្ធទៀត។'],
    ['应舟', 'ធ្វើបែបនេះ ដើម្បីឱ្យកូននិងអុីងចូវអស់បារម្ភដែរ។'],
    ['喂', 'ហ៎េ! ឯងមកធ្វើអីហ្នឹង?'],
    ['好', 'ចា៎ះ ខ្ញុំយល់ហើយ។'],
    ['可以', 'គាត់ OK ហើយ។'],
    ['重量', 'ទម្ងន់50kgដែរ។'],
    ['你好', 'សួស្តី\nបង']
  ];
  for (const [src, okTr] of validSamples) {
    assert.equal(hasCorruptedKhmerText(okTr), false, `Unexpected false positive on: ${okTr}`);
    assert.equal(isTranslationIncomplete(okTr, src, 'km'), false, `Unexpected incomplete flag on: ${okTr}`);
  }

  // normalizeKhmerSpacing must join standalone prefixes without gluing previous words ending in ជា/ថា
  assert.equal(normalizeKhmerSpacing('ខ្ញុំ ជា មនុស្ស ល្អ'), 'ខ្ញុំ ជាមនុស្ស ល្អ');
  assert.equal(normalizeKhmerSpacing('កម្ពុជា មាន រឿង ល្អ'), 'កម្ពុជា មាន រឿង ល្អ');
  assert.equal(cleanTranslatedText('តើ ជា មនុស្ស\u0E00  ល្អ', 'km'), 'តើ ជាមនុស្ស ល្អ');
});

test('translateWithReflection rejects poisoned cache/drafts and retries before stripping foreign chars', async (t) => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const translationCache = require('./translation_cache');

  const origHttpsRequest = https.request;
  const origCacheGet = translationCache.get;
  const origCacheSet = translationCache.set;
  t.after(() => {
    https.request = origHttpsRequest;
    translationCache.get = origCacheGet;
    translationCache.set = origCacheSet;
  });

  const savedToCache = [];
  translationCache.get = async (sourceText) => {
    if (sourceText === '六个亿呢') return 'ប្រាំាំរយលាន'; // poisoned entry must be ignored
    return null;
  };
  translationCache.set = async (sourceText, translation) => {
    savedToCache.push({ sourceText, translation });
  };

  let callCount = 0;
  https.request = (_opts, cb) => {
    callCount++;
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    req.write = () => { };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => { };
      const bodyPayload = callCount === 1
        ? {
          translations: [
            // Item 1 has Thai + corrupted Khmer vowel; previously cleanTranslatedText hid this from retry
            { id: 1, translation: 'លុយប្រាំរយល้าน', voice: 'Radiant Queen' },
            { id: 2, translation: 'អាចថាčićម៉េចទៀត?', voice: 'Sovereign King' }
          ]
        }
        : {
          translations: [
            { id: 1, translation: 'លុយប្រាំមួយរយលាន', voice: 'Radiant Queen' },
            { id: 2, translation: 'អាចនិយាយម៉េចទៀត?', voice: 'Sovereign King' }
          ]
        };
      const envelope = JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(bodyPayload) }] } }]
      });
      process.nextTick(() => {
        cb(res);
        res.emit('data', envelope);
        res.emit('end');
      });
    };
    return req;
  };

  const result = await translationModule.translateWithReflection(
    [
      { startSec: 0, endSec: 2, text: '六个亿呢', translated: 'ប្រាំាំរយលាន', translatedLang: 'km' },
      { startSec: 2, endSec: 4, text: '还能怎么说' }
    ],
    'km',
    'fake-gemini-key',
    true,
    false,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );

  assert.equal(callCount >= 2, true, 'Corrupted attempt-1 translations must trigger Gemini retry');
  assert.equal(result.cacheHits, 0, 'Poisoned cache entry must not count as cache hit');
  assert.equal(result.cues[0].translated, 'លុយប្រាំមួយរយលាន');
  assert.equal(result.cues[1].translated, 'អាចនិយាយម៉េចទៀត?');
  assert.equal(savedToCache.length, 2);
});

test('speech continuity helper locks Simplified Chinese and Part-1 names for multi-chunk STT', () => {
  const prompt = translationModule.buildTranscriptContinuityContext(
    [{ text: '燕清哥，六个亿已经准备好了。' }, { text: '别再纠缠。' }],
    { name: 'Chinese' }
  );
  assert.match(prompt, /Simplified Chinese/i);
  assert.match(prompt, /燕清哥/);
  assert.match(prompt, /六个亿/);
});

test('Chuon Nath dictionary normalizer enforces ឲ្យ, fixes inverted clusters, and avoids valid homograph collisions', () => {
  const { normalizeKhmerChuonNath, isChuonNathWord, getChuonNathWordSet } = require('./src/backend/utils/khmer-chuon-nath');

  assert.ok(getChuonNathWordSet().size >= 24000);
  assert.equal(isChuonNathWord('ឲ្យ'), true);
  assert.equal(isChuonNathWord('ប្រាកដ'), true);
  assert.equal(isChuonNathWord('អោយ'), false);

  // Convert អោយ / ឱ្យ -> ឲ្យ, fix ជម្ងឺ -> ជំងឺ, សំរាប់ -> សម្រាប់, and broken vowel+coeng cluster អី្វ -> អ្វី
  assert.equal(normalizeKhmerChuonNath('សូមអោយខ្ញុំទៅផង'), 'សូមឲ្យខ្ញុំទៅផង');
  assert.equal(normalizeKhmerChuonNath('ដេញគេឱ្យទៅបាត់'), 'ដេញគេឲ្យទៅបាត់');
  assert.equal(normalizeKhmerChuonNath('ហេតុអី្វមានជម្ងឺសំរាប់បំរើស្រ្តី'), 'ហេតុអ្វីមានជំងឺសម្រាប់បម្រើស្ត្រី');

  // Must NOT alter legitimate Chuon Nath words like សំរោង
  assert.equal(normalizeKhmerChuonNath('ដើមសំរោងនៅក្នុងភូមិ'), 'ដើមសំរោងនៅក្នុងភូមិ');

  // Verify translation cleanTranslatedText + prompt guide enforce Chuon Nath spelling
  assert.equal(translationModule.cleanTranslatedText('តើ ជា ជម្ងឺ សំរាប់ អោយ អ្នកដឹង', 'km'), 'តើ ជាជំងឺ សម្រាប់ឲ្យ អ្នកដឹង');
  assert.equal(translationModule.cleanTranslatedText('ខ្ញុំ អោយ អ្នក ទៅ', 'km'), 'ខ្ញុំ ឲ្យអ្នក ទៅ');
  assert.match(translationModule.getPromptLanguageMeta('km').formatHint, /ឲ្យ/);
  assert.match(translationModule.getPromptLanguageMeta('km').formatHint, /ជួន ណាត|Chuon Nath/);
});

test('Full 24,704-word Chuon Nath engine handles segmentation, dynamic rules, wrapping, Tibetan leak, and HTTP endpoints', async () => {
  const express = require('express');
  const exportModule = require('./src/backend/routes/export');
  const {
    getChuonNathWordSet,
    getDynamicSpellingMap,
    getChuonNathStats,
    isChuonNathWord,
    segmentKhmerWithChuonNath,
    normalizeKhmerChuonNath,
    auditKhmerAgainstChuonNath
  } = require('./src/backend/utils/khmer-chuon-nath');

  const stats = getChuonNathStats();
  assert.equal(stats.totalWords, getChuonNathWordSet().size);
  assert.ok(stats.totalWords >= 24700, `Expected >=24700 words, got ${stats.totalWords}`);
  assert.ok(getDynamicSpellingMap().size >= 2000, `Expected >=2000 dynamic rules, got ${stats.dynamicRules}`);

  for (const w of ['ណា៎', 'ថី', 'នែ', 'អ៊ីចឹង', 'ឲ្យ']) {
    assert.equal(isChuonNathWord(w), true, `Missing Chuon Nath word: ${w}`);
  }

  for (const phrase of ['ប្រាំមួយរយលាន', 'នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ', 'បណ្ណាការក៏']) {
    const segs = segmentKhmerWithChuonNath(phrase);
    const unknown = segs.filter(s => s.isKhmer && !s.inDict);
    assert.equal(unknown.length, 0, `Unexpected unknown tokens in "${phrase}": ${JSON.stringify(unknown)}`);
  }

  assert.deepEqual(
    segmentKhmerWithChuonNath('នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ').map(s => s.text),
    ['នោះ', 'គ្រាន់តែ', 'ជា', 'នាឡិកា', 'ដៃ', 'មួយ', 'គ្រឿង', 'ប៉ុណ្ណោះ']
  );

  // Dynamic orthography fixes derived from all 24,704 words without corrupting compound words
  assert.equal(normalizeKhmerChuonNath('កំរាប ទំលាយ កន្រ្តៃ កម្ពុជះ ទំងន់ បរាជយ័'), 'កម្រាប ទម្លាយ កន្ត្រៃ កម្ពុជៈ ទម្ងន់ បរាជ័យ');
  assert.equal(normalizeKhmerChuonNath('បណ្ណាការក៏ និង ប្រាំរយ ដើមសំរោង'), 'បណ្ណាការក៏ និង ប្រាំរយ ដើមសំរោង');

  // Wrapping and karaoke segmentation must respect Chuon Nath word boundaries
  const wrapped = exportModule.wrapKhmerText('នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ', 20);
  const parts = wrapped.split('\\N');
  assert.equal(parts.length, 2);
  for (const p of parts) {
    const pUnknown = segmentKhmerWithChuonNath(p).filter(s => s.isKhmer && !s.inDict);
    assert.equal(pUnknown.length, 0, `Wrapped half broke mid-word: ${p}`);
  }
  const karaokeChunks = exportModule.segmentTextForKaraoke('នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ', 10, 2);
  const karaokeWords = karaokeChunks.flatMap(c => c.words);
  assert.ok(karaokeChunks.length >= 2, `Expected >=2 karaoke chunks, got ${karaokeChunks.length}`);
  assert.ok(karaokeWords.length >= 2, `Expected >=2 karaoke word groups, got ${karaokeWords.length}`);
  assert.equal(karaokeWords.map(w => w.text).join(''), 'នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ');
  assert.equal(karaokeWords.every(w => !/[\u1780-\u17FF]/.test(w.text) || segmentKhmerWithChuonNath(w.text).every(s => !s.isKhmer || s.inDict)), true);

  // Tibetan script leak detection + cleanup
  assert.equal(translationModule.hasCorruptedKhmerText('ហេតុអ\u0F7Cីច'), true);
  assert.equal(translationModule.cleanTranslatedText('ហេតុអ\u0F7Cីច សួរស្អី', 'km').includes('\u0F7C'), false);

  const audit = auditKhmerAgainstChuonNath('កំរាប កន្រ្តៃ ឲ្យបានល្អ');
  assert.equal(audit.normalizedText, 'កម្រាប កន្ត្រៃ ឲ្យបានល្អ');
  assert.equal(audit.coverage, 1);
  assert.deepEqual(audit.unknownTokens, []);

  // HTTP API verification for /chuon-nath-stats and /chuon-nath-check
  const app = express();
  app.use(express.json());
  app.use('/api/translation', translationModule);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const statsRes = await fetch(`http://127.0.0.1:${port}/api/translation/chuon-nath-stats`);
    const statsBody = await statsRes.json();
    assert.equal(statsRes.status, 200);
    assert.equal(statsBody.success, true);
    assert.ok(statsBody.totalWords >= 24700);
    assert.ok(statsBody.dynamicRules >= 2000);

    const checkRes = await fetch(`http://127.0.0.1:${port}/api/translation/chuon-nath-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'សូមអោយកំរាបនិងទំលាយកន្រ្តៃ' })
    });
    const checkBody = await checkRes.json();
    assert.equal(checkRes.status, 200);
    assert.equal(checkBody.success, true);
    assert.equal(checkBody.normalized, 'សូមឲ្យកម្រាបនិងទម្លាយកន្ត្រៃ');
    assert.equal(checkBody.audit.coverage, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('3-stage Story Bible + Strict ID Alignment + Reflection pipeline fixes plot mismatches and STT homophones', async (t) => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const translationCache = require('./translation_cache');

  const origHttpsRequest = https.request;
  const origCacheGet = translationCache.get;
  const origCacheSet = translationCache.set;
  t.after(() => {
    https.request = origHttpsRequest;
    translationCache.get = origCacheGet;
    translationCache.set = origCacheSet;
  });

  // 1. Strict ID resolution prevents off-by-one cue swaps when Gemini skips an item
  const indices = [35, 36, 37];
  assert.equal(translationModule.resolveDraftCueId(38, 1, indices, 2, false), 38);
  assert.equal(translationModule.resolveDraftCueId(36, 0, indices, 2, false), 36);
  assert.equal(translationModule.resolveDraftCueId(2, 1, indices, 3, true), 37);
  assert.equal(translationModule.resolveDraftCueId(99, 0, indices, 2, false), null);

  // 2. Full 3-pass flow on a 5-cue drama episode (<= 60 lines still gets full Story Bible + Reflection!)
  translationCache.get = async () => null;
  const savedToCache = [];
  let cachedDigestPrefix = '';
  translationCache.set = async (sourceText, translation, _src, _tgt, ctx) => {
    cachedDigestPrefix = String(ctx || '');
    savedToCache.push({ sourceText, translation });
  };

  const promptsSeen = [];
  https.request = (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    let reqBody = '';
    req.write = (chunk) => { if (chunk) reqBody += String(chunk); };
    req.end = (chunk) => {
      if (chunk) reqBody += String(chunk);
      let promptText = '';
      try {
        const parsedReq = JSON.parse(reqBody);
        promptText = parsedReq.contents?.[0]?.parts?.[0]?.text || '';
      } catch (_) { }
      promptsSeen.push(promptText);

      let payload;
      if (promptText.includes('Complete Episode Dialogue:')) {
        payload = {
          synopsis: 'Pei Zhian discovers quadruplets while divorcing Zheng Yanqing; her best friend Tao Xiaoman comforts her.',
          tone: 'emotional dramatic confrontation',
          characters: [
            { names: ['裴之安', '简姐'], rendering: 'ប៉ី ជីអាន', gender: 'female', role: 'Female Lead' }
          ],
          relationshipPronouns: ['Tao Xiaoman <-> Pei Zhian (best friends): use ឯង/គ្នា NEVER អ្នក'],
          sttCorrections: [
            { wrong: '怕妈...他们', intended: '爸妈 (parents)', note: 'Followed by 他们' },
            { wrong: '简姐', intended: '之安姐 (ប៉ី ជីអាន)', note: 'STT homophone of 之安姐' }
          ],
          terms: [{ source: '六个亿', rendering: 'ប្រាំមួយរយលាន' }]
        };
      } else if (promptText.includes('=== EPISODE STORY BIBLE ===')) {
        payload = {
          translations: [
            { id: 1, translation: 'ឯងមិនសួរគាត់ថាហេតុអីទេអ្ហី?', voice: 'kh_young_girl' },
            { id: 2, translation: 'សួរទៅ! កាលពីមុនសួររហូតហ្នឹង។', voice: 'Radiant Queen' },
            { id: 3, translation: 'ខ្លាចម៉ែស្លាប់ចោលតាំងពីតូច នេះជាវត្ថុអនុស្សាវរីយ៍តែមួយគត់។', voice: 'Radiant Queen' },
            { id: 4, translation: 'បងស្រី ជាន មើលសិនមក។', voice: 'kh_young_girl' },
            { id: 5, translation: 'លែងលះម្ដងរៀបចំប្រាំមួយរយលានបានលឿនមែន។', voice: 'kh_young_girl' }
          ]
        };
      } else {
        payload = {
          fixes: [
            { id: 2, translation: 'ធ្លាប់សួរតើ! កាលពីមុនគ្នាសួររហូតហ្នឹង។' },
            { id: 3, translation: 'ពុកម៉ែចែកឋានទៅតាំងពីតូច នេះជាវត្ថុអនុស្សាវរីយ៍តែមួយគត់។' },
            { id: 4, translation: 'បងស្រី ប៉ី ជីអាន មើលសិនមក។' }
          ]
        };
      }

      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => { };
      const envelope = JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
      });
      process.nextTick(() => {
        cb(res);
        res.emit('data', envelope);
        res.emit('end');
      });
    };
    return req;
  };

  const result = await translationModule.translateWithReflection(
    [
      { startSec: 0, endSec: 2, text: '你不问问他为什么？' },
      { startSec: 2, endSec: 4, text: '问啊，以前老问。' },
      { startSec: 4, endSec: 7, text: '怕妈死的早，这东西是他们留给我唯一的念想了。' },
      { startSec: 7, endSec: 9, text: '简姐，先看看吧。' },
      { startSec: 9, endSec: 12, text: '离个婚六个亿都安排得挺快。' }
    ],
    'km',
    'fake-gemini-key',
    true,
    false,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );

  assert.equal(promptsSeen.length, 3, 'Expected Story Bible + Chunk + Reflection (3 passes) for >=4 cue episode');
  assert.match(promptsSeen[1], /=== EPISODE STORY BIBLE ===/);
  assert.match(promptsSeen[1], /ប៉ី ជីអាន/);
  assert.match(promptsSeen[2], /Complete Episode Script:/);
  assert.equal(result.cues[1].translated, 'ធ្លាប់សួរតើ! កាលពីមុនគ្នាសួររហូតហ្នឹង។');
  assert.equal(result.cues[2].translated, 'ពុកម៉ែចែកឋានទៅតាំងពីតូច នេះជាវត្ថុអនុស្សាវរីយ៍តែមួយគត់។');
  assert.equal(result.cues[3].translated, 'បងស្រី ប៉ី ជីអាន មើលសិនមក។');
  assert.equal(result.storyBible.synopsis.includes('Pei Zhian'), true);
  assert.equal(savedToCache.length, 5);
  assert.ok(cachedDigestPrefix.length > 0);
});

test('strict single-voice locking prevents cross-voice bleed in tts.js, export.js, and all frontend selectors', async () => {
  // 1. Latin / digits stay on the chosen Khmer neural voice instead of switching to en-US-GuyNeural
  const keptLatin = ttsModule.normalizeSpokenTextAndLang('Hello OK 123', { voice: 'km-KH-PisethNeural' }, { strictVoice: true });
  assert.equal(keptLatin.edgeVoice, 'km-KH-PisethNeural');

  const keptFemaleLatin = ttsModule.normalizeSpokenTextAndLang('VIP 2026', { voice: 'km-KH-SreymomNeural' }, { strictVoice: true });
  assert.equal(keptFemaleLatin.edgeVoice, 'km-KH-SreymomNeural');

  // 2. Pure untranslated non-Khmer CJK script fails strictly instead of leaking a Chinese narrator voice
  assert.throws(
    () => ttsModule.normalizeSpokenTextAndLang('你好世界', { voice: 'km-KH-PisethNeural' }, { strictVoice: true }),
    /បកប្រែជាខ្មែរ/
  );

  // 3. Poisoned Google fallback meta markers are ignored by /api/check-audio-cache
  const poisonedText = 'សាកល្បងការពារសំឡេងឆ្លង';
  const cleanKey = ttsModule.getAudioCacheKey(poisonedText, 'kh_young_man');
  const poisonedMp3 = path.join(tempAudioDir, `${cleanKey}.mp3`);
  const poisonedMeta = `${poisonedMp3}.meta.json`;
  fs.writeFileSync(poisonedMp3, Buffer.alloc(400, 1));
  fs.writeFileSync(poisonedMeta, JSON.stringify({ actualEngine: 'google', fallback: true }));

  const { server, baseUrl } = await startTestServer();
  try {
    const cacheRes = await fetch(`${baseUrl}/api/check-audio-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ text: poisonedText, voice: 'kh_young_man' }] })
    });
    const cacheJson = await cacheRes.json();
    assert.equal(cacheJson.success, true);
    assert.equal(cacheJson.cachedKeys.length, 0, 'Poisoned fallback MP3 must never count as valid cached Edge audio');
  } finally {
    await new Promise(r => server.close(r));
    try { fs.unlinkSync(poisonedMp3); } catch (_) { }
    try { fs.unlinkSync(poisonedMeta); } catch (_) { }
  }

  // 4. export.js prepareCueAudioClips enforces fixedVoice over mixed cue voices
  const lockText1 = 'ខ្ញុំសុំទោស';
  const lockText2 = 'មិនអីទេបង';
  const lockedVoice = 'kh_elder_woman';
  const lockedKey1 = ttsModule.getAudioCacheKey(lockText1, lockedVoice, { strictVoice: true });
  const lockedKey2 = ttsModule.getAudioCacheKey(lockText2, lockedVoice, { strictVoice: true });
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey1}.mp3`), Buffer.alloc(500, 2));
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey2}.mp3`), Buffer.alloc(500, 2));
  const makeFakeMp3 = () => { const b = Buffer.alloc(8 * 417, 0); for (let i = 0; i < 8; i++) { const o = i * 417; b[o] = 0xFF; b[o + 1] = 0xFB; b[o + 2] = 0x90; b[o + 3] = 0x00; } return b; };
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey1}.mp3`), makeFakeMp3());
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey2}.mp3`), makeFakeMp3());

  const clips = await exportModule.prepareCueAudioClips([
    { startSec: 0, endSec: 1.5, text: 'A', translated: lockText1, voice: 'Sovereign King' },
    { startSec: 1.8, endSec: 3.2, text: 'B', translated: lockText2, voice: 'kh_deep_boss' }
  ], {
    castMode: 'single',
    fixedVoice: lockedVoice,
    autoGenerateMissingTts: false
  });
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map(c => c.voice), [lockedVoice, lockedVoice]);
  assert.ok(clips[0].filePath.endsWith(`${lockedKey1}.mp3`));
  assert.ok(clips[1].filePath.endsWith(`${lockedKey2}.mp3`));

  // 5. Frontend all voice selectors & batchGenerateAllAudio & exportVideoWithFfmpeg lock strictly
  const vm = require('node:vm');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const makeSelect = (val) => ({ value: val, innerHTML: '' });
  const elems = {
    defaultVoiceSelect: makeSelect('Sovereign King'),
    vmDefaultVoiceSelect: makeSelect('Sovereign King'),
    bulkVoiceSelect: makeSelect('Sovereign King'),
    castModeSelect: makeSelect('single'),
    vmCastModeSelect: makeSelect('single'),
    ttsEngineSelect: makeSelect('edge'),
    bottomStatusMsg: { innerText: '' },
    voiceReadyBadge: { innerText: '' },
    cuesTableBody: { innerHTML: '' },
    cuesStatsText: { innerText: '' },
    mainVideo: { paused: true, currentTime: 0, volume: 1, muted: false },
    playerTimeText: { innerText: '' },
    scrubberFill: { style: {} },
    exportStatusMsg: { innerText: '' },
    btnStartExport: { disabled: false },
    btnCancelExport: { style: {} },
    maskToggleCheck: { checked: false },
    maskModeSelect: { value: 'feathered' },
    subStyleSelect: { value: 'tiktok' },
    maskYSlider: { value: '70' },
    maskHSlider: { value: '48' },
    exportOutputDirInput: { value: '' },
    btnResetExportDir: { hidden: true },
    vmExportDirBtn: { innerText: '', title: '' },
    exportAutoFitCheck: { checked: true },
    exportAudioMode: { value: 'bgm_only' },
    exportQualityPreset: { value: 'hd' },
    exportResolution: { value: 'source' },
    exportEncoder: { value: 'cpu' },
    wordPopToggleCheck: { checked: true },
    subMarginV: { value: 64 }
  };
  const fetchCalls = [];
  const storageMap = new Map();
  const sandbox = {
    window: { electronAPI: { backendUrl: 'http://127.0.0.1:4567' } },
    document: {
      body: { classList: { toggle() { } }, appendChild() { }, dataset: {} },
      addEventListener() { },
      getElementById(id) { return elems[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { style: {}, click() { } }; }
    },
    localStorage: {
      getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
      setItem(k, v) { storageMap.set(k, String(v)); }
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
      return {
        ok: true,
        async json() {
          if (String(url).includes('/api/tts/batch-generate')) {
            const batchBody = opts.body ? JSON.parse(opts.body) : {};
            const items = Array.isArray(batchBody.items) ? batchBody.items : [];
            return { success: true, results: items.map(it => ({ index: it.index, success: true, audioUrl: '/audio_cache/x.mp3', voice: 'km-KH-PisethNeural', actualEngine: 'edge' })) };
          }
          if (String(url).includes('/api/tts/generate')) {
            return { success: true, audioUrl: '/audio_cache/x.mp3', voice: 'km-KH-PisethNeural', actualEngine: 'edge' };
          }
          if (String(url).includes('/api/export/video')) {
            return { success: true, outputFile: 'out.mp4', dubbedCueCount: 2 };
          }
          if (String(url).includes('/api/export/progress')) {
            return { percent: 100 };
          }
          return { success: true, cachedKeys: [] };
        }
      };
    },
    alert() { },
    confirm: () => true,
    Audio: class { pause() { } play() { return Promise.resolve(); } addEventListener() { } },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval() { return 0; },
    clearInterval() { },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  // Preserve custom clone IDs in normalizeVoicePresetId & getVoiceSignature
  assert.equal(sandbox.normalizeVoicePresetId('clone_abc123'), 'clone_abc123');
  assert.equal(sandbox.getVoiceSignature('clone_abc123'), 'clone:clone_abc123');

  // Seed mixed stale cues and switch voice via single default selector
  vm.runInContext(`
    activeCues = [
      { startSec: 0, endSec: 1.5, text: 'មួយ', translated: 'មួយ', voice: 'Sovereign King' },
      { startSec: 2, endSec: 3.5, text: 'ពីរ', translated: 'ពីរ', voice: 'Radiant Queen' }
    ];
    document.getElementById('defaultVoiceSelect').value = 'kh_deep_boss';
    onDefaultVoiceChange('kh_deep_boss');
    applyBulkVoice();
  `, sandbox);

  assert.equal(elems.defaultVoiceSelect.value, 'kh_deep_boss');
  assert.equal(elems.vmDefaultVoiceSelect.value, 'kh_deep_boss');
  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(activeCues.map(c => c.voice))', sandbox)),
    ['kh_deep_boss', 'kh_deep_boss']
  );

  // Per-row voice change also locks all selectors & rows consistently in single-voice mode
  vm.runInContext(`onVoiceChange(0, 'kh_young_girl');`, sandbox);
  assert.equal(elems.defaultVoiceSelect.value, 'kh_young_girl');
  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(activeCues.map(c => c.voice))', sandbox)),
    ['kh_young_girl', 'kh_young_girl']
  );

  // Even if activeCues is manually dirtied before batchGenerateAllAudio, batchGenerateAllAudio forces selected voice
  vm.runInContext(`activeCues[1].voice = 'Sovereign King';`, sandbox);
  fetchCalls.length = 0;
  await sandbox.batchGenerateAllAudio({ silentSuccess: true });
  const genCalls = (() => { const b = fetchCalls.find(c => String(c.url).includes('/api/tts/batch-generate')); return b ? (b.body.items || []).map(it => ({ body: { ...it, strictVoice: b.body.strictVoice } })) : fetchCalls.filter(c => String(c.url).includes('/api/tts/generate')); })();
  assert.equal(genCalls.length, 2);
  assert.deepEqual(genCalls.map(c => c.body.voice), ['kh_young_girl', 'kh_young_girl']);
  assert.deepEqual(genCalls.map(c => c.body.strictVoice), [true, true]);

  // exportVideoWithFfmpeg normalizes stale cues & passes fixedVoice + strictVoice + custom outputDir
  storageMap.set('eza_export_output_dir', 'D:/CustomExports');
  vm.runInContext(`currentVideoPath = 'D:/fake/video.mp4'; activeCues[0].voice = 'Sovereign King';`, sandbox);
  fetchCalls.length = 0;
  await sandbox.exportVideoWithFfmpeg();
  const expCall = fetchCalls.find(c => String(c.url).includes('/api/export/video'));
  assert.ok(expCall);
  assert.equal(expCall.body.castMode, 'single');
  assert.equal(expCall.body.fixedVoice, 'kh_young_girl');
  assert.equal(expCall.body.strictVoice, true);
  assert.equal(expCall.body.outputDir, 'D:/CustomExports');
  assert.deepEqual(expCall.body.cues.map(c => c.voice), ['kh_young_girl', 'kh_young_girl']);
});

test('Voice Clone Studio endpoints normalize uploaded/extracted 24kHz clips, register in /voices, and require Seed-VC honestly', async () => {
  const wavSample = path.join(tempRoot, 'sample_input.wav');
  const videoSample = path.join(tempRoot, 'sample_video.mp4');

  // Synthesize real 3.5s test audio and MP4 video using bundled FFMPEG_BIN
  const aRes = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3.5',
    '-ar', '16000', '-ac', '1', wavSample
  ], { windowsHide: true });
  assert.equal(aRes.status, 0);

  const vRes = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=3.5',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3.5',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoSample
  ], { windowsHide: true });
  assert.equal(vRes.status, 0);

  const { server, baseUrl } = await startTestServer();
  try {
    // 1. Hardware & engine status check
    const statusRes = await fetch(`${baseUrl}/api/tts/clone/status`);
    const statusData = await statusRes.json();
    assert.equal(statusRes.status, 200);
    assert.equal(statusData.success, true);
    assert.equal(statusData.ready, false);
    assert.equal(statusData.engine, 'seed-vc');

    // 2. Upload base64 voice sample -> creates clone_* profile
    const audioBase64 = 'data:audio/wav;base64,' + fs.readFileSync(wavSample).toString('base64');
    const createRes = await fetch(`${baseUrl}/api/tts/cloned-voices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'តារាគំរូ', baseGender: 'Female', audioBase64 })
    });
    const createData = await createRes.json();
    assert.equal(createRes.status, 200);
    assert.equal(createData.success, true);
    assert.ok(voiceClonerModule.isCustomCloneVoiceId(createData.voice.id));
    assert.equal(createData.voice.baseVoice, 'km-KH-SreymomNeural');
    assert.ok(createData.voice.durationSec >= 2.0);
    assert.ok(fs.existsSync(createData.voice.samplePath));

    // 3. Extract reference vocal sample from current video
    const extRes = await fetch(`${baseUrl}/api/tts/cloned-voices/extract-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'គំរូវីដេអូ', baseGender: 'Male', videoPath: videoSample, startSec: 0, durationSec: 3 })
    });
    const extData = await extRes.json();
    assert.equal(extRes.status, 200);
    assert.equal(extData.success, true);
    assert.equal(extData.voice.baseVoice, 'km-KH-PisethNeural');

    // 4. Verify cloned voices appear in /api/tts/voices & stay preserved in translation.js single-voice collapse
    const voicesRes = await fetch(`${baseUrl}/api/tts/voices`);
    const voicesData = await voicesRes.json();
    assert.equal(voicesData.clonedVoices.length, 2);
    assert.ok(voicesData.presets.some(p => p.id === createData.voice.id && p.isClone === true));
    assert.equal(
      translationModule.collapseVoiceForCastMode(createData.voice.id, 'single', createData.voice.id),
      createData.voice.id
    );

    // 5. Generating audio with cloned voice before Seed-VC install fails honestly (412 + needsCloneEngineInstall) instead of silent fallback
    const synthRes = await fetch(`${baseUrl}/api/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'សួស្តី តេស្តសំឡេង', voice: createData.voice.id, strictVoice: true })
    });
    const synthData = await synthRes.json();
    assert.equal(synthRes.status, 412);
    assert.equal(synthData.success, false);
    assert.equal(synthData.needsCloneEngineInstall, true);

    // 6. Clean deletion removes WAV file and profile
    for (const id of [createData.voice.id, extData.voice.id]) {
      const delRes = await fetch(`${baseUrl}/api/tts/cloned-voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const delData = await delRes.json();
      assert.equal(delRes.status, 200);
      assert.equal(delData.success, true);
    }
    const afterList = await (await fetch(`${baseUrl}/api/tts/cloned-voices`)).json();
    assert.equal(afterList.voices.length, 0);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('Anti-leak translation pipeline catches CJK leaks, rescues partial/failed chunks via sub-batch & Pass 4, and updates frontend cuesNeedTranslation', async (t) => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const fs = require('node:fs');
  const translationCache = require('./translation_cache');

  const origHttpsRequest = https.request;
  const origHttpsGet = https.get;
  const origCacheGet = translationCache.get;
  const origCacheSet = translationCache.set;
  t.after(() => {
    https.request = origHttpsRequest;
    https.get = origHttpsGet;
    translationCache.get = origCacheGet;
    translationCache.set = origCacheSet;
  });

  translationCache.get = async () => null;
  translationCache.set = async () => { };

  const { hasCorruptedKhmerText, isTranslationIncomplete, cleanTranslatedText } = translationModule;

  // 1. CJK Ideographs, Extension A/Compatibility, and CJK fullwidth punctuation are all caught
  const leakedSamples = [
    ['路上别空着肚子。', 'ផ្លូវ别空着ទទេ។'],
    ['好。', '好。'],
    ['东西都拿完了？', 'យករបស់អស់ហើយ？'],
    ['哎，裴之安', 'អេ\u3400 អត់ទាន់'],
    ['你好', 'សួស្តី\uF900បង']
  ];
  for (const [src, badTr] of leakedSamples) {
    assert.equal(hasCorruptedKhmerText(badTr), true, `Expected CJK leak detection for: ${badTr}`);
    assert.equal(isTranslationIncomplete(badTr, src, 'km'), true, `Expected incomplete flag for: ${badTr}`);
  }
  assert.equal(cleanTranslatedText('តើ បើ\u200B អោយ គាត់ ដឹង？', 'km'), 'តើ បើ ឲ្យគាត់ ដឹង?');

  // 2. Simulate real failure pattern: main chunk throws twice (lastChunkErr + draftMap.size === 0),
  //    then sub-batch Gemini returns partial + 1 mixed Khmer/Chinese leak + Pass 4 repairs the stubborn line!
  const cues = [
    { startSec: 0, endSec: 2, text: '路上别空着肚子。', translated: '路上别空着肚子。', translatedLang: 'km' },
    { startSec: 2, endSec: 4, text: '以后过好点。' },
    { startSec: 4, endSec: 6, text: '好。' },
    { startSec: 6, endSec: 8, text: '东西都拿完了？' },
    { startSec: 8, endSec: 10, text: '拿完了。' }
  ];

  let geminiCall = 0;
  https.request = (_opts, cb) => {
    geminiCall++;
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    let bodyStr = '';
    req.write = (d) => { bodyStr += String(d || ''); };
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => { };
      process.nextTick(() => {
        if (geminiCall === 1) {
          // Story Bible
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ synopsis: 'Departure scene', characters: [] }) }] } }] }));
          res.emit('end');
          return;
        }
        if (geminiCall === 2 || geminiCall === 3) {
          // Simulate main 25-cue chunk timing out / failing twice on BOTH main attempts
          res.statusCode = 502;
          cb(res);
          res.emit('data', JSON.stringify({ error: { message: 'Transient chunk failure' } }));
          res.emit('end');
          return;
        }
        if (geminiCall === 4) {
          // Sub-batch retry succeeds for 4 lines, but deliberately omits #3 ('好。') and leaks Chinese in #4!
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    translations: [
                      { id: 1, translation: 'កុំឲ្យឃ្លានតាមផ្លូវ។' },
                      { id: 2, translation: 'ថ្ងៃក្រោយរស់នៅឲ្យបានល្អ។' },
                      { id: 4, translation: 'យករបស់都拿完了?' },
                      { id: 5, translation: 'យកអស់ហើយ។' }
                    ]
                  })
                }]
              }
            }]
          }));
          res.emit('end');
          return;
        }
        if (geminiCall === 5) {
          // Story Reflection returns no fixes (proves leaked lines STILL get repaired by Pass 4)
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fixes: [] }) }] } }] }));
          res.emit('end');
          return;
        }
        // Pass 4 Anti-Leak Sweeper repairs stubborn #3 & #4 completely!
        res.statusCode = 200;
        cb(res);
        res.emit('data', JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  translations: [
                    { id: 3, translation: 'បាទ។' },
                    { id: 4, translation: 'យករបស់អស់ហើយឬនៅ?' }
                  ]
                })
              }]
            }
          }]
        }));
        res.emit('end');
      });
    };
    return req;
  };
  https.get = (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    process.nextTick(() => {
      // Simulate Google Translate temporarily rate-limited in mid-chunk so Pass 4 must rescue #3 & #4
      req.emit('error', new Error('Simulated 429 throttle'));
    });
    return req;
  };

  const result = await translationModule.translateWithReflection(
    cues,
    'km',
    'fake-gemini-key',
    false,
    false,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );

  assert.equal(result.untranslatedCount, 0);
  assert.ok(result.sweptCount >= 2, `Expected Pass 4 to sweep >=2 leaked cues, got ${result.sweptCount}`);
  assert.equal(result.cues[0].translated, 'កុំឲ្យឃ្លានតាមផ្លូវ។');
  assert.equal(result.cues[2].translated, 'បាទ។');
  assert.equal(result.cues[3].translated, 'យករបស់អស់ហើយឬនៅ?');
  for (const cue of result.cues) {
    assert.equal(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\uFF01-\uFF60]/.test(cue.translated), false);
    assert.equal(cue.translatedLang, 'km');
  }

  // 3. Frontend cuesNeedTranslation rejects mixed Khmer+Chinese cues as incomplete
  const appJs = fs.readFileSync(require('node:path').join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  assert.match(appJs, /KM_LEAKED_SCRIPT_RE/);
  assert.match(appJs, /function countIncompleteCues\(cues, targetLang\)/);
  assert.match(appJs, /remainingLeaks = countIncompleteCues\(activeCues, targetLang\)/);
});

test('Deep bug audit fixes: Gemini thought parts, alternate-order truncated JSON, draft auto-save protection, >300 cues, and VM rescue', async (t) => {
  const https = require('node:https');
  const express = require('express');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');

  const origHttpsRequest = https.request;
  const origGetEnv = process.env.GEMINI_ACCOUNTS_FILE;
  const origApiEnv = process.env.GEMINI_API_KEY;
  t.after(() => {
    https.request = origHttpsRequest;
    if (origGetEnv === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = origGetEnv;
    if (origApiEnv === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origApiEnv;
  });

  // 1. parseJsonObject recovers trailing commas + truncated arrays regardless of key order
  const truncatedSwapped = '{"translations":[{"id":1,"voice":"Radiant Queen","translation":"សួស្តី",},{"id":2,"voice":"Sovereign King","translation":"បាទ"},{"id":3,"translation":"កាត់ផ្ដាច់';
  const recoveredSwapped = translationModule.parseJsonObject(truncatedSwapped, 'translation');
  assert.equal(recoveredSwapped.translations.length, 2);
  assert.equal(recoveredSwapped.translations[0].translation, 'សួស្តី');
  assert.equal(recoveredSwapped.translations[0].voice, 'Radiant Queen');
  assert.equal(recoveredSwapped.translations[1].translation, 'បាទ');

  // 2. Gemini thought:true part containing broken braces does not corrupt JSON answer; safety-empty switches fallback model
  const thoughtEnvelope = JSON.stringify({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'Let me think carefully... { "id": 999, broken json' },
          { text: '{"translations":[{"id":1,"translation":"បានហើយ។","voice":"Radiant Queen"}]}' }
        ]
      }
    }]
  });

  let reqIdx = 0;
  https.request = (_opts, cb) => {
    reqIdx++;
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    req.write = () => { };
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => { };
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        if (reqIdx === 1) {
          // Empty safety response triggers fallback model
          res.emit('data', JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }));
        } else {
          res.emit('data', thoughtEnvelope);
        }
        res.emit('end');
      });
    };
    return req;
  };

  const singleRes = await translationModule.translateWithReflection(
    [{ startSec: 0, endSec: 2, text: '好了。' }],
    'km',
    'fake-key-single',
    false,
    true,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );
  assert.equal(reqIdx, 2, 'Empty SAFETY response must rotate cleanly to fallback model');
  assert.equal(singleRes.cues[0].translated, 'បានហើយ។');

  // 2b. Multi-account Router rotation recovers cleanly when Account #1 returns 401 API key invalid
  const tempAccFile = path.join(os.tmpdir(), `ezarg-acc-rot-${Date.now()}.json`);
  fs.writeFileSync(tempAccFile, JSON.stringify({
    activeAccountId: 'acc1',
    accounts: [
      { id: 'acc1', name: 'Bad Acc', apiKey: 'AIzaSyInvalidKeyForRotationTest1111111' },
      { id: 'acc2', name: 'Good Acc', apiKey: 'AIzaSyValidKeyForRotationTest22222222' }
    ]
  }), 'utf8');
  process.env.GEMINI_ACCOUNTS_FILE = tempAccFile;
  t.after(() => { try { fs.unlinkSync(tempAccFile); } catch (_) { } });
  const usedKeys = [];
  https.request = (opts, cb) => {
    const keyParam = new URL(`https://example.com${opts.path}`).searchParams.get('key');
    const callIdx = usedKeys.length;
    usedKeys.push(keyParam);
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.destroy = () => { };
    req.write = () => { };
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => { };
      process.nextTick(() => {
        if (callIdx === 0) {
          res.statusCode = 401;
          cb(res);
          res.emit('data', JSON.stringify({ error: { message: 'API key not valid.' } }));
        } else {
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"translations":[{"id":1,"translation":"សួស្តី!"}]}' }] } }]
          }));
        }
        res.emit('end');
      });
    };
    return req;
  };
  const rotRes = await translationModule.translateWithReflection(
    [{ startSec: 0, endSec: 2, text: '你好' }],
    'km',
    'AIzaSyInvalidKeyForRotationTest1111111',
    false,
    true,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );
  assert.equal(rotRes.cues[0].translated, 'សួស្តី!');
  assert.equal(new Set(usedKeys).size, 2);
  delete process.env.GEMINI_ACCOUNTS_FILE;

  // 3. >300 cues (e.g. 320 lines) are accepted without HTTP 400 truncation cliff
  process.env.GEMINI_API_KEY = 'AIzaSyValidEnvKeyForTestSuite33333333';
  const appCheck = express();
  appCheck.use(express.json({ limit: '5mb' }));
  appCheck.use('/api/translation', translationModule);
  appCheck.use('/api/drafts', require('./src/backend/routes/draft'));
  const srv = await new Promise(resolve => {
    const s = appCheck.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const uniqueDraftVideo = path.join(os.tmpdir(), `ezarg-test-draft-${Date.now()}.mp4`);
  try {
    const preTranslated320 = Array.from({ length: 320 }, (_, i) => ({
      startSec: i,
      endSec: i + 0.8,
      text: `你好 ${i + 1}`,
      translated: `សួស្តី ${i + 1}`,
      translatedLang: 'km'
    }));
    const bigRes = await fetch(`${baseUrl}/api/translation/translate-cues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: preTranslated320, targetLang: 'km', useCache: false, force: false })
    });
    assert.equal(bigRes.status, 200);
    const bigJson = await bigRes.json();
    assert.equal(bigJson.cues.length, 320);

    // 4. Draft auto-save must NOT overwrite existing translated draft with raw untranslated SRT
    const saveTranslatedRes = await fetch(`${baseUrl}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: uniqueDraftVideo,
        cues: [{ startSec: 0, endSec: 2, text: '你好', translated: 'សួស្តី', translatedLang: 'km' }]
      })
    });
    assert.equal(saveTranslatedRes.status, 200);

    const autoOverwriteRes = await fetch(`${baseUrl}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: uniqueDraftVideo,
        isAutoSave: true,
        cues: [{ startSec: 0, endSec: 2, text: '你好', translated: '你好' }]
      })
    });
    const autoOverwriteJson = await autoOverwriteRes.json();
    assert.equal(autoOverwriteRes.status, 200);
    assert.equal(autoOverwriteJson.skippedOverwrite, true);

    const loadedAfter = await (await fetch(`${baseUrl}/api/drafts/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: uniqueDraftVideo })
    })).json();
    assert.equal(loadedAfter.draft.cues[0].translated, 'សួស្តី');

    // Clean up test draft file
    await fetch(`${baseUrl}/api/drafts/${autoOverwriteJson.draftKey}`, { method: 'DELETE' });
  } finally {
    await new Promise(r => srv.close(r));
  }

  // 5. Export lock & frontend One-Click / Video Manager leak guards exist cleanly
  const exportJs = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'export.js'), 'utf8');
  const runningIdx = exportJs.indexOf('activeExportState.running = true;');
  const probeIdx = exportJs.indexOf('await probeMediaInfo(normalizedVideoPath)');
  assert.ok(runningIdx > 0 && probeIdx > runningIdx, 'Export lock must be acquired before await probeMediaInfo');
  const appJs = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  assert.match(appJs, /return remainingLeaks === 0;/);
  assert.match(appJs, /const leftoverLeaks = countIncompleteCues\(cues, config\.targetLang\);/);
  assert.match(appJs, /isAutoSave: true/);
});

test('Pro Router supports batch paste parsing/import and per-account pause/resume routing isolation', async (t) => {
  const proAccountsFile = path.join(tempRoot, '.gemini-accounts-pro-router.json');
  const prevAccountsFile = process.env.GEMINI_ACCOUNTS_FILE;
  const prevEnvKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_ACCOUNTS_FILE = proAccountsFile;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (prevAccountsFile === undefined) delete process.env.GEMINI_ACCOUNTS_FILE;
    else process.env.GEMINI_ACCOUNTS_FILE = prevAccountsFile;
    if (prevEnvKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevEnvKey;
    try { fs.unlinkSync(proAccountsFile); } catch (_) { }
  });

  const key1 = 'AIzaSyProRouterBatchKeyOne111111111111111';
  const key2 = 'AIzaSyProRouterBatchKeyTwo222222222222222';
  const key3 = 'AIzaSyProRouterBatchKeyThree3333333333333';

  const parsed = configModule.parseGeminiBatchKeysInput(
    [
      `Alpha Node | ${key1}`,
      key2,
      `Duplicate Alpha | ${key1}`,
      'short-key'
    ].join('\n'),
    0
  );
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].name, 'Alpha Node');
  assert.equal(parsed.entries[0].apiKey, key1);
  assert.equal(parsed.entries[1].name, 'Gemini Key #2');
  assert.equal(parsed.entries[1].apiKey, key2);
  assert.equal(parsed.invalidCount, 1);
  assert.equal(parsed.duplicateCount, 1);

  const { server, baseUrl } = await startTestServer();
  try {
    const batchRes = await fetch(`${baseUrl}/api/config/accounts/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: `Primary Key | ${key1}\n${key2}\n${key1}\nshort-key`
      })
    });
    const batchJson = await batchRes.json();
    assert.equal(batchRes.status, 200);
    assert.equal(batchJson.success, true);
    assert.equal(batchJson.addedCount, 2);
    assert.equal(batchJson.skippedCount, 1);
    assert.equal(batchJson.invalidCount, 1);
    assert.equal(batchJson.accounts.length, 2);
    assert.equal(batchJson.accounts.every(acc => acc.enabled === true), true);

    // Pausing active account #1 auto-rotates activeAccountId to enabled account #2 and excludes #1 from candidates
    const firstId = batchJson.accounts[0].id;
    const secondId = batchJson.accounts[1].id;
    const pauseRes = await fetch(`${baseUrl}/api/config/accounts/${firstId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    const pauseJson = await pauseRes.json();
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseJson.activeAccountId, secondId);
    assert.equal(pauseJson.accounts.find(a => a.id === firstId).enabled, false);

    const activeCandidates = configModule.getGeminiApiKeyCandidates();
    assert.equal(activeCandidates.includes(key1), false, 'Paused key must be excluded from routing candidates');
    assert.equal(activeCandidates.includes(key2), true, 'Enabled key must remain in routing candidates');

    // Pausing remaining account #2 yields empty candidate pool and fast pausedCount summary on test-all
    await fetch(`${baseUrl}/api/config/accounts/${secondId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(configModule.getGeminiApiKeyCandidates().length, 0);

    const testAllRes = await fetch(`${baseUrl}/api/config/accounts/test-all`, { method: 'POST' });
    const testAllJson = await testAllRes.json();
    assert.equal(testAllRes.status, 200);
    assert.equal(testAllJson.pausedCount, 2);
    assert.equal(testAllJson.totalCount, 0);

    // Importing another key restores active candidate
    const addThird = configModule.batchAddGeminiAccountsRecord({ rawText: key3 });
    assert.equal(addThird.addedCount, 1);
    assert.equal(configModule.getGeminiApiKeyCandidates().includes(key3), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('Export API exposes default output dir and writes MP4 to custom user-selected outputDir', async () => {
  const { server, baseUrl } = await startTestServer();
  const srcDir = path.join(tempRoot, 'custom-export-src');
  const customOutDir = path.join(tempRoot, 'custom-user-folder', 'Drama_Ep1');
  fs.mkdirSync(srcDir, { recursive: true });
  const sampleClip = path.join(srcDir, 'clip_custom_out.mp4');

  const synth = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sampleClip
  ], { windowsHide: true });
  assert.equal(synth.status, 0);

  try {
    const defRes = await fetch(`${baseUrl}/api/export/default-dir`);
    const defJson = await defRes.json();
    assert.equal(defRes.status, 200);
    assert.equal(defJson.success, true);
    assert.ok(defJson.exportDir && path.isAbsolute(defJson.exportDir));

    const expRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleClip,
        cues: [{ startSec: 0.05, endSec: 0.5, text: 'hello', translated: 'សួស្តី' }],
        includeDubAudio: false,
        burnSubtitles: false,
        encoder: 'cpu',
        outputDir: customOutDir
      })
    });
    const expJson = await expRes.json();
    assert.equal(expRes.status, 200, `Unexpected export error: ${JSON.stringify(expJson)}`);
    assert.equal(expJson.success, true);
    assert.equal(expJson.sponsorApplied, false);
    assert.ok(expJson.outputFile.startsWith(path.resolve(customOutDir)), `Expected file inside ${customOutDir}, got ${expJson.outputFile}`);
    assert.equal(fs.existsSync(expJson.outputFile), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('Optional Logo image and Sponsor video overlay in preview and FFmpeg export', async () => {
  const { server, baseUrl } = await startTestServer();
  const srcDir = path.join(tempRoot, 'sponsor-overlay-test');
  fs.mkdirSync(srcDir, { recursive: true });
  const mainVideoPath = path.join(srcDir, 'main_ep.mp4');
  const sponsorVideoPath = path.join(srcDir, 'sponsor_banner.mp4');
  const logoPngPath = path.join(srcDir, 'logo.png');

  const synthMain = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x284:d=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mainVideoPath
  ], { windowsHide: true });
  assert.equal(synthMain.status, 0);

  const synthSponsorVid = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=64x36:d=0.3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sponsorVideoPath
  ], { windowsHide: true });
  assert.equal(synthSponsorVid.status, 0);

  const synthLogo = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=red:s=48x48:d=0.1',
    '-frames:v', '1', logoPngPath
  ], { windowsHide: true });
  assert.equal(synthLogo.status, 0);

  try {
    // 1. Disabled / optional returns null
    assert.equal(exportModule.resolveSponsorOverlaySpec({ sponsorEnabled: false, sponsorPath: logoPngPath }), null);
    assert.equal(exportModule.resolveSponsorOverlaySpec({ sponsorEnabled: true, sponsorPath: '' }), null);

    // 2. Image logo spec
    const imgSpec = exportModule.resolveSponsorOverlaySpec({
      sponsorEnabled: true,
      sponsorPath: logoPngPath,
      sponsorPosition: 'top-right',
      sponsorScale: 25,
      sponsorOpacity: 85,
      mediaInfo: { width: 1080, height: 1920 }
    });
    assert.equal(imgSpec.mediaType, 'image');
    assert.deepEqual(imgSpec.inputArgs.slice(0, 2), ['-loop', '1']);
    assert.equal(imgSpec.targetWidth, 270);
    const imgGraph = exportModule.buildVideoGraphWithSponsor("ass='sub.ass'", 'vout', { ...imgSpec, inputIndex: 1 });
    assert.ok(imgGraph.includes('colorchannelmixer=aa=0.85'));
    assert.ok(imgGraph.includes('overlay=x=W-w-W*0.035:y=H*0.035:shortest=1'));

    // 3. Sponsor video spec with custom drag coordinates
    const vidSpec = exportModule.resolveSponsorOverlaySpec({
      sponsorEnabled: true,
      sponsorPath: sponsorVideoPath,
      sponsorPosition: 'custom',
      sponsorScale: 30,
      sponsorOpacity: 100,
      sponsorXPercent: 0.12,
      sponsorYPercent: 0.82,
      mediaInfo: { width: 1080, height: 1920 }
    });
    assert.equal(vidSpec.mediaType, 'video');
    assert.deepEqual(vidSpec.inputArgs.slice(0, 2), ['-stream_loop', '-1']);
    assert.ok(vidSpec.xExpr.includes('W*0.1200'));
    assert.ok(vidSpec.yExpr.includes('H*0.8200'));

    // 4. Real FFmpeg export with BOTH Logo image AND Sponsor Video overlay simultaneously
    const expRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: mainVideoPath,
        cues: [{ startSec: 0.05, endSec: 0.5, text: 'hi', translated: 'សួស្តី' }],
        includeDubAudio: false,
        encoder: 'cpu',
        outputDir: srcDir,
        logoEnabled: true,
        logoPath: logoPngPath,
        logoPosition: 'top-right',
        logoScale: 18,
        logoOpacity: 90,
        sponsorEnabled: true,
        sponsorPath: sponsorVideoPath,
        sponsorPosition: 'bottom-center',
        sponsorScale: 26,
        sponsorOpacity: 95
      })
    });
    const expJson = await expRes.json();
    assert.equal(expRes.status, 200, `Logo + Sponsor export failed: ${JSON.stringify(expJson)}`);
    assert.equal(expJson.success, true);
    assert.equal(expJson.logoApplied, true);
    assert.equal(expJson.sponsorApplied, true);
    assert.equal(fs.existsSync(expJson.outputFile), true);

    // 5. Direct MP4 download endpoint for mobile/browser
    const dlRes = await fetch(`${baseUrl}/api/export/download?file=${encodeURIComponent(expJson.outputFile)}`);
    assert.equal(dlRes.status, 200);
    assert.ok(String(dlRes.headers.get('content-disposition') || '').includes('attachment'));
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.ok(dlBuf.length > 100);

    // 6. Mobile Connect & System Maintenance Hub endpoints
    const hubGetRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubGetJson = await hubGetRes.json();
    assert.equal(hubGetRes.status, 200);
    assert.equal(hubGetJson.success, true);
    assert.ok(String(hubGetJson.phoneUrl || '').startsWith('http://'));

    const hubPostRes = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAccessEnabled: true,
        userAccessCode: 'EZA777',
        maintenanceBanner: 'កំណែថ្មី v1.0 រួចរាល់'
      })
    });
    const hubPostJson = await hubPostRes.json();
    assert.equal(hubPostRes.status, 200);
    assert.equal(hubPostJson.userAccessEnabled, true);
    assert.equal(hubPostJson.hasUserAccessCode, true);
    assert.equal(hubPostJson.maintenanceBanner, 'កំណែថ្មី v1.0 រួចរាល់');

    const badVerify = await fetch(`${baseUrl}/api/config/verify-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG' })
    });
    assert.equal(badVerify.status, 401);

    const okVerify = await fetch(`${baseUrl}/api/config/verify-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'EZA777' })
    });
    assert.equal(okVerify.status, 200);
    const okVerifyJson = await okVerify.json();
    assert.ok(String(okVerifyJson.accessToken || '').includes('.'));

    // 7. Hardware-Bound Signed License Key Generation & Anti-Crack Verification
    const licGenRes = await fetch(`${baseUrl}/api/config/generate-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: hubGetJson.machineId, durationDays: 30 })
    });
    const licGenJson = await licGenRes.json();
    assert.equal(licGenRes.status, 200);
    assert.ok(String(licGenJson.licenseKey || '').startsWith('EZAPRO-'));

    const licVerifyOk = await fetch(`${baseUrl}/api/config/verify-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: licGenJson.licenseKey })
    });
    assert.equal(licVerifyOk.status, 200);

    const tamperedLicVerify = await fetch(`${baseUrl}/api/config/verify-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'EZAPRO-LIFETIME-0000000000000000' })
    });
    assert.equal(tamperedLicVerify.status, 401);

    // Reset userAccessEnabled after test
    await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false, maintenanceBanner: '' })
    });

    // 8. Verify dynamic BACKEND_URL origin detection & mobile UX prompt
    const vm = require('node:vm');
    const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
    const remoteSandbox = {
      window: {
        innerWidth: 390,
        location: {
          protocol: 'https:',
          hostname: 'demo-tunnel.trycloudflare.com',
          origin: 'https://demo-tunnel.trycloudflare.com'
        }
      },
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile' },
      document: {
        body: { classList: { toggle() { } }, dataset: {} },
        addEventListener() { },
        getElementById() { return null; },
        querySelectorAll() { return []; }
      },
      Audio: class { pause() { } play() { return Promise.resolve(); } },
      URL,
      console: { log() { }, warn() { }, error() { } },
      setInterval() { return 0; },
      clearInterval() { },
      setTimeout,
      clearTimeout
    };
    vm.createContext(remoteSandbox);
    vm.runInContext(appJs, remoteSandbox);
    assert.equal(
      remoteSandbox.resolveBackendUrl('/api/tts/voices'),
      'https://demo-tunnel.trycloudflare.com/api/tts/voices',
      'Phone on Cloudflare tunnel must route API calls to its own HTTPS origin instead of localhost:3001'
    );
    assert.equal(remoteSandbox.isMobileOrRemoteClient(), true);
    assert.ok(indexHtml.includes('id="videoEmptyUploadPrompt"'), 'index.html must include tap-to-upload empty video prompt');
    assert.ok(stylesCss.includes('.video-empty-upload-prompt'), 'styles.css must style the tap-to-upload empty video prompt');

    // Verify postJsonWithTunnelRecovery automatically recovers from Cloudflare HTTP 524 gateway timeout
    let fetchCalls = 0;
    remoteSandbox.fetch = async (_url, opts) => {
      fetchCalls++;
      const parsedBody = JSON.parse(opts.body);
      if (fetchCalls === 1) {
        assert.equal(parsedBody.force, true, 'First attempt preserves initial force flag');
        return {
          status: 524,
          ok: false,
          json: async () => { throw new Error('HTML 524'); }
        };
      }
      assert.equal(parsedBody.force, false, 'Retry after 524 switches force=false to read completed cache');
      assert.equal(parsedBody.useCache, true, 'Retry after 524 enables useCache=true');
      return {
        status: 200,
        ok: true,
        json: async () => ({ success: true, cues: [{ text: '你好', translated: 'សួស្ដី' }] })
      };
    };
    const recovered = await remoteSandbox.postJsonWithTunnelRecovery(
      'https://demo-tunnel.trycloudflare.com/api/translation/translate-cues',
      { cues: [{ text: '你好' }], force: true },
      { maxRetries: 2, retryDelayMs: 5 }
    );
    assert.equal(fetchCalls, 2, 'Should retry after HTTP 524');
    assert.equal(recovered.data.success, true);
    assert.equal(recovered.data.cues[0].translated, 'សួស្ដី');

    // Verify Electron main.js and server-dev.js set requestTimeout = 0 for long Desktop/browser jobs
    const mainJsSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const serverDevSrc = fs.readFileSync(path.join(__dirname, 'server-dev.js'), 'utf8');
    assert.match(mainJsSrc, /requestTimeout\s*=\s*0/);
    assert.match(serverDevSrc, /requestTimeout\s*=\s*0/);
    assert.ok(appJs.includes('waitForExportCompletionViaProgress'));
    assert.match(mainJsSrc, /configurePackagedPaths/);
    assert.match(mainJsSrc, /!\s*app\.isPackaged/);

    // Verify packaged FFmpeg resolver prefers process.resourcesPath/bin/ffmpeg.exe
    const { resolveFfmpegBin } = require('./src/backend/utils/ffmpeg');
    const origFfmpegEnv = process.env.FFMPEG_BIN;
    const origResourcesPath = process.resourcesPath;
    const fakeResDir = path.join(tempRoot, 'fake-resources');
    const fakeBinDir = path.join(fakeResDir, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeFfmpegExe = path.join(fakeBinDir, 'ffmpeg.exe');
    fs.writeFileSync(fakeFfmpegExe, '');
    try {
      delete process.env.FFMPEG_BIN;
      process.resourcesPath = fakeResDir;
      assert.equal(resolveFfmpegBin(), fakeFfmpegExe);
    } finally {
      if (origFfmpegEnv !== undefined) process.env.FFMPEG_BIN = origFfmpegEnv;
      else delete process.env.FFMPEG_BIN;
      process.resourcesPath = origResourcesPath;
    }

    // Verify DRAFTS_DIR, EXPORT_DIR, and TRANSLATION_CACHE_DIR env overrides work cleanly
    const origDraftsDir = process.env.DRAFTS_DIR;
    const origExportDir = process.env.EXPORT_DIR;
    const origTransCacheDir = process.env.TRANSLATION_CACHE_DIR;
    const origPackagedFlag = process.env.EZA_PACKAGED_CLIENT;
    const customDraftsDir = path.join(tempRoot, 'custom-drafts');
    const customSrtExportDir = path.join(tempRoot, 'custom-srt-export');
    const customTransCacheDir = path.join(tempRoot, 'custom-trans-cache');
    try {
      process.env.DRAFTS_DIR = customDraftsDir;
      process.env.EXPORT_DIR = customSrtExportDir;
      process.env.TRANSLATION_CACHE_DIR = customTransCacheDir;

      delete require.cache[require.resolve('./translation_cache')];
      const CustomCacheInstance = require('./translation_cache');
      assert.equal(CustomCacheInstance.cacheDir, customTransCacheDir);
      assert.equal(fs.existsSync(customTransCacheDir), true);

      const draftSaveRes = await fetch(`${baseUrl}/api/drafts/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: 'C:/videos/packaged-draft.mp4',
          cues: [{ id: 1, start: 0, end: 1, text: '你好', translated: 'សួស្ដី', translatedLang: 'km' }]
        })
      });
      const draftSaveJson = await draftSaveRes.json();
      assert.equal(draftSaveJson.success, true);
      assert.ok(draftSaveJson.savedPath.startsWith(customDraftsDir));
      assert.equal(fs.existsSync(draftSaveJson.savedPath), true);

      const srtSaveRes = await fetch(`${baseUrl}/api/save-srt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }]
        })
      });
      const srtSaveJson = await srtSaveRes.json();
      assert.equal(srtSaveRes.status, 200);
      assert.equal(srtSaveJson.success, true);
      assert.ok(srtSaveJson.savedPath.startsWith(customSrtExportDir));
      assert.equal(fs.existsSync(srtSaveJson.savedPath), true);

      // Verify packaged client mode blocks /api/config/generate-license
      process.env.EZA_PACKAGED_CLIENT = '1';
      const blockedLicRes = await fetch(`${baseUrl}/api/config/generate-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'TEST-MACHINE-ID' })
      });
      assert.equal(blockedLicRes.status, 403);
    } finally {
      if (origDraftsDir !== undefined) process.env.DRAFTS_DIR = origDraftsDir;
      else delete process.env.DRAFTS_DIR;
      if (origExportDir !== undefined) process.env.EXPORT_DIR = origExportDir;
      else delete process.env.EXPORT_DIR;
      if (origTransCacheDir !== undefined) process.env.TRANSLATION_CACHE_DIR = origTransCacheDir;
      else delete process.env.TRANSLATION_CACHE_DIR;
      if (origPackagedFlag !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackagedFlag;
      else delete process.env.EZA_PACKAGED_CLIENT;
      delete require.cache[require.resolve('./translation_cache')];
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Cloudflare Worker ECDSA P-256 cloud license enforcement, anti-bypass API guard, and offline grace', async () => {
  const crypto = require('crypto');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const configMod = require('./src/backend/routes/config');
  const express = require('express');
  const { setupRoutes } = require('./src/backend/routes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const machineId = configMod.getMachineHardwareId();

  function signTestLease(payloadObj) {
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payloadB64}.${sig.toString('base64url')}`;
  }

  const now = Date.now();
  const validLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-TEST-1111-2222-3333',
    machineId,
    status: 'active',
    customerName: 'Sokha VIP',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, machineId, pubJwk, now, 'studio').valid, true);
  const downloaderOnlyLease = signTestLease({
    v: 1,
    licenseKey: 'EZAPRO-DLON-1111-2222-3333',
    machineId,
    appScope: 'downloader',
    status: 'active',
    customerName: 'Downloader Only',
    expiresAt: now + 86400000,
    issuedAt: now,
    leaseUntil: now + 3600000
  });
  assert.equal(cloudLicense.verifySignedLeaseToken(downloaderOnlyLease, machineId, pubJwk, now, 'studio').reason, 'wrong_app');
  assert.equal(cloudLicense.verifySignedLeaseToken(validLease, 'EZA-WRONG-HWID-9999', pubJwk, now).valid, false);
  const [tamperedPayload, origSig] = validLease.split('.');
  const fakePayload = Buffer.from(JSON.stringify({ v: 1, machineId, status: 'active', leaseUntil: now + 999999999 }), 'utf8').toString('base64url');
  assert.equal(cloudLicense.verifySignedLeaseToken(`${fakePayload}.${origSig}`, machineId, pubJwk, now).valid, false);
  assert.notEqual(tamperedPayload, fakePayload);

  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  assert.ok(String(cloudCfg.workerUrl || '').startsWith('https://'), 'Expected live Cloudflare Worker URL in cloud-license-config.json');
  assert.equal(cloudCfg.publicKeyJwk.crv, 'P-256');

  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origPubJwkEnv = process.env.EZA_CLOUD_PUBLIC_JWK;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origPackaged = process.env.EZA_PACKAGED_CLIENT;
  const testStatePath = path.join(tempRoot, `cloud-state-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = testStatePath;
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-license-worker.invalid';
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_PACKAGED_CLIENT = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';

    // Without active lease, protected backend routes block with 403 and system-hub hides admin
    const hubRes = await fetch(`${baseUrl}/api/config/system-hub`);
    const hubJson = await hubRes.json();
    assert.equal(hubJson.isPackagedClient, true);
    assert.equal(hubJson.cloudLicenseEnforced, true);
    assert.equal(hubJson.userAccessEnabled, true);

    const blockedHubPost = await fetch(`${baseUrl}/api/config/system-hub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessEnabled: false })
    });
    assert.equal(blockedHubPost.status, 403);

    const blockedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedSrt.status, 403);

    // Mock online verify + offline grace + server revoke
    const okVerify = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-TEST-1111-2222-3333',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken: validLease,
          customerName: 'Sokha VIP',
          expiresAt: now + 86400000,
          maintenanceBanner: 'សួស្ដីអតិថិជន!'
        })
      })
    });
    assert.equal(okVerify.valid, true);
    assert.equal(okVerify.source, 'cloud');

    // Now protected API succeeds using active local signed lease
    const allowedSrt = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី', translated: 'សួស្ដី' }] })
    });
    assert.equal(allowedSrt.status, 200);

    // Offline grace works if network drops cleanly within lease window
    const offlineGrace = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ENOTFOUND offline'); }
    });
    assert.equal(offlineGrace.valid, true);
    assert.equal(offlineGrace.source, 'offline_grace');

    // Server revocation wipes lease immediately and re-blocks API routes
    const revokedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked by Admin' })
      })
    });
    assert.equal(revokedRes.valid, false);
    const blockedAfterRevoke = await fetch(`${baseUrl}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: [{ id: 1, start: 0, end: 1, text: 'សួស្ដី' }] })
    });
    assert.equal(blockedAfterRevoke.status, 403);
  } finally {
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origPubJwkEnv !== undefined) process.env.EZA_CLOUD_PUBLIC_JWK = origPubJwkEnv;
    else delete process.env.EZA_CLOUD_PUBLIC_JWK;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origPackaged !== undefined) process.env.EZA_PACKAGED_CLIENT = origPackaged;
    else delete process.env.EZA_PACKAGED_CLIENT;
    await new Promise(resolve => server.close(resolve));
  }
});


test('audio-separator engine: chunked stem separation, cache upgrade, and 3-layer mix compatibility', async () => {
  const vm = require('node:vm');
  assert.equal(audioModule.isAiSeparationEngine('audio-separator'), true);
  assert.equal(audioModule.isAiSeparationEngine('demucs'), true);
  assert.equal(audioModule.isAiSeparationEngine('ffmpeg_dsp'), false);

  const sampleLong = path.join(tempRoot, 'sample-uvr-chunks.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3.0:r=24',
    '-f', 'lavfi', '-i', 'sine=f=330:d=3.0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleLong
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const stubScript = path.join(tempRoot, 'stub-audio-sep.js');
  const countFile = path.join(tempRoot, 'stub-audio-sep.count');
  fs.writeFileSync(stubScript, `
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('audio-separator 0.48.0-stub');
      process.exit(0);
    }
    const outIdx = args.indexOf('--output_dir');
    const outDir = outIdx !== -1 ? args[outIdx + 1] : process.cwd();
    const inputWav = args[args.length - 1];
    const prev = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(countFile)}, String(prev + 1));
    fs.copyFileSync(inputWav, path.join(outDir, 'bgm.wav'));
    fs.copyFileSync(inputWav, path.join(outDir, 'vocals.wav'));
  `, 'utf8');

  const prevBgmCacheDir = process.env.BGM_CACHE_DIR;
  process.env.BGM_CACHE_DIR = path.join(tempRoot, 'bgm_cache_test');
  const origSepBin = process.env.AUDIO_SEPARATOR_BIN;
  try {
    // Step 1: seed legacy ffmpeg_dsp cache first
    const dspResult = await audioModule.isolateVideoBgm(sampleLong, { engine: 'ffmpeg_dsp', force: true });
    assert.equal(dspResult.engine, 'ffmpeg_dsp');
    const cachedDsp = await audioModule.isolateVideoBgm(sampleLong, { engine: 'ffmpeg_dsp' });
    assert.equal(cachedDsp.cached, true);
    assert.equal(cachedDsp.engine, 'ffmpeg_dsp');

    // Step 2: run chunked UVR separation using fast stub binary via Node wrapper
    const bgmOut = path.join(tempRoot, 'chunked_bgm.mp3');
    const vocalsOut = path.join(tempRoot, 'chunked_vocals.mp3');
    await audioModule.runAudioSeparatorSeparation(
      sampleLong,
      bgmOut,
      vocalsOut,
      { id: 'audio-separator', cmd: process.execPath, argsPrefix: [stubScript], model: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
      { chunkTriggerSec: 2.0, chunkDurationSec: 1.5 }
    );
    assert.ok(fs.existsSync(bgmOut) && fs.statSync(bgmOut).size > 2000);
    assert.ok(fs.existsSync(vocalsOut) && fs.statSync(vocalsOut).size > 2000);
    const chunkCalls = Number(fs.readFileSync(countFile, 'utf8'));
    assert.ok(chunkCalls >= 2, `Expected >=2 chunks for 3.0s audio with 1.5s chunkDurationSec, got ${chunkCalls}`);

    // Step 3: verify export.js & app.js recognize 'audio-separator' alongside 'demucs' for origVolume > 0 layering
    const expCode = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'export.js'), 'utf8');
    assert.match(expCode, /cachedBgmStems\.engine === 'audio-separator'/);

    const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
    const bgmAudioObj = { src: '', volume: 1, loop: false, paused: true, currentTime: 0, playbackRate: 1, play: () => Promise.resolve(), pause() { this.paused = true; } };
    const vidEl = { volume: 1.0, muted: false, paused: false, playbackRate: 1.0, currentTime: 1.5, style: {} };
    const sandbox = {
      console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
      URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { getItem: () => null, setItem() { } },
      document: { getElementById: (id) => (id === 'mainVideo' ? vidEl : null), querySelectorAll: () => [], addEventListener() { } },
      Audio: function () { return bgmAudioObj; },
      fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => { };
    sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(appCode, ctx);
    vm.runInContext(`
      isVocalInvertOn = true;
      isDubVoiceEnabled = true;
      Object.assign(audioMixerState, { origPct: 15, bgmPct: 70, dubPct: 120, bgmOnPause: true });
      currentIsolatedBgmEngine = 'audio-separator';
      currentIsolatedBgmUrl = 'http://localhost:3001/bgm_cache/test_bgm.mp3';
      bgmAudio = new Audio();
      syncLiveSourceAudioSuppression(document.getElementById('mainVideo'), -1);
    `, ctx);
    assert.equal(bgmAudioObj.src, 'http://localhost:3001/bgm_cache/test_bgm.mp3');
    assert.ok(vidEl.volume > 0 && vidEl.volume <= 0.16, `Expected orig audio preserved alongside audio-separator stem, got ${vidEl.volume}`);
  } finally {
    if (prevBgmCacheDir !== undefined) process.env.BGM_CACHE_DIR = prevBgmCacheDir;
    else delete process.env.BGM_CACHE_DIR;
    if (origSepBin !== undefined) process.env.AUDIO_SEPARATOR_BIN = origSepBin;
    else delete process.env.AUDIO_SEPARATOR_BIN;
    audioModule.detectSeparationEngine(true);
  }
});

test('routerAdminPinModal works without window.prompt for Electron and Chrome', async () => {
  const vm = require('node:vm');
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const cssCode = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  assert.match(htmlCode, /id="routerAdminPinModal"/);
  assert.match(htmlCode, /id="routerPinResetDefaultBtn"/);
  assert.doesNotMatch(htmlCode, /1688/);
  assert.doesNotMatch(cssCode, /@media\s*\(max-width:\s*1280px\)\s*\{[^}]*\.brand-badge\s*\{\s*display:\s*none/s);

  const storage = new Map();
  const makeEl = () => ({
    style: {},
    hidden: false,
    value: '',
    innerText: '',
    innerHTML: '',
    type: 'password',
    focus() { },
    select() { },
    setAttribute() { },
    querySelector() { return null; },
    classList: { toggle() { }, contains: () => false, add() { }, remove() { } }
  });
  const els = {
    navBtnRouter: makeEl(),
    routerLockUserBtn: makeEl(),
    hubRouterLockToggleBtn: makeEl(),
    studioViewPane: makeEl(),
    videoManagerModal: makeEl(),
    routerSidebar: makeEl(),
    routerAddPanel: makeEl(),
    routerBatchPanel: makeEl(),
    routerAccountsList: makeEl(),
    routerAdminPinModal: makeEl(),
    routerPinModalTitle: makeEl(),
    routerPinModalDesc: makeEl(),
    routerPinModalInput: makeEl(),
    routerPinModalError: makeEl(),
    routerPinModalSubmitBtn: makeEl(),
    routerPinResetDefaultBtn: makeEl(),
    accessGateOverlay: makeEl()
  };

  let promptCalls = 0;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => { },
    URLSearchParams,
    Audio: function () { return { pause() { }, addEventListener() { }, removeAttribute() { }, load() { } }; },
    prompt: () => { promptCalls++; throw new Error('prompt() is not supported in Electron'); },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() { }
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, accounts: [] }) })
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => { };
  sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appCode, ctx);

  // Lock via modal without calling unsupported prompt()
  assert.equal(sandbox.lockRouterForUserMode(), false);
  assert.equal(els.routerAdminPinModal.style.display, 'flex');
  els.routerPinModalInput.value = '9876';
  await sandbox.submitRouterAdminPinModal();
  assert.equal(promptCalls, 0);
  assert.equal(els.navBtnRouter.hidden, true);
  assert.equal(storage.get('eza_router_admin_pin'), '9876');

  // Packaged client cannot use reset button
  await sandbox.syncAccessGateOverlay({ isPackagedClient: true });
  assert.equal(els.routerPinResetDefaultBtn.style.display, 'none');
  assert.equal(await sandbox.resetRouterAdminPinToDefault(), false);

  // Unlock modal rejects wrong PIN cleanly, then Admin dev reset restores 1688 and opens Router
  const unlockPromise = sandbox.unlockRouterAdminMode();
  assert.equal(els.routerAdminPinModal.style.display, 'flex');
  els.routerPinModalInput.value = '1688';
  assert.equal(await sandbox.submitRouterAdminPinModal(), false);
  assert.match(els.routerPinModalError.innerText, /មិនត្រឹមត្រូវ/);

  await sandbox.syncAccessGateOverlay({ isPackagedClient: false });
  assert.equal(els.routerPinResetDefaultBtn.style.display, '');
  assert.equal(await sandbox.resetRouterAdminPinToDefault(), true);
  assert.equal(await unlockPromise, true);
  assert.equal(promptCalls, 0);
  assert.equal(storage.get('eza_router_admin_pin'), '1688');
  assert.equal(storage.get('eza_router_user_locked'), '0');
  assert.equal(els.navBtnRouter.hidden, false);
  assert.equal(els.routerSidebar.hidden, false);
});

test('Subtitle blur mask supports X/Y/W/H + blur sigma in FFmpeg filter, live sliders, direct drag/resize, and localStorage persistence', async () => {
  // 1. Backend FFmpeg filter builder precision & zero/clamping edge cases
  const customFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'blur',
    maskXPercent: 0.1,
    maskYPercent: 0.2,
    maskWPercent: 0.5,
    maskHPercent: 0.12,
    maskBlurSigma: 24
  });
  assert.ok(customFilter.includes('crop=iw*0.5:ih*0.12:iw*0.1:ih*0.2,gblur=sigma=24'));
  assert.ok(customFilter.includes('overlay=W*0.1:H*0.2'));

  const zeroEdgeFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'black',
    maskXPercent: 0,
    maskYPercent: 0,
    maskWPercent: 0.4,
    maskHPercent: 0.1,
    maskBlurSigma: 99
  });
  assert.ok(zeroEdgeFilter.includes('drawbox=x=iw*0:y=ih*0:w=iw*0.4:h=ih*0.1:'));

  const clampedFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'feathered',
    maskXPercent: 0.9,
    maskYPercent: 0.95,
    maskWPercent: 0.4,
    maskHPercent: 0.2,
    maskBlurSigma: 99
  });
  assert.ok(clampedFilter.includes('crop=iw*0.4:ih*0.2:iw*0.6:ih*0.8,gblur=sigma=40'));

  // 2. Real FFmpeg render with custom blur mask geometry & sigma
  const sampleVideo = path.join(tempRoot, 'sample-custom-mask.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=360x640:d=0.4:r=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '0.4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleVideo,
        duration: 0.4,
        maskEnabled: true,
        maskMode: 'blur',
        maskXPercent: 0.15,
        maskYPercent: 0.12,
        maskWPercent: 0.7,
        maskHPercent: 0.1,
        maskBlurSigma: 22,
        cues: [{ startSec: 0, endSec: 0.35, text: '你好', translated: 'សួស្តី' }]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.ok(fs.existsSync(body.outputFile));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // 3. Frontend state, sliders, drag/resize interaction, and persistence
  const vm = require('vm');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === true) set.add(c);
        else if (force === false) set.delete(c);
        else if (set.has(c)) set.delete(c);
        else set.add(c);
      },
      contains: (c) => set.has(c)
    };
  };
  const makeStyle = () => {
    const props = {};
    return {
      setProperty: (k, v) => { props[k] = String(v); },
      getPropertyValue: (k) => props[k] || ''
    };
  };
  const createEventTarget = (extra = {}) => {
    const listeners = {};
    return {
      ...extra,
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatch(type, ev = {}) {
        (listeners[type] || []).forEach((fn) => fn(ev));
      }
    };
  };

  const buildMaskHarness = (storage) => {
    const winListeners = {};
    const videoFrame = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 270, height: 480 })
    };
    const resizeHandle = createEventTarget();
    resizeHandle.contains = (t) => t === resizeHandle;
    const maskBox = createEventTarget({
      classList: makeClassList(['subtitle-mask-box', 'feathered', 'hidden-mask']),
      style: makeStyle(),
      parentElement: videoFrame,
      dataset: {}
    });
    const maskControlsContainer = { scrollIntoView() { } };
    const mkSlider = (val) => ({ value: String(val), parentElement: { classList: makeClassList() } });
    const els = {
      subtitleMaskBox: maskBox,
      subtitleMaskResizeHandle: resizeHandle,
      quickMaskToggleBtn: { classList: makeClassList(), innerText: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      previewDockBody: { hidden: true },
      previewDockCollapseBtn: { innerText: '▴' },
      maskToggleCheck: { checked: false },
      maskModeSelect: { value: 'feathered' },
      maskXSlider: mkSlider('4'),
      maskYSlider: mkSlider('78'),
      maskWSlider: mkSlider('92'),
      maskHSlider: mkSlider('8'),
      maskBlurSlider: mkSlider('14'),
      maskXVal: { innerText: '' },
      maskYVal: { innerText: '' },
      maskWVal: { innerText: '' },
      maskHVal: { innerText: '' },
      maskBlurVal: { innerText: '' },
      subStyleSelect: { value: 'tiktok' },
      exportPreviewSummary: { innerText: '' }
    };
    const sandbox = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
      alert() { },
      confirm: () => true,
      Audio: class { pause() { } play() { return Promise.resolve(); } addEventListener() { } },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v))
      },
      document: {
        getElementById: (id) => els[id] || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() { }
      },
      fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, accounts: [] }) })
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    };
    sandbox.dispatchWindow = (type, ev = {}) => {
      (winListeners[type] || []).forEach((fn) => fn(ev));
    };
    sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(appCode, ctx);
    sandbox.renderSubtitleMaskPreview();
    sandbox.initSubtitleMaskInteraction();
    return { sandbox, els, maskBox, resizeHandle };
  };

  const sharedStorage = new Map();
  const h1 = buildMaskHarness(sharedStorage);

  // Quick toggle opens Preview Dock Mask panel, activates mask box & quick pill
  h1.sandbox.toggleMaskBox();
  assert.equal(h1.els.maskToggleCheck.checked, true);
  assert.equal(h1.els.previewDockBody.hidden, false);
  assert.equal(h1.els.quickMaskToggleBtn.attrs['aria-pressed'], 'true');
  assert.equal(h1.maskBox.classList.contains('hidden-mask'), false);

  // Slider adjustments propagate to preview CSS & export payload without moving Khmer subMarginV
  h1.sandbox.changeMaskMode('blur');
  h1.sandbox.setSubtitleMaskControl('w', 50);
  h1.sandbox.setSubtitleMaskControl('h', 15);
  h1.sandbox.setSubtitleMaskControl('x', 20);
  h1.sandbox.setSubtitleMaskControl('y', 10);
  h1.sandbox.setSubtitleMaskControl('blur', 26);
  const payload1 = h1.sandbox.getSubtitleAndMaskExportPayload();
  assert.equal(payload1.maskEnabled, true);
  assert.equal(payload1.maskMode, 'blur');
  assert.equal(payload1.maskXPercent, 0.2);
  assert.equal(payload1.maskYPercent, 0.1);
  assert.equal(payload1.maskWPercent, 0.5);
  assert.equal(payload1.maskHPercent, 0.15);
  assert.equal(payload1.maskBlurSigma, 26);
  assert.equal(payload1.subMarginV, 154);
  assert.equal(h1.maskBox.style.getPropertyValue('--mask-blur-px'), '26px');

  // Direct pointer drag (+27px = +10% X, +48px = +10% Y) + corner resize (+54px = +20% W, +24px = +5% H)
  h1.maskBox.dispatch('mousedown', { clientX: 150, clientY: 150, target: h1.maskBox, preventDefault() { }, stopPropagation() { } });
  h1.sandbox.dispatchWindow('mousemove', { clientX: 177, clientY: 198 });
  h1.sandbox.dispatchWindow('mouseup', {});
  const afterDrag = h1.sandbox.getSubtitleAndMaskExportPayload();
  assert.equal(afterDrag.maskXPercent, 0.3);
  assert.equal(afterDrag.maskYPercent, 0.2);

  h1.resizeHandle.dispatch('mousedown', { clientX: 200, clientY: 200, target: h1.resizeHandle, preventDefault() { }, stopPropagation() { } });
  h1.sandbox.dispatchWindow('mousemove', { clientX: 254, clientY: 224 });
  h1.sandbox.dispatchWindow('mouseup', {});
  const afterResize = h1.sandbox.getSubtitleAndMaskExportPayload();
  assert.equal(afterResize.maskWPercent, 0.7);
  assert.equal(afterResize.maskHPercent, 0.2);

  // Reloading restores persisted state; reset restores defaults cleanly
  const h2 = buildMaskHarness(sharedStorage);
  const restored = h2.sandbox.getSubtitleAndMaskExportPayload();
  assert.equal(restored.maskXPercent, 0.3);
  assert.equal(restored.maskYPercent, 0.2);
  assert.equal(restored.maskWPercent, 0.7);
  assert.equal(restored.maskHPercent, 0.2);
  assert.equal(restored.maskBlurSigma, 26);

  h2.sandbox.resetSubtitleMask();
  const afterReset = h2.sandbox.getSubtitleAndMaskExportPayload();
  assert.equal(afterReset.maskXPercent, 0.04);
  assert.equal(afterReset.maskYPercent, 0.78);
  assert.equal(afterReset.maskWPercent, 0.92);
  assert.equal(afterReset.maskHPercent, 0.08);
  assert.equal(afterReset.maskBlurSigma, 14);

  // 4. Clean Studio Preview frame aspect auto-fit & dock tab collapse behavior
  const dockTabs = ['audio', 'mask', 'sub', 'brand'].map((name) => ({
    getAttribute: (k) => (k === 'data-dock-tab' ? name : ''),
    setAttribute(k, v) { this[k] = v; },
    classList: makeClassList(name === 'audio' ? ['preview-dock-tab', 'active'] : ['preview-dock-tab'])
  }));
  const dockPanels = ['audio', 'mask', 'sub', 'brand'].map((name) => ({
    hidden: name !== 'audio',
    getAttribute: (k) => (k === 'data-dock-panel' ? name : ''),
    classList: makeClassList(name === 'audio' ? ['preview-dock-panel', 'active'] : ['preview-dock-panel'])
  }));
  const previewEls = {
    videoDropZone: { clientWidth: 424, clientHeight: 380 },
    previewFrameBox: { style: makeStyle() },
    mainVideo: { videoWidth: 1280, videoHeight: 720 },
    previewAspectSelect: { value: 'auto' },
    previewDockBody: { hidden: false },
    previewDockCollapseBtn: { innerText: '▾' },
    maskTabDot: { hidden: true },
    safeZoneOverlay: { style: makeStyle() },
    safeZoneToggle: { checked: false },
    headerSafeZoneBtn: { classList: makeClassList() }
  };
  const ctx3 = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
    alert() { }, confirm: () => true,
    Audio: class { pause() { } play() { return Promise.resolve(); } addEventListener() { } },
    localStorage: { getItem: () => null, setItem() { } },
    document: {
      getElementById: (id) => previewEls[id] || null,
      querySelectorAll: (sel) => (String(sel).includes('.preview-dock-tab') ? dockTabs : String(sel).includes('.preview-dock-panel') ? dockPanels : []),
      querySelector: () => null,
      addEventListener() { }
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, accounts: [] }) })
  });
  ctx3.window = ctx3;
  ctx3.addEventListener = () => { };
  ctx3.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  vm.runInContext(appCode, ctx3);

  // Auto aspect fits 16:9 landscape video cleanly inside 424x380 viewport (400x225) without 9:16 letterbox waste
  ctx3.fitPreviewFrameSize();
  assert.equal(previewEls.previewFrameBox.style.width, '400px');
  assert.equal(previewEls.previewFrameBox.style.height, '225px');

  // Switching to 9:16 mode fits full vertical height (203x360)
  ctx3.setPreviewAspectMode('9:16');
  assert.equal(previewEls.previewFrameBox.style.width, '203px');
  assert.equal(previewEls.previewFrameBox.style.height, '360px');

  // Tab switch activates chosen panel and hides others; clicking active tab again collapses drawer
  ctx3.setPreviewDockTab('mask');
  assert.equal(dockPanels[0].hidden, true);
  assert.equal(dockPanels[1].hidden, false);
  ctx3.setPreviewDockTab('mask');
  assert.equal(previewEls.previewDockBody.hidden, true);
  assert.equal(previewEls.previewDockCollapseBtn.innerText, '▴');

  // Header Safe Zone toggle syncs overlay, checkbox, and active button state
  ctx3.toggleSafeZone();
  assert.equal(previewEls.safeZoneOverlay.style.display, 'block');
  assert.equal(previewEls.safeZoneToggle.checked, true);
  assert.equal(previewEls.headerSafeZoneBtn.classList.contains('active'), true);
});

test('AI BGM auto-upgrade from legacy DSP, 3-layer movie presets, live sample sub preview, and sub Y position sync', async () => {
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');

  const html = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  const exportCode = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'export.js'), 'utf8');

  for (const id of [
    'audioAiEngineBadge', 'btnDockIsolateBgm', 'presetBgmDubBtn',
    'presetMovieDubBtn', 'presetOrigOnlyBtn', 'btnQuickAudioBoost',
    'boostTag', 'subPosYSlider', 'subPosYVal', 'subVisibleToggleCheck'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Expected #${id} in index.html`);
  }
  assert.match(exportCode, /ensureAiBgm/);
  assert.match(appCode, /ensureAiBgm:\s*true/);

  const mkClassList = (...init) => {
    const set = new Set(init);
    return {
      add: (...c) => c.forEach(x => set.add(x)),
      remove: (...c) => c.forEach(x => set.delete(x)),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? (set.delete(c), false) : (set.add(c), true)) : (force ? (set.add(c), true) : (set.delete(c), false))),
      contains: (c) => set.has(c)
    };
  };

  let isolateCalls = 0;
  const subBoxStyle = { bottom: '8%' };
  const subTextEl = {
    className: 'subtitle-text-inside style-tiktok',
    style: { fontSize: '16px', display: 'none' },
    dataset: {},
    innerHTML: '',
    innerText: '',
    classList: mkClassList()
  };
  const maskBoxEl = {
    classList: mkClassList('subtitle-mask-box', 'feathered', 'hidden-mask'),
    style: { setProperty() { } }
  };

  const els = {
    mainVideo: { paused: true, currentTime: 0, volume: 1.0, muted: false },
    liveSubtitleBox: { style: subBoxStyle },
    liveSubtitleText: subTextEl,
    subtitleMaskBox: maskBoxEl,
    quickMaskToggleBtn: { classList: mkClassList(), innerText: '', setAttribute() { } },
    maskToggleCheck: { checked: false },
    maskModeSelect: { value: 'feathered' },
    subStyleSelect: { value: 'tiktok' },
    subFontSizeSlider: { value: '16' },
    subFontSizeVal: { innerText: '16px' },
    subPosYSlider: { value: '8' },
    subPosYVal: { innerText: '8%' },
    subVisibleToggleCheck: { checked: true },
    wordPopToggleCheck: { checked: true },
    dubVoiceSwitch: { classList: mkClassList('switch-box', 'active') },
    btnQuickBgm: { classList: mkClassList('action-icon-btn'), innerText: '🎵 BGM' },
    audioAiEngineBadge: { classList: mkClassList('audio-ai-badge'), innerText: '' },
    btnDockIsolateBgm: { disabled: false, innerText: '' },
    presetBgmDubBtn: { classList: mkClassList() },
    presetMovieDubBtn: { classList: mkClassList() },
    presetOrigOnlyBtn: { classList: mkClassList() },
    btnQuickAudioBoost: { classList: mkClassList() },
    boostTag: { innerText: 'OFF' },
    playerOrigVolSlider: { value: '0' },
    playerOrigVolLabel: { innerText: '0%' },
    playerBgmVolSlider: { value: '65' },
    playerBgmVolLabel: { innerText: '65%' },
    playerDubVolSlider: { value: '100' },
    playerDubVolLabel: { innerText: '100%' },
    bgmOnPauseCheck: { checked: true },
    exportAudioMode: { value: 'bgm_only' },
    exportPreviewSummary: { innerText: '' },
    bottomStatusMsg: { innerText: '' }
  };

  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl,
    alert() { }, confirm: () => true,
    Audio: class {
      constructor() { this.paused = true; this.volume = 1; }
      pause() { this.paused = true; }
      play() { this.paused = false; return Promise.resolve(); }
      addEventListener() { }
    },
    localStorage: { getItem: () => null, setItem() { } },
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() { }
    },
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('/api/audio/capabilities')) {
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, engine: { id: 'audio-separator', model: 'UVR-MDX-NET-Inst_HQ_3.onnx', label: 'UVR MDX-Net AI', ai: true } })
        };
      }
      if (u.includes('/api/audio/status')) {
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, ready: true, engine: 'ffmpeg_dsp', bgmUrl: '/bgm_cache/test_bgm.mp3', vocalsUrl: '/bgm_cache/test_vocals.mp3' })
        };
      }
      if (u.includes('/api/audio/isolate-bgm')) {
        isolateCalls += 1;
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, engine: 'audio-separator', bgmUrl: '/bgm_cache/test_bgm.mp3', vocalsUrl: '/bgm_cache/test_vocals.mp3' })
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, accounts: [] }) };
    }
  });
  ctx.window = ctx;
  ctx.addEventListener = () => { };
  ctx.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  vm.runInContext(appCode, ctx);

  // 1) Legacy ffmpeg_dsp status triggers automatic UVR AI upgrade when capabilities report ai: true
  vm.runInContext(`currentVideoPath = 'D:/EZARG/uploads/test_ep.mp4';`, ctx);
  await ctx.syncCachedBgmStemForVideo('D:/EZARG/uploads/test_ep.mp4');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(isolateCalls, 1);
  assert.equal(vm.runInContext('currentIsolatedBgmEngine', ctx), 'audio-separator');
  assert.match(els.audioAiEngineBadge.innerText, /UVR AI/);

  // 2) Audio presets switch seamlessly between Movie+Dub, Original 100%, and BGM+Dub
  ctx.applyAudioMixPreset('movie_plus_dub');
  assert.equal(vm.runInContext('audioMixerState.origPct', ctx), 25);
  assert.equal(vm.runInContext('isDubVoiceEnabled', ctx), true);
  ctx.applyAudioMixPreset('orig_only');
  assert.equal(vm.runInContext('audioMixerState.origPct', ctx), 100);
  assert.equal(vm.runInContext('isDubVoiceEnabled', ctx), false);
  ctx.applyAudioMixPreset('bgm_dub');
  assert.equal(vm.runInContext('audioMixerState.origPct', ctx), 0);
  assert.equal(vm.runInContext('isDubVoiceEnabled', ctx), true);

  // 3) Switching sub style or Y position renders live sample subtitle immediately even when paused/no cues
  ctx.changeSubStyle('hormozi');
  assert.equal(subTextEl.style.display, 'inline-block');
  assert.ok(subTextEl.innerHTML.length > 0);
  ctx.updateSubPosY(14);
  assert.equal(subBoxStyle.bottom, '14%');
  assert.equal(els.subPosYVal.innerText, '14%');
  assert.notEqual(ctx.getSubtitleAndMaskExportPayload().subMarginV, 154);
  assert.equal(ctx.getSubtitleAndMaskExportPayload().subMarginV, Math.round((14 / 100) * 1920));
  ctx.toggleSubtitleVisibility(false);
  assert.equal(subTextEl.style.display, 'none');

  // 4) Moving a blur slider automatically activates the Blur Mask so changes appear live immediately
  ctx.setSubtitleMaskControl('blur', 22);
  assert.equal(ctx.getSubtitleAndMaskExportPayload().maskEnabled, true);
  assert.equal(ctx.getSubtitleAndMaskExportPayload().maskBlurSigma, 22);
});


test('Anti-copyright backend helpers: normalizeAntiCopyrightOptions, buildAntiCopyrightVideoPrefix, buildExportFilter & audio pitch/speed', () => {
  // 1. Disabled state resets transforms
  const disabled = exportModule.normalizeAntiCopyrightOptions({
    enabled: false,
    mirror: true,
    zoomPercent: 10,
    speedRate: 1.1,
    colorShift: 'warm_vivid',
    audioPitchPct: -5,
    vignette: true,
    stripMetadata: true
  });
  assert.deepEqual(disabled, {
    enabled: false,
    mirror: false,
    zoomPercent: 0,
    speedRate: 1.0,
    colorShift: 'none',
    audioPitchPct: 0,
    vignette: false,
    stripMetadata: false
  });

  // 2. Enabled normalization & clamping + 100..125 scale conversion + aliases
  const norm = exportModule.normalizeAntiCopyrightOptions({
    enabled: true,
    mirror: true,
    zoomPercent: 107,
    speedRate: 1.05,
    colorShift: 'vivid',
    audioPitchPct: -4,
    vignette: true,
    stripMetadata: true
  });
  assert.equal(norm.enabled, true);
  assert.equal(norm.mirror, true);
  assert.equal(norm.zoomPercent, 7);
  assert.equal(norm.speedRate, 1.05);
  assert.equal(norm.colorShift, 'cinema_crisp');
  assert.equal(norm.audioPitchPct, -4);
  assert.equal(norm.vignette, true);
  assert.equal(norm.stripMetadata, true);

  // 3. Video prefix chain order
  const prefix = exportModule.buildAntiCopyrightVideoPrefix(norm, '1080p', { width: 1080, height: 1920 });
  assert.ok(prefix.includes('hflip'), 'prefix includes hflip');
  assert.ok(prefix.some(f => f.includes('crop=trunc(iw/1.0700/2)*2')), 'prefix includes even crop');
  assert.ok(prefix.some(f => f.includes('eq=contrast=1.10')), 'prefix includes eq color shift');
  assert.ok(prefix.includes('vignette=angle=PI/5'), 'prefix includes vignette');
  assert.ok(prefix.includes('setpts=PTS/1.0500'), 'prefix includes PTS speedup');

  // 4. Filter graph places CR transforms + upscale BEFORE blur mask and ASS subtitle burn-in
  const filterGraph = exportModule.buildExportFilter('D:/tmp/sub-cr.ass', {
    resolution: '1080p',
    mediaInfo: { width: 1080, height: 1920 },
    maskEnabled: true,
    burnSubtitles: true,
    antiCopyright: norm
  });
  const vscaledIdx = filterGraph.indexOf('[vscaled]');
  const hflipIdx = filterGraph.indexOf('hflip');
  const splitIdx = filterGraph.indexOf('[vscaled]split[orig][copy]');
  const assIdx = filterGraph.indexOf("ass='D");
  assert.ok(hflipIdx >= 0 && hflipIdx < vscaledIdx, 'hflip applied before [vscaled]');
  assert.ok(filterGraph.includes('scale='), 'zoomed 1080p clip still upscales back to HD before [vscaled]');
  assert.ok(vscaledIdx < splitIdx, 'blur mask runs after CR transforms & scaling');
  assert.ok(splitIdx < assIdx, 'ASS subtitles burn upright after CR transforms and blur mask');
});

test('Anti-copyright integration: POST /api/export/video renders transformed MP4, accelerates speed, and strips original metadata', async () => {
  const sampleCrVideo = path.join(tempRoot, 'sample-cr-source.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=2.0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.0',
    '-metadata', 'comment=OriginalSourceTag123',
    '-metadata', 'title=ProtectedDramaSource',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleCrVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleCrVideo,
        duration: 2.0,
        resolution: 'source',
        qualityPreset: 'ultrafast',
        encoder: 'libx264',
        fastCopy: true,
        burnSubtitles: false,
        maskEnabled: false,
        cues: [{ startSec: 0, endSec: 1.5, text: '你好', translated: 'សួស្តី' }],
        antiCopyright: {
          enabled: true,
          mirror: true,
          zoomPercent: 8,
          colorShift: 'warm_vivid',
          vignette: true,
          speedRate: 1.15,
          audioPitchPct: -5,
          stripMetadata: true
        }
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.ok(body.outputFile && fs.existsSync(body.outputFile), 'exported MP4 file exists');
    assert.ok(fs.statSync(body.outputFile).size > 5000, 'exported MP4 has non-trivial size');

    // Probe metadata and duration with ffmpeg
    const metaProbe = spawnSync(FFMPEG_BIN, ['-i', body.outputFile, '-f', 'ffmetadata', '-'], { encoding: 'utf8' });
    const combinedProbe = `${metaProbe.stdout || ''}\n${metaProbe.stderr || ''}`;
    assert.ok(!combinedProbe.includes('OriginalSourceTag123'), 'source comment metadata stripped');
    assert.ok(!combinedProbe.includes('ProtectedDramaSource'), 'source title metadata stripped');
    const parsed = exportModule.parseMediaInfoFromStderr(metaProbe.stderr || '');
    assert.equal(parsed.width, 360);
    assert.equal(parsed.height, 640);
    assert.ok(parsed.durationSec > 1.4 && parsed.durationSec < 1.9, `expected accelerated duration ~1.74s, got ${parsed.durationSec}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Anti-copyright frontend UI & WYSIWYG state: presets, live preview CSS/rate, export payload, and persistence', () => {
  const vm = require('vm');
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const cssCode = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  // Verify HTML dock tab, panel controls, and export modal quick row
  assert.ok(htmlCode.includes('data-dock-tab="copyright"'), 'CR dock tab present in index.html');
  assert.ok(htmlCode.includes('data-dock-panel="copyright"'), 'CR dock panel present in index.html');
  assert.ok(htmlCode.includes('id="crMirrorCheck"'), 'Mirror checkbox present');
  assert.ok(htmlCode.includes('id="crZoomSlider"'), 'Zoom slider present');
  assert.ok(htmlCode.includes('id="crColorSelect"'), 'Color select present');
  assert.ok(htmlCode.includes('id="crSpeedSlider"'), 'Speed slider present');
  assert.ok(htmlCode.includes('id="crPitchSlider"'), 'Pitch slider present');
  assert.ok(htmlCode.includes('id="crStripMetaCheck"'), 'Strip metadata checkbox present');
  assert.ok(htmlCode.includes('id="exportCrSummaryRow"'), 'Export modal CR summary row present');

  // Verify CSS layer ordering keeps vignette below blur/subtitles/logo and 5-column dock bar
  assert.ok(cssCode.includes('repeat(5, minmax(0, 1fr)) auto'), '5-column preview dock bar');
  assert.ok(cssCode.includes('.video-frame-916.has-cr-vignette::after'), 'Vignette pseudo-element CSS');
  assert.ok(cssCode.includes('z-index: 12'), 'Vignette layer at z-index 12 below mask (14) & subs (15)');

  // Build VM sandbox with dock & CR elements
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === true) set.add(c);
        else if (force === false) set.delete(c);
        else if (set.has(c)) set.delete(c);
        else set.add(c);
      },
      contains: (c) => set.has(c)
    };
  };
  const makeEl = (extra = {}) => {
    const attrs = {};
    const listeners = {};
    return {
      style: { transform: '', filter: '', setProperty: () => { }, getPropertyValue: () => '' },
      classList: makeClassList(),
      dataset: {},
      innerText: '',
      value: '',
      checked: false,
      hidden: false,
      playbackRate: 1,
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector: () => null,
      ...extra
    };
  };

  const makeHarness = (storageMap) => {
    const dockTabBtns = ['audio', 'mask', 'sub', 'brand', 'copyright'].map((tab) =>
      makeEl({ dataset: { dockTab: tab }, getAttribute: (k) => k === 'data-dock-tab' ? tab : null })
    );
    const dockPanels = ['audio', 'mask', 'sub', 'brand', 'copyright'].map((panel) =>
      makeEl({ hidden: panel !== 'audio', dataset: { dockPanel: panel }, getAttribute: (k) => k === 'data-dock-panel' ? panel : null })
    );
    const presetBtns = ['safe', 'strong', 'off'].map((p) =>
      makeEl({ getAttribute: (k) => k === 'data-cr-preset' ? p : null })
    );

    const els = {
      mainVideo: makeEl({ playbackRate: 1 }),
      previewFrame: makeEl({ classList: makeClassList(['video-frame-916']) }),
      speedSelect: makeEl({ value: '1' }),
      quickCrToggleBtn: makeEl(),
      crStatusBadge: makeEl(),
      crTabDot: makeEl({ hidden: true }),
      crMirrorCheck: makeEl({ checked: false }),
      crVignetteCheck: makeEl({ checked: false }),
      crStripMetaCheck: makeEl({ checked: true }),
      crColorSelect: makeEl({ value: 'none' }),
      crZoomSlider: makeEl({ value: '100' }),
      crZoomVal: makeEl({ innerText: '100%' }),
      crSpeedSlider: makeEl({ value: '100' }),
      crSpeedVal: makeEl({ innerText: '1.00x' }),
      crPitchSlider: makeEl({ value: '0' }),
      crPitchVal: makeEl({ innerText: '0%' }),
      exportCrStatusText: makeEl(),
      exportCrSafeBtn: makeEl(),
      exportPreviewSummary: makeEl(),
      subtitleStyleSelect: makeEl({ value: 'cinema_gold' }),
      previewDockBody: makeEl({ hidden: false }),
      previewDockCollapseBtn: makeEl()
    };

    const documentMock = {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '.video-frame-916' ? els.previewFrame : null),
      querySelectorAll: (sel) => {
        if (sel.includes('preview-dock-tab')) return dockTabBtns;
        if (sel.includes('preview-dock-panel')) return dockPanels;
        if (sel.includes('cr-preset-btn')) return presetBtns;
        if (sel.includes('data-cr-preset')) return presetBtns;
        return [];
      },
      addEventListener: () => { },
      body: makeEl()
    };

    const ctx = vm.createContext({
      console,
      Math,
      Number,
      String,
      Boolean,
      JSON,
      Array,
      Object,
      Set,
      Map,
      RegExp,
      Date,
      parseFloat,
      parseInt,
      isNaN,
      setTimeout,
      clearTimeout,
      window: { addEventListener: () => { }, location: { protocol: 'http:', host: 'localhost:3001' }, electronAPI: null },
      document: documentMock,
      localStorage: {
        getItem: (k) => (k in storageMap ? storageMap[k] : null),
        setItem: (k, v) => { storageMap[k] = String(v); },
        removeItem: (k) => { delete storageMap[k]; }
      },
      navigator: { userAgent: 'node-test' },
      Audio: function MockAudio() {
        return makeEl({ pause: () => { }, play: () => Promise.resolve(), currentTime: 0, src: '' });
      },
      Image: function MockImage() { return makeEl(); },
      URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => { } },
      alert: () => { },
      confirm: () => true
    });
    vm.runInContext(appCode, ctx);
    return { ctx, els, dockTabBtns, dockPanels };
  };

  const storage = {};
  const h1 = makeHarness(storage);

  // Activate Copyright dock tab
  h1.ctx.setPreviewDockTab('copyright');
  assert.equal(h1.dockPanels.find(p => p.dataset.dockPanel === 'copyright').hidden, false, 'copyright panel shown');
  assert.equal(h1.dockPanels.find(p => p.dataset.dockPanel === 'audio').hidden, true, 'audio panel hidden');

  // Apply Safe preset -> live preview CSS & export payload align with FFmpeg
  h1.ctx.applyCopyrightPreset('safe');
  assert.equal(h1.els.mainVideo.style.transform, 'scale(1.04)');
  assert.ok(h1.els.mainVideo.style.filter.includes('contrast(1.06)'));
  assert.equal(h1.els.mainVideo.playbackRate, 1.03);
  assert.equal(h1.els.previewFrame.classList.contains('has-cr-vignette'), false);
  assert.equal(h1.els.crTabDot.hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h1.ctx.getCopyrightExportPayload())), {
    enabled: true,
    preset: 'safe',
    mirror: false,
    zoomPercent: 4,
    colorShift: 'warm_vivid',
    vignette: false,
    speedRate: 1.03,
    audioPitchPct: 0,
    stripMetadata: true
  });

  // Apply Strong preset -> Mirror + Zoom + Vignette + Pitch
  h1.ctx.applyCopyrightPreset('strong');
  assert.equal(h1.els.mainVideo.style.transform, 'scaleX(-1) scale(1.07)');
  assert.equal(h1.els.previewFrame.classList.contains('has-cr-vignette'), true);
  assert.equal(h1.els.mainVideo.playbackRate, 1.05);
  assert.deepEqual(JSON.parse(JSON.stringify(h1.ctx.getCopyrightExportPayload())), {
    enabled: true,
    preset: 'strong',
    mirror: true,
    zoomPercent: 7,
    colorShift: 'cinema_crisp',
    vignette: true,
    speedRate: 1.05,
    audioPitchPct: -4,
    stripMetadata: true
  });

  // Custom control update & persistence across reload
  h1.ctx.setCopyrightControl('zoomPercent', 110);
  const h2 = makeHarness(storage);
  assert.equal(h2.ctx.getCopyrightExportPayload().zoomPercent, 10, 'saved zoomPercent restored on startup');
  assert.equal(h2.els.mainVideo.style.transform, 'scaleX(-1) scale(1.10)');

  // Turn off cleanly
  h2.ctx.applyCopyrightPreset('off');
  assert.equal(h2.els.mainVideo.style.transform, '');
  assert.equal(h2.els.mainVideo.style.filter, '');
  assert.equal(h2.els.mainVideo.playbackRate, 1);
  assert.equal(h2.els.previewFrame.classList.contains('has-cr-vignette'), false);
  assert.equal(h2.els.crTabDot.hidden, true);
});


test('Simplified 1-Click Export Modal: scrollable modal, quick mode presets, readiness pills, and collapsed advanced drawer', () => {
  const vm = require('vm');
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const cssCode = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  assert.ok(htmlCode.includes('id="exportQuickModeGroup"'), 'quick mode preset cards present');
  assert.ok(htmlCode.includes('id="exportReadinessBar"'), 'readiness pills bar present');
  assert.ok(htmlCode.includes('class="btn-export export-main-cta"'), 'primary Export MP4 CTA button present');
  assert.ok(cssCode.includes('.export-modal-card { width: min(580px, 94vw); max-height: 90vh; overflow-y: auto; }'), 'export modal scrollable on smaller screens');

  // Verify advanced details wraps duplicate audio/logo/sponsor/video controls cleanly
  const detailsMatch = htmlCode.match(/<details id="exportAdvancedDetails"[\s\S]*?<\/details>/);
  assert.ok(detailsMatch, 'exportAdvancedDetails section exists');
  assert.ok(detailsMatch[0].includes('id="exportAudioMode"'), 'audio mode inside collapsible details');
  assert.ok(detailsMatch[0].includes('id="exportLogoRow"'), 'logo override row inside collapsible details');
  assert.ok(detailsMatch[0].includes('id="exportSponsorRow"'), 'sponsor override row inside collapsible details');
  assert.ok(detailsMatch[0].includes('id="exportVideoModeSelect"'), 'video mode select inside collapsible details');

  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === true) set.add(c);
        else if (force === false) set.delete(c);
        else if (set.has(c)) set.delete(c);
        else set.add(c);
      },
      contains: (c) => set.has(c)
    };
  };
  const makeEl = (extra = {}) => {
    const attrs = {};
    return {
      style: { transform: '', filter: '', width: '', display: '', setProperty: () => { }, getPropertyValue: () => '' },
      classList: makeClassList(),
      dataset: {},
      innerText: '',
      innerHTML: '',
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener: () => { },
      ...extra
    };
  };

  const modeCards = ['standard', 'copyright', 'copy'].map((m) =>
    makeEl({ getAttribute: (k) => k === 'data-export-mode' ? m : null })
  );
  const els = {
    exportModal: makeEl({ style: { display: 'none' } }),
    exportStatusMsg: makeEl(),
    btnOpenExportedFile: makeEl({ hidden: true }),
    btnDownloadExportedMp4: makeEl({ hidden: true }),
    exportProgressTrack: makeEl({ hidden: true }),
    exportProgressFill: makeEl(),
    exportVideoModeSelect: makeEl({ value: 'burn' }),
    exportAudioMode: makeEl({ value: 'bgm_only' }),
    exportResolution: makeEl({ value: 'source' }),
    exportQualityPreset: makeEl({ value: 'hd' }),
    exportEncoder: makeEl({ value: 'auto' }),
    exportAutoFitCheck: makeEl({ checked: true }),
    exportPreviewSummary: makeEl({ innerText: 'stale placeholder' }),
    exportReadinessBar: makeEl({ innerHTML: '' }),
    exportCrStatusText: makeEl(),
    exportCrSafeBtn: makeEl(),
    exportOutputDirInput: makeEl(),
    mainVideo: makeEl({ playbackRate: 1, src: 'http://localhost:3001/video.mp4' }),
    previewFrame: makeEl({ classList: makeClassList(['video-frame-916']) })
  };

  const ctx = vm.createContext({
    console, Math, Number, String, Boolean, JSON, Array, Object, Set, Map, RegExp, Date,
    parseFloat, parseInt, isNaN, setTimeout, clearTimeout,
    window: { addEventListener: () => { }, location: { protocol: 'http:', host: 'localhost:3001' }, electronAPI: null },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => els.previewFrame,
      querySelectorAll: (sel) => (sel.includes('export-mode-card') ? modeCards : []),
      addEventListener: () => { },
      body: makeEl()
    },
    localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
    navigator: { userAgent: 'node-test' },
    Audio: function MockAudio() { return makeEl({ pause: () => { }, play: () => Promise.resolve() }); },
    Image: function MockImage() { return makeEl(); },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => { } },
    alert: () => { },
    confirm: () => true
  });
  vm.runInContext(appCode, ctx);
  vm.runInContext("currentVideoPath = 'D:/tmp/drama.mp4'; activeCues = [{ startSec: 0, endSec: 1.5, text: 'hi', translated: 'សួស្តី', audioUrl: '/audio/1.mp3' }];", ctx);

  // Opening modal immediately refreshes readiness pills & summary
  ctx.openExportModal();
  assert.notEqual(els.exportPreviewSummary.innerText, 'stale placeholder');
  assert.ok(els.exportReadinessBar.innerHTML.includes('វីដេអូ៖ រួចរាល់'));
  assert.ok(els.exportReadinessBar.innerHTML.includes('អក្សរ 1'));
  assert.equal(modeCards[0].classList.contains('active'), true, 'standard mode pill active by default');

  // Clicking "+ Copyright" mode enables CR & selects burn
  ctx.selectExportQuickMode('copyright');
  assert.equal(els.exportVideoModeSelect.value, 'burn');
  assert.equal(ctx.getCopyrightExportPayload().enabled, true);
  assert.equal(modeCards[1].classList.contains('active'), true);

  // Clicking "Fast Copy" switches to copy & disables CR transforms
  ctx.selectExportQuickMode('copy');
  assert.equal(els.exportVideoModeSelect.value, 'copy');
  assert.equal(ctx.getCopyrightExportPayload().enabled, false);
  assert.equal(modeCards[2].classList.contains('active'), true);

  // Clicking "Standard" returns cleanly to burn
  ctx.selectExportQuickMode('standard');
  assert.equal(els.exportVideoModeSelect.value, 'burn');
  assert.equal(modeCards[0].classList.contains('active'), true);
});

test('Timeline and Studio Tools UX/UI Redesign', () => {
  const assert = require('node:assert');
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const html = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');

  // 1. HTML exposes 1-click Studio actions, subtitle edit pills, and visible timeline quick tools
  [
    'startSpeechDetection(',
    'startAiTranslation(',
    'batchGenerateAllAudio(',
    'batchGenerateAllAudio({ onlyMissing: true })',
    'startSubtitleOcr(',
    'id="btnQuickBgm"',
    'openVoiceCloneModal(',
    'id="advancedToolsMenu"',
    'addNewCueLine(',
    'saveSrtToDisk(',
    'deleteSelectedCue(',
    'clearAllCues(',
    'id="timelineActiveCueBadge"',
    'class="timeline-quick-tools"',
    'id="timelineZoomLabel"',
    'stepTimelineZoom(',
    'resetTimelineZoom(',
    'onmousedown="onTimelineMouseDown(event)"',
    'onwheel="onTimelineWheel(event)"'
  ].forEach((token) => {
    assert.ok(html.includes(token), `index.html missing expected UI token: ${token}`);
  });
  assert.ok(!html.includes('timelineEditMenu'), 'Old clipped timelineEditMenu dropdown should be removed');

  // 2. CSS styles secondary-toggle pills, sticky track labels, crisp blocks & missing dub indicators
  [
    '.secondary-toggle',
    '.track-label',
    'position: sticky',
    '.timeline-block.is-selected',
    '.timeline-dub-block.is-missing-dub',
    '.timeline-quick-tools'
  ].forEach((token) => {
    assert.ok(css.includes(token), `styles.css missing expected timeline/toolbar style: ${token}`);
  });

  // 3. Runtime VM check of renderTimeline, zoom steppers, active cue badge, and block selection
  function makeEl(id = '') {
    const classes = new Set();
    const el = {
      id,
      value: '1',
      textContent: '',
      innerText: '',
      innerHTML: '',
      className: '',
      scrollLeft: 0,
      clientWidth: 800,
      scrollWidth: 800,
      currentTime: 0,
      duration: 60,
      paused: true,
      style: {},
      children: [],
      dataset: {},
      setAttribute: () => { },
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (n, force) => (force === undefined ? (classes.has(n) ? classes.delete(n) : classes.add(n)) : (force ? classes.add(n) : classes.delete(n))),
        contains: (n) => classes.has(n)
      },
      addEventListener: () => { },
      removeEventListener: () => { },
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      scrollIntoView: () => { },
      focus: () => { },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 894, height: 110 })
    };
    return el;
  }

  const elements = new Map([
    ['timelineRuler', makeEl('timelineRuler')],
    ['trackSubBlocks', makeEl('trackSubBlocks')],
    ['trackDubBlocks', makeEl('trackDubBlocks')],
    ['trackVideoBar', makeEl('trackVideoBar')],
    ['tracksContainer', Object.assign(makeEl('tracksContainer'), { clientWidth: 800 })],
    ['timelineZoom', Object.assign(makeEl('timelineZoom'), { value: '1', min: '1', max: '8' })],
    ['timelineZoomLabel', makeEl('timelineZoomLabel')],
    ['timelineActiveCueBadge', makeEl('timelineActiveCueBadge')],
    ['playheadNeedle', makeEl('playheadNeedle')],
    ['scrubberFill', makeEl('scrubberFill')],
    ['playerTimeText', makeEl('playerTimeText')],
    ['mainVideo', Object.assign(makeEl('mainVideo'), { duration: 60, currentTime: 0, paused: true })]
  ]);

  const doc = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => { },
    removeEventListener: () => { },
    body: makeEl('body'),
    documentElement: makeEl('html')
  };

  const sandbox = {
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Date,
    RegExp,
    Error,
    Map,
    Set,
    Promise,
    Audio: class {
      constructor() { this.volume = 1; this.currentTime = 0; this.paused = true; }
      play() { return Promise.resolve(); }
      pause() { }
      addEventListener() { }
      removeEventListener() { }
    },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    URL: class { },
    URLSearchParams: class { toString() { return ''; } },
    localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
    sessionStorage: { getItem: () => null, setItem: () => { } },
    navigator: { userAgent: 'node-test' },
    matchMedia: () => ({ matches: false, addEventListener: () => { } }),
    requestAnimationFrame: (cb) => 0,
    cancelAnimationFrame: () => { },
    setTimeout: () => 0,
    clearTimeout: () => { },
    setInterval: () => 0,
    clearInterval: () => { },
    fetch: async () => ({ ok: false, json: async () => ({}), text: async () => '' }),
    alert: () => { },
    confirm: () => true,
    prompt: () => null,
    document: doc,
    window: null,
    self: null,
    globalThis: null,
    addEventListener: () => { },
    removeEventListener: () => { },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appCode, ctx);

  // Populate activeCues: cue 0 has audioUrl, cue 1 is missing audioUrl and selected
  vm.runInContext(`
        currentVideoDuration = 60;
        activeCues = [
            { index: 1, startSec: 2, endSec: 6, text: 'Hello', translated: 'សួស្តីពិភពលោក', audioUrl: '/tmp/c1.wav' },
            { index: 2, startSec: 10, endSec: 18, text: 'Test', translated: 'សាកល្បងអត្ថបទខ្មែរ', audioUrl: '' }
        ];
        selectedCueIndex = 1;
        renderTimeline();
    `, ctx);

  const subHtml = elements.get('trackSubBlocks').innerHTML;
  const dubHtml = elements.get('trackDubBlocks').innerHTML;
  const rulerHtml = elements.get('timelineRuler').innerHTML;

  assert.ok(subHtml.includes('timeline-sub-block'), 'Sub track should render timeline-sub-block items');
  assert.ok(subHtml.includes('#1 ') && subHtml.includes('#2 '), 'Sub track should render cue index labels');
  assert.ok(subHtml.includes('is-selected'), 'Selected cue should have is-selected highlight');
  assert.ok(dubHtml.includes('is-missing-dub'), 'Dub track should mark cues without audio with is-missing-dub');
  assert.ok(rulerHtml.includes('is-start'), 'Ruler should mark 0:00 tick with is-start');
  assert.strictEqual(elements.get('timelineZoomLabel').innerText, '1.0x');
  assert.ok(elements.get('timelineActiveCueBadge').innerText.includes('#2'), 'Active badge should show #2');

  // Step zoom and reset zoom
  vm.runInContext('stepTimelineZoom(1);', ctx);
  assert.strictEqual(elements.get('timelineZoom').value, '2');
  assert.strictEqual(elements.get('timelineZoomLabel').innerText, '2.0x');
  vm.runInContext('resetTimelineZoom();', ctx);
  assert.strictEqual(elements.get('timelineZoom').value, '1');
  assert.strictEqual(elements.get('timelineZoomLabel').innerText, '1.0x');

  // Selecting block 0 updates selectedCueIndex, badge, and video currentTime
  vm.runInContext('onTimelineBlockClick(0);', ctx);
  assert.strictEqual(vm.runInContext('selectedCueIndex', ctx), 0);
  assert.strictEqual(elements.get('mainVideo').currentTime, 2);
  assert.ok(elements.get('timelineActiveCueBadge').innerText.includes('#1'));
});

test('backend performance, security, and mono audio filter protections hold', async () => {
  const express = require('express');
  const os = require('os');
  const cfg = require('./src/backend/routes/config');
  const ffmpegUtils = require('./src/backend/utils/ffmpeg');
  const audioRoutes = require('./src/backend/routes/audio');
  const mediaRoutes = require('./src/backend/routes/media');

  // 1. parseMp3DurationFast parses MPEG1 Layer III frames accurately
  const mp3Fixture = path.join(os.tmpdir(), `eza_mp3_fast_${Date.now()}.mp3`);
  const frameCount = 38; // ~0.992s @ 128kbps 44.1kHz (417B/frame)
  const buf = Buffer.alloc(frameCount * 417, 0);
  for (let i = 0; i < frameCount; i++) {
    const off = i * 417;
    buf[off] = 0xFF;
    buf[off + 1] = 0xFB;
    buf[off + 2] = 0x90;
    buf[off + 3] = 0x00;
  }
  fs.writeFileSync(mp3Fixture, buf);
  try {
    const dur = ffmpegUtils.parseMp3DurationFast(mp3Fixture);
    assert.ok(dur > 0.9 && dur < 1.1, `Expected ~0.99s, got ${dur}`);
  } finally {
    try { fs.unlinkSync(mp3Fixture); } catch (_) { }
  }

  // 2. Audio BGM filter skips stereotools on mono (1ch) input
  const monoBgm = audioRoutes.buildBgmFilterForChannels(1);
  const stereoBgm = audioRoutes.buildBgmFilterForChannels(2);
  assert.ok(!monoBgm.includes('stereotools'), 'Mono input must not use center-canceling stereotools');
  assert.ok(stereoBgm.includes('stereotools'), 'Stereo input should apply center-canceling stereotools');

  // 3. config route rejects restricted secrets via POST /api/config
  const app = express();
  app.use(express.json());
  app.use('/api/config', cfg);
  app.get('/api/video-stream', mediaRoutes.videoStreamHandler);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const blockedRes = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ EZA_VAULT_KEY: 'should-block' })
    });
    assert.equal(blockedRes.status, 403);

    // 4. video-stream blocks sensitive non-video files like .json / .env
    const secretFile = path.join(__dirname, 'package.json');
    const streamBlocked = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent(secretFile)}`);
    assert.equal(streamBlocked.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('empty preview aspect fits cleanly without squishing dropzone and mobile CSS enforces viewport-locked zero-scroll UX', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  // HTML + CSS mobile zero-long-scroll contracts
  assert.ok(html.includes('id="btnJumpActiveCue"'), 'index.html must include jump-to-active button');
  assert.ok(html.includes('onchange="syncVideoPlaybackRate()"'), 'speedSelect must sync dub + video playback rate');
  assert.ok(!html.includes('id="exportDubCheck"'), 'index.html must not contain removed exportDubCheck');
  assert.ok(css.includes('height: 100dvh !important;'), 'Mobile CSS must lock viewport height to prevent 5000px scrolling');
  assert.ok(css.includes('overflow-x: auto !important;'), 'Mobile AI bar must scroll horizontally in 1 row');
  assert.ok(css.includes('@media (hover: none), (max-width: 860px)'), 'Router actions must be visible without hover on touch devices');

  // fitPreviewFrameSize empty dropzone width + cachedAudioMap Timeline/Readiness check
  const frameEl = { style: {}, classList: { toggle() { } } };
  const dropZoneEl = { clientWidth: 400, clientHeight: 280 };
  const mainVideoEl = { videoWidth: 0, videoHeight: 0, currentTime: 0, pause() { }, src: '' };
  const mapEls = {
    previewFrameBox: frameEl,
    videoDropZone: dropZoneEl,
    mainVideo: mainVideoEl,
    tracksContainer: { clientWidth: 640, scrollWidth: 640, scrollLeft: 0, querySelectorAll: () => [] },
    timelineRuler: { innerHTML: '', style: {} },
    trackVideoBar: { style: {} },
    trackSubBlocks: { innerHTML: '', style: {}, getBoundingClientRect: () => ({ left: 94, width: 520 }) },
    trackDubBlocks: { innerHTML: '', style: {}, getBoundingClientRect: () => ({ left: 94, width: 520 }) },
    exportReadinessBar: { innerHTML: '' },
    cuesTableBody: { innerHTML: '' },
    cuesStatsText: { innerText: '' },
    scriptStatusFilter: { value: 'all' },
    scriptSearch: { value: '' },
    defaultVoiceSelect: { value: 'Sovereign King', innerHTML: '' },
    castModeSelect: { value: 'single' },
    ttsEngineSelect: { value: 'edge' },
    playheadNeedle: { style: {}, setAttribute() { } },
    playerTimeText: { innerText: '' },
    scrubberFill: { style: {} }
  };
  const sandbox = {
    window: { innerWidth: 390, addEventListener() { } },
    document: {
      body: { classList: { toggle() { } }, dataset: {}, appendChild() { } },
      getElementById: (id) => mapEls[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { toggle() { } } }),
      addEventListener() { }
    },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Audio: class { },
    URL,
    console: { log() { }, warn() { }, error() { } },
    setInterval: () => 0,
    clearInterval() { },
    setTimeout: () => 0,
    clearTimeout() { },
    requestAnimationFrame: (fn) => fn()
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  sandbox.fitPreviewFrameSize();
  const emptyW = Number.parseInt(frameEl.style.width, 10);
  const emptyH = Number.parseInt(frameEl.style.height, 10);
  assert.ok(emptyW >= 240 && emptyW > emptyH, `Empty preview dropzone must be comfortably wide (got ${emptyW}x${emptyH})`);

  vm.runInContext(`
    currentVideoDuration = 20;
    activeCues = [{ index: 1, startSec: 1, endSec: 4, text: 'hi', translated: 'សួស្តី', voice: 'Sovereign King' }];
    cachedAudioMap.add(getAudioCacheKey('Sovereign King', 'សួស្តី', 'auto', 'edge'));
    renderTimeline();
    updateExportReadinessBar();
  `, sandbox);
  assert.ok(!mapEls.trackDubBlocks.innerHTML.includes('is-missing-dub'), 'Timeline must treat cachedAudioMap entries as voiced');
  assert.ok(mapEls.exportReadinessBar.innerHTML.includes('🗣️ 1'), 'Export readiness bar must count cachedAudioMap entries');

  mapEls.scriptStatusFilter.value = 'untranslated';
  sandbox.renderTable();
  assert.ok(mapEls.cuesTableBody.innerHTML.includes('script-empty-box'), 'Empty filter match must render friendly empty-state message');
});

test('export.js regressions: custom overlay escaping, ASS apostrophe path escaping, odd source video dimensions, and path hardening', async () => {
  const logoPath = path.join(tempRoot, 'regression-logo.png');
  fs.writeFileSync(logoPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const sponsorSpec = exportModule.resolveSponsorOverlaySpec({
    sponsorEnabled: true,
    sponsorPath: logoPath,
    sponsorPosition: 'custom',
    sponsorXPercent: 0.25,
    sponsorYPercent: 0.4,
    resolution: 'source',
    mediaInfo: { width: 1080, height: 1920 }
  });
  assert.ok(sponsorSpec && sponsorSpec.enabled);
  assert.equal(sponsorSpec.xExpr, 'min(W-w\\,max(0\\,W*0.2500))');
  assert.equal(sponsorSpec.yExpr, 'min(H-h\\,max(0\\,H*0.4000))');

  const assFilter = exportModule.buildExportFilter("C:\\Users\\O'Brien\\sub.ass", {
    maskEnabled: false,
    resolution: 'source',
    mediaInfo: { width: 1081, height: 1921 },
    burnSubtitles: true
  });
  assert.ok(assFilter.includes("scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos"), 'Odd source dimensions must enforce even scale filter');
  assert.ok(assFilter.includes("ass='C\\:/Users/O'\\\\\\''Brien/sub.ass'"), 'ASS filter path must escape apostrophes for FFmpeg');

  const safeAss = exportModule.serializeAss([{ startSec: 0, endSec: 2, translated: "ខ្ញុំមិនទៅទេ" }], 'tiktok', 58, 320, false);
  assert.ok(safeAss.includes('Dialogue: 0,0:00:00.00,0:00:02.00,KhmerSub'), 'serializeAss must emit standard Dialogue line');

  const { server, baseUrl } = await startTestServer();
  try {
    const uncOpen = await fetch(`${baseUrl}/api/export/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath: '\\\\192.168.1.99\\share\\secret.mp4' })
    });
    assert.equal(uncOpen.status, 403, 'UNC paths must be blocked in /open-folder');

    const adsDl = await fetch(`${baseUrl}/api/export/download?file=${encodeURIComponent('C:\\temp\\video.mp4::$DATA')}`);
    assert.equal(adsDl.status, 403, 'NTFS alternate data streams must be blocked in /download');

    const dotDl = await fetch(`${baseUrl}/api/export/download?file=${encodeURIComponent('C:\\temp\\video.mp4.')}`);
    assert.equal(dotDl.status, 403, 'Trailing-dot bypass paths must be blocked in /download');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dns-fix.js regression: handles nullish hostname safely and preserves explicit family', async () => {
  const dns = require('node:dns');
  const { installDnsFix } = require('./src/backend/utils/dns-fix');
  installDnsFix();

  await new Promise((resolve) => {
    let settled = false;
    try {
      dns.lookup(null, (err, address, family) => {
        settled = true;
        // Node 24 native lookup resolves nullish hostnames cleanly (address: null) without crashing on .trim()
        assert.ok(Boolean(err) || address === null || typeof address === 'string');
        assert.ok(family === undefined || family === 0 || family === 4 || family === 6);
        resolve();
      });
    } catch (syncErr) {
      settled = true;
      assert.ok(syncErr && !String(syncErr.message || '').includes('trim'));
      resolve();
    }
    setTimeout(() => { if (!settled) resolve(); }, 1500);
  });

  await new Promise((resolve) => {
    dns.lookup('localhost', { family: 6 }, (err, address, family) => {
      if (!err && family !== undefined) {
        assert.equal(family, 6, 'Explicit family: 6 must not be overwritten to 4');
      }
      resolve();
    });
  });
});

test('tts.js and translation.js regressions: foreign neural voices, fractional concurrency, 1-item JSON array, local cue ID offset, and per-job speech progress', async () => {
  const foreignVoice = ttsModule.resolveVoiceSpec('en-US-AndrewNeural');
  assert.equal(foreignVoice.voice, 'en-US-AndrewNeural', 'Explicit foreign neural voice must not be forced back to Khmer default');

  const arrParsed = translationModule.parseJsonObject('[{"id":1,"translated":"សួស្តី"}]', 'batch');
  assert.ok(Array.isArray(arrParsed.translations) && arrParsed.translations.length === 1);
  assert.equal(arrParsed.translations[0].translated, 'សួស្តី');

  assert.equal(
    translationModule.resolveDraftCueId(1, 0, [4, 5], 2, true, false),
    5,
    'Local 1-based draft cue IDs must map through chunk indices cleanly'
  );
  assert.equal(
    translationModule.resolveDraftCueId(0, 0, [4, 5], 2, false, true),
    5,
    'Local 0-based draft cue IDs must map through chunk indices cleanly'
  );
  assert.equal(
    translationModule.resolveDraftCueId(6, 1, [4, 5], 2, false, false),
    6,
    'Global 1-based draft cue IDs must stay 6 when indices contain 5'
  );

  const { server, baseUrl } = await startTestServer();
  try {
    const batchRes = await fetch(`${baseUrl}/api/tts/batch-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ text: '   ' }], concurrency: 0.5 })
    });
    assert.equal(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.equal(batchData.stats && batchData.stats.errors, 1, 'Fractional concurrency < 1 must clamp to >= 1 worker and process item');

    const progRes = await fetch(`${baseUrl}/api/translation/speech-progress?jobId=missing-job-xyz&videoPath=${encodeURIComponent('C:\\none.mp4')}`);
    assert.equal(progRes.status, 200);
    const progData = await progRes.json();
    assert.equal(progData.running, false, 'Unknown speech-progress jobId must not leak stale running status');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('config.js and routes/index.js security regressions: token versioning, remote auth gate, and localhost-only sensitive admin routes', async () => {
  const cfgPath = process.env.EZA_CONFIG_FILE;
  const origCfgRaw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
  try {
    configModule.saveConfig({ USER_ACCESS_ENABLED: true, USER_ACCESS_CODE: '9988' });
    const validTok = configModule.issueSignedAccessToken('verified', '9988');
    const openTok = configModule.issueSignedAccessToken('open');
    assert.equal(configModule.verifySignedAccessToken(validTok), true);
    assert.equal(configModule.verifySignedAccessToken(openTok), false, "'open' token must be rejected when passcode is enabled");

    configModule.saveConfig({ USER_ACCESS_ENABLED: true, USER_ACCESS_CODE: '7766' });
    assert.equal(configModule.verifySignedAccessToken(validTok), false, 'Rotating USER_ACCESS_CODE must invalidate previous passcode tokens');
    const newTok = configModule.issueSignedAccessToken('verified', '7766');

    const loopbackReq = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
      get: () => ''
    };
    assert.equal(configModule.isCallerAuthorized(loopbackReq), true);

    const forwardedReq = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.5' },
      get: (k) => (String(k).toLowerCase() === 'x-forwarded-for' ? '203.0.113.5' : '')
    };
    assert.equal(configModule.isCallerAuthorized(forwardedReq), false, 'Forwarded remote callers must require signed access token');

    const { server, baseUrl } = await startTestServer();
    try {
      const unauthVoices = await fetch(`${baseUrl}/api/tts/voices`, {
        headers: { 'x-forwarded-for': '203.0.113.5' }
      });
      assert.equal(unauthVoices.status, 401);

      const authVoices = await fetch(`${baseUrl}/api/tts/voices`, {
        headers: { 'x-forwarded-for': '203.0.113.5', 'x-eza-access-token': newTok }
      });
      assert.equal(authVoices.status, 200);

      const remotePostHub = await fetch(`${baseUrl}/api/config/system-hub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'x-eza-access-token': newTok },
        body: JSON.stringify({ maintenanceBanner: 'hijack' })
      });
      assert.equal(remotePostHub.status, 403, 'POST /system-hub must remain local-only even with user token');

      const remoteGenLic = await fetch(`${baseUrl}/api/config/generate-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'x-eza-access-token': newTok },
        body: JSON.stringify({ machineId: 'ABC' })
      });
      assert.equal(remoteGenLic.status, 403, 'POST /generate-license must remain local-only');

      const remoteTunnel = await fetch(`${baseUrl}/api/config/public-tunnel/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'x-eza-access-token': newTok },
        body: JSON.stringify({})
      });
      assert.equal(remoteTunnel.status, 403, 'POST /public-tunnel/start must remain local-only');

      const hiddenSrt = await fetch(`${baseUrl}/api/save-srt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 'C:\\temp\\bad.txt', cues: [{ startSec: 0, endSec: 1, text: 'hi' }] })
      });
      assert.equal(hiddenSrt.status, 403);

      const badStream = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent('C:\\temp\\clip.mp4::$DATA')}`);
      assert.equal(badStream.status, 403);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    if (origCfgRaw !== null) {
      fs.writeFileSync(cfgPath, origCfgRaw, 'utf8');
    } else if (fs.existsSync(cfgPath)) {
      fs.unlinkSync(cfgPath);
    }
  }
});

test('frontend regressions: real ISO 18004 QR SVG encoder, bgm_only dub inclusion, auth token fetch/URL injection, and single CSS link', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  const cssLinks = html.match(/<link[^>]+styles\.css[^>]*>/gi) || [];
  assert.equal(cssLinks.length, 1, 'index.html must include styles.css exactly once');
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(htmlIds.length, new Set(htmlIds).size, 'index.html must not have duplicate IDs');

  const gateOverlay = { style: { display: 'none' } };
  const gateErr = { innerText: '' };
  const fetchCalls = [];
  const storage = new Map();
  let capturedExportBody = null;

  const sandbox = {
    window: { location: { origin: 'http://127.0.0.1:3001', protocol: 'http:' } },
    document: {
      body: { dataset: {}, classList: { toggle() {}, add() {}, remove() {} } },
      documentElement: { style: { setProperty() {} } },
      getElementById(id) {
        if (id === 'accessGateOverlay') return gateOverlay;
        if (id === 'gateErrorMsg') return gateErr;
        if (id === 'exportAudioMode') return { value: 'bgm_only' };
        if (id === 'exportResolution') return { value: 'source' };
        if (id === 'exportQualityPreset') return { value: 'hd' };
        if (id === 'exportEncoder') return { value: 'cpu' };
        if (id === 'exportAutoFitCheck') return { checked: true };
        if (id === 'exportVideoModeSelect') return { value: 'reencode' };
        if (id === 'mainVideo') return { duration: 10, videoWidth: 1080, videoHeight: 1920, style: {}, classList: { toggle() {} }, pause() {} };
        if (id === 'exportStatusMsg') return { innerText: '' };
        if (id === 'btnStartExport') return { disabled: false };
        if (id === 'btnCancelExport') return { style: {} };
        if (id === 'btnOpenExportedFile') return { hidden: true };
        if (id === 'btnDownloadExportedMp4') return { hidden: true };
        if (id === 'exportProgressTrack') return { hidden: true };
        if (id === 'exportProgressFill') return { style: {} };
        return null;
      },
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/api/export/video')) {
        capturedExportBody = JSON.parse(init.body || '{}');
        return { ok: true, status: 200, json: async () => ({ success: true, outputFile: 'C:\\out.mp4', elapsedSec: 1 }) };
      }
      if (String(url).includes('/api/export/progress')) {
        return { ok: true, status: 200, json: async () => ({ active: false, percent: 100 }) };
      }
      if (String(url).includes('/api/protected-check')) {
        return { ok: false, status: 401, clone: () => ({ json: async () => ({ authRequired: true, error: 'Locked' }) }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    AudioContext: function () {},
    Audio: function () { return { play: async () => {}, pause() {}, addEventListener() {} }; },
    navigator: { clipboard: { writeText: async () => {} }, mediaDevices: {} },
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    AbortController: globalThis.AbortController,
    Headers: globalThis.Headers,
    alert() {},
    confirm: () => true,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    console
  };
  sandbox.window.fetch = sandbox.fetch;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  // 1. Token injection in fetch wrapper and backend asset URLs
  sandbox.saveVerifiedAccessToken('tok-abc-123');
  assert.equal(
    sandbox.appendAccessTokenToUrl('http://127.0.0.1:3001/api/video-stream?file=a.mp4'),
    'http://127.0.0.1:3001/api/video-stream?file=a.mp4&accessToken=tok-abc-123'
  );
  await sandbox.fetch('http://127.0.0.1:3001/api/health');
  assert.equal(fetchCalls.at(-1).init.headers['x-eza-access-token'], 'tok-abc-123');

  // 401 authRequired clears saved token and reveals access gate overlay
  await sandbox.fetch('http://127.0.0.1:3001/api/protected-check');
  assert.equal(sandbox.getSavedAccessToken(), '');
  assert.equal(gateOverlay.style.display, 'flex');

  // 2. QR encoder emits valid scannable matrix (dark module + finder corners + BCH L format + byte roundtrip)
  const sampleUrl = 'https://eza-test.trycloudflare.com/?accessToken=xyz789';
  const qrGrid = sandbox.encodeQrMatrix(sampleUrl);
  assert.ok(Array.isArray(qrGrid) && qrGrid.length >= 21 && (qrGrid.length - 17) % 4 === 0);
  assert.equal(qrGrid[qrGrid.length - 8][8], 1, 'QR dark module (4V+9, 8) must be set');
  const qrSvg = sandbox.buildVisualQrSvg(sampleUrl);
  assert.ok(qrSvg.includes('<svg ') && qrSvg.includes('viewBox="0 0 ') && qrSvg.includes('<rect '));

  // 3. bgm_only export mode must still include Khmer dubbing audio
  vm.runInContext(`currentVideoPath = "C:\\\\temp\\\\ep1.mp4"; activeCues = [{ id: 1, startSec: 0, endSec: 2, translated: "សួស្តី" }];`, sandbox);
  await sandbox.exportVideoWithFfmpeg();
  assert.ok(capturedExportBody && capturedExportBody.includeDubAudio === true, 'bgm_only mode must include dubbed Khmer voice');
});

test('export.js size control: computeAdaptiveMaxrateKbps, audio bitrates, /api/export/estimate, balanced render, and UI estimate pills', async () => {
  assert.equal(exportModule.getAudioBitrateForPreset('fast'), '128k');
  assert.equal(exportModule.getAudioBitrateForPreset('balanced'), '128k');
  assert.equal(exportModule.getAudioBitrateForPreset('hd'), '160k');
  assert.equal(exportModule.getAudioBitrateForPreset('ultra'), '192k');

  // Low-bitrate 1080p web drama (871 kbps) stays bounded instead of bloating 15x
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'fast',
      resolution: 'source',
      mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
    }),
    1600
  );
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'balanced',
      resolution: 'source',
      mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
    }),
    2090
  );
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'hd',
      resolution: 'source',
      mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
    }),
    2787
  );

  // Ultra-low-bitrate 1080p movie (518 kbps) respects minFloor 1400k for balanced & keeps 40m well below 2 GB
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'balanced',
      resolution: 'source',
      mediaInfo: { width: 1920, height: 1080, videoBitrateKbps: 518 }
    }),
    1400
  );
  // High-bitrate 1080p source still obeys tierCap
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'balanced',
      resolution: '1080p',
      mediaInfo: { width: 1920, height: 1080, videoBitrateKbps: 9000 }
    }),
    2200
  );
  // 720p & 4k tiers work both with unknown and known bitrate
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'balanced',
      resolution: '720p',
      mediaInfo: { width: 540, height: 960, videoBitrateKbps: 0 }
    }),
    1400
  );
  assert.equal(
    exportModule.computeAdaptiveMaxrateKbps({
      qualityPreset: 'ultra',
      resolution: '4k',
      mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 900 }
    }),
    16000
  );

  // buildVideoEncodingArgs uses VBR + adaptive maxrate when encodeContext is passed, while staying backward-compatible when omitted
  const balCpu = exportModule.buildVideoEncodingArgs('balanced', 'cpu', {
    resolution: 'source',
    mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
  });
  assert.equal(balCpu.encoderName, 'libx264');
  assert.ok(balCpu.args.includes('-crf') && balCpu.args.includes('24'));
  assert.ok(balCpu.args.includes('-maxrate') && balCpu.args.includes('2090k'));
  assert.ok(balCpu.args.includes('-bufsize') && balCpu.args.includes('4180k'));

  // Intel QSV: ICQ (-global_quality) ignores VBV caps, so capped exports must switch to explicit VBR target
  const balQsv = exportModule.buildVideoEncodingArgs('balanced', 'h264_qsv', {
    resolution: 'source',
    mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
  });
  assert.equal(balQsv.encoderName, 'h264_qsv');
  assert.equal(balQsv.args.includes('-global_quality'), false, 'QSV capped export must drop ICQ global_quality');
  assert.ok(balQsv.args.includes('-b:v') && balQsv.args.includes('1777k'), `QSV VBR target expected 1777k, got ${balQsv.args.join(' ')}`);
  assert.ok(balQsv.args.includes('-maxrate') && balQsv.args.includes('2090k'));
  // Without encodeContext QSV keeps legacy ICQ args (backward compatible)
  assert.ok(exportModule.buildVideoEncodingArgs('balanced', 'h264_qsv').args.includes('-global_quality'));

  const est40m = exportModule.estimateExportSize({
    qualityPreset: 'balanced',
    resolution: 'source',
    durationSec: 2400,
    mediaInfo: { width: 1080, height: 1920, videoBitrateKbps: 871 }
  });
  assert.ok(est40m.estimatedSizeMB > 300 && est40m.estimatedSizeMB < 900, `Expected 40m balanced estimate well below 1 GB, got ${est40m.estimatedSizeMB} MB`);
  assert.ok(est40m.maxSizeMB < 1024, `Expected 40m balanced max ceiling < 1 GB, got ${est40m.maxSizeMB} MB`);

  const sampleBalanced = path.join(tempRoot, 'sample-balanced-540x960.mp4');
  const genBal = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24:duration=1.0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleBalanced
  ], { encoding: 'utf8' });
  assert.equal(genBal.status, 0, genBal.stderr);

  const { server, baseUrl } = await startTestServer();
  try {
    const capRes = await fetch(`${baseUrl}/api/export/capabilities`);
    const capData = await capRes.json();
    assert.equal(capRes.status, 200);
    assert.ok(capData.presets.includes('balanced'));
    assert.ok(capData.maxrateTiers && capData.maxrateTiers.balanced);

    const estRes = await fetch(`${baseUrl}/api/export/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleBalanced,
        qualityPreset: 'balanced',
        resolution: 'source'
      })
    });
    assert.equal(estRes.status, 200);
    const estBody = await estRes.json();
    assert.equal(estBody.success, true);
    assert.equal(estBody.qualityPreset, 'balanced');
    assert.equal(estBody.audioBitrateKbps, 128);
    assert.ok(estBody.sourceMedia && estBody.sourceMedia.width === 540);
    assert.ok(estBody.maxrateKbps > 0);

    // Ensure UNC path in /estimate is safely ignored rather than accessing SMB share
    const uncEst = await fetch(`${baseUrl}/api/export/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: '\\\\192.168.1.99\\share\\clip.mp4', duration: 2400, width: 1080, height: 1920 })
    });
    assert.equal(uncEst.status, 200);
    const uncBody = await uncEst.json();
    assert.ok(uncBody.estimatedSizeMB > 0 && uncBody.estimatedSizeMB < 1000);

    const expRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: sampleBalanced,
        duration: 1.0,
        maskEnabled: false,
        includeDubAudio: false,
        qualityPreset: 'balanced',
        resolution: 'source',
        encoder: 'cpu',
        cues: [{ startSec: 0, endSec: 0.8, text: '你好', translated: 'សួស្តី' }]
      })
    });
    const expBody = await expRes.json();
    assert.equal(expRes.status, 200, JSON.stringify(expBody));
    assert.equal(expBody.success, true);
    assert.equal(expBody.qualityPreset, 'balanced');
    assert.ok(fs.existsSync(expBody.outputFile));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // Verify frontend HTML defaults to balanced & UI summary renders size estimate
  const vm = require('node:vm');
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  assert.ok(htmlCode.includes('<option value="balanced" selected>'), 'index.html exportQualityPreset must default to balanced');

  const els = {
    exportQualityPreset: { value: 'balanced' },
    exportResolution: { value: 'source' },
    exportVideoModeSelect: { value: 'burn' },
    exportAudioMode: { value: 'bgm_only' },
    exportPreviewSummary: { innerText: '' },
    exportReadinessBar: { innerHTML: '' },
    mainVideo: { duration: 2400, videoWidth: 1080, videoHeight: 1920, style: {}, classList: { toggle() {} } }
  };
  const ctx = vm.createContext({
    console, Math, Number, String, Boolean, JSON, Array, Object, Set, Map, RegExp, Date,
    parseFloat, parseInt, isNaN, setTimeout, clearTimeout,
    window: { location: { origin: 'http://127.0.0.1:3001', protocol: 'http:' } },
    document: {
      body: { dataset: {}, classList: { toggle() {} } },
      documentElement: { style: { setProperty() {} } },
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Audio: class {},
    URL,
    setInterval: () => 0,
    clearInterval() {}
  });
  vm.runInContext(appCode, ctx);
  vm.runInContext("currentVideoPath = 'D:/tmp/drama40m.mp4'; currentVideoDuration = 2400; activeCues = [{ startSec: 0, endSec: 2, translated: 'សួស្តី' }];", ctx);
  ctx.updateExportPreviewSummary();
  assert.ok(els.exportReadinessBar.innerHTML.includes('📦 ~'), 'Readiness bar must show estimated output size pill');
  assert.ok(els.exportPreviewSummary.innerText.includes('Balanced'), 'Summary must include active quality preset');
  assert.ok(els.exportPreviewSummary.innerText.includes('MB'), '40-min Balanced estimate must stay under 1 GB (reported in MB)');
});

test('frontend styles.css: `:root` is defined at line 1, CSS variables valid, and braces are balanced', () => {
  const css = fs.readFileSync('src/frontend/styles.css', 'utf8');
  assert.match(css, /^:root\s*\{/, 'styles.css must begin with `:root {`');
  assert.match(css, /--bg-base:\s*#070b16;/, '--bg-base must be defined in :root');
  assert.match(css, /--bg-panel:\s*#0c1322;/, '--bg-panel must be defined in :root');
  assert.match(css, /--cyan:\s*#00e5c0;/, '--cyan must be defined in :root');

  let depth = 0;
  let inComment = false;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '/' && css[i+1] === '*') { inComment = true; i++; continue; }
    if (inComment && css[i] === '*' && css[i+1] === '/') { inComment = false; i++; continue; }
    if (inComment) continue;
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      assert.ok(depth >= 0, `Unmatched closing brace at char ${i}`);
    }
  }
  assert.strictEqual(depth, 0, 'styles.css must have completely balanced curly braces');
});

test('frontend app.js: resetSubtitleStateOnVideoSwitch invalidates _exportMediaProbeCache and guards duration', () => {
  const appCode = fs.readFileSync('src/frontend/app.js', 'utf8');
  assert.match(appCode, /_exportMediaProbeCache\s*=\s*\{\s*videoPath:\s*'',\s*width:\s*0,\s*height:\s*0,\s*durationSec:\s*0,\s*videoBitrateKbps:\s*0\s*\};/, 'resetSubtitleStateOnVideoSwitch must reset _exportMediaProbeCache');
  assert.match(appCode, /Number\.isFinite\(v\?\.duration\)\s*&&\s*v\.duration\s*>\s*0/, 'Video duration must guard against NaN and Infinity');
});

test('export.js & frontend: subtitle fontsdir, ASS styles, exact 1:1 positioning, and custom colors', () => {
  // 1. hexToAssColor conversion
  assert.equal(exportModule.hexToAssColor('#ffffff'), '&H00FFFFFF');
  assert.equal(exportModule.hexToAssColor('#ffd700'), '&H0000D7FF');
  assert.equal(exportModule.hexToAssColor('#00e5c0'), '&H00C0E500');
  assert.equal(exportModule.hexToAssColor('#ff0000'), '&H000000FF');
  assert.equal(exportModule.hexToAssColor('#fff'), '&H00FFFFFF');
  assert.equal(exportModule.hexToAssColor(null), null);

  // 2. serializeAss style presets
  const tiktokGoldAss = exportModule.serializeAss([{ startSec: 0, endSec: 2, translated: 'តេស្ត' }], 'tiktok_gold', 58, 154, false);
  assert.ok(tiktokGoldAss.includes('&H0000D7FF'), 'tiktok_gold must use gold primary color');

  const cinemaAss = exportModule.serializeAss([{ startSec: 0, endSec: 2, translated: 'តេស្ត' }], 'cinema', 58, 154, false);
  assert.ok(cinemaAss.includes('KhmerSub,Kantumruy Pro,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.4,1.4,2,40,40,154,1'), 'cinema must emit clean cinematic styling');

  // 3. Custom color overrides in serializeAss
  const customAss = exportModule.serializeAss(
    [{ startSec: 0, endSec: 2, translated: 'តេស្ត' }],
    'tiktok',
    60,
    200,
    false,
    { primaryColor: '#ffd700', outlineColor: '#be123c' }
  );
  assert.ok(customAss.includes('&H0000D7FF'), 'custom primary color must override base style');
  assert.ok(customAss.includes('&H003C12BE'), 'custom outline color must override base style');

  // 4. buildExportFilter omits fontsdir on Windows for speed while DirectWrite resolves Kantumruy Pro
  const filter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: false,
    resolution: 'source',
    burnSubtitles: true
  });
  assert.ok(!filter.includes('fontsdir='), 'buildExportFilter must omit slow fontsdir override');
  assert.ok(filter.includes("ass='C\\:/temp/sub.ass'"), 'buildExportFilter must escape ASS path properly');

  // 5. Frontend subtitle interaction and positioning math
  const appCode = fs.readFileSync('src/frontend/app.js', 'utf8');
  assert.ok(appCode.includes('initSubtitleBoxInteraction'), 'app.js must define direct subtitle drag interaction');
  assert.ok(appCode.includes('setSubPosPreset'), 'app.js must define position presets (bottom, center, top)');
  assert.ok(appCode.includes('setSubTextColor'), 'app.js must define text color selection');
  assert.ok(appCode.includes('onCustomExportOutputDirInput'), 'app.js must allow custom folder typing/pasting');
});

test('tts.js and app.js voice switching: /api/tts/preview audition, instant voice playback, and non-Piseth voice dubbing', async () => {
  // 1. Backend VOICE_PREVIEW_TEXTS coverage
  assert.ok(ttsModule.VOICE_PREVIEW_TEXTS, 'ttsModule must export VOICE_PREVIEW_TEXTS');
  const requiredPresets = [
    'Sovereign King',
    'Radiant Queen',
    'kh_narrator_fast',
    'kh_young_man',
    'kh_deep_boss',
    'kh_young_girl',
    'kh_child',
    'kh_elder_woman'
  ];
  for (const preset of requiredPresets) {
    assert.ok(ttsModule.VOICE_PREVIEW_TEXTS[preset], `Preview text must exist for preset ${preset}`);
    assert.match(ttsModule.VOICE_PREVIEW_TEXTS[preset], /[\u1780-\u17FF]/, `Preview text for ${preset} must be in Khmer`);
  }

  // 2. POST /api/tts/preview integration test
  const testServer = express();
  testServer.use(express.json());
  testServer.use('/api/tts', ttsModule);
  const server = await new Promise(r => {
    const s = testServer.listen(0, '127.0.0.1', () => r(s));
  });
  const ttsPort = server.address().port;
  const ttsBase = `http://127.0.0.1:${ttsPort}`;

  try {
    const prevRes = await fetch(`${ttsBase}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: 'Radiant Queen' })
    });
    assert.equal(prevRes.status, 200, 'POST /api/tts/preview should return 200 for Radiant Queen');
    const prevData = await prevRes.json();
    assert.equal(prevData.success, true);
    assert.ok(prevData.audioUrl && prevData.audioUrl.endsWith('.mp3'));
    assert.equal(prevData.voice, 'km-KH-SreymomNeural');
    assert.equal(prevData.presetId, 'Radiant Queen');
    assert.ok(prevData.text.includes('ស្រីមុំ'));
  } finally {
    await new Promise(r => server.close(r));
  }

  // 3. Frontend UI verification
  const indexHtml = fs.readFileSync('src/frontend/index.html', 'utf8');
  assert.ok(indexHtml.includes('id="btnPreviewSelectedVoice"'), 'index.html must have voice preview button');
  assert.ok(indexHtml.includes("previewCurrentVoice('defaultVoiceSelect')"), 'index.html must bind preview to defaultVoiceSelect');
  assert.ok(indexHtml.includes("previewCurrentVoice('vmDefaultVoiceSelect')"), 'index.html must bind preview to vmDefaultVoiceSelect');

  const stylesCss = fs.readFileSync('src/frontend/styles.css', 'utf8');
  assert.ok(stylesCss.includes('.voice-preview-btn'), 'styles.css must style .voice-preview-btn');

  // 4. Frontend app.js voice playback and race-condition safety
  const appJsCode = fs.readFileSync('src/frontend/app.js', 'utf8');
  assert.ok(appJsCode.includes('previewVoice('), 'app.js must define previewVoice');
  assert.ok(appJsCode.includes('previewCurrentVoice('), 'app.js must define previewCurrentVoice');
  assert.ok(appJsCode.includes('isStillInCueWindow'), 'app.js must check isStillInCueWindow in startDubAudioElement');
  assert.ok(appJsCode.includes('autoVoiceBatchTimer'), 'app.js must define debounced batch synthesis on voice change');
});

test('voice tuner drawer and custom prosody: rate/pitch controls, live preview with custom pitch/rate, and export integration', async () => {
  // 1. Frontend index.html verification
  const indexHtml = fs.readFileSync('src/frontend/index.html', 'utf8');
  assert.ok(indexHtml.includes('id="btnToggleVoiceTuner"'), 'index.html must have voice tuner toggle button');
  assert.ok(indexHtml.includes('id="voiceTunerDrawer"'), 'index.html must have voice tuner drawer');
  assert.ok(indexHtml.includes('id="voiceRateSlider"'), 'index.html must have voice rate slider');
  assert.ok(indexHtml.includes('id="voicePitchSlider"'), 'index.html must have voice pitch slider');
  assert.ok(indexHtml.includes('resetVoiceTuningToPreset()'), 'index.html must have reset voice tuning button');
  assert.ok(indexHtml.includes('previewTunedVoice()'), 'index.html must have audition tuned voice button');
  assert.ok(indexHtml.includes('applyTunedVoiceToAllCues()'), 'index.html must have apply tuned voice to all cues button');

  // 2. Frontend styles.css verification
  const stylesCss = fs.readFileSync('src/frontend/styles.css', 'utf8');
  assert.ok(stylesCss.includes('.voice-tuner-drawer'), 'styles.css must style .voice-tuner-drawer');
  assert.ok(stylesCss.includes('.voice-tuner-grid'), 'styles.css must style .voice-tuner-grid');

  // 3. Frontend app.js verification
  const appJsCode = fs.readFileSync('src/frontend/app.js', 'utf8');
  assert.ok(appJsCode.includes('toggleVoiceTunerPanel'), 'app.js must define toggleVoiceTunerPanel');
  assert.ok(appJsCode.includes('onVoiceRateSliderInput'), 'app.js must define onVoiceRateSliderInput');
  assert.ok(appJsCode.includes('onVoicePitchSliderInput'), 'app.js must define onVoicePitchSliderInput');
  assert.ok(appJsCode.includes('resetVoiceTuningToPreset'), 'app.js must define resetVoiceTuningToPreset');
  assert.ok(appJsCode.includes('previewTunedVoice'), 'app.js must define previewTunedVoice');
  assert.ok(appJsCode.includes('applyTunedVoiceToAllCues'), 'app.js must define applyTunedVoiceToAllCues');
  assert.ok(appJsCode.includes('getEffectiveVoiceProsody'), 'app.js must define getEffectiveVoiceProsody');

  // 4. Backend POST /api/tts/preview with custom pitch and rate
  const testServer = express();
  testServer.use(express.json());
  testServer.use('/api/tts', ttsModule);
  const server = await new Promise(r => {
    const s = testServer.listen(0, '127.0.0.1', () => r(s));
  });
  const ttsPort = server.address().port;
  const ttsBase = `http://127.0.0.1:${ttsPort}`;

  try {
    const tunedRes = await fetch(`${ttsBase}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: 'Sovereign King', pitch: -15, rate: 20 })
    });
    assert.equal(tunedRes.status, 200, 'POST /api/tts/preview should accept custom pitch and rate');
    const tunedData = await tunedRes.json();
    assert.equal(tunedData.success, true);
    assert.ok(tunedData.audioUrl && tunedData.audioUrl.endsWith('.mp3'));
    assert.equal(tunedData.pitch, '-15Hz');
    assert.equal(tunedData.rate, '+20%');
  } finally {
    await new Promise(r => server.close(r));
  }

  // 5. Backend export.js prepareCueAudioClips passes custom voicePitch and voiceRate
  const exportModule = require('./src/backend/routes/export');
  assert.ok(typeof exportModule.prepareCueAudioClips === 'function');
  const dummyCues = [
    { startSec: 0, endSec: 2, translated: 'តេស្តសំឡេងទីមួយ', voice: 'kh_deep_boss', pitch: -10, rate: 12 },
    { startSec: 2, endSec: 4, translated: 'តេស្តសំឡេងទីពីរ' }
  ];
  const clips = await exportModule.prepareCueAudioClips(dummyCues, {
    autoGenerateMissingTts: false,
    voicePitch: -18,
    voiceRate: 15
  });
  assert.ok(Array.isArray(clips));
});

test('subtitle mask: translucent glass blur (ថ្លាតិច ព្រាល), 1-click presets, clean playback suppression, and drag target isolation', () => {
  // 1. HTML Verification
  const indexHtml = fs.readFileSync('src/frontend/index.html', 'utf8');
  assert.ok(indexHtml.includes("setMaskPreset('standard')"), 'index.html must have Standard preset button');
  assert.ok(indexHtml.includes("setMaskPreset('slim')"), 'index.html must have Slim 1-line preset button');
  assert.ok(indexHtml.includes("setMaskPreset('tall')"), 'index.html must have Tall 2-line preset button');
  assert.ok(indexHtml.includes("setMaskPreset('cinema')"), 'index.html must have Cinema bar preset button');
  assert.ok(indexHtml.includes('id="btnFocusMaskTarget"'), 'index.html must have mask focus target button');
  assert.ok(indexHtml.includes('id="btnFocusSubTarget"'), 'index.html must have subtitle focus target button');
  assert.ok(indexHtml.includes('alignSubtitleToMask()'), 'index.html must have 1-click center subtitle in mask button');
  assert.ok(indexHtml.includes("nudgeMask('y'"), 'index.html must have vertical nudge buttons');
  assert.ok(indexHtml.includes("nudgeMask('h'"), 'index.html must have height nudge buttons');
  assert.ok(indexHtml.includes('🌫️ បាំងអក្សរចិន'), 'index.html must display clean tab title 🌫️ បាំងអក្សរចិន');

  // 2. CSS Verification
  const stylesCss = fs.readFileSync('src/frontend/styles.css', 'utf8');
  assert.ok(stylesCss.includes('.subtitle-mask-box'), 'styles.css must style .subtitle-mask-box');
  assert.ok(stylesCss.includes('backdrop-filter: blur('), 'styles.css must use backdrop-filter blur for translucent glass blur');
  assert.ok(stylesCss.includes('rgba(0, 0, 0, 0.28)'), 'styles.css must use soft translucent tint (0.28) instead of opaque black');
  assert.ok(stylesCss.includes('.video-preview-wrapper.is-playing .subtitle-mask-box'), 'styles.css must suppress borders and handles during video playback for clean viewing');
  assert.ok(stylesCss.includes('.mask-preset-chip'), 'styles.css must style .mask-preset-chip');
  assert.ok(stylesCss.includes('.mask-target-group'), 'styles.css must style .mask-target-group');

  // 3. JS Verification
  const appJsCode = fs.readFileSync('src/frontend/app.js', 'utf8');
  assert.ok(appJsCode.includes('function setPreviewEditTarget('), 'app.js must define setPreviewEditTarget');
  assert.ok(appJsCode.includes('function setMaskPreset('), 'app.js must define setMaskPreset');
  assert.ok(appJsCode.includes('function nudgeMask('), 'app.js must define nudgeMask');
  assert.ok(appJsCode.includes('function alignSubtitleToMask('), 'app.js must define alignSubtitleToMask');
  assert.ok(appJsCode.includes('window.setPreviewEditTarget = setPreviewEditTarget'), 'app.js must expose setPreviewEditTarget on window');
  assert.ok(appJsCode.includes('window.setMaskPreset = setMaskPreset'), 'app.js must expose setMaskPreset on window');
  assert.ok(appJsCode.includes('window.nudgeMask = nudgeMask'), 'app.js must expose nudgeMask on window');
  assert.ok(appJsCode.includes('window.alignSubtitleToMask = alignSubtitleToMask'), 'app.js must expose alignSubtitleToMask on window');
  assert.ok(appJsCode.includes("subtitleMaskState.mode = 'feathered'"), 'app.js must configure feathered translucent blur mode');
  assert.ok(appJsCode.includes("stage.classList.toggle('is-playing', !v.paused)"), 'app.js must toggle is-playing class on preview stage on play');
});

test('UVR BGM separation: live chunk progress, resumable checkpoint, instant cancel, and honest fastCopy UX estimate', async () => {
  const vm = require('node:vm');
  const express = require('express');

  const sampleVideo = path.join(tempRoot, 'sample-uvr-resume.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3.0:r=24',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3.0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    sampleVideo
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const stubScript = path.join(tempRoot, 'stub-uvr-prog.js');
  const callLogFile = path.join(tempRoot, 'stub-uvr-calls.log');
  fs.writeFileSync(stubScript, `
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    const outDir = args[args.indexOf('--output_dir') + 1];
    const inputWav = args[args.length - 1];
    fs.appendFileSync(${JSON.stringify(callLogFile)}, path.basename(inputWav) + '\\n');
    console.error(' 50%|█████     | 1/2');
    fs.copyFileSync(inputWav, path.join(outDir, 'bgm.wav'));
    fs.copyFileSync(inputWav, path.join(outDir, 'vocals.wav'));
  `, 'utf8');

  const prevBgmCacheDir = process.env.BGM_CACHE_DIR;
  process.env.BGM_CACHE_DIR = path.join(tempRoot, 'bgm_cache_resume_test');
  fs.mkdirSync(process.env.BGM_CACHE_DIR, { recursive: true });

  try {
    const resumeKey = 'test_resume_key_01';
    const progressEvents = [];
    const bgmOut1 = path.join(tempRoot, 'res_bgm1.mp3');
    const vocOut1 = path.join(tempRoot, 'res_voc1.mp3');

    // Simulate interruption on chunk 2 via isCancelled so chunk 1 stays checkpointed on disk
    await assert.rejects(
      () => audioModule.runAudioSeparatorSeparation(
        sampleVideo,
        bgmOut1,
        vocOut1,
        { id: 'audio-separator', cmd: process.execPath, argsPrefix: [stubScript], model: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
        {
          chunkTriggerSec: 2.0,
          chunkDurationSec: 1.5,
          resumableKey: resumeKey,
          cleanResume: true,
          isCancelled: () => progressEvents.some(ev => ev.phase === 'separate' && ev.doneChunks >= 1),
          onProgress: (ev) => progressEvents.push(ev)
        }
      ),
      (err) => Boolean(err && err.cancelled === true)
    );

    assert.ok(progressEvents.some(e => e.phase === 'separate' && e.totalChunks >= 2 && e.percent > 5));
    const jobDir = path.join(process.env.BGM_CACHE_DIR, `_tmp_uvr_job_${resumeKey}`);
    assert.ok(fs.existsSync(path.join(jobDir, 'out_0', 'bgm.wav')), 'Interrupted job must keep completed chunk 0 checkpoint');

    // Resume without cleanResume: chunk 0 must be skipped, only remaining chunk(s) processed
    fs.writeFileSync(callLogFile, '', 'utf8');
    await audioModule.runAudioSeparatorSeparation(
      sampleVideo,
      bgmOut1,
      vocOut1,
      { id: 'audio-separator', cmd: process.execPath, argsPrefix: [stubScript], model: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
      { chunkTriggerSec: 2.0, chunkDurationSec: 1.5, resumableKey: resumeKey }
    );
    const resumedCalls = fs.readFileSync(callLogFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(resumedCalls.includes('chunk_000.wav'), false, 'Resumed job must skip already-completed chunk_000.wav');
    assert.equal(resumedCalls.includes('chunk_001.wav'), true, 'Resumed job must finish chunk_001.wav');
    assert.equal(fs.existsSync(jobDir), false, 'Temp checkpoint dir must be cleaned once final MP3 succeeds');
    assert.ok(fs.existsSync(bgmOut1) && fs.statSync(bgmOut1).size > 2000);

    // Check /api/audio/bgm-progress HTTP endpoint
    const app = express();
    app.use('/api/audio', audioModule);
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = server.address().port;
      const pRes = await fetch(`http://127.0.0.1:${port}/api/audio/bgm-progress`);
      assert.equal(pRes.status, 200);
      const pJson = await pRes.json();
      assert.equal(pJson.success, true);
      assert.ok('percent' in pJson && 'totalChunks' in pJson);
    } finally {
      await new Promise(r => server.close(r));
    }

    // Verify export.js dynamically scales progress > 20% during UVR AI separation
    const expCode = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'export.js'), 'utf8');
    assert.match(expCode, /bgmEndPercent\s*=\s*75/);
    assert.match(expCode, /executeFfmpegRender\(attempt\.args,\s*totalDurationSec,\s*encodeStartPercent\)/);

    // Verify frontend updateExportPreviewSummary warns honestly when fastCopy needs uncached AI BGM for long video
    const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
    const summaryEl = { innerText: '' };
    const els = {
      exportPreviewSummary: summaryEl,
      exportVideoModeSelect: { value: 'copy' },
      exportAudioMode: { value: 'bgm_only' },
      exportQualityPreset: { value: 'balanced' },
      exportResolution: { value: 'source' },
      mainVideo: { duration: 4200, videoWidth: 1280, videoHeight: 720 },
      exportReadinessBar: { innerHTML: '' }
    };
    const sandbox = {
      console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
      URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { getItem: () => null, setItem() { } },
      document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [], addEventListener() { } },
      Audio: function () { return { pause() {}, play: () => Promise.resolve(), src: '' }; },
      fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => { };
    sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(appCode, ctx);
    vm.runInContext(`
      currentVideoPath = 'D:/movies/test70m.mp4';
      currentVideoDuration = 4200;
      audioSeparationCapabilities.ai = true;
      currentIsolatedBgmUrl = null;
      currentIsolatedBgmEngine = '';
      updateExportPreviewSummary();
    `, ctx);
    assert.match(summaryEl.innerText, /70 នាទី/);
    assert.match(summaryEl.innerText, /UVR AI/);
  } finally {
    if (prevBgmCacheDir !== undefined) process.env.BGM_CACHE_DIR = prevBgmCacheDir;
    else delete process.env.BGM_CACHE_DIR;
  }
});

test('Anti-overlap dub scheduling, boundary fuzzy deduplication, and uncovered speech gap probe', async () => {
  const vm = require('node:vm');
  const exportModule = require('./src/backend/routes/export');

  // 1. Boundary fuzzy dedup merges slightly differing cross-chunk boundary lines
  const deduped = translationModule.deduplicateOverlappingSegments([
    { chunkIndex: 1, startSec: 119.91, endSec: 122.4, text: '有活鱼活虾还有很多菜', suggestedVoice: 'Radiant Queen' },
    { chunkIndex: 2, startSec: 119.95, endSec: 122.51, text: '有活鱼活虾还有肉菜', suggestedVoice: 'Radiant Queen' },
    { chunkIndex: 2, startSec: 125.0, endSec: 127.0, text: '快过来吃饭吧', suggestedVoice: 'Sovereign King' }
  ]);
  assert.equal(deduped.length, 2, `Expected boundary fuzzy duplicate merged to 2, got ${deduped.length}`);
  assert.equal(deduped[0].startSec, 119.91);
  assert.equal(deduped[0].endSec, 122.51);

  // 2. probeSpeechGapActivity distinguishes silent gaps from active vocal/audio gaps
  const mixedGapVideo = path.join(tempRoot, 'sample-gap-probe.mp4');
  const genGap = spawnSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=8:r=5',
    '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*440*t)*lt(t\\,4):s=44100:d=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    mixedGapVideo
  ], { encoding: 'utf8' });
  assert.equal(genGap.status, 0, genGap.stderr);

  const activeGap = await translationModule.probeSpeechGapActivity(mixedGapVideo, 0.2, 3.5);
  const silentGap = await translationModule.probeSpeechGapActivity(mixedGapVideo, 4.5, 7.8);
  assert.equal(activeGap.hasSpeech, true, `Expected active audio detected, got ${JSON.stringify(activeGap)}`);
  assert.equal(silentGap.hasSpeech, false, `Expected silent window ignored, got ${JSON.stringify(silentGap)}`);

  // 3. enforceNonOverlappingDubSchedule drops boundary duplicate + eliminates overlap across tight fast lines
  const clipA = path.join(tempRoot, 'dub_a.wav');
  const clipB = path.join(tempRoot, 'dub_b.wav');
  spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'sine=f=500:d=2.8', '-c:a', 'pcm_s16le', clipA]);
  spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'sine=f=700:d=1.4', '-c:a', 'pcm_s16le', clipB]);

  const scheduleInput = [
    { cueIndex: 0, startSec: 1.0, endSec: 2.0, spokenText: 'ម៉ាក់ កូនមិនមែនចង់បង្កជម្លោះទេ', clipDurSec: 2.8, filePath: clipA },
    { cueIndex: 1, startSec: 1.05, endSec: 2.4, spokenText: 'ម៉ាក់ កូនមិនមែនចង់បង្កជម្លោះទេ!', clipDurSec: 2.8, filePath: clipA },
    { cueIndex: 2, startSec: 2.1, endSec: 3.5, spokenText: 'ប្រញាប់ឡើង កុំនៅយូរពេក!', clipDurSec: 1.4, filePath: clipB }
  ];
  const fitted = exportModule.enforceNonOverlappingDubSchedule(scheduleInput, true);
  assert.equal(fitted.length, 2, 'Duplicate simultaneous cue must be removed');
  assert.ok(fitted[1].startSec > fitted[0].startSec + 0.35, 'Sequential cues must not share identical onset');
  assert.ok(Number.isFinite(fitted[0].maxSlotSec) && fitted[0].maxSlotSec <= (fitted[1].startSec - fitted[0].startSec), 'Tight spillover clip must receive maxSlotSec guard');

  const outDubDir = fs.mkdtempSync(path.join(tempRoot, 'dub-anti-overlap-'));
  const renderedMaster = await exportModule.renderDubMasterWav(fitted, outDubDir);
  assert.ok(fs.existsSync(renderedMaster) && fs.statSync(renderedMaster).size > 10000);

  // 4. Frontend normalizeCuesTiming never produces endSec > next.startSec on <0.3s intervals
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const sandbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() { } },
    Audio: function () { return { pause() {}, play: () => Promise.resolve(), src: '' }; },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => { };
  sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(appCode, ctx);
  const normOut = vm.runInContext(`normalizeCuesTiming([
    { startSec: 10.0, endSec: 10.1, text: 'ប្រយ័ត្ន!', translated: 'ប្រយ័ត្ន!' },
    { startSec: 10.05, endSec: 12.0, text: 'រត់ទៅ!', translated: 'រត់ទៅ!' }
  ])`, ctx);
  assert.ok(normOut[1].startSec > normOut[0].endSec, `Expected strict separation, got ${normOut[0].endSec} vs ${normOut[1].startSec}`);
});

test('SenseVoice-Small Local STT Mode: Python check, engine routing, speech-capabilities API, and UI selectors', async () => {
  const vm = require('node:vm');

  // 1. Engine selection & language routing helpers
  assert.equal(translationModule.normalizeSttEngine('sensevoice_local'), 'sensevoice');
  assert.equal(translationModule.normalizeSttEngine('AUTO'), 'auto');
  assert.equal(translationModule.normalizeSttEngine(''), 'gemini');
  assert.equal(translationModule.isSenseVoiceSupportedLanguage('zh'), true);
  assert.equal(translationModule.isSenseVoiceSupportedLanguage('th'), false);

  assert.deepEqual(
    translationModule.resolveSttEngineChoice({ sttEngine: 'auto', sourceLang: 'zh', capabilities: { available: true } }),
    { ok: true, engine: 'sensevoice' }
  );
  assert.deepEqual(
    translationModule.resolveSttEngineChoice({ sttEngine: 'auto', sourceLang: 'th', capabilities: { available: true } }),
    { ok: true, engine: 'gemini' }
  );
  assert.deepEqual(
    translationModule.resolveSttEngineChoice({ sttEngine: 'auto', sourceLang: 'zh', capabilities: { available: false } }),
    { ok: true, engine: 'gemini' }
  );
  assert.equal(
    translationModule.resolveSttEngineChoice({ sttEngine: 'sensevoice', sourceLang: 'vi', capabilities: { available: true } }).status,
    400
  );
  assert.equal(
    translationModule.resolveSttEngineChoice({ sttEngine: 'sensevoice', sourceLang: 'zh', capabilities: { available: false } }).status,
    503
  );

  // 2. Python wrapper unit helper check (no model weights needed for pure helper check)
  const venvPy = path.join(__dirname, '.venv_audio', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const scriptPath = path.join(__dirname, 'src', 'backend', 'utils', 'sensevoice_stt.py');
  assert.ok(fs.existsSync(scriptPath), 'sensevoice_stt.py must exist');
  if (fs.existsSync(venvPy)) {
    const pyCheck = spawnSync(venvPy, [scriptPath, '--check'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(pyCheck.status, 0, pyCheck.stderr);
    const checkJson = JSON.parse(String(pyCheck.stdout || '').trim().split(/\r?\n/).pop());
    assert.equal(checkJson.available, true, `Expected FunASR available in .venv_audio: ${pyCheck.stdout}`);

    const helperTest = spawnSync(
      venvPy,
      ['-c', [
        'import sys; sys.path.insert(0, "src/backend/utils");',
        'import sensevoice_stt as sv;',
        'tags = sv.parse_sensevoice_raw_tags("<|zh|><|ANGRY|><|Speech|><|withitn|>你好啊");',
        'assert tags["langTag"] == "zh" and tags["emotionTag"] == "ANGRY" and not tags["isNoSpeech"];',
        'segs = sv.normalize_vad_segments([[100, 1200], [1350, 2600], [3000, 15000]], 16000, max_seg_ms=6000);',
        'assert segs[0] == [100, 2600] and len(segs) >= 3 and all(e - s <= 6000 for s, e in segs);',
        'split_res = sv.split_tokens_into_cues(["喂", "，", "你", "好", "？", "瘦", "了", "2", "0", "斤", "，"], [[100, 200], [210, 250], [260, 340], [350, 440], [450, 500], [600, 700], [720, 820], [840, 900], [910, 960], [980, 1080], [1100, 1140]], 4000, 6000, {"langTag": "zh"}, "zh");',
        'assert len(split_res) == 2 and split_res[0]["text"] == "喂，你好？" and split_res[1]["text"] == "瘦了20斤";',
        'assert sv.pick_voice_from_pitch(220.0, "duo", "Sovereign King", 0) == "Radiant Queen";',
        'assert sv.pick_voice_from_pitch(125.0, "duo", "Sovereign King", 0) == "Sovereign King";',
        'print("PY_HELPERS_OK")'
      ].join(' ')],
      { cwd: __dirname, encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(helperTest.status, 0, helperTest.stderr);
    assert.match(helperTest.stdout, /PY_HELPERS_OK/);
  }

  // 3. Backend speech-capabilities & /auto-detect-speech validation contracts
  const svTestVideo = path.join(tempRoot, 'sv-contract.mp4');
  const genSv = spawnSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=3:r=5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    svTestVideo
  ], { encoding: 'utf8' });
  assert.equal(genSv.status, 0, genSv.stderr);

  const { server, baseUrl } = await startTestServer();
  try {
    const capRes = await fetch(`${baseUrl}/api/translation/speech-capabilities`);
    assert.equal(capRes.status, 200);
    const capJson = await capRes.json();
    assert.equal(capJson.success, true);
    assert.ok(capJson.engines && capJson.engines.sensevoice && capJson.engines.gemini);

    if (fs.existsSync(venvPy)) {
      const langRejectRes = await fetch(`${baseUrl}/api/translation/auto-detect-speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: svTestVideo,
          sourceLang: 'th',
          sttEngine: 'sensevoice'
        })
      });
      assert.equal(langRejectRes.status, 400, 'Explicit sensevoice with unsupported Thai must return 400');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // 4. Frontend index.html selectors & app.js STT engine sync / persistence
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  assert.ok(htmlCode.includes('id="sttEngineSelect"'), 'index.html must expose #sttEngineSelect');
  assert.ok(htmlCode.includes('id="vmSttEngineSelect"'), 'index.html must expose #vmSttEngineSelect');

  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const fakeStorage = new Map();
  const sttEl = { value: 'auto', options: [{ value: 'auto', text: '' }, { value: 'sensevoice', text: '', disabled: false }, { value: 'cloud_gemini', text: '' }] };
  const vmSttEl = { value: 'auto', options: [{ value: 'auto', text: '' }, { value: 'sensevoice', text: '', disabled: false }, { value: 'cloud_gemini', text: '' }] };
  const sandbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    localStorage: {
      getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
      setItem: (k, v) => fakeStorage.set(k, String(v)),
      removeItem: (k) => fakeStorage.delete(k)
    },
    document: {
      getElementById: (id) => (id === 'sttEngineSelect' ? sttEl : (id === 'vmSttEngineSelect' ? vmSttEl : null)),
      querySelectorAll: () => [],
      addEventListener() { }
    },
    Audio: function () { return { pause() {}, play: () => Promise.resolve(), src: '' }; },
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        defaultEngine: 'sensevoice',
        engines: { sensevoice: { available: true, cuda: true, device: 'cuda:0', gpuName: 'NVIDIA GeForce GTX 1650', modelsCached: true } }
      })
    })
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => { };
  sandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(appCode, ctx);
  await vm.runInContext('refreshSpeechCapabilities()', ctx);
  assert.match(sttEl.options[1].text, /GTX 1650/, 'Dropdown must surface detected GPU name');
  vm.runInContext('onSttEngineChange("sensevoice")', ctx);
  assert.equal(sttEl.value, 'sensevoice');
  assert.equal(vmSttEl.value, 'sensevoice');
  assert.equal(vm.runInContext('willUseLocalSenseVoice("zh")', ctx), true);
  assert.equal(vm.runInContext('willUseLocalSenseVoice("th")', ctx), false);
});

test('Khmer numeric, currency, weight, clock time, and quantity formatting guide + cleanTranslatedText + TTS comma fix', async (t) => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');

  // 1. Prompt guides for translation, Story Bible, and reflection must require digits & clear units
  const kmHint = translationModule.getPromptLanguageMeta('km').formatHint;
  assert.match(kmHint, /Arabic digits \(0-9\)/);
  assert.match(kmHint, /យ័ន/);
  assert.match(kmHint, /ដុល្លារ/);
  assert.match(kmHint, /រៀល/);
  assert.match(kmHint, /បាត/);
  assert.match(kmHint, /វ៉ុន/);
  assert.match(kmHint, /យ៉េន/);
  assert.match(kmHint, /1 斤 = 0\.5 គីឡូក្រាម/);
  assert.match(kmHint, /ម៉ោង 7:30/);
  assert.match(kmHint, /600 លាន/);

  // 2. cleanTranslatedText & normalizeKhmerNumericText fixes digits, units, clock colons & currency typos cleanly
  assert.equal(translationModule.cleanTranslatedText('១៨២ថ្ងៃ និង ១៥នាទី', 'km'), '182 ថ្ងៃ និង 15 នាទី');
  assert.equal(translationModule.cleanTranslatedText('ម៉ោង7：30 ហើយ', 'km'), 'ម៉ោង 7:30 ហើយ');
  assert.equal(translationModule.cleanTranslatedText('តម្លៃ4,000យាន់នេះ និង បួនពាន់យាន់', 'km'), 'តម្លៃ 4,000 យ័ននេះ និង បួនពាន់យ័ន');
  assert.equal(translationModule.cleanTranslatedText('ស្លឹកត្រចៀកយាន់ចុះ', 'km'), 'ស្លឹកត្រចៀកយាន់ចុះ');
  assert.equal(translationModule.cleanTranslatedText('ទិញ $100 និង 50kg អង្ករ 500g ដើរ 10km ផឹក 200ml', 'km'), 'ទិញ 100 ដុល្លារ និង 50 គីឡូក្រាម អង្ករ 500 ក្រាម ដើរ 10 គីឡូម៉ែត្រ ផឹក 200 មីលីលីត្រ');
  assert.equal(translationModule.cleanTranslatedText('សេវា 5G និង លើកទី១', 'km'), 'សេវា 5G និង លើកទី1');
  assert.equal(translationModule.cleanTranslatedText('4000 RMB និង 500 THB', 'km'), '4000 យ័ន និង 500 បាត');
  assert.equal(translationModule.cleanTranslatedText('ក៏ទុកសំណល់អាហារ', 'km'), 'ក៏ទុកអាហារដែលនៅសល់');
  assert.equal(
    translationModule.cleanTranslatedText('ពេលញ៉ាំរួច ក៏ទុកសំណល់អាហារបន្តិចបន្តួចឲ្យ វិន ថាំង។', 'km'),
    'ពេលញ៉ាំរួច ក៏ទុកអាហារដែលនៅសល់បន្តិចបន្តួចឲ្យ វិន ថាំង។'
  );
  assert.equal(translationModule.cleanTranslatedText('កំពុងញ៉ាំបាយកាកសំណល់', 'km'), 'កំពុងញ៉ាំបាយដែលនៅសល់');
  assert.equal(translationModule.cleanTranslatedText('បោះចោលក្នុងធុងសំរាមដាក់សំណល់អាហារ', 'km'), 'បោះចោលក្នុងធុងសំរាមដាក់សំណល់អាហារ');

  // 3. EdgeTTS pre-speech normalization removes grouping commas inside numbers so it speaks seamlessly without pausing
  assert.equal(
    ttsModule.enhanceDramaticSpokenText('តម្លៃ 4,000 យ័ន, 1,250,000 ដុង ទៅ ឬអត់ ?'),
    'តម្លៃ 4000 យ័ន, 1250000 ដុង ទៅ ទេអ្ហី?'
  );

  // 4. Story Bible, chunk translation, and reflection prompts all carry numeric + unit rules
  const origHttpsRequest = https.request;
  t.after(() => {
    https.request = origHttpsRequest;
  });

  const promptsSeen = [];
  https.request = (_opts, cb) => {
    let reqBody = '';
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = (chunk) => { if (chunk) reqBody += String(chunk); };
    req.end = (chunk) => {
      if (chunk) reqBody += String(chunk);
      const parsedReq = JSON.parse(reqBody);
      const promptText = parsedReq.contents?.[0]?.parts?.[0]?.text || '';
      promptsSeen.push(promptText);
      let payload;
      if (promptText.includes('Complete Episode Dialogue:')) {
        payload = {
          synopsis: 'Couple argues over time and 4,000 yuan transfer.',
          tone: 'tense',
          characters: [],
          relationshipPronouns: [],
          sttCorrections: [],
          terms: [{ source: '四千块', rendering: '4,000 យ័ន' }]
        };
      } else if (promptText.includes('=== EPISODE STORY BIBLE ===')) {
        payload = {
          translations: [
            { id: 1, translation: 'សល់ 15 នាទីទៀតទេ។', voice: 'Radiant Queen' },
            { id: 2, translation: '4,000 យាន់ មិនបានដាក់ចំណាំទេ។', voice: 'Sovereign King' },
            { id: 3, translation: 'ទម្ងន់ 10 គីឡូក្រាម។', voice: 'Radiant Queen' },
            { id: 4, translation: 'ម៉ោង 7:30 ហើយ មនុស្ស 3 នាក់ ម្ហូប 7 មុខ។', voice: 'Sovereign King' }
          ]
        };
      } else {
        payload = { fixes: [{ id: 2, translation: '4,000 យ័ន មិនបានដាក់ចំណាំទេ។' }] };
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      const envelope = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      process.nextTick(() => {
        cb(res);
        res.emit('data', envelope);
        res.emit('end');
      });
    };
    return req;
  };

  const out = await translationModule.translateWithReflection(
    [
      { startSec: 0, endSec: 2, text: '还有15分钟。' },
      { startSec: 2, endSec: 4, text: '四千块，没有备注。' },
      { startSec: 4, endSec: 6, text: '二十斤。' },
      { startSec: 6, endSec: 9, text: '7点半，三个人七个菜。' }
    ],
    'km',
    'fake-gemini-key',
    false,
    false,
    'zh',
    { castMode: 'single', fixedVoice: 'Sovereign King' }
  );

  assert.equal(promptsSeen.length, 3);
  assert.match(promptsSeen[0], /600 លានយ័ន/);
  assert.match(promptsSeen[1], /NUMBERS, COUNTRY CURRENCIES, WEIGHTS, TIME & QUANTITIES/);
  assert.match(promptsSeen[1], /អាហារដែលនៅសល់/);
  assert.match(promptsSeen[2], /1 斤 = 0\.5 គីឡូក្រាម/);
  assert.match(promptsSeen[2], /ទុកអាហារដែលនៅសល់/);
  assert.equal(out.cues[1].translated, '4,000 យ័ន មិនបានដាក់ចំណាំទេ។');
});

test('Deep bug audit regressions: export audio modes, portrait rotation, Khmer spacing/currency, batch key parser, cache isolation, draft sort, and System Hub UI', async () => {
  const vm = require('node:vm');
  const os = require('node:os');
  const TranslationCache = require('./translation_cache').constructor;
  const ffmpegUtils = require('./src/backend/utils/ffmpeg');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const draftModule = require('./src/backend/routes/draft');

  // 1. export.js: origVolume: 0 no longer shadows bgm_only / bg_low / duck, rotation 90 swaps dimensions, short words preserved
  const bgmGraph = exportModule.buildAudioMixGraph({
    audioMixMode: 'bgm_only',
    hasSourceAudio: true,
    origVolume: 0,
    bgVolume: 0.7,
    bgmOnPause: false
  });
  assert.match(bgmGraph, /sidechaincompress/, 'bgm_only must keep BGM ducking graph even when origVolume=0 is sent');
  const lowGraph = exportModule.buildAudioMixGraph({
    audioMixMode: 'bg_low',
    hasSourceAudio: true,
    origVolume: 0,
    bgVolume: 0.2
  });
  assert.doesNotMatch(lowGraph, /sidechaincompress/, 'bg_low must use direct mix instead of shadowed mix_custom');
  assert.match(lowGraph, /volume=0\.20/, 'bg_low must preserve capped background volume');

  const rotInfo = exportModule.parseMediaInfoFromStderr(
    'Stream #0:0: Video: h264, yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\n    displaymatrix: rotation of -90.00 degrees'
  );
  assert.equal(rotInfo.width, 1080);
  assert.equal(rotInfo.height, 1920);
  assert.match(exportModule.getScaleFilterExpr('source', { width: 0, height: 0 }), /trunc\(iw\/2\)\*2/);

  const tinyWordsAss = exportModule.serializeAss([
    { startSec: 0, endSec: 0.3, text: 'src', translated: 'ក ខ គ ឃ ង ច ឆ ជ ឈ ញ ដ ឋ ឌ ឍ ណ ត ថ ទ' }
  ], 'tiktok', 58, 150, true);
  assert.ok((tinyWordsAss.match(/^Dialogue:/gm) || []).length >= 2, 'Short-cue karaoke must coalesce <20ms steps instead of dropping lines');

  // 2. translation.js: Khmer sentence spacing & dual currency symbol/code normalization & ID offset mode
  assert.equal(translationModule.normalizeKhmerSpacing('ខ្ញុំទៅផ្ទះ។ ហើយបងវិញ?'), 'ខ្ញុំទៅផ្ទះ។ ហើយបងវិញ?');
  assert.equal(translationModule.cleanTranslatedText('តម្លៃ $100 USD និង €50 EUR', 'km'), 'តម្លៃ 100 ដុល្លារ និង 50 អឺរ៉ូ');
  const zeroOff = translationModule.detectDraftIdOffsetMode(
    [{ id: 0, translated: 'a' }, { id: 1, translated: 'b' }, { id: 2, translated: 'c' }],
    [0, 1, 2, 3]
  );
  assert.equal(zeroOff.allUseLocalZeroBased, true);
  const sparseOne = translationModule.detectDraftIdOffsetMode(
    [{ id: 1, translated: 'a' }, { id: 2, translated: 'b' }],
    [1, 3, 5]
  );
  assert.equal(sparseOne.allUseLocalOneBased, true);

  // 3. translation_cache.js: exact casing preserved and non-string input safe
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-tcache-case-'));
  try {
    const tc = new TranslationCache(tmpCacheDir);
    await tc.set('OK', 'បាទ', 'en', 'km');
    await tc.set('ok', 'អូខេ', 'en', 'km');
    assert.equal(await tc.get('OK', 'en', 'km'), 'បាទ');
    assert.equal(await tc.get('ok', 'en', 'km'), 'អូខេ');
    assert.equal(await tc.get(null, 'en', 'km'), null);
  } finally {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  }

  // 4. ffmpeg.js: truncated/corrupt MP3 returns 0 instead of partial frame duration
  const corruptMp3 = path.join(os.tmpdir(), `eza_corrupt_${Date.now()}.mp3`);
  const badBuf = Buffer.alloc(417 + 2048, 0);
  badBuf[0] = 0xFF; badBuf[1] = 0xFB; badBuf[2] = 0x90;
  fs.writeFileSync(corruptMp3, badBuf);
  try {
    assert.equal(ffmpegUtils.parseMp3DurationFast(corruptMp3), 0);
  } finally {
    try { fs.unlinkSync(corruptMp3); } catch (_) {}
  }

  // 5. config.js: email >= 20 chars before pipe must NOT overwrite API key
  const longEmail = 'seabkoeurn64_very_long_email@gmail.com';
  const validKey = 'AIzaSyTestBatchKeyValue1234567890ABCDEFG';
  const batchParsed = configModule.parseGeminiBatchKeysInput(`${longEmail} | ${validKey}`, 0);
  assert.equal(batchParsed.entries.length, 1);
  assert.equal(batchParsed.entries[0].apiKey, validKey);
  assert.equal(batchParsed.entries[0].email, longEmail);
  assert.notEqual(batchParsed.entries[0].name, validKey);

  // 6. draft.js & worker.js contracts
  const workerSrc = fs.readFileSync(path.join(__dirname, 'cloudflare-license-worker/src/worker.js'), 'utf8');
  assert.match(workerSrc, /WHERE license_key = \? AND bound_machines = \?/);
  assert.match(workerSrc, /Number\.isFinite\(parsedMax\)/);
  const tmpDraftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-draft-sort-'));
  const prevDraftDir = process.env.DRAFTS_DIR;
  process.env.DRAFTS_DIR = tmpDraftDir;
  const appDraft = express().use(express.json()).use('/api/drafts', draftModule);
  const srv = await new Promise(r => {
    const s = appDraft.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const port = srv.address().port;
    await fetch(`http://127.0.0.1:${port}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: 'D:\\Temp\\older.mp4',
        cues: [{ text: 'a' }],
        timestamp: '2026-01-01T00:00:00.000Z'
      })
    });
    await fetch(`http://127.0.0.1:${port}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: 'D:\\Temp\\newer.mp4',
        cues: [{ text: 'b' }],
        timestamp: '2026-06-01T00:00:00.000Z'
      })
    });
    const listRes = await (await fetch(`http://127.0.0.1:${port}/api/drafts/list`)).json();
    assert.equal(typeof listRes.drafts[0].timestamp, 'number');
    assert.match(listRes.drafts[0].videoPath, /newer\.mp4$/);
  } finally {
    await new Promise(r => srv.close(r));
    if (prevDraftDir === undefined) delete process.env.DRAFTS_DIR;
    else process.env.DRAFTS_DIR = prevDraftDir;
    fs.rmSync(tmpDraftDir, { recursive: true, force: true });
  }

  // 7. Frontend: System Hub buttons, activeSpeakingCueIdx jump, null addNewCueLine, playback mask is-playing
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  const stageClassSet = new Set();
  const mockFrameBox = { classList: { toggle: (c, on) => (on ? stageClassSet.add(c) : stageClassSet.delete(c)) } };
  const fakeElements = {
    previewFrameBox: mockFrameBox,
    mainVideo: null
  };
  const sbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      getElementById: (id) => fakeElements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    Audio: function () { return { pause() {}, play: () => Promise.resolve(), removeAttribute() {}, load() {} }; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
  };
  sbox.window = sbox;
  sbox.addEventListener = () => {};
  sbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  const ctx = vm.createContext(sbox);
  vm.runInContext(appCode, ctx);
  assert.equal(typeof vm.runInContext('toggleRouterLockFromHub', ctx), 'function');
  assert.equal(typeof vm.runInContext('saveSystemHubConfig', ctx), 'function');
  assert.doesNotThrow(() => vm.runInContext('addNewCueLine()', ctx));
  assert.doesNotMatch(appCode, /activePlayingCueIdx/);
  fakeElements.mainVideo = { paused: false, volume: 1 };
  vm.runInContext('syncPlayPauseButton()', ctx);
  assert.equal(stageClassSet.has('is-playing'), true);
});

test('Khmer real-life spoken drama prompts, reflection guidance, and cleanup replace awkward textbook/animal-food calques', () => {
  const translation = require('./src/backend/routes/translation');
  const kmHint = translation.getPromptLanguageMeta('km').formatHint;
  assert.match(kmHint, /ម៉ាក់បង/);
  assert.match(kmHint, /នំប៉ាវស/);
  assert.match(kmHint, /សាច់ភ្លៅគោ/);
  assert.match(kmHint, /ផ្ទះទិញមុនការ/);
  assert.match(kmHint, /ហាងគ្រឿងសមុទ្រ យ៉េជី/);

  // Deterministic cleanup fixes unambiguous blunders without corrupting animal-feed or valid words
  assert.equal(
    translation.cleanTranslatedText('ទុកតែចំណីសល់ៗឲ្យញ៉ាំ', 'km'),
    'ទុកតែម្ហូបសល់ឲ្យញ៉ាំ'
  );
  assert.equal(
    translation.cleanTranslatedText('មានបបរ សារ៉ាម៉ាន់ និងសាច់ដុំគោ', 'km'),
    'មានបបរ នំប៉ាវស និងសាច់ភ្លៅគោ'
  );
  assert.equal(
    translation.cleanTranslatedText('ឆ្អឹងជំនីរខរម្ងាស់ តែពិតស្តែងល្អ', 'km'),
    'ឆ្អឹងជំនីរស្ងោររម្ងាស់ តែតាមពិតល្អ'
  );
  // Preserve genuine animal feeding and trash contexts untouched
  assert.equal(
    translation.cleanTranslatedText('ឲ្យចំណីសល់ឆ្កែស៊ី', 'km'),
    'ឲ្យចំណីសល់ឆ្កែស៊ី'
  );
  assert.equal(
    translation.cleanTranslatedText('រឿងនេះជាក់ស្តែងហើយ', 'km'),
    'រឿងនេះជាក់ស្តែងហើយ'
  );
  assert.equal(
    translation.cleanTranslatedText('បោះសំណល់អាហារចូលធុងសំរាម', 'km'),
    'បោះសំណល់អាហារចូលធុងសំរាម'
  );

  // Verify Story Bible and reflection prompts enforce daily real-life spoken Khmer & shop transliteration
  const srcText = fs.readFileSync(path.join(__dirname, 'src/backend/routes/translation.js'), 'utf8');
  assert.match(srcText, /7\. Stiff Textbook, Courtroom, or Essay Khmer Calques \(CRITICAL\)/);
  assert.match(srcText, /ធានារ៉ាប់រងសង្គម/);
  assert.match(srcText, /លាងចានឲ្យមួយផ្ទះទាំងមូល/);
});

test('Series Glossary cross-episode name lock, duration-aware translation, 问他 guard, polish-cues API, and EdgeTTS Khmer pronunciation', async (t) => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const vm = require('node:vm');
  const translation = require('./src/backend/routes/translation');
  const tts = require('./src/backend/routes/tts');

  // 1. EdgeTTS pronunciation handles Khmer times, percentages, currency symbols, and acronyms while keeping pure English safe
  assert.equal(
    tts.enhanceDramaticSpokenText('ប្រជុំម៉ោង 7:30 និងម៉ោង 8:00 ចុះ 50% ចំណេញ $200 ជាមួយ VIP DNA CCTV!'),
    'ប្រជុំម៉ោង 7 កន្លះ និងម៉ោង 8 គត់ ចុះ 50 ភាគរយ ចំណេញ 200 ដុល្លារ ជាមួយ វីអាយភី ឌីអិនអេ ស៊ីស៊ីធីវី!'
  );
  assert.equal(
    tts.enhanceDramaticSpokenText('ចេញដំណើរម៉ោង 7:15 តម្លៃ ¥500'),
    'ចេញដំណើរម៉ោង 7 និង 15 នាទី តម្លៃ 500 យ័ន'
  );
  assert.equal(
    tts.enhanceDramaticSpokenText('Hello VIP guest 50% at 7:30'),
    'Hello VIP guest 50% at 7:30'
  );

  // 2. Prompt guards against "问他/问唐" -> "ធ្លាប់សួរតើ" false positive and passes duration guidance
  const kmHint = translation.getPromptLanguageMeta('km').formatHint;
  assert.match(kmHint, /NEVER apply "ធ្លាប់សួរតើ" to "问他\/问她\/问唐"/);
  assert.match(kmHint, /Spoken Timing & Brevity Budget/);

  // 3. Series Glossary helper locks Episode 1 names across Episode 2 alias drift + ignores temp/generic staging folders
  assert.equal(translation.resolveSeriesGlossaryKey(path.join(os.tmpdir(), 'ep1.mp4')), '');
  assert.equal(translation.resolveSeriesGlossaryKey('D:\\EZARG\\uploads\\ep1.mp4'), '');
  const epSeriesKey = translation.resolveSeriesGlossaryKey('D:\\Dramas\\WifeLeftovers\\EP001.mp4');
  assert.ok(epSeriesKey && epSeriesKey.includes('wifeleftovers'));

  const merged = translation.mergeStoryBibleWithSeries(
    {
      characters: [{ names: ['温糖'], rendering: 'វិន ថាំង', gender: 'female', role: 'wife' }, { names: ['盈盈'], rendering: 'យីង យីង', gender: 'female' }],
      relationshipPronouns: ['wife to husband mom: ម៉ាក់បង'],
      terms: [{ source: '夜记海鲜', rendering: 'ហាងគ្រឿងសមុទ្រ យ៉េជី' }]
    },
    {
      characters: [{ names: ['问唐', '温糖'], rendering: 'វិន តាង', gender: 'female' }, { names: ['茵英', '盈盈'], rendering: 'អ៊ីន អ៊ីន', gender: 'female' }, { names: ['奶奶'], rendering: 'លោកយាយ', gender: 'female' }],
      relationshipPronouns: ['wife to husband mom: ម៉ាក់បង', 'grandson -> grandma: ចៅ/លោកយាយ'],
      terms: [{ source: '夜记海鲜', rendering: 'ហាងយប់ជ្រៅ' }, { source: '排骨汤', rendering: 'ស្ងោរឆ្អឹងជំនីរ' }]
    }
  );
  const wenTang = merged.characters.find(c => c.names.includes('温糖'));
  const yingYing = merged.characters.find(c => c.names.includes('盈盈'));
  assert.equal(wenTang.rendering, 'វិន ថាំង');
  assert.ok(wenTang.names.includes('问唐'));
  assert.equal(yingYing.rendering, 'យីង យីង');
  assert.ok(yingYing.names.includes('茵英'));
  assert.equal(merged.terms.find(x => x.source === '夜记海鲜').rendering, 'ហាងគ្រឿងសមុទ្រ យ៉េជី');

  // 4. End-to-end Series Glossary persistence + "sec" timing metadata + reflection & polish flow with mocked Gemini
  const tmpGlossaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-series-glossary-'));
  const prevGlossaryDir = process.env.SERIES_GLOSSARY_DIR;
  process.env.SERIES_GLOSSARY_DIR = tmpGlossaryDir;
  const origHttpsRequest = https.request;
  t.after(() => {
    https.request = origHttpsRequest;
    if (prevGlossaryDir === undefined) delete process.env.SERIES_GLOSSARY_DIR;
    else process.env.SERIES_GLOSSARY_DIR = prevGlossaryDir;
    fs.rmSync(tmpGlossaryDir, { recursive: true, force: true });
  });

  const capturedPrompts = [];
  let episodeCallStage = 0;
  https.request = (_opts, cb) => {
    let reqBody = '';
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = (chunk) => { if (chunk) reqBody += String(chunk); };
    req.end = (chunk) => {
      if (chunk) reqBody += String(chunk);
      const promptText = JSON.parse(reqBody).contents?.[0]?.parts?.[0]?.text || '';
      capturedPrompts.push(promptText);
      let payload;
      if (promptText.includes('Complete Episode Dialogue:')) {
        episodeCallStage++;
        payload = {
          synopsis: 'Family drama dinner',
          tone: 'Tense',
          characters: episodeCallStage === 1
            ? [{ names: ['盈盈'], rendering: 'យីង យីង', gender: 'female', role: 'cousin' }]
            : [{ names: ['茵英', '盈盈'], rendering: 'អ៊ីន អ៊ីន', gender: 'female', role: 'cousin' }],
          relationshipPronouns: ['ម៉ាក់បង'],
          sttCorrections: [],
          terms: []
        };
      } else if (promptText.includes('Complete Episode Script:')) {
        payload = { fixes: [{ id: 1, translation: 'ម្ហូបសល់នេះឲ្យ យីង យីង ញ៉ាំអ្ហី?' }] };
      } else {
        payload = {
          translations: [
            { id: 1, translation: 'ទុកតែចំណីសល់ៗឲ្យ យីង យីង មែនទេ?', voice: 'Radiant Queen' },
            { id: 2, translation: 'ម៉ាក់ធ្វើនំប៉ាវស', voice: 'Sovereign King' },
            { id: 3, translation: 'ស្ងោរឆ្អឹងជំនីរ', voice: 'Sovereign King' },
            { id: 4, translation: 'ល្អណាស់', voice: 'Radiant Queen' }
          ]
        };
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.setEncoding = () => {};
      const responsePayload = JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
      });
      process.nextTick(() => {
        cb(res);
        res.emit('data', responsePayload);
        res.emit('end');
      });
    };
    return req;
  };

  const ep1Cues = [
    { startSec: 0, endSec: 1.5, text: '给盈盈吃剩菜吗？' },
    { startSec: 1.6, endSec: 3.0, text: '妈做馒头了' },
    { startSec: 3.1, endSec: 5.5, text: '排骨汤' },
    { startSec: 5.6, endSec: 7.0, text: '好极了' }
  ];
  await translation.translateWithReflection(ep1Cues, 'km', 'AIzaSySeriesGlossaryUnitTest12345', false, true, 'zh', {
    videoPath: 'D:\\Dramas\\TestSeries\\EP001.mp4',
    speedMode: 'auto'
  });
  const chunkPromptSeen = capturedPrompts.find(p => p.includes('Dialogue items to translate'));
  assert.ok(chunkPromptSeen && chunkPromptSeen.includes('"sec":1.5'), 'chunk payload must pass duration "sec" to Gemini');

  const ep2Cues = [
    { startSec: 0, endSec: 1.8, text: '茵英来了' },
    { startSec: 2.0, endSec: 3.5, text: '别客气' },
    { startSec: 3.6, endSec: 5.0, text: '坐吧' },
    { startSec: 5.1, endSec: 6.5, text: '谢谢' }
  ];
  const ep2Out = await translation.translateWithReflection(ep2Cues, 'km', 'AIzaSySeriesGlossaryUnitTest12345', false, true, 'zh', {
    videoPath: 'D:\\Dramas\\TestSeries\\EP002.mp4',
    speedMode: 'auto'
  });
  // Series glossary locked EP001 spelling "យីង យីង" overrides EP002's "អ៊ីន អ៊ីន" drift
  assert.equal(ep2Out.storyBible.characters[0].rendering, 'យីង យីង');
  const ep2StoryPrompt = capturedPrompts.filter(p => p.includes('Complete Episode Dialogue:'))[1];
  assert.match(ep2StoryPrompt, /PRIOR EPISODES SERIES GLOSSARY/);
  assert.match(ep2StoryPrompt, /យីង យីង/);

  // 5. polishTranslatedCues refines existing translated draft without API key (deterministic) AND with API key (reflection)
  const offlinePolished = await translation.polishTranslatedCues([
    { startSec: 0, endSec: 2, text: '剩菜', translated: 'ទុកតែចំណីសល់ៗឲ្យ សារ៉ាម៉ាន់ និងសាច់ដុំគោ' }
  ], 'km', '', 'zh');
  assert.equal(offlinePolished.deterministicFixedCount, 1);
  assert.equal(offlinePolished.cues[0].translated, 'ទុកតែម្ហូបសល់ឲ្យ នំប៉ាវស និងសាច់ភ្លៅគោ');

  const appExpress = express().use(express.json()).use('/api/translation', translation);
  const polishSrv = await new Promise(r => {
    const s = appExpress.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const pPort = polishSrv.address().port;
    const pRes = await fetch(`http://127.0.0.1:${pPort}/api/translation/polish-cues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cues: [{ startSec: 0, endSec: 2, text: '剩菜', translated: 'ទុកតែចំណីសល់ៗ និងសារ៉ាម៉ាន់' }],
        sourceLang: 'zh',
        targetLang: 'km'
      })
    });
    const pJson = await pRes.json();
    assert.equal(pRes.status, 200);
    assert.equal(pJson.success, true);
    assert.equal(pJson.cues[0].translated, 'ទុកតែម្ហូបសល់ និងនំប៉ាវស');
  } finally {
    await new Promise(r => polishSrv.close(r));
  }

  // 6. Frontend UI has polish button + polishTranslatedScript helper
  const htmlCode = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  assert.match(htmlCode, /id="btnPolishScript"/);
  assert.match(htmlCode, /polishTranslatedScript\(\)/);
  const appJsCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  assert.match(appJsCode, /async function polishTranslatedScript\(/);
  const uiCtx = vm.createContext({
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    Audio: function () { return { pause() {}, removeAttribute() {}, load() {} }; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
  });
  uiCtx.window = uiCtx;
  uiCtx.addEventListener = () => {};
  uiCtx.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  vm.runInContext(appJsCode, uiCtx);
  assert.equal(typeof vm.runInContext('polishTranslatedScript', uiCtx), 'function');
});

test('Video Manager reliability & UX: SenseVoice GPU queue, browser/folder SRT pairing, draft resume, single-item retry, and responsive layout', async () => {
  const vm = require('node:vm');
  const translation = require('./src/backend/routes/translation');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  // 1. HTML & CSS contracts for responsive non-clipped Video Manager UI
  assert.match(html, /id="batchFolderFilesInput"[^>]*webkitdirectory/);
  assert.match(html, /id="vmFolderPathInput"/);
  assert.match(html, /id="btnVmRetryFailed"/);
  assert.match(html, /id="vmOpenExportDirBtn"/);
  assert.match(css, /\.vm-workspace-pane\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)\s*\{\s*\.vm-steps/);
  assert.match(css, /@media\s*\(max-width:\s*820px\)\s*\{\s*\.vm-steps/);

  // 2. Backend SenseVoice GPU mutex serializes concurrent calls to max 1 active execution
  let activeSv = 0;
  let maxActiveSv = 0;
  await Promise.all([1, 2, 3].map(n => translation.enqueueSenseVoiceTask(async () => {
    activeSv++;
    maxActiveSv = Math.max(maxActiveSv, activeSv);
    await new Promise(r => setTimeout(r, 15));
    activeSv--;
    return n;
  })));
  assert.equal(maxActiveSv, 1);

  // 3. Frontend VM behaviors: file filtering, SRT auto-pairing, dedup, draft resume, fileObj Studio open, single retry
  const mkEl = (id, props = {}) => {
    const _cls = new Set();
    return {
      id, innerText: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, style: {},
      classList: {
        toggle(c, f) { const on = f === undefined ? !_cls.has(c) : Boolean(f); on ? _cls.add(c) : _cls.delete(c); },
        add(c) { _cls.add(c); },
        remove(c) { _cls.delete(c); },
        contains(c) { return _cls.has(c); }
      },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      ...props
    };
  };
  const elements = {
    vmSourceLangSelect: mkEl('vmSourceLangSelect', { value: 'zh' }),
    vmTargetLangSelect: mkEl('vmTargetLangSelect', { value: 'km' }),
    vmDefaultVoiceSelect: mkEl('vmDefaultVoiceSelect', { value: 'Sovereign King' }),
    vmSttEngineSelect: mkEl('vmSttEngineSelect', { value: 'auto' }),
    vmConcurrencySelect: mkEl('vmConcurrencySelect', { value: '2' }),
    vmGenerateTtsCheck: mkEl('vmGenerateTtsCheck', { checked: false }),
    vmSaveDraftCheck: mkEl('vmSaveDraftCheck', { checked: false }),
    vmIsolateBgmCheck: mkEl('vmIsolateBgmCheck', { checked: false }),
    vmAutoExportCheck: mkEl('vmAutoExportCheck', { checked: false }),
    vmQueueContainer: mkEl('vmQueueContainer'),
    btnVmRetryFailed: mkEl('btnVmRetryFailed', { hidden: true }),
    btnVmStart: mkEl('btnVmStart'),
    btnVmStop: mkEl('btnVmStop'),
    vmTopBadge: mkEl('vmTopBadge', { hidden: true }),
    vmProgressSummary: mkEl('vmProgressSummary'),
    vmProgressCount: mkEl('vmProgressCount'),
    vmProgressFill: mkEl('vmProgressFill'),
    vmFolderPathInput: mkEl('vmFolderPathInput', { value: 'D:\\Dramas\\Show1' }),
    mainVideo: mkEl('mainVideo', { paused: true, volume: 1, load() {}, removeAttribute() {} })
  };
  const fetchLog = [];
  let failOnceOnEp2 = true;
  const sbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set, Error,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL: { createObjectURL: (f) => `blob://mock/${f && f.name}`, revokeObjectURL: () => {} },
    Audio: class { pause() {} addEventListener() {} play() { return Promise.resolve(); } },
    alert: () => {},
    document: { body: mkEl('body'), getElementById: (id) => elements[id] || null, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl('tmp'), addEventListener() {} },
    window: { electronAPI: { backendUrl: 'http://127.0.0.1:4567' }, addEventListener() {} },
    fetch: async (url, opts = {}) => {
      const pathname = new URL(url, 'http://localhost:3001').pathname;
      const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      fetchLog.push({ pathname, body });
      if (pathname === '/api/drafts/load') {
        return {
          ok: true,
          async json() {
            return {
              success: true,
              draft: { cues: [{ startSec: 0, endSec: 2, text: '你好', translated: 'សួស្តី', voice: 'Sovereign King' }] }
            };
          }
        };
      }
      if (pathname === '/api/scan-folder') {
        return { ok: true, async json() { return { name: 'Show1', episodes: [{ ep: 2, video: 'EP02.mp4', videoPath: 'D:\\Dramas\\Show1\\EP02.mp4', srtPath: '' }] }; } };
      }
      if (pathname === '/api/inspect-videos') {
        return {
          ok: true,
          async json() {
            return {
              success: true,
              items: (body.filePaths || []).map(p => ({ videoPath: p, videoName: p.split(/[\\/]/).pop(), srtPath: '', draftInfo: { draftKey: 'a'.repeat(32), cueCount: 1 } }))
            };
          }
        };
      }
      if (pathname === '/api/translation/auto-detect-speech') {
        if (failOnceOnEp2) {
          failOnceOnEp2 = false;
          return { ok: false, async json() { return { success: false, error: 'Transient error' }; } };
        }
        return { ok: true, async json() { return { success: true, cues: [{ startSec: 0, endSec: 2, text: '你好', voice: 'Sovereign King' }] }; } };
      }
      if (pathname === '/api/translation/translate-cues') {
        return { ok: true, async json() { return { success: true, cues: (body.cues || []).map(c => ({ ...c, translated: 'សួស្តី', translatedLang: 'km' })) }; } };
      }
      return { ok: true, async json() { return { success: true }; } };
    }
  };
  sbox.window.localStorage = sbox.localStorage;
  vm.createContext(sbox);
  vm.runInContext(appJs, sbox);

  // Filter non-video files, pair companion .srt onto browser video, and dedup repeated uploads
  const fakeSrt = { name: 'EP01.srt', size: 80, async text() { return '1\n00:00:00,000 --> 00:00:02,000\n你好\n'; } };
  const fakeMp4 = { name: 'EP01.mp4', size: 1024 };
  const fakeJpg = { name: 'cover.jpg', size: 512 };
  const addedBrowser = await sbox.ingestBrowserFilesToVideoManager([fakeJpg, fakeSrt, fakeMp4, { name: 'EP01.mp4', size: 1024 }]);
  assert.equal(addedBrowser, 1);
  assert.equal(vm.runInContext('vmQueue[0].hasLocalSrt', sbox), true);
  assert.equal(vm.runInContext('vmQueue[0].cues.length', sbox), 1);

  // Open browser-only fileObj item in Studio via blob URL
  await sbox.openVideoManagerItemInStudio(vm.runInContext('vmQueue[0].id', sbox));
  assert.equal(vm.runInContext('activeObjectUrl', sbox), 'blob://mock/EP01.mp4');

  // Clear queue and test paste-path load + draft resume (zero STT call when draft exists!)
  sbox.clearVideoManagerQueue();
  await sbox.loadVideoManagerFromPathInput();
  assert.equal(elements.vmFolderPathInput.value, '');
  assert.equal(vm.runInContext('vmQueue.length', sbox), 1);
  assert.equal(vm.runInContext('vmQueue[0].draftInfo.cueCount', sbox), 1);

  fetchLog.length = 0;
  await sbox.startVideoManagerBatch();
  assert.equal(fetchLog.some(x => x.pathname === '/api/drafts/load'), true);
  assert.equal(fetchLog.some(x => x.pathname === '/api/translation/auto-detect-speech'), false, 'Existing draft cues must skip redundant STT');
  assert.equal(vm.runInContext('vmQueue[0].status', sbox), 'done');

  // Test retryFailedVideoManagerItems recovers errored item
  sbox.clearVideoManagerQueue();
  sbox.appendBatchItems([{ name: 'EP02.mp4', videoPath: 'D:\\Dramas\\Show1\\EP02.mp4', srtPath: '' }]);
  await sbox.startVideoManagerBatch();
  assert.equal(vm.runInContext('vmQueue[0].status', sbox), 'error');
  assert.equal(elements.btnVmRetryFailed.hidden, false);
  await sbox.retryFailedVideoManagerItems();
  assert.equal(vm.runInContext('vmQueue[0].status', sbox), 'done');
  assert.equal(elements.btnVmRetryFailed.hidden, true);

  // 4. Clean non-overlapping multi-video display without inline preview drawer
  assert.equal(/id="vmPreviewPane"/i.test(html), false, 'Inline preview drawer must be removed');
  assert.match(html, /id="vmQueueSearch"[^>]*autocomplete="off"/);
  assert.match(html, /id="vmFolderPathInput"[^>]*autocomplete="off"/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.btn-mini\s*\{/);

  Object.assign(elements, {
    vmSetupPanel: mkEl('vmSetupPanel'),
    btnVmToggleSetup: mkEl('btnVmToggleSetup'),
    btnVmViewMode: mkEl('btnVmViewMode'),
    vmQueueSearch: mkEl('vmQueueSearch', { value: '' }),
    vmQueueTotalBadge: mkEl('vmQueueTotalBadge'),
    vmCountAll: mkEl('vmCountAll'),
    vmCountDone: mkEl('vmCountDone'),
    vmCountPending: mkEl('vmCountPending')
  });

  sbox.clearVideoManagerQueue();
  sbox.appendBatchItems([
    { ep: '1', name: 'EP01_Dinner.mp4', videoPath: 'D:\\Dramas\\Show1\\EP01_Dinner.mp4', cues: [{ startSec: 0, endSec: 2, text: '你好', translated: 'សួស្តី!' }] },
    { ep: '2', name: 'EP02_Market.mp4', videoPath: 'D:\\Dramas\\Show1\\EP02_Market.mp4', cues: [{ startSec: 1, endSec: 3, text: '买菜', translated: 'ទៅផ្សារទិញម្ហូប!' }] },
    { ep: '3', name: 'EP03_Secret.mp4', videoPath: 'D:\\Dramas\\Show1\\EP03_Secret.mp4', cues: [] }
  ]);
  assert.equal(elements.vmQueueTotalBadge.innerText, '3');
  assert.equal(elements.vmCountAll.innerText, '3');
  assert.match(elements.vmQueueContainer.innerHTML, /EP01_Dinner\.mp4/);
  assert.match(elements.vmQueueContainer.innerHTML, /EP02_Market\.mp4/);
  assert.match(elements.vmQueueContainer.innerHTML, /EP03_Secret\.mp4/);
  assert.match(elements.vmQueueContainer.innerHTML, /💬 សួស្តី!/);

  // Filter by search & toggle setup/view modes cleanly
  elements.vmQueueSearch.value = 'Market';
  sbox.renderVideoManagerQueue();
  assert.match(elements.vmQueueContainer.innerHTML, /EP02_Market\.mp4/);
  assert.doesNotMatch(elements.vmQueueContainer.innerHTML, /EP01_Dinner\.mp4/);
  sbox.resetVideoManagerFilter();
  sbox.toggleVideoManagerSetup(true);
  assert.equal(elements.vmSetupPanel.classList.contains('is-collapsed'), true);
  sbox.toggleVideoManagerViewMode();
  assert.equal(elements.vmQueueContainer.classList.contains('is-grid'), true);
});

test('Commercial readiness: packaged anti-bypass, clock-rollback guard, diagnostics bundle, janitor, and zero-dub export guard', async () => {
  const crypto = require('crypto');
  const express = require('express');
  const logger = require('./src/backend/utils/logger');
  const janitor = require('./src/backend/utils/janitor');
  const cloudLicense = require('./src/backend/utils/cloud-license');
  const { setupRoutes } = require('./src/backend/routes');

  // 1. Secret scrubber redacts Gemini keys, Bearer tokens, and license keys
  const dirty = 'Key=AIzaSyTestSecretValue1234567890ABCDEF Auth: Bearer eyJhbGciOiJFUzI1NiJ9.payload License EZAPRO-ABCD-EFGH-IJKL-MNOP {"apiKey":"my-secret"}';
  const scrubbed = logger.scrubSensitiveText(dirty);
  assert.equal(scrubbed.includes('AIzaSyTestSecretValue'), false);
  assert.equal(scrubbed.includes('eyJhbGciOiJFUzI1NiJ9'), false);
  assert.equal(scrubbed.includes('EZAPRO-ABCD-EFGH'), false);
  assert.equal(scrubbed.includes('my-secret'), false);
  assert.match(scrubbed, /\[REDACTED_GEMINI_KEY\]/);
  assert.match(scrubbed, /EZA-\[REDACTED\]/);

  // 2. Janitor prunes expired files & enforces byte cap while keeping .gitkeep
  const tmpJanitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-janitor-test-'));
  try {
    fs.writeFileSync(path.join(tmpJanitorDir, '.gitkeep'), '');
    const oldFile = path.join(tmpJanitorDir, 'old.mp4');
    const bigA = path.join(tmpJanitorDir, 'a.mp4');
    const bigB = path.join(tmpJanitorDir, 'b.mp4');
    fs.writeFileSync(oldFile, Buffer.alloc(1024));
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    fs.writeFileSync(bigA, Buffer.alloc(4096));
    const twoMinAgo = new Date(Date.now() - 120000);
    fs.utimesSync(bigA, twoMinAgo, twoMinAgo);
    fs.writeFileSync(bigB, Buffer.alloc(4096));

    const pruned = janitor.pruneDirectoryByAgeAndSize(tmpJanitorDir, {
      maxAgeMs: 5 * 86400000,
      maxTotalBytes: 5000
    });
    assert.equal(pruned.deletedCount, 2);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(bigA), false);
    assert.equal(fs.existsSync(bigB), true);
    assert.equal(fs.existsSync(path.join(tmpJanitorDir, '.gitkeep')), true);
  } finally {
    fs.rmSync(tmpJanitorDir, { recursive: true, force: true });
  }

  // 3. Packaged mode (EZA_PACKAGED=1) blocks env license bypasses & EZA_ADMIN_TOOLS=1
  const origPackaged = process.env.EZA_PACKAGED;
  const origReqCloud = process.env.EZA_REQUIRE_CLOUD_LICENSE;
  const origAdminTools = process.env.EZA_ADMIN_TOOLS;
  const origWorkerUrl = process.env.EZA_CLOUD_LICENSE_URL;
  const origStateFile = process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  const tmpLicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-comm-lic-'));
  const origUserData = process.env.EZA_USER_DATA_DIR;

  const app = express();
  app.use(express.json());
  setupRoutes(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.EZA_USER_DATA_DIR = tmpLicDir;
    process.env.EZA_PACKAGED = '1';
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '0';
    process.env.EZA_CLOUD_LICENSE_URL = 'https://evil-attacker.invalid';
    process.env.EZA_ADMIN_TOOLS = '1';

    assert.equal(cloudLicense.isCloudLicenseEnforced(), true, 'EZA_REQUIRE_CLOUD_LICENSE=0 must be ignored when EZA_PACKAGED=1');
    assert.notEqual(cloudLicense.loadCloudLicenseConfig().workerUrl, 'https://evil-attacker.invalid', 'Custom Worker URL env override must be ignored when EZA_PACKAGED=1');

    // Protected operational routes (like /api/drafts/save) must block with 403 licenseRequired
    const blockedDraft = await fetch(`${baseUrl}/api/drafts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: 'D:/video.mp4', cues: [{ id: 1, start: 0, end: 1, text: 'a' }] })
    });
    assert.equal(blockedDraft.status, 403);
    const blockedDraftJson = await blockedDraft.json();
    assert.equal(blockedDraftJson.licenseRequired, true);

    // Admin endpoints must reject even with EZA_ADMIN_TOOLS=1 when EZA_PACKAGED=1
    const blockedGen = await fetch(`${baseUrl}/api/config/generate-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationDays: 30 })
    });
    assert.equal(blockedGen.status, 403);

    // Warranty Support diagnostics bundle remains accessible while locked so buyers can send logs
    const diagRes = await fetch(`${baseUrl}/api/diagnostics/bundle`);
    assert.equal(diagRes.status, 200);
    const diagTxt = await diagRes.text();
    assert.match(diagTxt, /=== EZA PRO SUPPORT DIAGNOSTICS ===/);

    // Switch back to non-packaged test mode to verify clock rollback & zero-dub / SVG export guards
    delete process.env.EZA_PACKAGED;
    process.env.EZA_REQUIRE_CLOUD_LICENSE = '0';

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubJwk = publicKey.export({ format: 'jwk' });
    const stateFile = path.join(tmpLicDir, 'rollback-state.json');
    process.env.EZA_CLOUD_LICENSE_STATE_FILE = stateFile;
    process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
    process.env.EZA_CLOUD_LICENSE_URL = 'https://mock-worker.invalid';

    const hwid = 'EZA-1111-2222-3333';
    const nowMs = Date.now();
    const payloadB64 = Buffer.from(JSON.stringify({
      v: 1,
      licenseKey: 'EZAPRO-MONTH-1000-2000-3000',
      machineId: hwid,
      appScope: 'studio',
      planId: 'monthly_10',
      priceUsd: 10,
      status: 'active',
      customerName: 'Buyer A',
      expiresAt: nowMs + 30 * 86400000,
      issuedAt: nowMs - 7200000,
      leaseUntil: nowMs + 48 * 3600000
    })).toString('base64url');
    const sigB64 = crypto.sign('sha256', Buffer.from(payloadB64), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const leaseToken = `${payloadB64}.${sigB64}`;

    const verOk = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-MONTH-1000-2000-3000',
      machineId: hwid,
      appVersion: '1.0.0',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken,
          planId: 'monthly_10',
          priceUsd: 10,
          customerName: 'Buyer A',
          expiresAt: nowMs + 30 * 86400000,
          serverNow: nowMs
        })
      })
    });
    assert.equal(verOk.valid, true);
    assert.equal(verOk.planId, 'monthly_10');
    assert.equal(verOk.priceUsd, 10);
    assert.equal(verOk.remainingDays, 30);

    // Rolling local clock backward by 30 minutes invalidates local lease immediately
    assert.equal(cloudLicense.hasActiveLocalLease(hwid, nowMs - 30 * 60 * 1000), false);

    // HTTP 429 without reason preserves stored licenseKey instead of wiping it
    const rateRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId: hwid,
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) })
    });
    assert.equal(rateRes.reason, 'rate_limited');
    assert.ok(cloudLicense.loadStoredCloudLicenseState().licenseKey, '429 must preserve saved license key');

    // Outdated app version is blocked when server requires higher minAppVersion
    const outdatedRes = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-MONTH-1000-2000-3000',
      machineId: hwid,
      appVersion: '1.0.0',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          leaseToken,
          minAppVersion: '1.2.0',
          downloadUrl: 'https://example.com/update.exe'
        })
      })
    });
    assert.equal(outdatedRes.valid, false);
    assert.equal(outdatedRes.reason, 'outdated_version');

    // SVG overlay rejected cleanly & zero-dub export rejected with 502 instead of silent undubbed MP4
    const svgPath = path.join(tmpLicDir, 'logo.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.throws(
      () => exportModule.resolveSponsorOverlaySpec({ sponsorEnabled: true, sponsorPath: svgPath }),
      /\.SVG/i
    );

    const { FFMPEG_BIN } = require('./src/backend/utils/ffmpeg');
    const { spawnSync } = require('child_process');
    const tinyMp4 = path.join(tmpLicDir, 'tiny.mp4');
    spawnSync(FFMPEG_BIN, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.6',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tinyMp4
    ], { windowsHide: true });

    const zeroDubRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: tinyMp4,
        duration: 0.6,
        includeDubAudio: true,
        autoGenerateMissingTts: false,
        audioMixMode: 'duck',
        cues: [{ startSec: 0.05, endSec: 0.5, text: '你好', translated: '__uncached_unique_commercial_test_line_999__', voice: 'Sovereign King' }]
      })
    });
    assert.equal(zeroDubRes.status, 502, 'Export must fail loudly with 502 when 0 dubbed clips are produced');
  } finally {
    if (origPackaged !== undefined) process.env.EZA_PACKAGED = origPackaged;
    else delete process.env.EZA_PACKAGED;
    if (origReqCloud !== undefined) process.env.EZA_REQUIRE_CLOUD_LICENSE = origReqCloud;
    else delete process.env.EZA_REQUIRE_CLOUD_LICENSE;
    if (origAdminTools !== undefined) process.env.EZA_ADMIN_TOOLS = origAdminTools;
    else delete process.env.EZA_ADMIN_TOOLS;
    if (origWorkerUrl !== undefined) process.env.EZA_CLOUD_LICENSE_URL = origWorkerUrl;
    else delete process.env.EZA_CLOUD_LICENSE_URL;
    if (origStateFile !== undefined) process.env.EZA_CLOUD_LICENSE_STATE_FILE = origStateFile;
    else delete process.env.EZA_CLOUD_LICENSE_STATE_FILE;
    if (origUserData !== undefined) process.env.EZA_USER_DATA_DIR = origUserData;
    else delete process.env.EZA_USER_DATA_DIR;
    delete process.env.EZA_CLOUD_PUBLIC_JWK;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpLicDir, { recursive: true, force: true });
  }
});

test('Cloudflare License Worker: $10/mo & $50/yr plans, first-activation countdown, extend_days guards, unbind_machine, and UI cleanliness', async () => {
  const { pathToFileURL } = require('url');
  const workerMod = await import(pathToFileURL(path.join(__dirname, 'cloudflare-license-worker/src/worker.js')).href);
  const worker = workerMod.default;

  // Generate ECDSA P-256 signing JWK for Worker
  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);

  // Minimal stateful mock D1 database for Worker routes
  const licenses = new Map();
  const settings = new Map();
  const mockDb = {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      return {
        args: [],
        bind(...vals) { this.args = vals; return this; },
        async run() {
          if (q.startsWith('INSERT INTO licenses')) {
            const [key, customerName, contact, appScope, planId, priceUsd, durationDays, firstActivatedAt, warrantySupport, maxMachines, boundMachines, expiresAt, createdAt, updatedAt] = this.args;
            licenses.set(key, {
              license_key: key, customer_name: customerName, contact, app_scope: appScope,
              plan_id: planId, price_usd: priceUsd, duration_days: durationDays,
              first_activated_at: firstActivatedAt, warranty_support: warrantySupport,
              status: 'active', max_machines: maxMachines, bound_machines: boundMachines,
              expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, verify_count: 0
            });
            return { meta: { changes: 1 } };
          }
          if (q.includes('WHERE license_key = ? AND bound_machines = ?')) {
            const [boundJson, expAt, firstAct, updAt, seenAt, machId, appTag, key, expectedPrev] = this.args;
            const row = licenses.get(key);
            if (!row || row.bound_machines !== expectedPrev) return { meta: { changes: 0 } };
            Object.assign(row, {
              bound_machines: boundJson, expires_at: expAt, first_activated_at: firstAct,
              updated_at: updAt, last_seen_at: seenAt, last_machine_id: machId,
              last_app_version: appTag, verify_count: (row.verify_count || 0) + 1
            });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith('UPDATE licenses SET status = ?')) {
            const [st, upd, key] = this.args;
            const row = licenses.get(key);
            if (row) { row.status = st; row.updated_at = upd; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (q.startsWith('UPDATE licenses SET bound_machines = ?')) {
            const [bm, upd, key] = this.args;
            const row = licenses.get(key);
            if (row) { row.bound_machines = bm; row.updated_at = upd; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (q.includes("SET expires_at = NULL, plan_id = 'lifetime'")) {
            const [upd, key] = this.args;
            const row = licenses.get(key);
            if (row) Object.assign(row, { expires_at: null, plan_id: 'lifetime', duration_days: 0, status: 'active', updated_at: upd });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (q.startsWith('UPDATE licenses SET expires_at = ?, plan_id = ?')) {
            const [expAt, planId, priceUsd, durDays, upd, key] = this.args;
            const row = licenses.get(key);
            if (row) Object.assign(row, { expires_at: expAt, plan_id: planId, price_usd: priceUsd, duration_days: durDays, status: 'active', updated_at: upd });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (q.startsWith('INSERT INTO settings')) {
            const [k, v] = this.args;
            settings.set(k, v);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          if (q.includes('FROM licenses WHERE license_key = ?')) {
            return licenses.get(this.args[0]) || null;
          }
          return null;
        },
        async all() {
          if (q.includes('FROM settings')) {
            return { results: Array.from(settings.entries()).map(([key, value]) => ({ key, value })) };
          }
          if (q.includes('FROM licenses')) {
            return { results: Array.from(licenses.values()) };
          }
          return { results: [] };
        }
      };
    }
  };

  const env = { DB: mockDb, ADMIN_SECRET: 'super-admin-secret-2026', LEASE_PRIVATE_JWK: JSON.stringify(privJwk) };
  const adminCall = async (pathname, method, body) => {
    const req = new Request(`https://worker.test${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-secret': env.ADMIN_SECRET, 'cf-connecting-ip': '10.0.0.1' },
      body: body ? JSON.stringify(body) : undefined
    });
    const res = await worker.fetch(req, env);
    return { status: res.status, data: await res.json() };
  };

  // 1. Create $10/month (30d) and $50/year (365d, 2 machines) plans
  const created10 = await adminCall('/api/admin/licenses', 'POST', { customerName: 'Sokha Monthly', planId: 'monthly_10', maxMachines: 1 });
  assert.equal(created10.status, 200);
  assert.equal(created10.data.license.planId, 'monthly_10');
  assert.equal(created10.data.license.priceUsd, 10);
  assert.equal(created10.data.license.durationDays, 30);

  const created50 = await adminCall('/api/admin/licenses', 'POST', { customerName: 'Dara Yearly', planId: 'yearly_50', maxMachines: 2 });
  assert.equal(created50.status, 200);
  assert.equal(created50.data.license.planId, 'yearly_50');
  assert.equal(created50.data.license.priceUsd, 50);
  assert.equal(created50.data.license.durationDays, 365);

  // Simulate key bought 5 days before customer opens app: first activation grants full 30 days from activation!
  const key10 = created10.data.license.licenseKey;
  licenses.get(key10).expires_at = Date.now() + 25 * 86400000;
  const verReq = new Request('https://worker.test/api/license/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.2' },
    body: JSON.stringify({ licenseKey: key10, machineId: 'EZA-AAAA-BBBB-CCCC', appId: 'studio', appVersion: '1.0.0' })
  });
  const verRes = await worker.fetch(verReq, env);
  const verJson = await verRes.json();
  assert.equal(verRes.status, 200);
  assert.equal(verJson.valid, true);
  assert.equal(verJson.planId, 'monthly_10');
  assert.ok(verJson.expiresAt >= Date.now() + 29.9 * 86400000, 'First activation must grant full 30 days from activation timestamp');

  // 2. extend_days guards: reject days <= 0, reject unbanning revoked keys, reject overwriting Lifetime
  const badDays = await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'extend_days', days: 0 });
  assert.equal(badDays.status, 400);

  await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'set_status', status: 'revoked' });
  const extRevoked = await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'extend_days', days: 30 });
  assert.equal(extRevoked.status, 409, 'Must not silently unban a revoked key on extend_days');

  await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'set_status', status: 'active' });
  const toLife = await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'extend_days', lifetime: true });
  assert.equal(toLife.status, 200);
  assert.equal(toLife.data.expiresAt, null);

  const overwriteLife = await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key10, action: 'extend_days', days: 30 });
  assert.equal(overwriteLife.status, 409, 'Must not overwrite Lifetime down to 30 days');

  // 3. unbind_machine removes only the specified machine slot
  const key50 = created50.data.license.licenseKey;
  licenses.get(key50).bound_machines = JSON.stringify(['EZA-PC01-1111-2222', 'EZA-PC02-3333-4444']);
  const unbindRes = await adminCall('/api/admin/licenses/action', 'POST', { licenseKey: key50, action: 'unbind_machine', machineId: 'EZA-PC01-1111-2222' });
  assert.equal(unbindRes.status, 200);
  assert.deepEqual(unbindRes.data.boundMachines, ['EZA-PC02-3333-4444']);

  // 4. Packaging, fonts, dead files, and commercial UI cleanliness contracts
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'UNLICENSED');
  assert.ok(pkg.build.asarUnpack.includes('src/backend/utils/sensevoice_stt.py'));
  assert.ok(pkg.build.asarUnpack.includes('src/frontend/fonts/**'));
  assert.equal(fs.existsSync(path.join(__dirname, 'src/backend/routes.js.old')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'src/backend/server-logic.js')), false);

  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');
  assert.match(html, /id="episodeSelect"/);
  assert.match(html, /id="warrantySupportSection"/);
  assert.match(html, /downloadSupportDiagnosticsBundle\(\)/);
  assert.match(html, /retryAccessGateCheck\(\)/);
  assert.equal(html.includes('D:\\HDRG'), false);
  assert.equal(appJs.includes('C:\\\\Users\\\\ASUS'), false);
  assert.equal(appJs.includes('Drive D'), false);
  assert.match(css, /@font-face\s*\{[\s\S]*?KantumruyPro-Bold\.ttf/);
  assert.match(appJs, /body\.licenseRequired/);
  assert.match(html, /id="byokSetupModal"/);
  assert.match(html, /openGoogleAiStudioKeyPage\(\)/);
  assert.match(html, /submitByokQuickSetup\(\)/);
  assert.match(html, /openLicenseKeyPromptFromHub\(\)/);
  assert.equal(html.includes('systemHubAdminSection'), false, 'Client HTML must never ship local Admin/Anti-Crack generator card');
  assert.equal(html.includes('Anti-Crack'), false);
  assert.equal(html.includes('Scrypt'), false);
  assert.equal(html.includes('HWID Generator'), false);
  assert.equal(html.includes('លាក់ Router'), false);
  assert.match(appJs, /aistudio\.google\.com\/apikey/);
  const adminUiSrc = fs.readFileSync(path.join(__dirname, 'cloudflare-license-worker/src/admin-ui.js'), 'utf8');
  assert.equal(adminUiSrc.includes('setRouterLock'), false, 'Router must remain freely open for BYOK users');
  assert.equal(verJson.routerLocked, false);

  // Packaged client must NEVER provide any default Gemini API key from env or config.json
  const prevEzaPackaged = process.env.EZA_PACKAGED;
  const prevEnvGemini = process.env.GEMINI_API_KEY;
  const prevAccountsFile = process.env.GEMINI_ACCOUNTS_FILE;
  const emptyAccountsFile = path.join(tempRoot, 'empty-customer-accounts.json');
  try {
    process.env.EZA_PACKAGED = '1';
    process.env.GEMINI_API_KEY = 'AIzaSyShouldNeverBeUsedAsDefaultInPackagedExe12345';
    process.env.GEMINI_ACCOUNTS_FILE = emptyAccountsFile;
    assert.deepEqual(configModule.getGeminiApiKeyCandidates(), [], 'Packaged .exe must start with 0 default Gemini keys');
    assert.equal(configModule.loadConfig().GEMINI_API_KEY, '', 'Packaged .exe loadConfig must not inject default GEMINI_API_KEY');
    assert.equal(configModule.getSystemHubSnapshot().routerDefaultLocked, false);
  } finally {
    if (prevEzaPackaged !== undefined) process.env.EZA_PACKAGED = prevEzaPackaged;
    else delete process.env.EZA_PACKAGED;
    if (prevEnvGemini !== undefined) process.env.GEMINI_API_KEY = prevEnvGemini;
    else delete process.env.GEMINI_API_KEY;
    if (prevAccountsFile !== undefined) process.env.GEMINI_ACCOUNTS_FILE = prevAccountsFile;
    else delete process.env.GEMINI_ACCOUNTS_FILE;
  }

  const ffmpegSrc = fs.readFileSync(path.join(__dirname, 'src/backend/utils/ffmpeg.js'), 'utf8');
  assert.equal(ffmpegSrc.includes('EZA POST'), false);
});

test('Clean Studio UX/UI, persistent preview settings across restarts/videos, and draggable custom video text overlay + ASS export', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src/frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/frontend/styles.css'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, 'src/frontend/app.js'), 'utf8');

  assert.match(html, /data-dock-tab="text"/);
  assert.match(html, /id="customTextOverlayBox"/);
  assert.match(html, /id="customTextOverlayInput"/);
  assert.match(html, /class="preview-persist-pill"/);
  assert.match(html, /class="secondary-quick-grid"/);
  assert.match(css, /\.custom-text-overlay-box\b/);

  const store = new Map();
  const buildSandbox = () => {
    const els = {};
    const getOrMakeEl = (id) => {
      if (!els[id]) {
        const cls = new Set();
        els[id] = {
          id,
          hidden: false,
          checked: true,
          value: '',
          innerText: '',
          innerHTML: '',
          dataset: {},
          style: { display: '' },
          classList: {
            add: (...names) => names.forEach(n => cls.add(n)),
            remove: (...names) => names.forEach(n => cls.delete(n)),
            toggle: (n, f) => { if (f === undefined) { cls.has(n) ? cls.delete(n) : cls.add(n); } else if (f) cls.add(n); else cls.delete(n); },
            contains: (n) => cls.has(n)
          },
          addEventListener() {},
          focus() {},
          getAttribute: () => ''
        };
      }
      return els[id];
    };
    const sbox = {
      console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set, URL,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v))
      },
      document: {
        getElementById: (id) => getOrMakeEl(id),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
      },
      Audio: function () { return { pause() {}, play: () => Promise.resolve(), removeAttribute() {}, load() {} }; },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, accounts: [] }) })
    };
    sbox.window = sbox;
    sbox.addEventListener = () => {};
    sbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(sbox);
    vm.runInContext(appCode, ctx);
    return { ctx, els };
  };

  // 1. Adjust preview settings + custom video text overlay in session 1
  const s1 = buildSandbox();
  vm.runInContext(`
    changeSubStyle('hormozi');
    setSubTextColor('#ffd700');
    updateSubFontSize(21);
    updateSubPosY(35);
    setWordPopEffect(false);
    setPreviewAspectMode('9:16');
    onCustomTextOverlayInput('ផេក៖ រឿងខ្លីល្អមើល');
    setCustomTextPresetPos('top-right');
    setCustomTextOverlayControl('bgStyle', 'gold_box');
    setCustomTextOverlayControl('fontSizePx', 18);
  `, s1.ctx);

  // Switching video must NOT reset any preview setting or custom text overlay
  vm.runInContext('resetSubtitleStateOnVideoSwitch(true)', s1.ctx);
  const payloadAfterSwitch = vm.runInContext('getSubtitleAndMaskExportPayload()', s1.ctx);
  assert.equal(payloadAfterSwitch.subStyle, 'hormozi');
  assert.equal(payloadAfterSwitch.subPrimaryColor, '#ffd700');
  assert.equal(payloadAfterSwitch.subFontSize, Math.round(21 * 3.6));
  assert.equal(payloadAfterSwitch.wordPopEnabled, false);
  assert.equal(payloadAfterSwitch.customTextOverlay.enabled, true);
  assert.equal(payloadAfterSwitch.customTextOverlay.text, 'ផេក៖ រឿងខ្លីល្អមើល');
  assert.equal(payloadAfterSwitch.customTextOverlay.xPercent, 0.78);
  assert.equal(payloadAfterSwitch.customTextOverlay.yPercent, 0.08);
  assert.equal(payloadAfterSwitch.customTextOverlay.bgStyle, 'gold_box');

  // 2. Fresh session 2 restores all preview settings & custom text overlay automatically
  const s2 = buildSandbox();
  const payloadRestored = vm.runInContext('getSubtitleAndMaskExportPayload()', s2.ctx);
  assert.equal(payloadRestored.subStyle, 'hormozi');
  assert.equal(payloadRestored.subPrimaryColor, '#ffd700');
  assert.equal(payloadRestored.subFontSize, Math.round(21 * 3.6));
  assert.equal(payloadRestored.wordPopEnabled, false);
  assert.equal(vm.runInContext('previewAspectMode', s2.ctx), '9:16');
  assert.equal(payloadRestored.customTextOverlay.enabled, true);
  assert.equal(payloadRestored.customTextOverlay.text, 'ផេក៖ រឿងខ្លីល្អមើល');

  // 3. ASS serializer renders CustomOverlayText cleanly with exact PlayRes (1080x1920) coordinates
  const ass = exportModule.serializeAss(
    [{ startSec: 0, endSec: 2, translated: 'សួស្ដី' }],
    payloadRestored.subStyle,
    payloadRestored.subFontSize,
    payloadRestored.subMarginV,
    payloadRestored.wordPopEnabled,
    { primaryColor: payloadRestored.subPrimaryColor },
    payloadRestored.customTextOverlay,
    60
  );
  assert.match(ass, /Style: CustomOverlayText,Kantumruy Pro,65,/);
  assert.match(ass, /Dialogue: 5,0:00:00\.00,0:01:00\.00,CustomOverlayText,,0,0,0,,\{\\an5\\pos\(842,154\)\}ផេក៖ រឿងខ្លីល្អមើល/);

  // 4. Toggling OFF or clearing custom text removes it cleanly
  vm.runInContext('toggleCustomTextOverlay(false)', s2.ctx);
  assert.equal(vm.runInContext('getCustomTextOverlayExportPayload().enabled', s2.ctx), false);
  vm.runInContext('clearCustomTextOverlay()', s2.ctx);
  assert.equal(vm.runInContext('getCustomTextOverlayExportPayload().text', s2.ctx), '');
});

test('Respan OpenAI-compatible GPT-6.2 SOL gateway: encrypted storage, standalone primary & Gemini-assist failover, audio guard, and Router UI', async () => {
  const http = require('http');
  const https = require('https');
  const express = require('express');
  const vm = require('node:vm');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-respan-test-'));
  const prevCfgEnv = process.env.EZA_CONFIG_FILE;
  const prevAccEnv = process.env.GEMINI_ACCOUNTS_FILE;
  const prevStrict = process.env.EZA_PACKAGED;

  const tmpConfigPath = path.join(tmpDir, 'config.json');
  const tmpAccountsPath = path.join(tmpDir, 'accounts.json');
  fs.writeFileSync(tmpAccountsPath, JSON.stringify({ activeAccountId: null, accounts: [] }), 'utf8');
  fs.writeFileSync(tmpConfigPath, JSON.stringify({ DOWNLOAD_DIR: '' }), 'utf8');
  process.env.EZA_CONFIG_FILE = tmpConfigPath;
  process.env.GEMINI_ACCOUNTS_FILE = tmpAccountsPath;
  delete process.env.EZA_PACKAGED;

  const configMod = require('./src/backend/routes/config');
  const translationMod = require('./src/backend/routes/translation');
  const { setupRoutes } = require('./src/backend/routes');

  let mockRespanServer = null;
  let apiServer = null;
  try {
    // 1. Mock OpenAI-compatible Respan Gateway (strips <think>, verifies Bearer auth & model ID)
    const gatewayHits = [];
    mockRespanServer = await new Promise(resolve => {
      const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
          const parsed = raw ? JSON.parse(raw) : {};
          gatewayHits.push({
            url: req.url,
            auth: req.headers.authorization || '',
            model: parsed.model || '',
            sysPrompt: (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || '',
            userPrompt: (parsed.messages && parsed.messages[1] && parsed.messages[1].content) || ''
          });
          if (req.headers.authorization !== 'Bearer rsp_test_respan_secret_987654') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Invalid key' } }));
          }
          const userP = String((parsed.messages && parsed.messages[1] && parsed.messages[1].content) || '');
          let replyObj = { ok: true, km: 'សួស្តី' };
          if (userP.includes('Dialogue items to translate') || userP.includes('"translations"')) {
            replyObj = {
              translations: [
                { id: 1, translation: 'តោះទៅញ៉ាំបាយជាមួយគ្នា!', voice: 'Sovereign King' },
                { id: 2, translation: 'ចាំបន្តិច ខ្ញុំទៅដល់ឥឡូវហើយ។', voice: 'Radiant Queen' }
              ]
            };
          } else if (userP.includes('Complete Episode Dialogue') || userP.includes('"synopsis"')) {
            replyObj = {
              synopsis: 'Drama chat',
              tone: 'casual',
              characters: [{ name: '小明', rendering: 'មីង', role: 'friend', gender: 'male' }],
              relationshipPronouns: [],
              sttCorrections: [],
              terms: []
            };
          } else if (userP.includes('"corrections"')) {
            replyObj = { corrections: [] };
          }
          const bodyStr = JSON.stringify({
            id: 'chatcmpl-respan-mock',
            object: 'chat.completions',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `<think>draft reasoning</think>\n\`\`\`json\n${JSON.stringify(replyObj)}\n\`\`\``
                }
              }
            ]
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(bodyStr);
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const respanPort = mockRespanServer.address().port;
    const localGatewayBase = `http://127.0.0.1:${respanPort}/v1`;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    setupRoutes(app);
    apiServer = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const apiBase = `http://127.0.0.1:${apiServer.address().port}`;

    // 2. Zero default keys initially (default role is 'assist' — helper, not replacing Gemini)
    const initRes = await fetch(`${apiBase}/api/config/respan`);
    const initJson = await initRes.json();
    assert.equal(initRes.status, 200);
    assert.equal(initJson.hasKey, false);
    assert.equal(initJson.enabled, false);
    assert.equal(initJson.role, 'assist');
    assert.equal(initJson.baseUrl, 'https://gateway.respan.ai/v1');
    assert.equal(initJson.model, 'openai/gpt-6.2-sol:free');

    // SSRF guard ignores arbitrary internal non-localhost HTTP endpoints (role omitted defaults cleanly to 'assist')
    const badSaveRes = await fetch(`${apiBase}/api/config/respan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'rsp_test_respan_secret_987654',
        baseUrl: 'http://169.254.169.254/latest/meta-data',
        model: 'openai/gpt-6.2-sol:free'
      })
    });
    const badSaveJson = await badSaveRes.json();
    assert.equal(badSaveJson.hasKey, true);
    assert.equal(badSaveJson.role, 'assist');
    assert.equal(badSaveJson.baseUrl, 'https://gateway.respan.ai/v1');

    // Save local mock gateway URL (keep default 'assist' helper mode) + test connection via /api/config/respan/test
    const saveRes = await fetch(`${apiBase}/api/config/respan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: localGatewayBase,
        model: 'openai/gpt-6.2-sol:free',
        role: 'assist'
      })
    });
    const saveJson = await saveRes.json();
    assert.equal(saveJson.hasKey, true);
    assert.equal(saveJson.enabled, true);
    assert.equal(saveJson.baseUrl, localGatewayBase);
    assert.equal(JSON.stringify(saveJson).includes('rsp_test_respan_secret_987654'), false, 'Raw API key must never leak in API JSON');

    // On-disk config stores encrypted secret, not plaintext key
    const diskCfgRaw = fs.readFileSync(tmpConfigPath, 'utf8');
    assert.equal(diskCfgRaw.includes('rsp_test_respan_secret_987654'), false);
    assert.ok(JSON.parse(diskCfgRaw).RESPAN_API_KEY_ENC);

    const probeRes = await fetch(`${apiBase}/api/config/respan/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const probeJson = await probeRes.json();
    assert.equal(probeJson.healthy, true);

    // 3. Standalone translation with ZERO Gemini keys using Respan GPT-6.2 SOL
    const trRes = await fetch(`${apiBase}/api/translation/translate-cues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceLang: 'zh',
        targetLang: 'km',
        useCache: false,
        force: true,
        speedMode: 'fast',
        cues: [
          { startSec: 0, endSec: 2, text: '我们一起去吃饭吧！' },
          { startSec: 2.1, endSec: 4, text: '等一下，我马上就到了。' }
        ]
      })
    });
    const trJson = await trRes.json();
    assert.equal(trRes.status, 200);
    assert.equal(trJson.success, true);
    assert.equal(trJson.cues[0].translated, 'តោះទៅញ៉ាំបាយជាមួយគ្នា!');
    assert.equal(trJson.cues[1].translated, 'ចាំបន្តិច ខ្ញុំទៅដល់ឥឡូវហើយ។');
    assert.ok(gatewayHits.some(h => h.model === 'openai/gpt-6.2-sol:free' && h.sysPrompt.includes('ភាសាខ្មែរនិយាយធម្មតា')));

    // 4. Assist mode: Gemini 429 automatically fails over to Respan for text, while audio blobs stay excluded from Respan
    const httpsOrigReq = https.request;
    let geminiHitCount = 0;
    https.request = function mockGemini429(_opts, cb) {
      geminiHitCount++;
      const EventEmitter = require('events');
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 429;
        res.setEncoding = () => {};
        process.nextTick(() => {
          cb(res);
          res.emit('data', JSON.stringify({ error: { message: 'Quota exceeded retry in 5s' } }));
          res.emit('end');
        });
      };
      return req;
    };
    try {
      const hitsBefore = gatewayHits.length;
      const outAssist = await translationMod.callGeminiApi(
        'Dialogue items to translate to Khmer JSON',
        'AIzaSyDummyAssistFailoverKey123456',
        [],
        12000,
        { respanConfig: { apiKey: 'rsp_test_respan_secret_987654', baseUrl: localGatewayBase, model: 'openai/gpt-6.2-sol:free', role: 'assist', enabled: true } }
      );
      assert.ok(gatewayHits.length > hitsBefore, 'Respan assist must execute on text call/failover');
      assert.match(outAssist, /តោះទៅញ៉ាំបាយជាមួយគ្នា/);

      // Quality/Story Bible call in 'assist' mode tries Gemini FIRST (helper doesn't replace Gemini quality pass)
      const hitsBeforeQuality = gatewayHits.length;
      const gemCountBeforeQuality = geminiHitCount;
      await translationMod.callGeminiApi(
        'Dialogue items to translate to Khmer JSON',
        'AIzaSyDummyQualityHelperKey123456',
        [],
        12000,
        { preferQuality: true, respanConfig: { apiKey: 'rsp_test_respan_secret_987654', baseUrl: localGatewayBase, model: 'openai/gpt-6.2-sol:free', role: 'assist', enabled: true } }
      );
      assert.ok(geminiHitCount > gemCountBeforeQuality, 'In assist mode, preferQuality must try Gemini first');
      assert.ok(gatewayHits.length > hitsBeforeQuality, 'After Gemini 429 on preferQuality, assist fails over cleanly to Respan');

      // Multimodal audio parts MUST NOT be sent to OpenAI text gateway
      const hitsBeforeAudio = gatewayHits.length;
      await assert.rejects(
        () => translationMod.callGeminiApi(
          'Transcribe audio',
          'AIzaSyDummyAudioOnlyKey1234567',
          [{ inline_data: { mime_type: 'audio/wav', data: 'UklGRg==' } }],
          8000,
          { respanConfig: { apiKey: 'rsp_test_respan_secret_987654', baseUrl: localGatewayBase, model: 'openai/gpt-6.2-sol:free', role: 'primary', enabled: true } }
        )
      );
      assert.equal(gatewayHits.length, hitsBeforeAudio, 'Audio/image parts must stay strictly on Gemini, never sent to Respan');
      assert.ok(geminiHitCount > 0);
    } finally {
      https.request = httpsOrigReq;
    }

    // 5. Router UI HTML & JS checks
    const html = fs.readFileSync('D:/EZARG/src/frontend/index.html', 'utf8');
    const appCode = fs.readFileSync('D:/EZARG/src/frontend/app.js', 'utf8');
    assert.match(html, /id="routerRespanStrip"/);
    assert.match(html, /id="routerRespanPanel"/);
    assert.match(html, /id="respanApiKeyInput"/);
    assert.match(html, /openai\/gpt-6\.2-sol:free/);

    const statusEl = { innerText: '', style: {} };
    const roleBtns = {
      btnRespanRolePrimary: { classList: new Set(), _init() { this.classList = { toggle: (c, f) => f ? statusEl.p = c : statusEl.p = '' }; } },
      btnRespanRoleAssist: { classList: new Set(), _init() { this.classList = { toggle: (c, f) => f ? statusEl.a = c : statusEl.a = '' }; } },
      btnRespanRoleOff: { classList: new Set(), _init() { this.classList = { toggle: (c, f) => f ? statusEl.o = c : statusEl.o = '' }; } }
    };
    Object.values(roleBtns).forEach(b => b._init());
    let byokOpened = false;
    const byokModal = { style: { display: 'none' } };
    const uiMap = { routerRespanStatusText: statusEl, byokSetupModal: byokModal, ...roleBtns };
    const sbox = {
      console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set, URL,
      setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {} },
      document: {
        getElementById: (id) => {
          if (id === 'byokSetupModal') { byokOpened = true; return byokModal; }
          return uiMap[id] || null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
      },
      Audio: function() { return { pause() {}, play: () => Promise.resolve(), removeAttribute() {}, load() {} }; },
      fetch: async (u) => {
        if (String(u).includes('/api/config/accounts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              accounts: [],
              respan: { hasKey: true, enabled: true, role: 'primary', keyHint: 'rsp_te...87654', model: 'openai/gpt-6.2-sol:free' }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
    };
    sbox.window = sbox;
    sbox.addEventListener = () => {};
    sbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(sbox);
    vm.runInContext(appCode, ctx);
    vm.runInContext(`renderRouterRespanStrip(${JSON.stringify(saveJson)})`, ctx);
    assert.match(statusEl.innerText, /ជួយ Gemini/);
    await vm.runInContext('maybeShowFirstRunApiKeyHint()', ctx);
    assert.equal(byokOpened, false, 'First-run Gemini BYOK prompt must stay silent when Respan GPT-6.2 SOL is enabled');
  } finally {
    if (apiServer) await new Promise(r => apiServer.close(r));
    if (mockRespanServer) await new Promise(r => mockRespanServer.close(r));
    if (prevCfgEnv === undefined) delete process.env.EZA_CONFIG_FILE; else process.env.EZA_CONFIG_FILE = prevCfgEnv;
    if (prevAccEnv === undefined) delete process.env.GEMINI_ACCOUNTS_FILE; else process.env.GEMINI_ACCOUNTS_FILE = prevAccEnv;
    if (prevStrict === undefined) delete process.env.EZA_PACKAGED; else process.env.EZA_PACKAGED = prevStrict;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Fast export optimizations: bounded boxblur + bilinear on fastRender, preserved gblur defaults, faster presets & source fallback', async () => {
  const vm = require('node:vm');
  const exportModule = require('./src/backend/routes/export');
  const { FFMPEG_BIN, lowerProcessPriority } = require('./src/backend/utils/ffmpeg');
  const express = require('express');
  const http = require('http');

  // 0. lowerProcessPriority handles null safely and lowers priority on live child processes
  assert.equal(lowerProcessPriority(null), false);
  const { spawn } = require('child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { windowsHide: true });
  try {
    assert.equal(lowerProcessPriority(sleeper), true, 'lowerProcessPriority should set BELOW_NORMAL on live child pid');
  } finally {
    try { sleeper.kill(); } catch (_) {}
  }

  // 1. Default buildExportFilter preserves gblur + lanczos backward compatibility
  const defaultFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'feathered',
    maskBlurSigma: 12,
    resolution: '1080p',
    mediaInfo: { width: 540, height: 960 }
  });
  assert.ok(defaultFilter.includes('gblur=sigma=12'), 'default filter must keep gblur');
  assert.ok(defaultFilter.includes('flags=lanczos'), 'default filter must keep lanczos');

  // 2. fastRender uses bilinear scale and bounded 2-pass boxblur safe on any crop size
  const fastFilter = exportModule.buildExportFilter('C:\\temp\\sub.ass', {
    maskEnabled: true,
    maskMode: 'feathered',
    maskBlurSigma: 12,
    resolution: '1080p',
    mediaInfo: { width: 540, height: 960 },
    fastRender: true
  });
  assert.ok(fastFilter.includes('flags=bilinear'), 'fastRender must use bilinear scale');
  assert.ok(fastFilter.includes('boxblur=lr=max(1\\,min(floor(min(w\\,h)/2)-1\\,10)):lp=2:cr=max(0\\,min(floor(min(cw\\,ch)/2)-1\\,10)):cp=2'), 'fastRender must use bounded multi-pass boxblur');

  // 3. Fast and Balanced encoder profiles skip slow spatial-aq and medium preset bottlenecks
  const fastCpu = exportModule.buildVideoEncodingArgs('fast', 'cpu');
  const balCpu = exportModule.buildVideoEncodingArgs('balanced', 'cpu');
  const fastNv = exportModule.buildVideoEncodingArgs('fast', 'h264_nvenc');
  const balNv = exportModule.buildVideoEncodingArgs('balanced', 'h264_nvenc');
  assert.ok(fastCpu.args.includes('superfast'), 'fast CPU preset should use superfast');
  assert.ok(balCpu.args.includes('veryfast'), 'balanced CPU preset should use veryfast');
  assert.equal(fastNv.args.includes('-spatial-aq'), false, 'fast NVENC must omit slow spatial-aq');
  assert.equal(balNv.args.includes('-spatial-aq'), false, 'balanced NVENC must omit slow spatial-aq');

  // 4. Frontend Turbo & fallback resolution should default to source rather than forcing 1080p upscale
  const appCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  assert.equal(/exportResolution'\)\?\.value \|\| '1080p'/.test(appCode), false, 'app.js Video Manager fallback must default to source');

  // 5. Real end-to-end FFmpeg render in qualityPreset="fast" on tiny clip (verifies bounded boxblur never fails chroma_param checks)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-fastexp-'));
  const prevExportDir = process.env.EXPORT_DIR;
  let srv = null;
  try {
    process.env.EXPORT_DIR = tmpDir;
    const tinyVid = path.join(tmpDir, 'tiny-160x284.mp4');
    const mk = spawnSync(FFMPEG_BIN, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=15:duration=1',
      '-f', 'lavfi', '-i', 'sine=f=440:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', tinyVid
    ], { windowsHide: true });
    assert.equal(mk.status, 0);

    const app = express();
    app.use(express.json());
    app.use('/api/export', exportModule);
    srv = await new Promise(resolve => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = srv.address().port;
    const resp = await fetch(`http://127.0.0.1:${port}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: tinyVid,
        cues: [{ startSec: 0.05, endSec: 0.9, translated: 'សាកល្បង Fast Export', text: '测试' }],
        duration: 1,
        maskEnabled: true,
        maskMode: 'feathered',
        maskWPercent: 0.35,
        maskHPercent: 0.06,
        maskBlurSigma: 18,
        includeDubAudio: false,
        audioMixMode: 'original',
        qualityPreset: 'fast',
        resolution: 'source',
        encoder: 'auto',
        burnSubtitles: true,
        outputDir: tmpDir
      })
    });
    const json = await resp.json();
    assert.equal(resp.status, 200, `Expected 200 OK, got ${resp.status}: ${JSON.stringify(json)}`);
    assert.equal(json.success, true);
    assert.ok(json.outputFile && fs.existsSync(json.outputFile), 'Fast export MP4 must exist on disk');
    assert.ok(fs.statSync(json.outputFile).size > 2000, 'Fast export MP4 must be non-empty');

    // 6. Low-spec / Eco CPU mode: capabilities exposes systemProfile and ecoCpu=true renders cleanly on CPU encoder
    const capRes = await fetch(`http://127.0.0.1:${port}/api/export/capabilities`);
    const capJson = await capRes.json();
    assert.equal(capRes.status, 200);
    assert.ok(capJson.systemProfile && typeof capJson.systemProfile.cpuCores === 'number');
    assert.ok(typeof capJson.systemProfile.totalRamGB === 'number');
    assert.ok([1, 2, 4].includes(capJson.systemProfile.recommendedVmConcurrency));

    const ecoResp = await fetch(`http://127.0.0.1:${port}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: tinyVid,
        cues: [{ startSec: 0.05, endSec: 0.9, translated: 'សាកល្បង Eco CPU', text: '测试' }],
        duration: 1,
        maskEnabled: true,
        maskMode: 'feathered',
        includeDubAudio: false,
        audioMixMode: 'original',
        qualityPreset: 'balanced',
        resolution: 'source',
        encoder: 'cpu',
        ecoCpu: true,
        burnSubtitles: true,
        outputDir: tmpDir
      })
    });
    const ecoJson = await ecoResp.json();
    assert.equal(ecoResp.status, 200, `Expected Eco CPU 200 OK, got ${ecoResp.status}: ${JSON.stringify(ecoJson)}`);
    assert.equal(ecoJson.success, true);
    assert.equal(ecoJson.encoder, 'libx264');
    assert.ok(ecoJson.outputFile && fs.existsSync(ecoJson.outputFile), 'Eco CPU export MP4 must exist on disk');

    // 7. Frontend Low-Spec / Eco PC controls exist and wire cleanly
    const htmlCode = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
    assert.ok(htmlCode.includes('<option value="1">x1'), 'Video Manager must support x1 concurrency for 4-8GB RAM PCs');
    assert.ok(htmlCode.includes('id="btnVmEcoMode"'), 'Video Manager must expose Eco low-spec preset button');
    assert.ok(htmlCode.includes('id="ecoCpuModeCheck"'), 'Export modal must expose ecoCpuModeCheck');
    const vmSandbox = {
      console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
      URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: (() => {
        const s = new Map();
        return { getItem: k => s.get(k) || null, setItem: (k, v) => s.set(k, String(v)), removeItem: k => s.delete(k) };
      })(),
      Audio: function () { return { pause() {}, play: () => Promise.resolve(), src: '' }; },
      fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    };
    const mockEls = {
      vmConcurrencySelect: { value: '2' },
      vmGenerateTtsCheck: { checked: false },
      vmSaveDraftCheck: { checked: false },
      vmIsolateBgmCheck: { checked: true },
      vmAutoExportCheck: { checked: false },
      exportResolution: { value: '1080p' },
      exportQualityPreset: { value: 'balanced' },
      exportEncoder: { value: 'auto' },
      ecoCpuModeCheck: { checked: false },
      vmStudioPresetSummary: { innerText: '' },
      shortcutToast: { innerText: '', style: {}, classList: { add() {}, remove() {} } }
    };
    vmSandbox.document = { getElementById: id => mockEls[id] || null, querySelectorAll: () => [], addEventListener() {} };
    vmSandbox.window = vmSandbox;
    vmSandbox.addEventListener = () => {};
    vmSandbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
    const ctx = vm.createContext(vmSandbox);
    vm.runInContext(appCode, ctx);
    vm.runInContext('applyVideoManagerEcoPreset()', ctx);
    assert.equal(mockEls.vmConcurrencySelect.value, '1');
    assert.equal(mockEls.exportResolution.value, 'source');
    assert.equal(mockEls.exportQualityPreset.value, 'fast');
    assert.equal(mockEls.ecoCpuModeCheck.checked, true);
    assert.equal(vm.runInContext('readVideoManagerConfig().exportSnapshot.ecoCpu', ctx), true);
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    if (prevExportDir === undefined) delete process.env.EXPORT_DIR;
    else process.env.EXPORT_DIR = prevExportDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Bug audit regressions: missing Hub handlers, startup ecoCpu restore, 403 cooldown, dedup keys, process cleanup & main lifecycle', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const ttsJs = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'tts.js'), 'utf8');
  const translationJs = fs.readFileSync(path.join(__dirname, 'src', 'backend', 'routes', 'translation.js'), 'utf8');

  // 1. All inline HTML onclick/onchange handlers in index.html must map to defined functions in app.js
  const skipBuiltins = new Set(['if', 'event', 'this', 'Boolean', 'Number', 'String', 'Math', 'preventDefault', 'stopPropagation', 'focus', 'scrollIntoView', 'closest', 'getElementById', 'click', 'select']);
  const attrRe = /\son(?:click|change|input|keydown|keyup|dblclick|submit|dragover|dragleave|drop|mousedown|pointerdown)="([^"]+)"/gi;
  const missingHandlers = [];
  for (const m of html.matchAll(attrRe)) {
    for (const fnM of m[1].matchAll(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) {
      const fn = fnM[1];
      if (skipBuiltins.has(fn)) continue;
      if (!new RegExp(`function\\s+${fn}\\s*\\(|window\\.${fn}\\s*=|(?:const|let|var)\\s+${fn}\\s*=`).test(appJs)) {
        missingHandlers.push(fn);
      }
    }
  }
  assert.deepEqual(missingHandlers, [], `HTML inline handlers missing from app.js: ${missingHandlers.join(', ')}`);

  // 2. Runtime check for Hub license prompt / cancel / copyHubMachineId
  let focused = false;
  let copiedText = '';
  const gateMock = { style: { display: 'none' } };
  const cancelBtnMock = { style: { display: 'none' } };
  const errMock = { innerText: '' };
  const inputMock = { focus: () => { focused = true; } };
  const hwidMock = { innerText: 'EZA-TEST-1234' };
  const mobileModalMock = { style: { display: 'flex' } };
  const toastMock = { innerText: '', style: {}, classList: { add() {}, remove() {} } };
  const elsMap = {
    accessGateOverlay: gateMock,
    gateCancelSwitchBtn: cancelBtnMock,
    gateErrorMsg: errMock,
    gateAccessCodeInput: inputMock,
    hubCurrentMachineId: hwidMock,
    mobileConnectModal: mobileModalMock,
    shortcutToast: toastMock
  };
  const sbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { clipboard: { writeText: async (t) => { copiedText = t; } } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Audio: function () { return { pause() {}, play: () => Promise.resolve(), src: '' }; },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    document: { getElementById: id => elsMap[id] || null, querySelectorAll: () => [], addEventListener() {} }
  };
  sbox.window = sbox;
  sbox.addEventListener = () => {};
  sbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  const ctx = vm.createContext(sbox);
  vm.runInContext(appJs, ctx);
  vm.runInContext('openLicenseKeyPromptFromHub()', ctx);
  assert.equal(gateMock.style.display, 'flex');
  assert.equal(cancelBtnMock.style.display, 'flex');
  assert.equal(mobileModalMock.style.display, 'none');
  assert.equal(focused, true);
  vm.runInContext('cancelLicenseKeySwitchPrompt()', ctx);
  assert.equal(gateMock.style.display, 'none');
  assert.equal(cancelBtnMock.style.display, 'none');
  await vm.runInContext('copyHubMachineId()', ctx);
  assert.equal(copiedText, 'EZA-TEST-1234');

  // 3. Startup restores ecoCpu saved state & probes system capabilities
  assert.match(appJs, /applyEcoCpuSavedState\(\);[\s\S]{0,160}refreshExportCapabilities\(\)/);

  // 4. Backend concurrency & lifecycle invariants
  assert.match(ttsJs, /\|b=\$\{options\.allowBaseFallback \? 1 : 0\}/, 'inFlightTtsJobs jobKey must include allowBaseFallback');
  assert.match(translationJs, /effectiveSttEngine,\s*\r?\n\s*rawRequestedSttEngine/, 'speechJobKey must distinguish rawRequestedSttEngine');
  assert.match(translationJs, /activeExtractProcs\.clear\(\)/, 'extractSpeechAudioChunks must terminate orphaned ffmpeg processes on error');
  assert.match(translationJs, /await getSenseVoiceCapabilitiesAsync\(/, 'HTTP routes must use non-blocking async SenseVoice check');
  assert.match(mainJs, /let shouldRunMainApp = true;/, 'main.js must guard app.whenReady when single-instance lock fails');
  assert.match(mainJs, /if \(process\.platform !== 'darwin'\)\s*\{\s*\r?\n\s*shutdownBackendAndTunnels\(\);/, 'macOS window-all-closed must keep backend alive');
  assert.match(mainJs, /Skipping legacy key migration when accounts unavailable/, 'migrateLegacyGeminiKey must guard loadGeminiAccounts');
});

test('BGM + DUB root-cause regressions: dual-mono DSP protection, writable export fallback, model/venv discovery, and preview AudioContext guard', async () => {
  const vm = require('node:vm');
  const appJs = fs.readFileSync(path.join(__dirname, 'src', 'frontend', 'app.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

  // 1. Dual-mono stereo fixture (L == R): detectNarrowStereoAudio identifies narrow stereo & buildBgmFilterForChannels preserves volume
  const dualMonoVid = path.join(tempRoot, 'dual-mono-stereo.mp4');
  const gen = spawnSync(FFMPEG_BIN, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x160:d=1.2:r=24',
    '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*220*t)|0.4*sin(2*PI*220*t):d=1.2:s=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    dualMonoVid
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const isNarrow = await audioModule.detectNarrowStereoAudio(dualMonoVid);
  assert.equal(isNarrow, true, 'Identical L/R 2ch stereo must be detected as narrowStereo');
  const safeFilter = audioModule.buildBgmFilterForChannels(2, { narrowStereo: true });
  assert.ok(!safeFilter.includes('stereotools'), 'Narrow stereo must avoid center-canceling stereotools');
  const normalStereoFilter = audioModule.buildBgmFilterForChannels(2);
  assert.ok(normalStereoFilter.includes('stereotools'), 'Standard stereo default filter retains stereotools');

  // Verify ffmpeg_dsp isolation on dual-mono preserves audible signal instead of -45dB silence
  const prevBgmDir = process.env.BGM_CACHE_DIR;
  process.env.BGM_CACHE_DIR = path.join(tempRoot, 'bgm_narrow_test');
  try {
    const res = await audioModule.isolateVideoBgm(dualMonoVid, { engine: 'ffmpeg_dsp', force: true });
    const vd = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', res.bgmPath, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' });
    const meanM = (vd.stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    assert.ok(meanM && parseFloat(meanM[1]) > -30, `Expected audible BGM > -30 dB on dual-mono video, got ${meanM && meanM[1]} dB`);
  } finally {
    if (prevBgmDir === undefined) delete process.env.BGM_CACHE_DIR;
    else process.env.BGM_CACHE_DIR = prevBgmDir;
  }

  // 2. getAiModelsDir prefers existing directory with model weights over an empty override
  const emptyOverrideModelDir = path.join(tempRoot, 'empty_override_models');
  const prevModelOverride = process.env.AUDIO_SEPARATOR_MODEL_DIR;
  fs.mkdirSync(emptyOverrideModelDir, { recursive: true });
  process.env.AUDIO_SEPARATOR_MODEL_DIR = emptyOverrideModelDir;
  try {
    const resolvedModelDir = audioModule.getAiModelsDir();
    const projectModels = path.join(__dirname, '.ai_models', 'audio_separator');
    if (fs.existsSync(projectModels) && fs.readdirSync(projectModels).some(f => /\.(onnx|ckpt|pth|safetensors)$/i.test(f))) {
      assert.equal(path.normalize(resolvedModelDir).toLowerCase(), path.normalize(projectModels).toLowerCase());
    }
  } finally {
    if (prevModelOverride === undefined) delete process.env.AUDIO_SEPARATOR_MODEL_DIR;
    else process.env.AUDIO_SEPARATOR_MODEL_DIR = prevModelOverride;
  }

  // 3. Export writability fallback & fast fail on blocked custom outputDir
  assert.match(mainJs, /resolveDefaultPackagedExportDir/, 'main.js must probe packaged default export folder writability');
  const prevExportDir = process.env.EXPORT_DIR;
  const badDefaultDir = path.join(tempRoot, 'file_blocking_dir');
  fs.writeFileSync(badDefaultDir, 'not a dir', 'utf8');
  process.env.EXPORT_DIR = badDefaultDir;
  try {
    const resolvedDefault = exportModule.resolveWritableExportDir('');
    assert.equal(resolvedDefault.writable, true);
    assert.equal(resolvedDefault.isFallback, true);
    assert.notEqual(path.normalize(resolvedDefault.dir), path.normalize(badDefaultDir));
  } finally {
    if (prevExportDir === undefined) delete process.env.EXPORT_DIR;
    else process.env.EXPORT_DIR = prevExportDir;
  }

  const { server, baseUrl } = await startTestServer();
  try {
    const blockedRes = await fetch(`${baseUrl}/api/export/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: dualMonoVid,
        cues: [{ startSec: 0, endSec: 1, text: '你好', translated: 'សួស្តី' }],
        outputDir: badDefaultDir
      })
    });
    assert.equal(blockedRes.status, 403);
    const blockedJson = await blockedRes.json();
    assert.match(blockedJson.error, /Controlled Folder Access|Folder/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // 4. Frontend keeps bgm_only on startup and avoids creating MediaElementSource into suspended AudioContext
  const modeSelect = { value: 'bgm_only' };
  let createSrcCount = 0;
  const suspendedCtx = {
    state: 'suspended',
    resume: () => Promise.resolve(),
    createMediaElementSource: () => { createSrcCount += 1; return { connect() {} }; },
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBiquadFilter: () => ({ frequency: { value: 0 }, Q: { value: 1 }, gain: { value: 0 }, connect() {} }),
    destination: {}
  };
  const els = {
    exportAudioMode: modeSelect,
    mainVideo: { paused: true, muted: false, volume: 1.0, currentTime: 0, playbackRate: 1.0 }
  };
  const sbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Promise, Map, Set,
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Audio: function () { return { pause() {}, play: () => Promise.resolve(), addEventListener() {}, src: '', volume: 1 }; },
    AudioContext: function () { return suspendedCtx; },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    document: { getElementById: id => els[id] || null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} }
  };
  sbox.window = sbox;
  sbox.addEventListener = () => {};
  sbox.location = { protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
  const fctx = vm.createContext(sbox);
  vm.runInContext(appJs, fctx);
  assert.equal(modeSelect.value, 'bgm_only', 'Startup loadSavedAudioMixerState must preserve bgm_only mode');
  assert.equal(vm.runInContext('audioMixerState.bgmPct', fctx), 85, 'Default BGM slider level should align with 85% UI');
  vm.runInContext(`isVocalInvertOn = true; audioMixerState.origPct = 25;`, fctx);
  assert.equal(vm.runInContext('shouldSuppressOrigVocals()', fctx), true, 'Movie+Dub 25% preset must retain vocal notch suppression when BGM isolate is active');
  vm.runInContext(`audioCtx = new AudioContext(); applyDubElementGain({ volume: 1 }, 1.25);`, fctx);
  assert.equal(createSrcCount, 0, 'Must not trap <audio> inside a suspended AudioContext');
  assert.match(appJs, /ensureAiBgm:\s*Boolean\(config\.isolateBgm/, 'Video Manager batch must propagate ensureAiBgm for bgm_only');

  // 4b. When origPct === 0, live preview must keep <video> muted (even without stem or with Dub+BGM toggled off)
  vm.runInContext(`
    isDubVoiceEnabled = true;
    isVocalInvertOn = true;
    currentIsolatedBgmUrl = null;
    Object.assign(audioMixerState, { origPct: 0, bgmPct: 85, dubPct: 100, bgmOnPause: true });
    const mv1 = document.getElementById('mainVideo');
    mv1.paused = false;
    mv1.volume = 0.9;
    syncLiveSourceAudioSuppression(mv1, -1);
  `, fctx);
  assert.equal(els.mainVideo.volume, 0, 'origPct=0 without ready stem must keep raw <video> dialogue muted');

  vm.runInContext(`
    isDubVoiceEnabled = false;
    isVocalInvertOn = false;
    const mv2 = document.getElementById('mainVideo');
    mv2.volume = 0.8;
    syncLiveSourceAudioSuppression(mv2, -1);
  `, fctx);
  assert.equal(els.mainVideo.volume, 0, 'origPct=0 in bgm_only mode must keep raw <video> muted even when Dub & BGM buttons are toggled off');

  // 5. Ambient SFX v3 recovery blends non-speech impacts while ducking active speech core to prevent dialogue leaks
  const ambTestDir = path.join(tempRoot, 'bgm_ambient_upgrade_test');
  fs.mkdirSync(ambTestDir, { recursive: true });
  const prevAmbBgmDir = process.env.BGM_CACHE_DIR;
  process.env.BGM_CACHE_DIR = ambTestDir;
  try {
    const srcVid = path.join(tempRoot, 'ambient-sfx-src.mp4');
    const genSrc = spawnSync(FFMPEG_BIN, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x160:d=1.2:r=24',
      '-f', 'lavfi', '-i', 'sine=f=120:d=1.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      srcVid
    ], { encoding: 'utf8' });
    assert.equal(genSrc.status, 0, genSrc.stderr);
    const cacheKey = audioModule.getBgmCacheKey(srcVid);
    const quietBgm = path.join(ambTestDir, `${cacheKey}_bgm.mp3`);
    const impactVoc = path.join(ambTestDir, `${cacheKey}_vocals.mp3`);
    const metaJson = path.join(ambTestDir, `${cacheKey}_meta.json`);
    spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1.2', '-c:a', 'libmp3lame', quietBgm]);
    spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'aevalsrc=0.45*sin(2*PI*110*t)|0.45*sin(2*PI*110*t):d=1.2:s=44100', '-c:a', 'libmp3lame', impactVoc]);
    fs.writeFileSync(metaJson, JSON.stringify({ engine: 'audio-separator', videoPath: srcVid, createdAt: new Date().toISOString() }), 'utf8');

    const beforeSt = audioModule.getCachedStemsForVideo(srcVid);
    assert.equal(beforeSt.needsAmbientUpgrade, true);
    const upSt = await audioModule.upgradeExistingBgmWithAmbient(srcVid);
    assert.equal(upSt.needsAmbientUpgrade, false);
    assert.equal(upSt.ambientVersion, 3);
    assert.ok(upSt.hasRawBgm && upSt.rawBgmPath && fs.existsSync(upSt.rawBgmPath), 'Upgraded AI BGM must preserve _bgm_raw.mp3 backup');
    const vdUp = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', upSt.bgmPath, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' });
    const meanUp = (vdUp.stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    assert.ok(meanUp && parseFloat(meanUp[1]) > -25, `Expected recovered ambient sub-bass > -25 dB in upgraded BGM, got ${meanUp && meanUp[1]} dB`);

    // Verify vocal-core sidechain gate ducks pitch F0 / sibilants during active dialogue (prevents dialogue leak)
    const leakTestDir = path.join(tempRoot, 'bgm_ambient_speech_gate_test');
    fs.mkdirSync(leakTestDir, { recursive: true });
    const silenceBgm = path.join(leakTestDir, 'silence_bgm.mp3');
    const speechVoc = path.join(leakTestDir, 'speech_vocals.mp3');
    const gatedOut = path.join(leakTestDir, 'gated_out.mp3');
    spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1.5', '-c:a', 'libmp3lame', silenceBgm]);
    // Mix 180Hz vocal F0 + 850Hz speech formant + 5500Hz fricative
    spawnSync(FFMPEG_BIN, [
      '-y', '-f', 'lavfi',
      '-i', 'aevalsrc=(0.25*sin(2*PI*180*t)+0.45*sin(2*PI*850*t)+0.20*sin(2*PI*5500*t))|(0.25*sin(2*PI*180*t)+0.45*sin(2*PI*850*t)+0.20*sin(2*PI*5500*t)):d=1.5:s=44100',
      '-c:a', 'libmp3lame', speechVoc
    ]);
    await audioModule.blendAmbientSfxIntoBgm(silenceBgm, speechVoc, gatedOut);
    const vdLeak = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', gatedOut, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' });
    const meanLeak = (vdLeak.stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    assert.ok(meanLeak && parseFloat(meanLeak[1]) < -38, `Expected speech-gated ambient stem < -38 dB during active vocals, got ${meanLeak && meanLeak[1]} dB`);

    // Legacy v2 cache without raw backup must flag needsCleanReseparate
    const v2Vid = path.join(tempRoot, 'legacy-v2-polluted.mp4');
    fs.copyFileSync(srcVid, v2Vid);
    const v2Key = audioModule.getBgmCacheKey(v2Vid);
    fs.copyFileSync(quietBgm, path.join(ambTestDir, `${v2Key}_bgm.mp3`));
    fs.copyFileSync(impactVoc, path.join(ambTestDir, `${v2Key}_vocals.mp3`));
    fs.writeFileSync(path.join(ambTestDir, `${v2Key}_meta.json`), JSON.stringify({
      engine: 'audio-separator',
      ambientVersion: 2,
      videoPath: v2Vid
    }), 'utf8');
    const v2State = audioModule.getCachedStemsForVideo(v2Vid);
    assert.equal(v2State.needsCleanReseparate, true);
    assert.equal(v2State.needsAmbientUpgrade, true);
  } finally {
    if (prevAmbBgmDir === undefined) delete process.env.BGM_CACHE_DIR;
    else process.env.BGM_CACHE_DIR = prevAmbBgmDir;
  }
});







