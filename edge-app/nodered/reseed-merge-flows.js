'use strict';
/**
 * reseed-merge-flows.js - the D-12 reseed coexistence merge (contract:
 * docs/contracts/v2/flow-artifact.md §4): an image update replaces ONLY the
 * VENDOR tab group of flows.json; user-flow ARTIFACT tabs - tabs whose `info`
 * starts with the `@vp-flow` ownership marker - survive byte-for-byte,
 * together with every node on them (z == tab id).
 *
 * Before E2, reseed-entrypoint.sh replaced flows.json WHOLESALE - correct
 * while every flow was VoltPilot-owned, fatal for deployed user flows
 * (discrepancy log #3). The entrypoint now calls this script; when it cannot
 * run (no node, corrupt current file) the entrypoint falls back to the old
 * wholesale copy WITH a loud warning - safe either way, because the retained
 * deployment set restores dropped artifact tabs on the next core reconcile
 * (the contract's "self-healing either way").
 *
 * CLI: node reseed-merge-flows.js <template-flows.json> <current-flows.json>
 *   -> merged flow document on STDOUT, notes on STDERR, exit 0.
 *   Unreadable TEMPLATE = exit 1 (fatal - nothing sane to emit).
 *   Unreadable CURRENT  = exit 2 (the entrypoint falls back to wholesale).
 */

const MARKER = '@vp-flow';

// merge() is exported for unit tests: template nodes + preserved artifact
// tabs (and their nodes) from the current document. On an id collision the
// TEMPLATE node wins (deterministic; the dropped artifact node is reported -
// the core's deployment reconcile restores the artifact tab correctly).
function merge(template, current) {
  if (!Array.isArray(template)) throw new Error('template flows.json is not a node array');
  if (!Array.isArray(current)) throw new Error('current flows.json is not a node array');

  const artifactTabs = current.filter(
    (n) => n && n.type === 'tab' && typeof n.info === 'string' && n.info.startsWith(MARKER)
  );
  const tabIds = new Set(artifactTabs.map((t) => t.id));
  const preserved = current.filter(
    (n) => n && (tabIds.has(n.id) || (typeof n.z === 'string' && tabIds.has(n.z)))
  );

  const templateIds = new Set(template.map((n) => n && n.id).filter(Boolean));
  const kept = [];
  const dropped = [];
  for (const n of preserved) {
    if (templateIds.has(n.id)) dropped.push(n.id);
    else kept.push(n);
  }
  return { nodes: template.concat(kept), preservedTabs: [...tabIds], dropped };
}

module.exports = { merge, MARKER };

if (require.main === module) {
  const fs = require('fs');
  const [templatePath, currentPath] = process.argv.slice(2);
  if (!templatePath || !currentPath) {
    process.stderr.write('usage: reseed-merge-flows.js <template> <current>\n');
    process.exit(1);
  }
  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    if (!Array.isArray(template)) throw new Error('not an array');
  } catch (e) {
    process.stderr.write('template flows.json unreadable: ' + e.message + '\n');
    process.exit(1);
  }
  let current;
  try {
    current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    if (!Array.isArray(current)) throw new Error('not an array');
  } catch (e) {
    process.stderr.write('current flows.json unreadable: ' + e.message + '\n');
    process.exit(2);
  }
  const { nodes, preservedTabs, dropped } = merge(template, current);
  if (preservedTabs.length > 0) {
    process.stderr.write(
      'preserving ' + preservedTabs.length + ' @vp-flow artifact tab(s): ' + preservedTabs.join(', ') + '\n'
    );
  }
  for (const id of dropped) {
    process.stderr.write('WARN: artifact node ' + id + ' collides with a template id; template wins\n');
  }
  process.stdout.write(JSON.stringify(nodes) + '\n');
}
