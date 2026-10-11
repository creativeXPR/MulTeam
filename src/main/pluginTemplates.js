// Starter templates for MulTeam plugins ("Create from template"). Each is a
// small, working plugin that shows one part of the API. {name}/{id} are
// filled in when the template is used.

const README = (title, body) => `# {name}

${title}

${body}

## Files

- \`multeam-plugin.json\` — the manifest: \`id\`, \`name\`, \`version\`, \`description\`, \`main\`, \`permissions\`
- \`main.js\` — runs in a sandboxed worker with a global \`multeam\` object

Edit \`main.js\`, then press **Reload** on the plugin (Plugins → Installed).
Open **Plugins → Tutorial** for the full guide and API reference.
`;

const TEMPLATES = [
  {
    id: 'hello-command',
    title: 'Hello command',
    summary: 'A palette command that asks for input and shows a message. The best place to start.',
    permissions: [],
    main: `// Commands appear in the command palette (Ctrl+K) as "{name}: <title>".
multeam.commands.register('sayHello', 'Say hello', async () => {
  const who = await multeam.window.showInput({ title: 'Say hello', label: 'Your name', placeholder: 'Ada' });
  if (!who) return; // cancelled
  multeam.window.showMessage(\`Hello, \${who}! 👋\`);
});
`,
    readme: README('Registers one command that prompts for a name and greets you.', 'Try it: press **Ctrl+K**, type "Say hello".')
  },
  {
    id: 'status-item',
    title: 'Status bar item',
    summary: 'Live text in the footer — this one shows the word and line count of the open file.',
    permissions: ['editor'],
    main: `// A footer status item, kept up to date on open and save.
async function update() {
  const text = await multeam.editor.getText();
  if (text === null) return multeam.window.setStatus(''); // no file open → hide
  const words = (text.match(/\\S+/g) || []).length;
  const lines = text.split('\\n').length;
  multeam.window.setStatus(\`\${words} words · \${lines} lines\`);
}

multeam.on('open', update);
multeam.on('save', update);
update();
`,
    readme: README('Shows the word and line count of the open file in the footer.', 'Uses the **editor** permission to read the text.')
  },
  {
    id: 'text-tools',
    title: 'Text transformer',
    summary: 'Commands that rewrite the selection: sort lines, UPPER/lower case, trim trailing spaces.',
    permissions: ['editor'],
    main: `// Each command reads the selection, transforms it, and writes it back.
function transform(id, title, fn) {
  multeam.commands.register(id, title, async () => {
    const text = await multeam.editor.getSelectedText();
    if (!text) return multeam.window.showError('Select some text first.');
    await multeam.editor.replaceSelection(fn(text));
  });
}

transform('sortLines', 'Sort selected lines', (t) => t.split('\\n').sort((a, b) => a.localeCompare(b)).join('\\n'));
transform('upper', 'UPPERCASE selection', (t) => t.toUpperCase());
transform('lower', 'lowercase selection', (t) => t.toLowerCase());
transform('trim', 'Trim trailing spaces', (t) => t.replace(/[ \\t]+$/gm, ''));
`,
    readme: README('Four commands that rewrite the selected text.', 'Select text, press **Ctrl+K**, search for the command.')
  },
  {
    id: 'snippet-pack',
    title: 'Snippet pack',
    summary: 'Completions for a language — type a prefix and pick the snippet. Ships with a few JavaScript ones.',
    permissions: [],
    main: `// Completions for one language. insertText can use $1, \${1:placeholder} and $0.
const SNIPPETS = [
  { label: 'log', insertText: 'console.log($1);', detail: 'console.log' },
  { label: 'afn', insertText: 'const \${1:name} = async (\${2}) => {\\n\\t$0\\n};', detail: 'async arrow function' },
  { label: 'tryc', insertText: 'try {\\n\\t$1\\n} catch (err) {\\n\\tconsole.error(err);\\n}', detail: 'try / catch' }
];

multeam.languages.registerCompletions('javascript', () => SNIPPETS);
multeam.languages.registerCompletions('typescript', () => SNIPPETS);
`,
    readme: README('Adds JavaScript/TypeScript snippets to autocomplete.', 'Type **log**, **afn** or **tryc** in a .js/.ts file.')
  },
  {
    id: 'file-generator',
    title: 'File generator',
    summary: 'Creates project files from a template (.gitignore, README) — shows workspace read/write.',
    permissions: ['workspace.read', 'workspace.write'],
    main: `// Writes files into the open project (needs workspace.read + workspace.write).
const FILES = {
  '.gitignore': 'node_modules/\\ndist/\\n.env\\n.DS_Store\\n',
  'README.md': '# My project\\n\\nDescribe what it does.\\n'
};

multeam.commands.register('generate', 'Add starter files', async () => {
  if (!(await multeam.workspace.getRoot())) return multeam.window.showError('Open a project first.');
  const existing = new Set(await multeam.workspace.listFiles());
  const created = [];
  for (const [path, text] of Object.entries(FILES)) {
    if (existing.has(path)) continue; // never overwrite
    await multeam.workspace.writeFile(path, text);
    created.push(path);
  }
  multeam.window.showMessage(created.length ? \`Created \${created.join(', ')}\` : 'Everything already exists.');
});
`,
    readme: README('Adds a .gitignore and README.md to the open project, skipping files that exist.', 'Uses **workspace.read** and **workspace.write**.')
  },
  {
    id: 'save-check',
    title: 'Save hook',
    summary: 'Reacts to saves — counts TODO/FIXME comments in the saved file and reminds you.',
    permissions: ['editor'],
    main: `// Runs every time a file is saved.
multeam.on('save', async ({ path }) => {
  const text = await multeam.editor.getText();
  if (!text) return;
  const todos = (text.match(/\\b(TODO|FIXME)\\b/g) || []).length;
  if (todos) multeam.window.showMessage(\`\${path.split(/[\\\\/]/).pop()}: \${todos} TODO/FIXME left\`);
});
`,
    readme: README('Counts TODO/FIXME comments whenever you save.', 'Uses the **save** event and the **editor** permission.')
  }
];

module.exports = { TEMPLATES };
