'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultReply = 'I do not know.\nSources: none';

async function run({ prompt, model } = {}) {
  if (typeof prompt !== 'string') throw new Error('fake host: prompt must be a string');
  let fixture = { default: defaultReply, replies: {} };
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim()) throw new Error('fake host: fixture path must be a non-empty string');
    try {
      fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), model), 'utf8'));
    } catch {
      throw new Error('fake host: could not read fixture JSON');
    }
    if (!fixture || typeof fixture.default !== 'string' || !fixture.replies
      || typeof fixture.replies !== 'object' || Array.isArray(fixture.replies)
      || Object.values(fixture.replies).some((reply) => typeof reply !== 'string')) {
      throw new Error('fake host: invalid fixture; expected default string and replies map of strings');
    }
  }
  const matched = Object.keys(fixture.replies).find((substring) => prompt.includes(substring));
  return { text: matched === undefined ? fixture.default : fixture.replies[matched], model: 'fake', raw: { matched: matched ?? null } };
}

module.exports = { run };
