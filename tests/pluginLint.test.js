const test = require('node:test');
const assert = require('node:assert/strict');
const { lintPlugin } = require('../src/main/pluginLint');

const manifest = (over = {}) =>
  JSON.stringify({ id: 'word-count', name: 'Word Count', version: '0.1.0', description: 'Counts words', main: 'main.js', permissions: ['editor'], ...over }, null, 2);

const lint = ({ manifestText = manifest(), code = '', folderName = 'word-count' } = {}) =>
  lintPlugin({ manifestText, folderName, readFile: (name) => (name === 'main.js' ? code : null) });

const codes = (diags) => diags.map((d) => d.code);

test('a clean plugin has no errors or warnings', () => {
  const diags = lint({ code: "multeam.commands.register('count', 'Count words', async () => {\n  const text = await multeam.editor.getText();\n  multeam.window.showMessage(String(text.split(/\\s+/).length));\n});\n" });
  assert.deepEqual(diags.filter((d) => d.severity !== 'info'), []);
});

test('syntax errors point at the plugin’s own line', () => {
  const diags = lint({ code: "multeam.commands.register('a', 'A', () => {\n  const x = ;\n});\n" });
  assert.equal(diags[0].code, 'syntax');
  assert.equal(diags[0].file, 'main.js');
  assert.equal(diags[0].line, 2);
});

test('calling an API without its permission is an error', () => {
  const diags = lint({ manifestText: manifest({ permissions: [] }), code: "multeam.commands.register('a', 'A', () => multeam.workspace.readFile('x'));\n" });
  const d = diags.find((x) => x.code === 'permission-missing');
  assert.ok(d, codes(diags).join());
  assert.match(d.message, /workspace\.read/);
  assert.equal(d.line, 1);
});

test('unknown namespaces and members are errors', () => {
  const diags = lint({ code: "multeam.editor.getAllText();\nmulteam.network.get();\nmulteam.commands.register('a','A',()=>{});\n" });
  const unknown = diags.filter((d) => d.code === 'api-unknown');
  assert.equal(unknown.length, 2);
  assert.deepEqual(unknown.map((d) => d.line).sort(), [1, 2]);
});

test('declared but unused permissions are flagged on the manifest', () => {
  const diags = lint({ manifestText: manifest({ permissions: ['editor', 'workspace.write'] }), code: "multeam.commands.register('a','A', () => multeam.editor.getText());\n" });
  const d = diags.find((x) => x.code === 'permission-unused');
  assert.equal(d.file, 'multeam-plugin.json');
  assert.match(d.message, /workspace\.write/);
});

test('invalid manifest JSON reports a line', () => {
  const diags = lint({ manifestText: '{\n  "id": "word-count",\n  "name": "x",,\n}' });
  assert.equal(diags[0].code, 'manifest-json');
  assert.equal(diags[0].line, 3);
});

test('an id that does not match the folder is an error', () => {
  const diags = lint({ manifestText: manifest({ id: 'other-name' }), code: "multeam.commands.register('a','A',()=>{});" });
  assert.ok(codes(diags).includes('manifest-id-folder'));
});

test('missing entry file is an error', () => {
  const diags = lintPlugin({ manifestText: manifest({ main: 'src/index.js' }), folderName: 'word-count', readFile: () => null });
  assert.ok(codes(diags).includes('main-missing'));
});

test('sandbox globals warn, but multeam.window and local names do not', () => {
  const diags = lint({ code: "const window2 = 1;\nfetch('https://x');\nconst data = require('fs');\nmulteam.window.showMessage('hi');\nmulteam.commands.register('a','A',()=>{});\n" });
  const sandbox = diags.filter((d) => d.code === 'sandbox');
  assert.deepEqual(sandbox.map((d) => d.line), [2, 3]);
});

test('commented-out code is ignored', () => {
  const diags = lint({ manifestText: manifest({ permissions: [] }), code: "// multeam.editor.nope()\n/* fetch('x') */\nmulteam.commands.register('a','A',()=>{});\n" });
  assert.deepEqual(diags.filter((d) => d.severity !== 'info'), []);
});

test('listening to an event MulTeam never sends warns', () => {
  const diags = lint({ code: "multeam.on('close', () => {});\nmulteam.on('save', () => {});\n" });
  const ev = diags.filter((d) => d.code === 'event-unknown');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].line, 1);
});
