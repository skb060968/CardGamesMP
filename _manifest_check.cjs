const fs = require('fs');
const h = fs.readFileSync('index.html', 'utf8');
const link = h.match(/<link[^>]*rel=["']manifest["'][^>]*>/i);
console.log('manifest link tag:', link ? link[0] : '(none)');
for (const p of ['public/manifest.json', 'public-new/manifest.json', 'manifest.json']) {
  if (fs.existsSync(p)) {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(p, '=> name:', JSON.stringify(m.name), 'short_name:', JSON.stringify(m.short_name));
  } else {
    console.log(p, '=> (missing)');
  }
}
const vc = fs.existsSync('vite.config.js') ? fs.readFileSync('vite.config.js', 'utf8') : '(no vite.config.js)';
const pd = vc.match(/publicDir[^\n,]*/);
console.log('publicDir setting:', pd ? pd[0] : '(default "public")');
