const { Pool } = require('pg');

// Utworzenie puli połączeń do bazy PostgreSQL/Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Pomocnicze funkcje do wykonywania zapytań SQL
async function query(text, params) {
  return await pool.query(text, params);
}

async function queryOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function queryMany(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// Inicjalizacja struktur bazy danych
async function initDb() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        hub_channel_id TEXT,
        stats_channel_id TEXT,
        leaderboard_message_id TEXT,
        suggestions_channel_id TEXT,
        suggestions_prompt_message_id TEXT,
        suggestions_list_channel_id TEXT,
        suggestions_create_channel_id TEXT,
        levels_channel_id TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS temp_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        creator_id TEXT,
        started_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        creator_id TEXT,
        started_at BIGINT NOT NULL,
        ended_at BIGINT NOT NULL,
        duration_seconds INT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id);

      CREATE TABLE IF NOT EXISTS role_panels (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        mode TEXT NOT NULL,
        title TEXT,
        description TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS role_panel_items (
        id SERIAL PRIMARY KEY,
        panel_id INT NOT NULL REFERENCES role_panels(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL,
        emoji_key TEXT,
        emoji_raw TEXT,
        label TEXT,
        custom_id TEXT,
        position INT
      );

      CREATE INDEX IF NOT EXISTS idx_role_panel_items_panel ON role_panel_items(panel_id);

      CREATE TABLE IF NOT EXISTS user_levels (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INT NOT NULL DEFAULT 0,
        level INT NOT NULL DEFAULT 0,
        last_text_xp_at BIGINT,
        last_daily_at BIGINT,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS level_roles (
        guild_id TEXT NOT NULL,
        level INT NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, level)
      );

      CREATE TABLE IF NOT EXISTS suggestion_boards (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        list_channel_id TEXT NOT NULL,
        create_channel_id TEXT NOT NULL,
        prompt_message_id TEXT,
        prompt_text TEXT,
        button_label TEXT,
        upvote_emoji TEXT,
        downvote_emoji TEXT,
        created_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_suggestion_boards_guild ON suggestion_boards(guild_id);
      CREATE INDEX IF NOT EXISTS idx_suggestion_boards_create_channel ON suggestion_boards(create_channel_id);
    `);

    // Bezpieczne dodanie kolumny last_daily_at, jeśli tabela user_levels już istniała bez niej
    await query(`
      ALTER TABLE user_levels ADD COLUMN IF NOT EXISTS last_daily_at BIGINT;
    `);

    console.log('✅ Baza danych Supabase (PostgreSQL) została pomyślnie zainicjalizowana.');
  } catch (err) {
    console.error('❌ Błąd podczas inicjalizacji bazy PostgreSQL:', err);
  }
}

initDb();

module.exports = {
  raw: pool,

  // --- Konfiguracja serwera ---
  async getGuildConfig(guildId) {
    return await queryOne('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
  },

  async upsertGuildConfig(guildId, { hubChannelId, statsChannelId }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET hub_channel_id = COALESCE($1, hub_channel_id),
            stats_channel_id = COALESCE($2, stats_channel_id)
        WHERE guild_id = $3
      `, [hubChannelId ?? null, statsChannelId ?? null, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, hub_channel_id, stats_channel_id, created_at)
        VALUES ($1, $2, $3, $4)
      `, [guildId, hubChannelId ?? null, statsChannelId ?? null, Date.now()]);
    }
  },

  async setLeaderboardMessageId(guildId, messageId) {
    await query('UPDATE guild_config SET leaderboard_message_id = $1 WHERE guild_id = $2', [messageId, guildId]);
  },

  // --- Kanały propozycji (stare) ---
  async setSuggestionsConfig(guildId, { listChannelId, createChannelId, promptMessageId }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET suggestions_list_channel_id = COALESCE($1, suggestions_list_channel_id),
            suggestions_create_channel_id = COALESCE($2, suggestions_create_channel_id),
            suggestions_prompt_message_id = COALESCE($3, suggestions_prompt_message_id)
        WHERE guild_id = $4
      `, [listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, suggestions_list_channel_id, suggestions_create_channel_id, suggestions_prompt_message_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [guildId, listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, Date.now()]);
    }
  },

  // --- Tablice propozycji ---
  async createSuggestionBoard(guildId, { listChannelId, createChannelId, promptText, buttonLabel, upvoteEmoji, downvoteEmoji }) {
    const res = await queryOne(`
      INSERT INTO suggestion_boards (guild_id, list_channel_id, create_channel_id, prompt_text, button_label, upvote_emoji, downvote_emoji, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      guildId,
      listChannelId,
      createChannelId,
      promptText ?? null,
      buttonLabel ?? null,
      upvoteEmoji ?? null,
      downvoteEmoji ?? null,
      Date.now(),
    ]);
    return res;
  },

  async setSuggestionBoardPromptMessageId(boardId, messageId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return;
    await query('UPDATE suggestion_boards SET prompt_message_id = $1 WHERE id = $2', [messageId, parsedId]);
  },

  async getSuggestionBoard(boardId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return null;
    return await queryOne('SELECT * FROM suggestion_boards WHERE id = $1', [parsedId]);
  },

  async listSuggestionBoards(guildId) {
    return await queryMany('SELECT * FROM suggestion_boards WHERE guild_id = $1 ORDER BY id', [guildId]);
  },

  async deleteSuggestionBoard(boardId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return;
    await query('DELETE FROM suggestion_boards WHERE id = $1', [parsedId]);
  },

  // --- Tymczasowe kanały głosowe ---
  async addTempChannel(channelId, guildId, creatorId) {
    await query(`
      INSERT INTO temp_channels (channel_id, guild_id, creator_id, started_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel_id) DO NOTHING
    `, [channelId, guildId, creatorId, Date.now()]);
  },

  async getTempChannel(channelId) {
    return await queryOne('SELECT * FROM temp_channels WHERE channel_id = $1', [channelId]);
  },

  async removeTempChannel(channelId) {
    await query('DELETE FROM temp_channels WHERE channel_id = $1', [channelId]);
  },

  async getAllTempChannels() {
    return await queryMany('SELECT * FROM temp_channels');
  },

  // --- Sesje ---
  async addSession(guildId, channelId, creatorId, startedAt, endedAt) {
    const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    await query(`
      INSERT INTO sessions (guild_id, channel_id, creator_id, started_at, ended_at, duration_seconds)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [guildId, channelId, creatorId, startedAt, endedAt, durationSeconds]);
    return durationSeconds;
  },

  async getTopAllTime(guildId, limit = 5) {
    return await queryMany(`
      SELECT * FROM sessions WHERE guild_id = $1
      ORDER BY duration_seconds DESC LIMIT $2
    `, [guildId, limit]);
  },

  async getTopThisMonth(guildId, limit = 5) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return await queryMany(`
      SELECT * FROM sessions
      WHERE guild_id = $1 AND started_at >= $2 AND started_at < $3
      ORDER BY duration_seconds DESC LIMIT $4
    `, [guildId, monthStart, monthEnd, limit]);
  },

  // --- Panele ról ---
  async createRolePanel(guildId, { channelId, mode, title, description }) {
    return await queryOne(`
      INSERT INTO role_panels (guild_id, channel_id, mode, title, description, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [guildId, channelId, mode, title ?? null, description ?? null, Date.now()]);
  },

  async setRolePanelMessageId(panelId, messageId) {
    await query('UPDATE role_panels SET message_id = $1 WHERE id = $2', [messageId, panelId]);
  },

  async getRolePanel(panelId) {
    return await queryOne('SELECT * FROM role_panels WHERE id = $1', [panelId]);
  },

  async getRolePanelByMessageId(messageId) {
    return await queryOne('SELECT * FROM role_panels WHERE message_id = $1', [messageId]);
  },

  async listRolePanels(guildId) {
    return await queryMany('SELECT * FROM role_panels WHERE guild_id = $1 ORDER BY id', [guildId]);
  },

  async deleteRolePanel(panelId) {
    await query('DELETE FROM role_panel_items WHERE panel_id = $1', [panelId]);
    await query('DELETE FROM role_panels WHERE id = $1', [panelId]);
  },

  async addRolePanelItem(panelId, { roleId, emojiKey, emojiRaw, label, customId }) {
    const countRow = await queryOne('SELECT COUNT(*)::int as c FROM role_panel_items WHERE panel_id = $1', [panelId]);
    const position = countRow ? countRow.c : 0;
    return await queryOne(`
      INSERT INTO role_panel_items (panel_id, role_id, emoji_key, emojiRaw, label, custom_id, position)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [panelId, roleId, emojiKey ?? null, emojiRaw ?? null, label ?? null, customId ?? null, position]);
  },

  async removeRolePanelItemByRole(panelId, roleId) {
    await query('DELETE FROM role_panel_items WHERE panel_id = $1 AND role_id = $2', [panelId, roleId]);
  },

  async getRolePanelItems(panelId) {
    return await queryMany('SELECT * FROM role_panel_items WHERE panel_id = $1 ORDER BY position', [panelId]);
  },

  async getRolePanelItemByEmojiKey(panelId, emojiKey) {
    return await queryOne('SELECT * FROM role_panel_items WHERE panel_id = $1 AND emoji_key = $2', [panelId, emojiKey]);
  },

  async getRolePanelItemByCustomId(customId) {
    return await queryOne('SELECT * FROM role_panel_items WHERE custom_id = $1', [customId]);
  },

  // --- Kanał poziomów ---
  async setLevelsChannel(guildId, channelId) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query('UPDATE guild_config SET levels_channel_id = $1 WHERE guild_id = $2', [channelId, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, levels_channel_id, created_at)
        VALUES ($1, $2, $3)
      `, [guildId, channelId, Date.now()]);
    }
  },

  // --- System EXP ---
  async getUserLevel(guildId, userId) {
    return await queryOne('SELECT * FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  },

  async canGetTextXp(guildId, userId, cooldownMs) {
    const row = await this.getUserLevel(guildId, userId);
    if (!row || !row.last_text_xp_at) return true;
    return Date.now() - Number(row.last_text_xp_at) >= cooldownMs;
  },

  async addXp(guildId, userId, amount, source, computeLevel) {
    const existing = await this.getUserLevel(guildId, userId);
    const now = Date.now();

    if (!existing) {
      await query(`
        INSERT INTO user_levels (guild_id, user_id, xp, level, last_text_xp_at)
        VALUES ($1, $2, $3, 0, $4)
      `, [guildId, userId, amount, source === 'text' ? now : null]);
    } else if (source === 'text') {
      await query(`
        UPDATE user_levels SET xp = xp + $1, last_text_xp_at = $2 WHERE guild_id = $3 AND user_id = $4
      `, [amount, now, guildId, userId]);
    } else {
      await query(`
        UPDATE user_levels SET xp = xp + $1 WHERE guild_id = $2 AND user_id = $3
      `, [amount, guildId, userId]);
    }

    const row = await this.getUserLevel(guildId, userId);
    const oldLevel = row.level;
    const newLevel = computeLevel(row.xp);

    if (newLevel !== oldLevel) {
      await query('UPDATE user_levels SET level = $1 WHERE guild_id = $2 AND user_id = $3', [newLevel, guildId, userId]);
    }

    return { oldLevel, newLevel, xp: row.xp };
  },

  async getLeaderboardXp(guildId, limit = 10) {
    return await queryMany(`
      SELECT * FROM user_levels WHERE guild_id = $1 ORDER BY xp DESC LIMIT $2
    `, [guildId, limit]);
  },

  // --- NAGRODA DZIENNA (Daily XP) ---
  async canClaimDaily(guildId, userId) {
    const row = await this.getUserLevel(guildId, userId);
    if (!row || !row.last_daily_at) return true;

    const lastClaimDate = new Date(Number(row.last_daily_at));
    const now = new Date();

    // Reset następuje o północy (inny dzień kalendarzowy, miesiąc lub rok)
    const isNewDay = 
      now.getFullYear() > lastClaimDate.getFullYear() ||
      now.getMonth() > lastClaimDate.getMonth() ||
      now.getDate() > lastClaimDate.getDate();

    return isNewDay;
  },

  async setDailyClaimed(guildId, userId) {
    const now = Date.now();
    const existing = await this.getUserLevel(guildId, userId);

    if (!existing) {
      await query(`
        INSERT INTO user_levels (guild_id, user_id, xp, level, last_daily_at)
        VALUES ($1, $2, 0, 0, $3)
      `, [guildId, userId, now]);
    } else {
      await query(`
        UPDATE user_levels SET last_daily_at = $1 WHERE guild_id = $2 AND user_id = $3
      `, [now, guildId, userId]);
    }
  },

  // --- Drabinka ról za poziomy ---
  async setLevelRole(guildId, level, roleId) {
    await query(`
      INSERT INTO level_roles (guild_id, level, role_id) VALUES ($1, $2, $3)
      ON CONFLICT(guild_id, level) DO UPDATE SET role_id = EXCLUDED.role_id
    `, [guildId, level, roleId]);
  },

  async removeLevelRole(guildId, level) {
    await query('DELETE FROM level_roles WHERE guild_id = $1 AND level = $2', [level, guildId]);
  },

  async getLevelRoles(guildId) {
    return await queryMany('SELECT * FROM level_roles WHERE guild_id = $1 ORDER BY level DESC', [guildId]);
  },
};
