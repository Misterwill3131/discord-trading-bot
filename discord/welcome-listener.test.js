const { test } = require('node:test');
const assert = require('node:assert');
const { formatWelcomeMessage, shouldWelcome } = require('./welcome-listener');

// ── formatWelcomeMessage ────────────────────────────────────────────

test('formatWelcomeMessage embeds user mention and start-here channel link', () => {
  const out = formatWelcomeMessage('111222333', '444555666');
  assert.strictEqual(
    out,
    '<@111222333> welcome to TOB! Please start with <#444555666> and watch us for a week or so to get familiar with the discord.'
  );
});

test('formatWelcomeMessage works with arbitrary snowflakes', () => {
  const out = formatWelcomeMessage('1', '2');
  assert.ok(out.includes('<@1>'));
  assert.ok(out.includes('<#2>'));
});

// ── shouldWelcome ───────────────────────────────────────────────────

// Helper: build a GuildMember-like mock. `roleIds` is the array of role
// IDs the member currently has — only `roles.cache.has()` is used by
// shouldWelcome so we keep the shape minimal.
function mockMember({ guildId = 'tob-guild', isBot = false, roleIds = [] } = {}) {
  return {
    guild: { id: guildId },
    user: { bot: isBot },
    roles: { cache: { has: (id) => roleIds.includes(id) } },
  };
}

const CFG = { roleId: 'sub-role', guildId: 'tob-guild' };

test('shouldWelcome returns true when subscriber role is newly added', () => {
  const oldM = mockMember({ roleIds: [] });
  const newM = mockMember({ roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), true);
});

test('shouldWelcome returns true when role is added alongside others', () => {
  const oldM = mockMember({ roleIds: ['other-role'] });
  const newM = mockMember({ roleIds: ['other-role', 'sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), true);
});

test('shouldWelcome returns false when role was already present (no transition)', () => {
  const oldM = mockMember({ roleIds: ['sub-role'] });
  const newM = mockMember({ roleIds: ['sub-role', 'other-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when role was removed (reverse transition)', () => {
  const oldM = mockMember({ roleIds: ['sub-role'] });
  const newM = mockMember({ roleIds: [] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when role is absent on both sides', () => {
  const oldM = mockMember({ roleIds: ['other-role'] });
  const newM = mockMember({ roleIds: ['other-role', 'another-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false on wrong guild (filter by guildId)', () => {
  const oldM = mockMember({ guildId: 'some-other-guild', roleIds: [] });
  const newM = mockMember({ guildId: 'some-other-guild', roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when member is a bot', () => {
  const oldM = mockMember({ isBot: true, roleIds: [] });
  const newM = mockMember({ isBot: true, roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});
