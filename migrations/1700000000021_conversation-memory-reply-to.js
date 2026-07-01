/* eslint-disable camelcase */

exports.shorthands = undefined;

// Lets an owner reply to a specific earlier answer (not just the last one) so a
// follow-up question is grounded to that exact turn, even if it's outside the
// last-5-exchanges window normally sent to the model. Self-referencing FK;
// ON DELETE SET NULL so deleting the quoted turn doesn't cascade into this one.
exports.up = (pgm) => {
  pgm.addColumn('conversation_memory', {
    reply_to_memory_id: {
      type: 'uuid',
      references: 'conversation_memory',
      onDelete: 'SET NULL',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('conversation_memory', 'reply_to_memory_id');
};
