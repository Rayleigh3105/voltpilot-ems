'use strict';
// node --test reseed-merge.test.js - the pure half of the D-12 reseed
// coexistence proof: vendor tab group replaced, @vp-flow artifact tabs +
// their nodes preserved byte-for-byte. The shell/entrypoint half lives in
// reseed.test.sh; the real-image proof in reseed-flows.docker.test.sh.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { merge, MARKER } = require('./reseed-merge-flows');

const vendorTab = { id: 'tab-auto', type: 'tab', label: 'Wechselrichter (automatisch)' };
const vendorNode = { id: 'auto-router', type: 'function', z: 'tab-auto', name: 'Router' };
const artifactTab = {
  id: 'vpflow-4e1c2b3a-v7',
  type: 'tab',
  label: 'VP Flow: Heizstab (v7)',
  info: MARKER + ' flow_id=4e1c2b3a-5d6e-4f70-8123-456789abcdef flow_version=7',
};
const artifactNode = {
  id: 'vpflow-4e1c2b3a-v7-n7',
  type: 'vp-desired',
  z: 'vpflow-4e1c2b3a-v7',
  entity: 'heatrod-cellar',
};

test('artifact tabs and their nodes survive; vendor group comes from the template', () => {
  const template = [vendorTab, vendorNode];
  const current = [
    { id: 'tab-auto', type: 'tab', label: 'ALTE Vorlage' }, // stale vendor tab
    { id: 'auto-router', type: 'function', z: 'tab-auto', name: 'ALTER Router' },
    artifactTab,
    artifactNode,
  ];
  const { nodes, preservedTabs, dropped } = merge(template, current);
  assert.deepStrictEqual(preservedTabs, ['vpflow-4e1c2b3a-v7']);
  assert.deepStrictEqual(dropped, []);
  // Vendor content = the NEW template, artifact content = byte-identical old.
  assert.deepStrictEqual(nodes, [vendorTab, vendorNode, artifactTab, artifactNode]);
});

test('a current file without artifact tabs merges to exactly the template', () => {
  const template = [vendorTab, vendorNode];
  const current = [
    { id: 'tab-auto', type: 'tab', label: 'ALTE Vorlage' },
    { id: 'stale-node', type: 'function', z: 'tab-auto' },
  ];
  const { nodes, preservedTabs } = merge(template, current);
  assert.deepStrictEqual(preservedTabs, []);
  assert.deepStrictEqual(nodes, template);
});

test('an unmarked user tab is NOT preserved (ownership is the marker, not novelty)', () => {
  const foreignTab = { id: 'tab-hand', type: 'tab', label: 'Handgebaut', info: 'just notes' };
  const { nodes } = merge([vendorTab], [foreignTab, { id: 'x1', type: 'inject', z: 'tab-hand' }]);
  assert.deepStrictEqual(nodes, [vendorTab]);
});

test('id collision: the template wins, the collision is reported', () => {
  const collidingArtifactNode = { id: 'auto-router', type: 'vp-desired', z: artifactTab.id };
  const { nodes, dropped } = merge([vendorTab, vendorNode], [artifactTab, collidingArtifactNode]);
  assert.deepStrictEqual(dropped, ['auto-router']);
  assert.ok(nodes.find((n) => n.id === 'auto-router' && n.name === 'Router'), 'template node kept');
  assert.strictEqual(nodes.filter((n) => n.id === 'auto-router').length, 1);
});

test('non-array inputs are refused', () => {
  assert.throws(() => merge({}, []));
  assert.throws(() => merge([], null));
});

test('CLI: merges to stdout, exit 2 on unreadable current (wholesale fallback signal)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-merge-'));
  const tpl = path.join(dir, 'template.json');
  const cur = path.join(dir, 'current.json');
  fs.writeFileSync(tpl, JSON.stringify([vendorTab, vendorNode]));
  fs.writeFileSync(cur, JSON.stringify([artifactTab, artifactNode]));
  const out = execFileSync(process.execPath, [path.join(__dirname, 'reseed-merge-flows.js'), tpl, cur]);
  const nodes = JSON.parse(out.toString());
  assert.deepStrictEqual(nodes, [vendorTab, vendorNode, artifactTab, artifactNode]);

  fs.writeFileSync(cur, 'OLD-FLOWS-not-json');
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'reseed-merge-flows.js'), tpl, cur], { stdio: 'pipe' });
  } catch (e) {
    code = e.status;
  }
  assert.strictEqual(code, 2, 'unreadable current must exit 2');
  fs.rmSync(dir, { recursive: true, force: true });
});
