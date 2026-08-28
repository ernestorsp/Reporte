const core = require('./index.js');
const email = require('./email-functions.js');
const homeLog = require('./home-log-sync.js');
module.exports = {...core, ...email, ...homeLog};
