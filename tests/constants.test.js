const test = require('node:test');
const assert = require('node:assert/strict');
const { IPC, ROLES, COLLECTIONS } = require('../src/shared/constants');

test('IPC channel names are unique', () => {
  const names = Object.values(IPC);
  assert.equal(new Set(names).size, names.length);
});

test('every role is a lowercase string', () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(role, role.toLowerCase());
  }
});

test('collections map to expected Firestore paths', () => {
  assert.equal(COLLECTIONS.USERS, 'users');
  assert.equal(COLLECTIONS.PROJECTS, 'projects');
  assert.equal(COLLECTIONS.DOCUMENTS, 'documents');
});
