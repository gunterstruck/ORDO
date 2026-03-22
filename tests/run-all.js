#!/usr/bin/env node
// run-all.js – Führt alle Testdateien aus
// Ausführen: node tests/run-all.js

const { execSync } = require('child_process');
const path = require('path');

const testFiles = [
  'brain.test.js',
  'app-logic.test.js',
  'ux-flows.test.js'
];

let allPassed = true;

console.log('\n🧪 ORDO Test Suite\n' + '═'.repeat(60));

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`\n▶ ${file}`);
  console.log('─'.repeat(60));
  try {
    const output = execSync(`node "${filePath}"`, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(output);
  } catch (err) {
    allPassed = false;
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || '');
  }
}

console.log('\n' + '═'.repeat(60));
if (allPassed) {
  console.log('✅ Alle Tests bestanden!');
} else {
  console.log('❌ Einige Tests fehlgeschlagen!');
  process.exit(1);
}
