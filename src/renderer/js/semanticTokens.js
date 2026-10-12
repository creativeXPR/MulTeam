// Semantic highlighting from language servers (functions, parameters,
// properties, classes, built-ins like `console`…), like VS Code.
//
// Monaco styles a semantic token by matching "type.modifier.modifier" against
// the theme's rules by dotted prefix, which can't express VS Code's selector
// rules. So the client remaps every server token onto one STYLE KEY below
// ("function", "variable.readonly", "method.defaultLibrary"…) and every
// theme gets one rule per key. Tokens the editor's tokenizer already colors
// well (keywords, strings, numbers, comments) are left to it.

// key → TextMate scopes VS Code falls back to for it (most specific first)
export const SEMANTIC_KEYS = [
  ['namespace', ['entity.name.namespace', 'entity.name.type.module']],
  ['type', ['entity.name.type', 'support.type']],
  ['type.defaultLibrary', ['support.type', 'entity.name.type']],
  ['class', ['entity.name.type.class', 'entity.name.class', 'entity.name.type']],
  ['class.defaultLibrary', ['support.class', 'entity.name.type.class', 'entity.name.type']],
  ['interface', ['entity.name.type.interface', 'entity.name.type']],
  ['enum', ['entity.name.type.enum', 'entity.name.type']],
  ['struct', ['entity.name.type.struct', 'entity.name.type']],
  ['typeParameter', ['entity.name.type.parameter', 'entity.name.type']],
  ['parameter', ['variable.parameter']],
  ['variable', ['variable.other.readwrite', 'entity.name.variable']],
  ['variable.readonly', ['variable.other.constant', 'variable.other.readwrite']],
  ['variable.defaultLibrary', ['support.variable', 'variable.other.readwrite']],
  ['property', ['variable.other.property']],
  ['property.readonly', ['variable.other.constant.property', 'variable.other.property']],
  ['property.defaultLibrary', ['support.variable.property', 'variable.other.property']],
  ['enumMember', ['variable.other.enummember']],
  ['event', ['variable.other.event']],
  ['function', ['entity.name.function', 'support.function']],
  ['function.defaultLibrary', ['support.function', 'entity.name.function']],
  ['method', ['entity.name.function.member', 'entity.name.function', 'support.function']],
  ['method.defaultLibrary', ['support.function', 'entity.name.function.member', 'entity.name.function']],
  ['macro', ['entity.name.function.preprocessor', 'entity.name.function']],
  ['label', ['entity.name.label']],
  ['decorator', ['entity.name.decorator', 'entity.name.function.decorator', 'entity.name.function']]
];

export const STYLE_KEYS = SEMANTIC_KEYS.map(([k]) => k);
const KEY_INDEX = new Map(STYLE_KEYS.map((k, i) => [k, i]));
const HAS_LIB = new Set(['type', 'class', 'variable', 'property', 'function', 'method']);
const HAS_READONLY = new Set(['variable', 'property']);

export const STANDARD_TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'label'];
export const STANDARD_MODIFIERS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];

// The legend Monaco is given: our style keys, no modifiers.
export const MONACO_LEGEND = { tokenTypes: STYLE_KEYS, tokenModifiers: [] };

// Builds a remapper for one server legend: LSP relative-encoded data in,
// data over MONACO_LEGEND out (tokens without a style key are dropped).
export function makeRemapper(serverLegend) {
  const types = serverLegend?.tokenTypes || [];
  const mods = serverLegend?.tokenModifiers || [];
  const libBit = mods.indexOf('defaultLibrary');
  const roBit = mods.indexOf('readonly');
  const cache = new Map();
  const keyFor = (t, m) => {
    const id = t * 65536 + m;
    if (cache.has(id)) return cache.get(id);
    let base = types[t];
    if (base === 'member') base = 'method'; // older servers
    let key = null;
    if (KEY_INDEX.has(base)) {
      key = base;
      if (libBit >= 0 && (m >> libBit) & 1 && HAS_LIB.has(base)) key = `${base}.defaultLibrary`;
      else if (roBit >= 0 && (m >> roBit) & 1 && HAS_READONLY.has(base)) key = `${base}.readonly`;
    }
    const idx = key === null ? -1 : KEY_INDEX.get(key);
    cache.set(id, idx);
    return idx;
  };
  return (data) => {
    const out = [];
    let line = 0, char = 0, outLine = 0, outChar = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      const dl = data[i];
      line += dl;
      char = dl ? data[i + 1] : char + data[i + 1];
      const idx = keyFor(data[i + 3], data[i + 4]);
      if (idx < 0) continue;
      const odl = line - outLine;
      out.push(odl, odl ? char : char - outChar, data[i + 2], idx, 0);
      outLine = line;
      outChar = char;
    }
    return new Uint32Array(out);
  };
}

// Colors for MulTeam's own light/dark editor themes (VS Code Light+/Dark+).
export function builtinSemanticRules(dark) {
  const c = dark
    ? { fn: 'DCDCAA', type: '4EC9B0', vari: '9CDCFE', konst: '4FC1FF', macro: '569CD6' }
    : { fn: '795E26', type: '267F99', vari: '001080', konst: '0070C1', macro: '0000FF' };
  const map = {
    namespace: c.type, type: c.type, 'type.defaultLibrary': c.type, class: c.type, 'class.defaultLibrary': c.type,
    interface: c.type, enum: c.type, struct: c.type, typeParameter: c.type,
    parameter: c.vari, variable: c.vari, 'variable.defaultLibrary': c.vari, property: c.vari, 'property.defaultLibrary': c.vari,
    'variable.readonly': c.konst, 'property.readonly': c.konst, enumMember: c.konst, event: c.vari,
    function: c.fn, 'function.defaultLibrary': c.fn, method: c.fn, 'method.defaultLibrary': c.fn, decorator: c.fn,
    macro: c.macro, label: c.vari
  };
  return Object.entries(map).map(([token, foreground]) => ({ token, foreground }));
}
