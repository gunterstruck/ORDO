// test-runner.js – Minimaler Test-Runner ohne Abhängigkeiten
// Läuft in Node.js: node tests/test-runner.js

const results = { passed: 0, failed: 0, errors: [] };

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`    ✓ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ test: name, error: err.message });
    console.log(`    ✗ ${name}`);
    console.log(`      → ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(msg || `Expected ${e}, got ${a}`);
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
    throw new Error(msg || 'Expected function to throw');
  } catch (err) {
    if (err.message === (msg || 'Expected function to throw')) throw err;
  }
}

function assertIncludes(arr, item, msg) {
  // Support v1.3 item objects: match by name if searching for a string in an array of objects
  const found = arr.some(el =>
    el === item || (typeof el === 'object' && el !== null && el.name === item)
  );
  if (!found) {
    throw new Error(msg || `Expected array to include ${JSON.stringify(item)}`);
  }
}

function assertNotIncludes(arr, item, msg) {
  const found = arr.some(el =>
    el === item || (typeof el === 'object' && el !== null && el.name === item)
  );
  if (found) {
    throw new Error(msg || `Expected array not to include ${JSON.stringify(item)}`);
  }
}

function printResults() {
  console.log('\n' + '─'.repeat(50));
  console.log(`  ${results.passed} passed, ${results.failed} failed`);
  if (results.errors.length > 0) {
    console.log('\n  Fehler:');
    results.errors.forEach(e => console.log(`    - ${e.test}: ${e.error}`));
  }
  console.log('─'.repeat(50));
  return results.failed === 0;
}

module.exports = { describe, it, assert, assertEqual, assertDeepEqual, assertThrows, assertIncludes, assertNotIncludes, printResults, results };
