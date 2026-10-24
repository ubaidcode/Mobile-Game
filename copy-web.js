// Copies the web files into www/ (Capacitor's webDir).
const fs = require('fs'), path = require('path');
const out = 'www';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
['index.html', 'style.css', 'script.js', 'assets'].forEach(f => {
  if (fs.existsSync(f)) fs.cpSync(f, path.join(out, f), { recursive: true });
});
console.log('Copied web files to ./' + out);