/* What a waiting call shows a person: plain facts from its arguments, never a file's bytes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from '../server/cards.mjs';

test('a mail card: recipients as lists, the body kept short, files by name and size, never their bytes', () => {
    const c = cardOf('mail.forward', { to: 'a@example.com, b@example.org', cc: 'c@example.com', uid: '7', keep: 'none', body: 'x'.repeat(900), attachments: [{ name: 'f.pdf', bytes: 'QUJD'.repeat(1000) }] }, { config: { user: 'Me@Example.com' } });
    assert.deepEqual(c.to, ['a@example.com', 'b@example.org']);
    assert.deepEqual(c.cc, ['c@example.com']);
    assert.equal(c.self, 'me@example.com');
    assert.equal(c.keep, 'none');
    assert.equal(c.body.length, 600);
    assert.deepEqual(c.files, [{ name: 'f.pdf', kb: 3 }]);
    assert.ok(!JSON.stringify(c).includes('QUJD'), 'no bytes');
});

test('an event card, an answer card, a contact card; empty fields left out', () => {
    assert.deepEqual(cardOf('calendar.create', { title: 'Revue', start: '2030-11-10T10:00', end: '2030-11-10T10:45', with: 'p@example.com', online: 'teams' }),
        { kind: 'calendar', action: 'create', title: 'Revue', start: '2030-11-10T10:00', end: '2030-11-10T10:45', with: ['p@example.com'], online: 'teams' });
    assert.deepEqual(cardOf('calendar.respond', { id: 'e1', answer: 'accept' }), { kind: 'calendar', action: 'respond', id: 'e1', answer: 'accept' });
    assert.deepEqual(cardOf('contacts.create', { name: 'Julie', email: 'j@example.com' }), { kind: 'contacts', action: 'create', name: 'Julie', email: 'j@example.com' });
    assert.deepEqual(cardOf('files.write', { path: 'a.txt', text: 'héllo' }), { kind: 'files', action: 'write', path: 'a.txt', bytes: 6 });
});
