// module-loader.js – Lädt ES-Module-Dateien für den VM-Test-Kontext
// Strippt import/export-Statements und gibt Code zurück der in vm.runInContext() läuft

const fs = require('fs');
const path = require('path');

/**
 * Liest eine ES-Modul-Datei und entfernt import/export Syntax
 * damit der Code in einem gemeinsamen VM-Kontext laufen kann.
 */
function stripModuleSyntax(code) {
  // Remove import lines: import ... from '...';
  code = code.replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, '');
  // Remove import lines without from: import '...';
  code = code.replace(/^import\s+['"].*?['"];?\s*$/gm, '');

  // Convert: export function → function
  code = code.replace(/^export\s+function\s/gm, 'function ');
  // Convert: export async function → async function
  code = code.replace(/^export\s+async\s+function\s/gm, 'async function ');
  // Convert: export const → const
  code = code.replace(/^export\s+const\s/gm, 'const ');
  // Convert: export let → let
  code = code.replace(/^export\s+let\s/gm, 'let ');
  // Convert: export var → var
  code = code.replace(/^export\s+var\s/gm, 'var ');

  // Remove: export default Brain; or export default ...;
  code = code.replace(/^export\s+default\s+\w+;?\s*$/gm, '');

  // Remove: export { ... };
  code = code.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

  return code;
}

/**
 * Lädt alle Modul-Dateien in der richtigen Reihenfolge,
 * strippt Module-Syntax und konvertiert const/let zu var.
 */
function loadAllModules(rootDir) {
  const moduleOrder = [
    'brain.js',
    'overlay-manager.js',
    'modal.js',
    'app.js',
    'ai.js',
    'organizer.js',
    'chat.js',
    'photo-flow.js',
    'item-detail.js',
    'warranty-view.js',
    'brain-view.js',
    'onboarding.js',
    'settings.js',
  ];

  let combined = '';
  for (const file of moduleOrder) {
    const filePath = path.join(rootDir, file);
    let code = fs.readFileSync(filePath, 'utf8');
    code = stripModuleSyntax(code);
    // const/let → var damit Variablen im globalen VM-Context landen
    code = code.replace(/^(const|let) /gm, 'var ');
    combined += `\n// ══ ${file} ══\n${code}\n`;
  }

  return combined;
}

module.exports = { stripModuleSyntax, loadAllModules };
