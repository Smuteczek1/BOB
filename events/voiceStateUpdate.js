const { ChannelType } = require('discord.js');
const db = require('../db');
const { updateLeaderboard } = require('../utils/leaderboard');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    const config = db.getGuildConfig(guild.id);
    if (!config) return;

    // --- 1) Ktoś DOŁĄCZYŁ do kanału "hub" -> tworzymy mu nowy, prywatny kanał i przenosimy go ---
    if (newState.channelId && newState.channelId === config.hub_channel_id) {
      await handleJoinHub(newState, guild);
    }

    // --- 2) Ktoś OPUŚCIŁ jakiś kanał -> sprawdzamy czy to tymczasowy kanał i czy jest teraz pusty ---
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await handlePossibleEmptyTempChannel(oldState.channelId, guild);
    }
  },
};

async function handleJoinHub(newState, guild) {
  const member = newState.member;
  const hubChannel = newState.channel;
  if (!hubChannel) return;

  try {
    const newChannel = await guild.channels.create({
      name: `🔊 Kanał ${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: hubChannel.parent ?? null, // ta sama kategoria co hub - respektuje jego aktualne położenie
      bitrate: hubChannel.bitrate,
      userLimit: hubChannel.userLimit,
      reason: `Tymczasowy kanał dla ${member.user.tag}`,
    });

    db.addTempChannel(newChannel.id, guild.id, member.id);

    await member.voice.setChannel(newChannel).catch(() => null);
  } catch (err) {
    console.error('Nie udało się utworzyć tymczasowego kanału:', err);
  }
}

async function handlePossibleEmptyTempChannel(channelId, guild) {
  const tempInfo = db.getTempChannel(channelId);
  if (!tempInfo) return; // to nie jest nasz tymczasowy kanał

  const channel = await guild.channels.fetch(channelId).catch(() => null);

  // Jeśli kanał już nie istnieje (np. ktoś usunął ręcznie) - po prostu sprzątamy wpis
  if (!channel) {
    db.removeTempChannel(channelId);
    return;
  }

  if (channel.members.size === 0) {
    const startedAt = tempInfo.started_at;
    const endedAt = Date.now();

    db.addSession(guild.id, channelId, tempInfo.creator_id, startedAt, endedAt);
    db.removeTempChannel(channelId);

    await channel.delete('Tymczasowy kanał opustoszał').catch(() => null);
    await updateLeaderboard(guild.client, guild.id);
  }
}
