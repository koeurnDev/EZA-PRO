/**
 * Script to extract HTML/CSS/JS from server.js
 * Run: node extract-ui.js
 */

const fs = require('fs');
const path = require('path');

console.log('🔄 Extracting UI from server.js...');

// Read server.js
const serverContent = fs.readFileSync('server.js', 'utf8');

// Find HTML_CONTENT section
const htmlStart = serverContent.indexOf('const HTML_CONTENT = `');
const htmlEnd = serverContent.indexOf('`;', htmlStart + 100); // Find closing backtick

if (htmlStart === -1 || htmlEnd === -1) {
  console.error('❌ Could not find HTML_CONTENT in server.js');
  process.exit(1);
}

// Extract HTML content (remove const HTML_CONTENT = ` and closing `)
const htmlContent = serverContent.substring(htmlStart + 'const HTML_CONTENT = `'.length, htmlEnd);

console.log(`✅ Found HTML content: ${htmlContent.length} characters`);

// Split HTML into sections
const styleStart = htmlContent.indexOf('<style>');
const styleEnd = htmlContent.indexOf('</style>') + '</style>'.length;
const scriptStart = htmlContent.indexOf('<script>');
const scriptEnd = htmlContent.lastIndexOf('</script>') + '</script>'.length;

// Extract CSS
const cssContent = htmlContent.substring(styleStart + '<style>'.length, styleEnd - '</style>'.length);

// Extract JavaScript (everything between <script> tags, including multiple script blocks)
const jsContent = htmlContent.substring(scriptStart + '<script>'.length, scriptEnd - '</script>'.length);

// Extract pure HTML (before style and after last script)
const htmlOnly = htmlContent.substring(0, styleStart) + 
                 htmlContent.substring(styleEnd, scriptStart) +
                 htmlContent.substring(scriptEnd);

// Write to files
fs.writeFileSync('src/frontend/index.html', htmlOnly, 'utf8');
console.log('✅ Wrote src/frontend/index.html');

fs.writeFileSync('src/frontend/styles.css', cssContent, 'utf8');
console.log('✅ Wrote src/frontend/styles.css');

fs.writeFileSync('src/frontend/app.js', jsContent, 'utf8');
console.log('✅ Wrote src/frontend/app.js');

console.log('\n🎉 Extraction complete!');
console.log('📊 Stats:');
console.log(`   HTML: ${htmlOnly.length} chars`);
console.log(`   CSS:  ${cssContent.length} chars`);
console.log(`   JS:   ${jsContent.length} chars`);
