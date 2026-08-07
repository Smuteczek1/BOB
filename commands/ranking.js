const { SlashCommandBuilder } = require('discord.js');
const { buildLeaderboardEmbed, updateLeaderboard } = require('../utils/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Pokazuje aktualny ranking najdłuższych rozmów głosowych (top 5 ogólnie i z tego miesiąca).'),

  async execute(interaction) {
    await interaction.deferReply();
    const embed = buildLeaderboardEmbed(interaction.guild);
    await interaction.editReply({ embeds: [embed] });
    // Odświeżamy też "stały" ranking na kanale statystyk, jeśli jest skonfigurowany
    await updateLeaderboard(interaction.client, interaction.guild.id);
  },
};
