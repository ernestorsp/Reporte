const core = require('./index.js');
const email = require('./email-functions.js');
const homeLog = require('./home-log-sync.js');
const homeRescue = require('./home-rescue-summary.js');
const consolidate = require('./consolidate-functions.js');
const bonusSchedule = require('./bonus-schedule-functions.js');
const bonusReport = require('./bonus-report-functions.js');
module.exports = {...core, ...email, ...homeLog, ...homeRescue, ...consolidate, ...bonusSchedule, ...bonusReport};
