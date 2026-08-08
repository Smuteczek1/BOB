const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { syncLevelRole } = require('./levelRoles');

// --- Konfiguracja ---
const COOLDOWN_MINUTES = Number(process.env.XP_COOLDOWN_MINUTES ?? 1);
const CHAT_XP_MIN = Number(process.env.XP_CHAT_MIN ?? 5);
const CHAT_XP_MAX = Number(process.env.XP_CHAT_MAX ?? 10);
const VOICE_XP_MIN = Number(process.env.XP_VOICE_MIN ?? 5);
const VOICE_XP_MAX = Number(process.env.XP_VOICE_MAX ?? 10);

const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;

// Kamienie milowe - dokładnie te podane, a powyżej 900 co kolejne 100 ("itd.")
const EXPLICIT_MILESTONES = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900];
function isMilestone(level) {
  if (EXPLICIT_MILESTONES.includes(level)) return true;
  return level > 900 && level % 100 === 0;
}

function xpNeededForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelForXp(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpNeededForLevel(level + 1)) {
    remaining -= xpNeededForLevel(level + 1);
    level += 1;
  }
  return level;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function announceIfMilestone(client, guildId, userId, oldLevel, newLevel) {
  if (newLevel <= oldLevel) return;

  const milestonesHit = [];
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    if (isMilestone(lvl)) milestonesHit.push(lvl);
  }
  if (milestonesHit.length === 0) return;

  const config = await db.getGuildConfig(guildId);
  if (!config || !config.levels_channel_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(config.levels_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const topMilestone = milestonesHit[milestonesHit.length - 1];

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setDescription(`🎉 <@${userId}> osiągnął/osiągnęła **poziom ${topMilestone}**!`)
    .setTimestamp();

  await channel.send({ content: `<@${userId}>`, embeds: [embed] }).catch(() => null);
}

// Wywoływane przy każdej wiadomości na czacie (z cooldownem)
async function grantTextXp(client, message) {
  if (message.author.bot || !message.guild) return;

  const canGet = await db.canGetTextXp(message.guild.id, message.author.id, COOLDOWN_MS);
  if (!canGet) return;

  const amount = randomInt(CHAT_XP_MIN, CHAT_XP_MAX);
  const { oldLevel, newLevel } = await db.addXp(message.guild.id, message.author.id, amount, 'text', levelForXp);

  if (newLevel > oldLevel) {
    await syncLevelRole(client, message.guild.id, message.author.id, newLevel);
  }
  await announceIfMilestone(client, message.guild.id, message.author.id, oldLevel, newLevel);
}

// Wywoływane cyklicznie dla wszystkich połączonych z kanałami głosowymi
async function tickVoiceXp(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased?.() || channel.id === guild.afkChannelId) continue;

      for (const member of channel.members.values()) {
        if (member.user.bot) continue;

        const amount = randomInt(VOICE_XP_MIN, VOICE_XP_MAX);
        const { oldLevel, newLevel } = await db.addXp(guild.id, member.id, amount, 'voice', levelForXp);

        if (newLevel > oldLevel) {
          await syncLevelRole(client, guild.id, member.id, newLevel);
        }
        await announceIfMilestone(client, guild.id, member.id, oldLevel, newLevel);
      }
    }
  }
}

module.exports = {
  COOLDOWN_MINUTES,
  COOLDOWN_MS,
  isMilestone,
  xpNeededForLevel,
  levelForXp,
  grantTextXp,
  tickVoiceXp,
};
