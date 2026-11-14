const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const os = require('os');
const path = require('path');
const translationRouter = require('./src/backend/routes/translation');

async function startTestServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/translation', translationRouter);

  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/translation/auto-detect-speech`;
}

async function postSpeechRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

test('speech transcription rejects a missing video path', async t => {
  const url = await startTestServer(t);
  const response = await postSpeechRequest(url, {});

  assert.equal(response.status, 400);
  assert.equal(response.data.success, false);
});

test('speech transcription rejects relative video paths', async t => {
  const url = await startTestServer(t);
  const response = await postSpeechRequest(url, { videoPath: 'episode.mp4' });

  assert.equal(response.status, 400);
  assert.equal(response.data.success, false);
});

test('speech transcription rejects missing absolute video files', async t => {
  const url = await startTestServer(t);
  const missingVideoPath = path.join(os.tmpdir(), `eza-missing-${process.pid}.mp4`);
  const response = await postSpeechRequest(url, { videoPath: missingVideoPath });

  assert.equal(response.status, 404);
  assert.equal(response.data.success, false);
});

test('speech transcription rejects a directory instead of a video file', async t => {
  const url = await startTestServer(t);
  const response = await postSpeechRequest(url, { videoPath: os.tmpdir() });

  assert.equal(response.status, 400);
  assert.equal(response.data.success, false);
});
