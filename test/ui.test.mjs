import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEYS, LEVELS, fill, alwaysLabel, outcome, ruleWords, mount } from '../ui/ui.js';
import { LEVELS as RIGHTS_LEVELS } from '../server/rights.mjs';
import { VERBS } from '../server/verbs.mjs';
import { keeper } from '../host/keeper.mjs';
import { options } from '../host/serve.mjs';

const words = (lang) => JSON.parse(readFileSync(new URL(`../ui/texts/${lang}.json`, import.meta.url)));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };

test('the words: every key in both languages, nothing more, each one short line', () => {
    for (const lang of ['en', 'fr']) {
        const w = words(lang);
        assert.deepEqual(KEYS.filter((k) => !(k in w)), [], `${lang}: missing`);
        assert.deepEqual(Object.keys(w).filter((k) => !KEYS.includes(k)), [], `${lang}: unused`);
        for (const [k, v] of Object.entries(w)) { assert.ok(v.length <= 40, `${lang} ${k} is short`); assert.doesNotMatch(v, /\n/); }
    }
    assert.deepEqual(LEVELS, RIGHTS_LEVELS);
    for (const verb of ['terminal.run', 'terminal.type', 'terminal.open', 'files.write', 'files.move', 'files.delete']) assert.ok(VERBS[verb] && KEYS.includes(`ask-${verb}`));
});

test('what a card and a journal line say', () => {
    const w = (k) => words('fr')[k];
    assert.equal(fill(w('ask-terminal.run'), { target: 'serveur-web' }), 'Lancer une commande sur serveur-web ?');
    assert.equal(alwaysLabel({ kind: 'command', value: 'apt upgrade' }, w), 'Toujours pour « apt upgrade »');
    assert.equal(alwaysLabel({ kind: 'path', value: '~/site' }, w), 'Toujours dans ~/site');
    assert.equal(alwaysLabel(null, w), null, 'no rule, no Always');
    assert.equal(ruleWords({ kind: 'path', value: '~/Projets' }, w), 'dans ~/Projets');
    assert.deepEqual(outcome({ decision: 'auto', because: 'rule' }), { key: 'did-rule', tone: 'dim' });
    assert.deepEqual(outcome({ decision: 'yes', ok: true }), { key: 'did-yes', tone: 'ok' });
    assert.deepEqual(outcome({ decision: 'yes', ok: false, error: 'x' }), { key: 'did-failed', tone: 'no' });
    assert.deepEqual(outcome({ decision: 'no' }), { key: 'did-no', tone: 'no' });
    assert.deepEqual(outcome({ op: 'stop' }), { key: 'op-stop', tone: 'no' });
});

test('serve: the local target only when asked for; options read', () => {
    const o = options(['--side', 'a/.tether=Site', '--local', 'work=My files', '--port', '0', '--lang', 'fr'], { env: {}, cwd: '/srv' });
    assert.deepEqual(o.sides[0].who, { id: 'agent:site', kind: 'agent', name: 'Site' });
    assert.deepEqual(o.local, { folder: '/srv/work', title: 'My files' });
    assert.equal(options([], { env: {}, cwd: '/srv' }).local, null);
    assert.throws(() => options(['--fly'], { env: {}, cwd: '/srv' }), /not understood/);
    /* The browser target: off unless asked for, then propose with a title. */
    assert.equal(options([], { env: {}, cwd: '/srv' }).browser, null);
    assert.deepEqual(options(['--browser'], { env: {}, cwd: '/srv' }).browser, { title: 'Browser', level: 'propose' });
    assert.deepEqual(options(['--browser', '--browser-title', 'Work Chrome', '--browser-level', 'frame'], { env: {}, cwd: '/srv' }).browser, { title: 'Work Chrome', level: 'frame' });
    assert.throws(() => options(['--browser', '--browser-level', 'boss'], { env: {}, cwd: '/srv' }), /--browser-level is one of/);
});

test('the screen: a card per call waiting, hostile text stays text, Accept decides', async () => {
    /* A document just big enough for the screen to be drawn. */
    class Node { constructor() { this.childNodes = []; } append(...k) { for (const c of k) { c.parent = this; this.childNodes.push(c); } }
        replaceChildren(...k) { this.childNodes = []; this.append(...k); } remove() {} contains() { return false; }
        get textContent() { return this.childNodes.map((c) => c.textContent).join(''); } }
    class Text extends Node { constructor(t) { super(); this.data = t; } get textContent() { return this.data; } }
    class El extends Node {
        constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.on = {}; }
        setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
        addEventListener(k, fn) { this.on[k] = fn; } focus() {} querySelector() { return null; }
        set innerHTML(_) { throw new Error('innerHTML used'); }
        set className(v) { this.attrs.class = v; }
    }
    const all = (n, out = []) => { if (n instanceof El) { out.push(n); n.childNodes.forEach((c) => all(c, out)); } return out; };
    const was = { document: globalThis.document, Node: globalThis.Node };
    Object.assign(globalThis, { Node, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t), activeElement: null } });
    const k = keeper(mkdtempSync(join(tmpdir(), 'tether-ui-')), { sides: () => [{ dir: mkdtempSync(join(tmpdir(), 'tether-side-')), who: BOT }], connectors: { fake: { run: async () => ({ text: 'ok', size: 2, exit: 0 }) } } });
    try {
        k.store.putTarget({ id: 'web', title: 'serveur-web', kind: 'ssh', connector: 'fake' });
        k.store.grant('web', BOT.id, 'propose');
        const pending = k.act('terminal.run', { target: 'web', command: '<img src=x onerror=alert(1)>', why: '<b>trust me</b>' }, BOT);
        await new Promise((r) => setImmediate(r));
        const root = new El('div');
        const s = mount(root, { call: (op, args) => k.act(op, args, ME), words: words('fr'), lang: 'fr', agent: BOT.id });
        await new Promise((r) => setTimeout(r, 30));
        const els = all(root);
        assert.ok(!els.some((e) => e.tag === 'img' || e.tag === 'b' && e.textContent === 'trust me'), 'nothing an agent sent is markup');
        assert.match(root.textContent, /Lancer une commande sur serveur-web \?/);
        assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
        assert.match(root.textContent, /Niveau de serveur-web : Proposer · tu valides chaque action/);
        assert.equal(els.filter((e) => e.attrs['data-act'] === 'always').length, 0, 'a command with shell control offers no Always');
        assert.equal(els.filter((e) => e.attrs['data-level']).length, 4);
        await els.find((e) => e.attrs['data-act'] === 'yes').on.click();
        assert.equal((await pending).ok, true);
        assert.equal(s.state.waiting, 0);
        s.destroy();
    } finally { Object.assign(globalThis, was); }
});
