'use strict';

module.exports = function requireAuth(req, res, next) {
  if (!req.session?.ownerId) {
    return res.redirect('/login');
  }
  next();
};
