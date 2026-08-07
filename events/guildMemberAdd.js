const db = require('../db');
const { syncLevelRole } = require('../utils/levelRoles');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    if (member.user.bot) return;

    // Jeśli ktoś wrócił na serwer i miał już zapisany postęp - dostaje rolę adekwatną
    // do swojego poprzedniego poziomu, a nie zawsze startową.
    const existing = db.getUserLevel(member.guild.id, member.id);
    const level = existing ? existing.level : 0;

    await syncLevelRole(member.client, member.guild.id, member.id, level);
  },
};
