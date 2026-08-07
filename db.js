const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // wbudowane w Node.js - nic nie trzeba kompilować

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));
// UWAGA: celowo NIE ustawiamy trybu WAL - dla jednoprocesowego bota to niepotrzebny narzut,
// a przy częstych zapisach plik "-wal" potrafi rosnąć bez ograniczeń, jeśli baza nie zdąży go
// "scalić" (checkpoint). Domyślny tryb DELETE jest prostszy i nie generuje dodatkowego pliku.

// Konfiguracja per serwer (guild_id jest kluczem - działamy po ID, nigdy po nazwie kanału)
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    hub_channel_id TEXT,           -- kanał głosowy "dołącz aby stworzyć nowy"
    stats_channel_id TEXT,         -- kanał tekstowy z rekordami
    leaderboard_message_id TEXT,   -- ID wiadomości z rankingiem (edytowanej na bieżąco)
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS temp_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    creator_id TEXT,
    started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    creator_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id);

  CREATE TABLE IF NOT EXISTS role_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    mode TEXT NOT NULL,            -- 'emoji' albo 'button'
    title TEXT,
    description TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS role_panel_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    emoji_key TEXT,     -- do dopasowania reakcji: ID emoji (custom) albo sam unicode znak
    emoji_raw TEXT,      -- oryginalny zapis emoji, do wyświetlania/przycisków
    label TEXT,          -- etykieta (np. nazwa roli) pokazywana w embedzie/na przycisku
    custom_id TEXT,       -- unikalny custom_id przycisku (tylko tryb 'button')
    position INTEGER,
    FOREIGN KEY (panel_id) REFERENCES role_panels(id)
  );

  CREATE INDEX IF NOT EXISTS idx_role_panel_items_panel ON role_panel_items(panel_id);

  CREATE TABLE IF NOT EXISTS user_levels (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    last_text_xp_at INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS level_roles (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,   -- od jakiego poziomu obowiązuje ta rola (0 = od dołączenia do serwera)
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS suggestion_boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    list_channel_id TEXT NOT NULL,
    create_channel_id TEXT NOT NULL,
    prompt_message_id TEXT,
    prompt_text TEXT,
    button_label TEXT,
    upvote_emoji TEXT,    -- emotka "za" (domyślnie ✅) - może być custom Discord: <:nazwa:id>
    downvote_emoji TEXT,  -- emotka "przeciw" (domyślnie ❌) - może być custom Discord: <:nazwa:id>
    created_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_suggestion_boards_guild ON suggestion_boards(guild_id);
  CREATE INDEX IF NOT EXISTS idx_suggestion_boards_create_channel ON suggestion_boards(create_channel_id);
`);

// Migracja: dogrywamy nowe kolumny do istniejących baz danych (np. z poprzedniej wersji bota),
// żeby nikt nie musiał kasować swojego data.sqlite.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('guild_config', 'suggestions_channel_id', 'TEXT'); // stare pole - zachowane dla kompatybilności wstecznej
ensureColumn('guild_config', 'suggestions_prompt_message_id', 'TEXT');
ensureColumn('guild_config', 'suggestions_list_channel_id', 'TEXT');   // kanał, gdzie lądują opublikowane propozycje
ensureColumn('guild_config', 'suggestions_create_channel_id', 'TEXT'); // kanał z samym przyciskiem "utwórz propozycję"
ensureColumn('guild_config', 'levels_channel_id', 'TEXT'); // kanał, na którym ogłaszane są kamienie milowe poziomów
ensureColumn('suggestion_boards', 'upvote_emoji', 'TEXT');   // dla baz stworzonych przed dodaniem custom emotek
ensureColumn('suggestion_boards', 'downvote_emoji', 'TEXT');

// Jednorazowa migracja danych: kto miał starą, pojedynczą wersję kanału propozycji (sprzed
// wprowadzenia wielu niezależnych tablic), dostaje ją automatycznie jako pierwszą tablicę
// propozycji w nowej tabeli suggestion_boards - żeby nic nie zniknęło po aktualizacji.
db.exec(`
  UPDATE guild_config
  SET suggestions_list_channel_id = suggestions_channel_id
  WHERE suggestions_channel_id IS NOT NULL AND suggestions_list_channel_id IS NULL
`);

(function migrateLegacySuggestionsConfigToBoards() {
  const rows = db.prepare(`
    SELECT guild_id, suggestions_list_channel_id, suggestions_create_channel_id, suggestions_prompt_message_id
    FROM guild_config
    WHERE suggestions_list_channel_id IS NOT NULL AND suggestions_create_channel_id IS NOT NULL
  `).all();

  for (const row of rows) {
    const alreadyMigrated = db.prepare(`
      SELECT 1 FROM suggestion_boards WHERE create_channel_id = ?
    `).get(row.suggestions_create_channel_id);

    if (!alreadyMigrated) {
      db.prepare(`
        INSERT INTO suggestion_boards (guild_id, list_channel_id, create_channel_id, prompt_message_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        row.guild_id,
        row.suggestions_list_channel_id,
        row.suggestions_create_channel_id,
        row.suggestions_prompt_message_id,
        Date.now(),
      );
    }
  }
})();

// Sprzątanie po usuniętym systemie kolorowych ról - jeśli tabela istnieje z poprzedniej
// wersji bota, kasujemy ją, żeby nie zajmowała miejsca i nie mylić przy przeglądaniu bazy.
db.exec('DROP TABLE IF EXISTS color_roles');

module.exports = {
  raw: db,

  // --- Konfiguracja serwera ---
  getGuildConfig(guildId) {
    return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  },

  upsertGuildConfig(guildId, { hubChannelId, statsChannelId }) {
    const existing = this.getGuildConfig(guildId);
    if (existing) {
      db.prepare(`
        UPDATE guild_config
        SET hub_channel_id = COALESCE(?, hub_channel_id),
            stats_channel_id = COALESCE(?, stats_channel_id)
        WHERE guild_id = ?
      `).run(hubChannelId ?? null, statsChannelId ?? null, guildId);
    } else {
      db.prepare(`
        INSERT INTO guild_config (guild_id, hub_channel_id, stats_channel_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(guildId, hubChannelId ?? null, statsChannelId ?? null, Date.now());
    }
  },

  setLeaderboardMessageId(guildId, messageId) {
    db.prepare('UPDATE guild_config SET leaderboard_message_id = ? WHERE guild_id = ?')
      .run(messageId, guildId);
  },

  // --- Kanały propozycji (STARE, pojedyncze - zachowane dla kompatybilności wstecznej,
  //     nowy kod powinien używać funkcji "Tablice propozycji" poniżej) ---
  setSuggestionsConfig(guildId, { listChannelId, createChannelId, promptMessageId }) {
    const existing = this.getGuildConfig(guildId);
    if (existing) {
      db.prepare(`
        UPDATE guild_config
        SET suggestions_list_channel_id = COALESCE(?, suggestions_list_channel_id),
            suggestions_create_channel_id = COALESCE(?, suggestions_create_channel_id),
            suggestions_prompt_message_id = COALESCE(?, suggestions_prompt_message_id)
        WHERE guild_id = ?
      `).run(listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, guildId);
    } else {
      db.prepare(`
        INSERT INTO guild_config (guild_id, suggestions_list_channel_id, suggestions_create_channel_id, suggestions_prompt_message_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(guildId, listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, Date.now());
    }
  },

  // --- Tablice propozycji (można mieć wiele niezależnych tablic na serwerze) ---
  createSuggestionBoard(guildId, { listChannelId, createChannelId, promptText, buttonLabel, upvoteEmoji, downvoteEmoji }) {
    db.prepare(`
      INSERT INTO suggestion_boards (guild_id, list_channel_id, create_channel_id, prompt_text, button_label, upvote_emoji, downvote_emoji, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      listChannelId,
      createChannelId,
      promptText ?? null,
      buttonLabel ?? null,
      upvoteEmoji ?? null,
      downvoteEmoji ?? null,
      Date.now(),
    );
    return db.prepare('SELECT * FROM suggestion_boards WHERE rowid = last_insert_rowid()').get();
  },

  setSuggestionBoardPromptMessageId(boardId, messageId) {
    db.prepare('UPDATE suggestion_boards SET prompt_message_id = ? WHERE id = ?').run(messageId, boardId);
  },

  getSuggestionBoard(boardId) {
    return db.prepare('SELECT * FROM suggestion_boards WHERE id = ?').get(boardId);
  },

  listSuggestionBoards(guildId) {
    return db.prepare('SELECT * FROM suggestion_boards WHERE guild_id = ? ORDER BY id').all(guildId);
  },

  deleteSuggestionBoard(boardId) {
    db.prepare('DELETE FROM suggestion_boards WHERE id = ?').run(boardId);
  },

  // --- Tymczasowe kanały głosowe ---
  addTempChannel(channelId, guildId, creatorId) {
    db.prepare(`
      INSERT INTO temp_channels (channel_id, guild_id, creator_id, started_at)
      VALUES (?, ?, ?, ?)
    `).run(channelId, guildId, creatorId, Date.now());
  },

  getTempChannel(channelId) {
    return db.prepare('SELECT * FROM temp_channels WHERE channel_id = ?').get(channelId);
  },

  removeTempChannel(channelId) {
    db.prepare('DELETE FROM temp_channels WHERE channel_id = ?').run(channelId);
  },

  getAllTempChannels() {
    return db.prepare('SELECT * FROM temp_channels').all();
  },

  // --- Sesje (zakończone rozmowy) ---
  addSession(guildId, channelId, creatorId, startedAt, endedAt) {
    const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    db.prepare(`
      INSERT INTO sessions (guild_id, channel_id, creator_id, started_at, ended_at, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, channelId, creatorId, startedAt, endedAt, durationSeconds);
    return durationSeconds;
  },

  getTopAllTime(guildId, limit = 5) {
    return db.prepare(`
      SELECT * FROM sessions WHERE guild_id = ?
      ORDER BY duration_seconds DESC LIMIT ?
    `).all(guildId, limit);
  },

  getTopThisMonth(guildId, limit = 5) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return db.prepare(`
      SELECT * FROM sessions
      WHERE guild_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY duration_seconds DESC LIMIT ?
    `).all(guildId, monthStart, monthEnd, limit);
  },

  // --- Panele ról (reakcje lub przyciski) ---
  createRolePanel(guildId, { channelId, mode, title, description }) {
    db.prepare(`
      INSERT INTO role_panels (guild_id, channel_id, mode, title, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, channelId, mode, title ?? null, description ?? null, Date.now());
    return db.prepare('SELECT * FROM role_panels WHERE rowid = last_insert_rowid()').get();
  },

  setRolePanelMessageId(panelId, messageId) {
    db.prepare('UPDATE role_panels SET message_id = ? WHERE id = ?').run(messageId, panelId);
  },

  getRolePanel(panelId) {
    return db.prepare('SELECT * FROM role_panels WHERE id = ?').get(panelId);
  },

  getRolePanelByMessageId(messageId) {
    return db.prepare('SELECT * FROM role_panels WHERE message_id = ?').get(messageId);
  },

  listRolePanels(guildId) {
    return db.prepare('SELECT * FROM role_panels WHERE guild_id = ? ORDER BY id').all(guildId);
  },

  deleteRolePanel(panelId) {
    db.prepare('DELETE FROM role_panel_items WHERE panel_id = ?').run(panelId);
    db.prepare('DELETE FROM role_panels WHERE id = ?').run(panelId);
  },

  addRolePanelItem(panelId, { roleId, emojiKey, emojiRaw, label, customId }) {
    const countRow = db.prepare('SELECT COUNT(*) as c FROM role_panel_items WHERE panel_id = ?').get(panelId);
    const position = countRow.c;
    db.prepare(`
      INSERT INTO role_panel_items (panel_id, role_id, emoji_key, emoji_raw, label, custom_id, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(panelId, roleId, emojiKey ?? null, emojiRaw ?? null, label ?? null, customId ?? null, position);
    return db.prepare('SELECT * FROM role_panel_items WHERE rowid = last_insert_rowid()').get();
  },

  removeRolePanelItemByRole(panelId, roleId) {
    db.prepare('DELETE FROM role_panel_items WHERE panel_id = ? AND role_id = ?').run(panelId, roleId);
  },

  getRolePanelItems(panelId) {
    return db.prepare('SELECT * FROM role_panel_items WHERE panel_id = ? ORDER BY position').all(panelId);
  },

  getRolePanelItemByEmojiKey(panelId, emojiKey) {
    return db.prepare('SELECT * FROM role_panel_items WHERE panel_id = ? AND emoji_key = ?').get(panelId, emojiKey);
  },

  getRolePanelItemByCustomId(customId) {
    return db.prepare('SELECT * FROM role_panel_items WHERE custom_id = ?').get(customId);
  },

  // --- Kanał poziomów (kamienie milowe) ---
  setLevelsChannel(guildId, channelId) {
    const existing = this.getGuildConfig(guildId);
    if (existing) {
      db.prepare('UPDATE guild_config SET levels_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
    } else {
      db.prepare(`
        INSERT INTO guild_config (guild_id, levels_channel_id, created_at)
        VALUES (?, ?, ?)
      `).run(guildId, channelId, Date.now());
    }
  },

  // --- System EXP ---
  getUserLevel(guildId, userId) {
    return db.prepare('SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  },

  canGetTextXp(guildId, userId, cooldownMs) {
    const row = this.getUserLevel(guildId, userId);
    if (!row || !row.last_text_xp_at) return true;
    return Date.now() - row.last_text_xp_at >= cooldownMs;
  },

  // Dodaje XP (z dowolnego źródła), aktualizuje "ostatnio dostał XP z czatu" tylko dla source='text'.
  // Zwraca { oldLevel, newLevel, xp } - do sprawdzenia, czy trzeba ogłosić kamień milowy.
  addXp(guildId, userId, amount, source, computeLevel) {
    const existing = this.getUserLevel(guildId, userId);
    const now = Date.now();

    if (!existing) {
      db.prepare(`
        INSERT INTO user_levels (guild_id, user_id, xp, level, last_text_xp_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(guildId, userId, amount, source === 'text' ? now : null);
    } else if (source === 'text') {
      db.prepare(`
        UPDATE user_levels SET xp = xp + ?, last_text_xp_at = ? WHERE guild_id = ? AND user_id = ?
      `).run(amount, now, guildId, userId);
    } else {
      db.prepare(`
        UPDATE user_levels SET xp = xp + ? WHERE guild_id = ? AND user_id = ?
      `).run(amount, guildId, userId);
    }

    const row = this.getUserLevel(guildId, userId);
    const oldLevel = row.level;
    const newLevel = computeLevel(row.xp);

    if (newLevel !== oldLevel) {
      db.prepare('UPDATE user_levels SET level = ? WHERE guild_id = ? AND user_id = ?').run(newLevel, guildId, userId);
    }

    return { oldLevel, newLevel, xp: row.xp };
  },

  getLeaderboardXp(guildId, limit = 10) {
    return db.prepare(`
      SELECT * FROM user_levels WHERE guild_id = ? ORDER BY xp DESC LIMIT ?
    `).all(guildId, limit);
  },

  // --- Drabinka ról za poziomy (automatyczne role: dołączenie = poziom 0, potem coraz wyższe) ---
  setLevelRole(guildId, level, roleId) {
    db.prepare(`
      INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id
    `).run(guildId, level, roleId);
  },

  removeLevelRole(guildId, level) {
    db.prepare('DELETE FROM level_roles WHERE guild_id = ? AND level = ?').run(guildId, level);
  },

  getLevelRoles(guildId) {
    return db.prepare('SELECT * FROM level_roles WHERE guild_id = ? ORDER BY level DESC').all(guildId);
  },
};
