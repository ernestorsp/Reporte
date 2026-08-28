const core = require('./index.js');
const email = require('./email-functions.js');
const homeLog = require('./home-log-sync.js');
const consolidate = require('./consolidate-functions.js');
module.exports = {...core, ...email, ...homeLog, ...consolidate};
