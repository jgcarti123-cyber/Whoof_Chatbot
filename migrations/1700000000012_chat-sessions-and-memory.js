/* eslint-disable camelcase */

// Adds two things:
//
// 1. Chat sessions — each "chat" is now a conversation_session that groups
//    conversation_memory rows. Lets the owner start a fresh chat and switch
//    between past ones, instead of one endless thread per pet.
//
// 2. Long-term pet memory — pet_memory holds a compacted digest of the important
//    facts learned across ALL of a pet's chats. It's injected into every prompt
//    so the assistant "remembers" across sessions, and is re-compacted by the
//    fast model when it grows past a size budget (see lib/memory.js).

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── conversation_session ─────────────────────────────────────────────────
  pgm.createTable('conversation_session', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    pet_id: {
      type: 'uuid',
      notNull: true,
      references: 'pet_profile',
      onDelete: 'CASCADE',
    },
    title: { type: 'text', notNull: true, default: 'New chat' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Sidebar query is "sessions for this pet, most recent first".
  pgm.createIndex('conversation_session', ['pet_id', 'updated_at']);

  // ── link each memory to a session ────────────────────────────────────────
  pgm.addColumn('conversation_memory', {
    session_id: {
      type: 'uuid',
      references: 'conversation_session',
      onDelete: 'CASCADE',
    },
  });
  pgm.createIndex('conversation_memory', ['session_id', 'created_at']);

  // Backfill: roll each pet's existing flat history into one "Earlier conversation"
  // session so nothing is orphaned and the old thread is still reachable.
  pgm.sql(`
    INSERT INTO conversation_session (pet_id, title, created_at, updated_at)
    SELECT pet_id, 'Earlier conversation', MIN(created_at), MAX(created_at)
    FROM conversation_memory
    GROUP BY pet_id;
  `);
  pgm.sql(`
    UPDATE conversation_memory cm
    SET session_id = cs.id
    FROM conversation_session cs
    WHERE cm.pet_id = cs.pet_id AND cm.session_id IS NULL;
  `);

  // ── pet_memory — one rolling long-term digest per pet ────────────────────
  pgm.createTable('pet_memory', {
    pet_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'pet_profile',
      onDelete: 'CASCADE',
    },
    digest: { type: 'text', notNull: true, default: '' },
    // created_at of the most recent turn already folded into the digest, so
    // compaction only processes new turns.
    digest_through: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('pet_memory');
  pgm.dropIndex('conversation_memory', ['session_id', 'created_at']);
  pgm.dropColumn('conversation_memory', 'session_id');
  pgm.dropTable('conversation_session');
};
