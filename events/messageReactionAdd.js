const { handleReactionToggle } = require('../utils/rolePanels');
const { handleVerifyReaction } = require('../utils/verification');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    await handleReactionToggle(reaction, user, true);
    await handleVerifyReaction(reaction, user);
  },
};
