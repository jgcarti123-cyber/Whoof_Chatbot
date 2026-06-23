/* eslint-disable camelcase */

// Lets a chat be pinned to the top of the sidebar.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('conversation_session', {
    pinned: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('conversation_session', 'pinned');
};
