const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');
const { levelForXp } = require('../utils/leveling');
const { syncLevelRole } = require('../utils/levelRoles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Odbierz swoją dzienną nagrodę XP (dostępne raz na 24h)!'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Sprawdzanie czy minęły 24h od ostatniego odbioru
    const canClaim = await db.canClaimDaily(guildId, userId);
    if (!canClaim) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą nagrodę! Wróć jutro.',
        ephemeral: true,
      });
      return;
    }

    // Losowanie Tieru Skrzyni (0.00 - 1.00)
    const roll = Math.random();
    let tier = '';
    let color = 0x000000;
    let minXp = 0;
    let maxXp = 0;

    if (roll < 0.60) {
      // 60% szans
      tier = '⚪ Zwykła Skrzynia';
      color = 0x95a5a6;
      minXp = 50;
      maxXp = 150;
    } else if (roll < 0.90) {
      // 30% szans
      tier = '🔵 Dobra Skrzynia';
      color = 0x3498db;
      minXp = 151;
      maxXp = 300;
    } else if (roll < 0.99) {
      // 9% szans
      tier = '🟣 Mityczna Skrzynia';
      color = 0x9b59b6;
      minXp = 301;
      maxXp = 500;
    } else {
      // 1% szans (Cud!)
      tier = '🟡 LEGENDARNA SKRZYNIA!';
      color = 0xf1c40f;
      minXp = 2500;
      maxXp = 5000;
    }

    const rewardXp = Math.floor(Math.random() * (maxXp - minXp + 1)) + minXp;

    // Zapis w bazie i dodanie XP
    await db.setDailyClaimed(guildId, userId);
    const { oldLevel, newLevel } = await db.addXp(guildId, userId, rewardXp, 'daily', levelForXp);

    if (newLevel > oldLevel) {
      await syncLevelRole(interaction.client, guildId, userId, newLevel);
    }

    const embed = new EmbedBuilder()
      .setTitle('🎁 Dzienny Prezent Odbierania XP')
      .setColor(color)
      .setDescription(
        `Udało Ci się wyciągnąć: **${tier}**!\n\n` +
        `✨ Twoja nagroda: **+${rewardXp} XP**\n` +
        (newLevel > oldLevel ? `🎉 **AWANS! Osiągnięto poziom ${newLevel}!**` : `Poziom: **${newLevel}**`)
      )
      .setFooter({ text: 'Możesz odebrać kolejną skrzynkę za 24 godziny!' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
