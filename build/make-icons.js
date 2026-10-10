// Generates every app icon from public/logo-1024.png (transparent, square),
// and public/logo.ico when one is provided.
// Run with Electron so nativeImage can resize — no image library needed:
//   npm run icons
//
// Outputs
//   build/icon.png      1024px  electron-builder: macOS (.icns) + Linux
//   build/icon.ico      16–256  electron-builder: Windows exe/installer
//   src/assets/icon.png  512px  BrowserWindow icon (Linux / dev)
//   src/assets/icon.ico 16–256  BrowserWindow icon (Windows taskbar)
//   src/renderer/assets/logo.svg  in-app brand mark + favicon
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SOURCE_PNG = path.join(root, 'public', 'logo-1024.png');
const SOURCE_SVG = path.join(root, 'public', 'logo.svg');
const SOURCE_ICO = path.join(root, 'public', 'logo.ico'); // optional hand-made .ico — used as-is when present
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function resized(img, size) {
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICO container holding PNG-compressed entries (supported since Vista).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);      // palette colors
    e.writeUInt8(0, 3);      // reserved
    e.writeUInt16LE(1, 4);   // color planes
    e.writeUInt16LE(32, 6);  // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SOURCE_PNG);
  if (img.isEmpty()) throw new Error(`Could not read ${SOURCE_PNG}`);

  const ico = fs.existsSync(SOURCE_ICO)
    ? fs.readFileSync(SOURCE_ICO)
    : buildIco(ICO_SIZES.map((size) => ({ size, data: resized(img, size) })));
  console.log(fs.existsSync(SOURCE_ICO) ? '  using public/logo.ico for Windows' : '  generating .ico from logo-1024.png');
  const outputs = {
    'build/icon.png': fs.readFileSync(SOURCE_PNG),
    'build/icon.ico': ico,
    'src/assets/icon.png': resized(img, 512),
    'src/assets/icon.ico': ico,
    'src/renderer/assets/logo.svg': fs.readFileSync(SOURCE_SVG)
  };

  for (const [rel, data] of Object.entries(outputs)) {
    const out = path.join(root, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    console.log(`  ${rel}  ${(data.length / 1024).toFixed(1)} KB`);
  }
  app.quit();
});
