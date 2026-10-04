'use strict';

const claude = require('./claude');
const codex = require('./codex');
const fake = require('./fake');

function get(host) {
  if (host === 'claude') return claude;
  if (host === 'codex') return codex;
  if (host === 'fake') return fake;
  throw new Error('Unknown host. Expected claude, codex or fake.');
}

function parseSpec(spec) {
  if (typeof spec !== 'string' || !spec) throw new Error('Host spec must be claude[:model], codex[:model] or fake[:fixture.json].');
  const separator = spec.indexOf(':');
  const host = separator === -1 ? spec : spec.slice(0, separator);
  get(host);
  const model = separator === -1 ? undefined : spec.slice(separator + 1);
  if (model !== undefined && !model.trim()) throw new Error('Host spec must have a non-empty model or fixture after the colon.');
  return { host, model };
}

function allowedTools(personaJson) {
  return claude.validateAllowedTools(personaJson?.hosts?.claude?.allowed_tools);
}

module.exports = { parseSpec, get, allowedTools };
