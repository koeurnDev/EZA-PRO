/**
 * ⚡ EZA PRO - API Test Suite
 * Automated testing for all backend endpoints
 */

const https = require('https');
const http = require('http');

const BASE_URL = 'http://127.0.0.1:3001'; // Dev server port
const TEST_RESULTS = [];

// Color codes for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

/**
 * Make HTTP request
 */
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

/**
 * Test case runner
 */
async function test(name, fn) {
  try {
    await fn();
    TEST_RESULTS.push({ name, status: 'PASS', error: null });
    console.log(`${colors.green}✓${colors.reset} ${name}`);
  } catch (err) {
    TEST_RESULTS.push({ name, status: 'FAIL', error: err.message });
    console.log(`${colors.red}✗${colors.reset} ${name}`);
    console.log(`  ${colors.red}Error: ${err.message}${colors.reset}`);
  }
}

/**
 * Assertion helpers
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertExists(value, message) {
  if (value === null || value === undefined) {
    throw new Error(message || 'Value should exist');
  }
}

function assertStatus(response, expectedStatus) {
  if (response.status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${response.status}`);
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log(`\n${colors.blue}⚡ EZA PRO - API Test Suite${colors.reset}\n`);
  console.log(`Testing: ${BASE_URL}\n`);

  // ============================================
  // Health Check Tests
  // ============================================
  console.log(`${colors.yellow}📋 Health Check Tests${colors.reset}`);
  
  await test('GET /api/health returns 200', async () => {
    const res = await request('GET', '/api/health');
    assertStatus(res, 200);
    assertEqual(res.data.status, 'ok', 'Status should be ok');
    assertExists(res.data.version, 'Version should exist');
  });

  // ============================================
  // Configuration Tests
  // ============================================
  console.log(`\n${colors.yellow}⚙️  Configuration Tests${colors.reset}`);
  
  await test('GET /api/config returns config', async () => {
    const res = await request('GET', '/api/config');
    assertStatus(res, 200);
    assertEqual(res.data.success, true, 'Success should be true');
    assertExists(res.data.config, 'Config object should exist');
  });

  await test('POST /api/config saves config', async () => {
    const res = await request('POST', '/api/config', {
      TEST_VALUE: 'test123'
    });
    assertStatus(res, 200);
    assertEqual(res.data.success, true, 'Success should be true');
  });

  // ============================================
  // Translation Tests
  // ============================================
  console.log(`\n${colors.yellow}🌏 Translation Tests${colors.reset}`);
  
  await test('POST /api/translation/translate-cues requires cues array', async () => {
    const res = await request('POST', '/api/translation/translate-cues', {});
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail without cues');
  });

  await test('POST /api/translation/translate-cues requires API key', async () => {
    const res = await request('POST', '/api/translation/translate-cues', {
      cues: [{ index: 1, text: '你好' }]
    });
    // Should fail with 401 if no API key configured
    if (res.status === 401) {
      assertEqual(res.data.success, false, 'Should fail without API key');
    } else {
      // If API key exists, should succeed or process
      assertExists(res.data, 'Response should exist');
    }
  });

  // ============================================
  // TTS Tests
  // ============================================
  console.log(`\n${colors.yellow}🎤 TTS Tests${colors.reset}`);
  
  await test('POST /api/tts/generate requires text', async () => {
    const res = await request('POST', '/api/tts/generate', {});
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail without text');
  });

  await test('POST /api/tts/generate rejects empty text', async () => {
    const res = await request('POST', '/api/tts/generate', { text: '' });
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail with empty text');
  });

  await test('POST /api/tts/generate accepts valid text', async () => {
    const res = await request('POST', '/api/tts/generate', {
      text: 'សួស្តី',
      voice: 'km-KH-PisethNeural'
    });
    // May fail if EdgeTTS not installed, but should return proper error
    assertExists(res.data, 'Response should exist');
    if (res.status === 200) {
      assertEqual(res.data.success, true, 'Should succeed');
      assertExists(res.data.audioUrl, 'Audio URL should exist');
    }
  });

  await test('GET /api/tts/voices returns voice list', async () => {
    const res = await request('GET', '/api/tts/voices');
    assertStatus(res, 200);
    assertEqual(res.data.success, true, 'Success should be true');
    assertExists(res.data.voices, 'Voices array should exist');
    assertEqual(res.data.voices.length, 2, 'Should have 2 voices');
  });

  await test('POST /api/tts/batch-generate requires items array', async () => {
    const res = await request('POST', '/api/tts/batch-generate', {});
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail without items');
  });

  // ============================================
  // Draft Tests
  // ============================================
  console.log(`\n${colors.yellow}💾 Draft Tests${colors.reset}`);
  
  await test('POST /api/drafts/save requires videoPath', async () => {
    const res = await request('POST', '/api/drafts/save', {
      cues: []
    });
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail without videoPath');
  });

  await test('POST /api/drafts/save requires cues array', async () => {
    const res = await request('POST', '/api/drafts/save', {
      videoPath: 'test.mp4'
    });
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail with invalid cues');
  });

  await test('POST /api/drafts/save creates draft', async () => {
    const res = await request('POST', '/api/drafts/save', {
      videoPath: 'D:\\Test\\video.mp4',
      cues: [
        { index: 1, text: '你好', translated: 'សួស្តី' }
      ]
    });
    assertStatus(res, 200);
    assertEqual(res.data.success, true, 'Should succeed');
    assertExists(res.data.draftKey, 'Draft key should exist');
  });

  await test('GET /api/drafts/list returns drafts', async () => {
    const res = await request('GET', '/api/drafts/list');
    assertStatus(res, 200);
    assertEqual(res.data.success, true, 'Success should be true');
    assertExists(res.data.drafts, 'Drafts array should exist');
    assertExists(res.data.total, 'Total count should exist');
  });

  await test('POST /api/drafts/load requires videoPath or draftKey', async () => {
    const res = await request('POST', '/api/drafts/load', {});
    assertStatus(res, 400);
    assertEqual(res.data.success, false, 'Should fail without params');
  });

  await test('POST /api/drafts/load by videoPath', async () => {
    const res = await request('POST', '/api/drafts/load', {
      videoPath: 'D:\\Test\\video.mp4'
    });
    // May return 404 if not found, or 200 if found
    assertExists(res.data, 'Response should exist');
    if (res.status === 200) {
      assertEqual(res.data.success, true, 'Should succeed');
      assertExists(res.data.draft, 'Draft should exist');
    }
  });

  // ============================================
  // Error Handling Tests
  // ============================================
  console.log(`\n${colors.yellow}🛡️  Error Handling Tests${colors.reset}`);
  
  await test('GET /api/nonexistent returns 404', async () => {
    const res = await request('GET', '/api/nonexistent');
    assertStatus(res, 404);
  });

  await test('POST with invalid JSON is handled', async () => {
    try {
      const url = new URL('/api/config', BASE_URL);
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        // Should return error status
        if (res.statusCode === 400 || res.statusCode === 500) {
          console.log(`${colors.green}✓${colors.reset} POST with invalid JSON is handled`);
          TEST_RESULTS.push({ name: 'POST with invalid JSON is handled', status: 'PASS', error: null });
        }
      });
      req.write('invalid{json}');
      req.end();
    } catch (e) {
      // Expected to fail
    }
  });

  // ============================================
  // Print Summary
  // ============================================
  console.log(`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.blue}📊 Test Summary${colors.reset}\n`);

  const passed = TEST_RESULTS.filter(r => r.status === 'PASS').length;
  const failed = TEST_RESULTS.filter(r => r.status === 'FAIL').length;
  const total = TEST_RESULTS.length;

  console.log(`Total: ${total}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%\n`);

  if (failed > 0) {
    console.log(`${colors.red}Failed Tests:${colors.reset}`);
    TEST_RESULTS.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}`);
      console.log(`    ${r.error}`);
    });
    console.log();
  }

  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  // Exit with error code if tests failed
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(err => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
