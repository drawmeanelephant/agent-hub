#!/usr/bin/env node
'use strict';
// Manage per-agent upload tokens for the hub.
//   node collector/tokens.js list
//   node collector/tokens.js add <agent-name>     (idempotent per name)
//   node collector/tokens.js revoke <agent-name>

const store = require('./store');

const [cmd, name] = process.argv.slice(2);

if (cmd === 'add' && name) {
  const r = store.createToken(name);
  if (r.existing) console.log(`token "${r.name}" already exists:\n${r.token}`);
  else console.log(`token "${r.name}" created:\n${r.token}`);
} else if (cmd === 'list') {
  const rows = store.listTokens();
  if (!rows.length) { console.log('no tokens'); process.exit(0); }
  const pad = (s, n) => String(s || '–').padEnd(n);
  console.log(pad('name', 16) + pad('created', 26) + pad('last used', 26) + 'token');
  for (const t of rows) {
    console.log(pad(t.name, 16) + pad((t.created || '').replace('T', ' ').slice(0, 19), 26) +
      pad((t.lastUsed || '').replace('T', ' ').slice(0, 19), 26) + t.token);
  }
} else if (cmd === 'revoke' && name) {
  const r = store.revokeToken(name);
  console.log(r ? `revoked "${r.name}"` : `no token named "${name}"`);
} else {
  console.log('usage:\n  node collector/tokens.js list\n  node collector/tokens.js add <agent-name>\n  node collector/tokens.js revoke <agent-name>');
  process.exit(1);
}
