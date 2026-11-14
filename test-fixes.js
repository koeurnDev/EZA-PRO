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
  } catch (_) {}
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
  const binPath = path.join(tempRoot, 'range.bin');
  fs.writeFileSync(binPath, '0123456789ABCDEF');

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

    // Video stream byte ranges + 416
    const rangeRes = await fetch(`${baseUrl}/api/video-stream?file=${encodeURIComponent(binPath)}`, {
      headers: { Range: 'bytes=2-5' }
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(await rangeRes.text(), '2345');

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

  assert.ok(mainJs.includes("'GET, POST, DELETE, OPTIONS'"));
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
      body: { classList: { toggle() {} } },
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    Audio: class {},
    URL,
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return 0; },
    clearInterval() {},
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
      body: { classList: { toggle() {} } },
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    Audio: class {},
    URL,
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return 0; },
    clearInterval() {},
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
    try { fs.unlinkSync(tempAccFile); } catch (_) {}
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
    try { fs.unlinkSync(tempAccFile); } catch (_) {}
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
    try { if (fs.existsSync(tinyFile)) fs.unlinkSync(tinyFile); } catch (_) {}
    try { if (fs.existsSync(validFile)) fs.unlinkSync(validFile); } catch (_) {}
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
    try { fs.unlinkSync(tempAccFile); } catch (_) {}
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
    addEventListener() {}
    removeEventListener() {}
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
    btnRemoveVocals: { classList: { toggle() {}, add() {}, remove() {} }, textContent: '', title: '', innerHTML: '' }
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
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ className: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} })
    },
    fetch: (url) => {
      if (String(url).includes('/api/audio/isolate-bgm')) {
        return isolatePromise;
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
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
  assert.equal(translationModule.SPEECH_VOCAL_FILTER, 'highpass=f=85,lowpass=f=7600');

  const g4Cfg = translationModule.buildGeminiGenerationConfig('gemini-4-hydrogen');
  assert.deepEqual(g4Cfg.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal('temperature' in g4Cfg, false);
  assert.equal(g4Cfg.responseMimeType, 'application/json');

  const flashCfg = translationModule.buildGeminiGenerationConfig('gemini-3-flash-preview');
  assert.equal(flashCfg.temperature, 0.2);
  assert.equal('thinkingConfig' in flashCfg, false);

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
      body: { classList: { toggle() {} } },
      addEventListener() {},
      getElementById: (id) => (id === 'routerTelemetryDock' ? dockEl : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeMockEl(tag)
    },
    Audio: class {},
    URL,
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval() {},
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
    try { fs.unlinkSync(tempAccFile); } catch (_) {}
    try { fs.unlinkSync(tempCfgFile); } catch (_) {}
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
    remove() {},
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
      body: { classList: { toggle() {} }, appendChild() {} },
      addEventListener() {},
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeMockEl(tag)
    },
    fetch: async (url, init) => {
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
    Audio: class {},
    URL,
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval() {},
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
  assert.equal(batchResult.count, 2);
  assert.deepEqual(ttsCalls.sort(), ['raw line', 'ពិភពលោក'].sort());

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
    addEventListener() {},
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
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Audio: class {
      addEventListener() {}
      pause() {}
      play() { return Promise.resolve(); }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: mockFetch,
    window: {
      electronAPI: { backendUrl: 'http://127.0.0.1:4567' },
      addEventListener: () => {}
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => mkEl('tmp'),
      addEventListener: () => {}
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
      addEventListener() {},
      removeEventListener() {},
      focus() {},
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
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Audio: class {
      addEventListener() {}
      pause() {}
      play() { return Promise.resolve(); }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: mockFetch,
    window: {
      electronAPI: { backendUrl: 'http://127.0.0.1:4567' },
      addEventListener: () => {}
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => makeMockNode(tag),
      createElementNS: (_ns, tag) => makeMockNode(tag),
      addEventListener: () => {}
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
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    addEventListener() {},
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
    navigator: { clipboard: { writeText: async () => {} } },
    Audio: function MockAudio() {
      return { pause() {}, play: async () => {}, addEventListener() {} };
    },
    alert: () => {},
    confirm: () => true,
    prompt: () => null,
    document: {
      activeElement: null,
      body: makeEl('body'),
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl('created'),
      addEventListener: () => {}
    },
    window: {
      location: { search: '' },
      innerWidth: 1400,
      addEventListener: () => {}
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
          json: async () => ({ success: true, generated: (parsedBody?.items || []).length, results: [] })
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
  const ttsCalls = requests.filter(r => r.url.includes('/api/tts/generate'));
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
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
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
    req.setTimeout = () => {};
    req.destroy = () => {};
    let reqBody = '';
    req.write = (chunk) => { if (chunk) reqBody += String(chunk); };
    req.end = (chunk) => {
      if (chunk) reqBody += String(chunk);
      let promptText = '';
      try {
        const parsedReq = JSON.parse(reqBody);
        promptText = parsedReq.contents?.[0]?.parts?.[0]?.text || '';
      } catch (_) {}
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
      res.setEncoding = () => {};
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
    try { fs.unlinkSync(poisonedMp3); } catch (_) {}
    try { fs.unlinkSync(poisonedMeta); } catch (_) {}
  }

  // 4. export.js prepareCueAudioClips enforces fixedVoice over mixed cue voices
  const lockText1 = 'ខ្ញុំសុំទោស';
  const lockText2 = 'មិនអីទេបង';
  const lockedVoice = 'kh_elder_woman';
  const lockedKey1 = ttsModule.getAudioCacheKey(lockText1, lockedVoice, { strictVoice: true });
  const lockedKey2 = ttsModule.getAudioCacheKey(lockText2, lockedVoice, { strictVoice: true });
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey1}.mp3`), Buffer.alloc(500, 2));
  fs.writeFileSync(path.join(tempAudioDir, `${lockedKey2}.mp3`), Buffer.alloc(500, 2));

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
      body: { classList: { toggle() {} }, appendChild() {}, dataset: {} },
      addEventListener() {},
      getElementById(id) { return elems[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { style: {}, click() {} }; }
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
    alert() {},
    confirm: () => true,
    Audio: class { pause() {} play() { return Promise.resolve(); } addEventListener() {} },
    URL,
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return 0; },
    clearInterval() {},
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
  const genCalls = fetchCalls.filter(c => String(c.url).includes('/api/tts/generate'));
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
  translationCache.set = async () => {};

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
    req.setTimeout = () => {};
    req.destroy = () => {};
    let bodyStr = '';
    req.write = (d) => { bodyStr += String(d || ''); };
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => {};
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
    req.setTimeout = () => {};
    req.destroy = () => {};
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
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => {};
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
  t.after(() => { try { fs.unlinkSync(tempAccFile); } catch (_) {} });
  const usedKeys = [];
  https.request = (opts, cb) => {
    const keyParam = new URL(`https://example.com${opts.path}`).searchParams.get('key');
    const callIdx = usedKeys.length;
    usedKeys.push(keyParam);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => {};
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
    try { fs.unlinkSync(proAccountsFile); } catch (_) {}
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
        body: { classList: { toggle() {} }, dataset: {} },
        addEventListener() {},
        getElementById() { return null; },
        querySelectorAll() { return []; }
      },
      Audio: class { pause() {} play() { return Promise.resolve(); } },
      URL,
      console: { log() {}, warn() {}, error() {} },
      setInterval() { return 0; },
      clearInterval() {},
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
