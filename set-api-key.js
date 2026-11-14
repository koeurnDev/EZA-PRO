/**
 * Helper script to set Gemini API Key
 * Run: node set-api-key.js YOUR_API_KEY
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const apiKey = process.argv[2];

if (!apiKey || apiKey.trim().length === 0) {
  console.error('❌ Error: Please provide an API key');
  console.log('\nUsage:');
  console.log('  node set-api-key.js YOUR_GEMINI_API_KEY');
  console.log('\nExample:');
  console.log('  node set-api-key.js AIzaSyABC123...');
  process.exit(1);
}

try {
  // Load existing config
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }

  // Add API key
  config.GEMINI_API_KEY = apiKey.trim();

  // Save config
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

  console.log('✅ Gemini API Key saved to config.json');
  console.log('\nYou can now:');
  console.log('  1. Start the app: npm start');
  console.log('  2. Test translation in browser: open test-frontend.html');
  console.log('  3. Run API tests: npm test');
  
} catch (err) {
  console.error('❌ Error saving API key:', err.message);
  process.exit(1);
}
