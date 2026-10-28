// version.json, BUILD und der neueste CHANGELOG-Eintrag müssen übereinstimmen (Pages + Testliste).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILD, CHANGELOG } from '../app/changelog.js';

const file = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
assert.equal(file.version, BUILD.version);
assert.equal(file.date, BUILD.date);
assert.equal(CHANGELOG[0].version, BUILD.version);
assert.equal(CHANGELOG[0].date, BUILD.date);
assert.ok(CHANGELOG[0].items.length >= 1);
assert.ok(CHANGELOG.every(c => c.version && c.date && Array.isArray(c.items) && c.items.length));
console.log('version ok', BUILD.version, BUILD.date);
