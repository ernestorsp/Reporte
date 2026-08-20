const CONFIG = {
  REPORT_SPREADSHEET_ID: '1082Ol2ib76P943KZsNVBtRZF_Ia2xoIExnYdYj8AOB8',
  LOG_SPREADSHEET_ID: '1Hh-SaxsOQaBRadK7M1k-FWehlbi_s5CvZDAsluSF4ZU',
  EMAIL_SHEET: 'EMAIL',
  INFRA_SHEET: 'INFRA_LOG',
  RESCUES_SHEET: 'RESCUES_LOG',
  DATA_SHEET: '_REPORT_DATA',
  UPLOAD_SHEET: '_UPLOADS',
  SEND_SHEET: '_SEND_LOG',
  STATIONS: ['DJX3', 'DJX4'],
  POINTS: {
    PACKAGE: 0.15,
    RESCUE: 0.15,
    COMPLAINT: -20,
    INFRACTION: -50,
    DVIC: -50,
    LATE_MORNING: -10,
    NCNS: -20,
    CO: -15
  }
};

function doGet() {
  ensureStorage_();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Reporte de Drivers')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getBootstrapData() {
  ensureStorage_();
  const week = getLatestWeek_();
  return buildDashboard_(week);
}

function getDashboard(week) {
  ensureStorage_();
  return buildDashboard_(week || getLatestWeek_());
}

function uploadReportFile(payload) {
  ensureStorage_();
  if (!payload || !payload.name || !payload.base64) throw new Error('Archivo inválido.');

  const meta = detectFileMeta_(payload.name);
  if (!meta.station) throw new Error('No pude identificar DJX3 o DJX4 en el nombre del archivo.');
  if (!meta.week) throw new Error('No pude identificar la semana (ej. 2026-W33) en el nombre del archivo.');
  if (!meta.type) throw new Error('No pude identificar el tipo de documento por el nombre del archivo.');

  const bytes = Utilities.base64Decode(payload.base64);
  const blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', payload.name);
  let rows;
  let tempId = null;

  try {
    if (/\.csv$/i.test(payload.name)) {
      rows = Utilities.parseCsv(blob.getDataAsString());
    } else if (/\.xlsx?$/i.test(payload.name)) {
      const converted = Drive.Files.insert({title: 'TMP_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS}, blob, {convert: true});
      tempId = converted.id;
      const ss = SpreadsheetApp.openById(tempId);
      rows = ss.getSheets()[0].getDataRange().getDisplayValues();
    } else {
      throw new Error('Formato no soportado. Usa CSV, XLS o XLSX.');
    }

    if (!rows || rows.length < 2) throw new Error('El archivo no contiene datos suficientes.');
    const normalized = normalizeUploadedRows_(rows, meta);
    replaceSourceData_(meta, normalized);
    recordUpload_(meta, payload.name, normalized.length, 'LOADED');
    return buildDashboard_(meta.week);
  } catch (err) {
    recordUpload_(meta, payload.name, 0, 'ERROR', err.message);
    throw err;
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) {}
    }
  }
}

function sendDriverReport(request) {
  ensureStorage_();
  const week = request.week || getLatestWeek_();
  const driverKey = request.driverKey;
  if (!driverKey) throw new Error('Driver inválido.');

  const report = buildDriverReport_(week, driverKey);
  if (!report.email) throw new Error('No hay email disponible para ' + report.name + '.');

  MailApp.sendEmail({
    to: report.email,
    subject: 'Reporte semanal - ' + week,
    htmlBody: renderDriverEmail_(report),
    name: 'Reporte de Performance'
  });
  recordSend_(week, driverKey, report.name, report.email);
  return {ok: true, driverKey: driverKey, sentAt: new Date().toISOString()};
}

function sendDriverReports(request) {
  const week = request.week || getLatestWeek_();
  const keys = request.driverKeys || [];
  const results = [];
  keys.forEach(function(key) {
    try {
      results.push(sendDriverReport({week: week, driverKey: key}));
    } catch (e) {
      results.push({ok: false, driverKey: key, error: e.message});
    }
  });
  return {results: results, dashboard: buildDashboard_(week)};
}

function buildDashboard_(week) {
  const weeks = getWeeks_();
  if (!week) return {week: '', weeks: weeks, uploads: [], stations: {}, home: emptyHome_()};

  const data = readData_(week);
  const logs = readOperationalLogs_(week);
  const sentMap = readSendMap_(week);
  const emails = readEmailDirectory_();
  const drivers = aggregateDrivers_(data, logs, emails, sentMap);

  const stations = {};
  CONFIG.STATIONS.forEach(function(station) {
    const list = drivers.filter(function(d) { return d.stations.indexOf(station) !== -1; })
      .map(function(d) { return stationView_(d, station); })
      .sort(compareDrivers_);
    stations[station] = list;
  });

  return {
    week: week,
    weeks: weeks,
    uploads: uploadStatus_(week),
    stations: stations,
    home: buildHome_(stations),
    totals: {
      drivers: drivers.length,
      sent: drivers.filter(function(d) { return d.sent; }).length,
      pending: drivers.filter(function(d) { return !d.sent; }).length
    }
  };
}

function normalizeUploadedRows_(rows, meta) {
  const headers = rows[0].map(cleanHeader_);
  const out = [];
  const idx = indexHeaders_(headers);

  rows.slice(1).forEach(function(row) {
    if (row.join('').trim() === '') return;
    const rec = function(names) { return firstValue_(row, idx, names); };
    const name = rec(['delivery associate', 'driver', 'transporter name', 'transporter_name', 'name']);
    const transporterId = rec(['transporter id', 'transporterid', 'transporter_id']);
    const driverKey = transporterId || normalizeName_(name);
    if (!driverKey) return;

    if (meta.type === 'OVERVIEW') {
      out.push(baseRecord_(meta, driverKey, name, transporterId, 'OVERVIEW', '', '', {
        standing: rec(['overall standing']),
        overallScore: toNumber_(rec(['overall score'])),
        packages: toNumber_(rec(['packages delivered']))
      }));
      return;
    }

    if (meta.type === 'SAFETY') {
      const date = rec(['date station local time', 'date (station local time)', 'date']);
      const type = rec(['metric type']);
      if (type) out.push(baseRecord_(meta, driverKey, name, transporterId, 'INFRACTION', date, type, {}));
      return;
    }

    if (meta.type === 'CDF') {
      const date = rec(['delivery date', 'date']);
      const details = rec(['feedback details']);
      const ignored = ['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','feedback details','delivery date','station'];
      headers.forEach(function(h, i) {
        if (!h || ignored.indexOf(h) !== -1) return;
        if (isTruthyFlag_(row[i])) {
          out.push(baseRecord_(meta, driverKey, name, transporterId, 'COMPLAINT', date, headers[0] ? originalHeader_(rows[0][i]) : h, {details: details}));
        }
      });
      return;
    }

    if (meta.type === 'DSB') {
      const impacts = rec(['impacts scorecard']);
      if (!isTruthyFlag_(impacts)) return;
      const date = rec(['delivery date', 'date']);
      const skip = ['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','delivery date','impacts scorecard','station'];
      headers.forEach(function(h, i) {
        if (!h || skip.indexOf(h) !== -1) return;
        if (isTruthyFlag_(row[i])) out.push(baseRecord_(meta, driverKey, name, transporterId, 'DSB', date, originalHeader_(rows[0][i]), {}));
      });
      return;
    }

    if (meta.type === 'PSB') {
      const failed = toNumber_(rec(['failed stops']));
      if (failed > 0) out.push(baseRecord_(meta, driverKey, name, transporterId, 'FAILED_PICKUP', '', 'Failed Pickups', {count: failed}));
      return;
    }

    if (meta.type === 'DVIC') {
      const date = rec(['start date', 'start_date', 'date']);
      const inspection = rec(['inspection type', 'inspection_type']) || 'Pre-Trip';
      const duration = toNumber_(rec(['duration']));
      out.push(baseRecord_(meta, driverKey, name, transporterId, 'DVIC', date, inspection, {duration: duration}));
    }
  });
  return out;
}

function aggregateDrivers_(data, logs, emails, sentMap) {
  const map = {};
  function get(r) {
    const key = r.driverKey;
    if (!map[key]) map[key] = newDriver_(key, r.name, r.transporterId);
    if (!map[key].name && r.name) map[key].name = r.name;
    if (!map[key].transporterId && r.transporterId) map[key].transporterId = r.transporterId;
    return map[key];
  }

  data.forEach(function(r) {
    const d = get(r);
    if (r.station && d.stations.indexOf(r.station) === -1) d.stations.push(r.station);
    const s = d.byStation[r.station] || (d.byStation[r.station] = newStationStats_());
    switch (r.kind) {
      case 'OVERVIEW':
        s.packages = Number(r.extra.packages || 0);
        s.overallScore = Number(r.extra.overallScore || 0);
        s.overallStanding = r.extra.standing || '';
        break;
      case 'INFRACTION': s.infractions.push({date:r.date, type:r.label}); break;
      case 'COMPLAINT': s.complaints.push({date:r.date, type:r.label, details:r.extra.details || ''}); break;
      case 'DSB': s.dsb.push({date:r.date, category:r.label}); break;
      case 'FAILED_PICKUP': s.failedPickups += Number(r.extra.count || 0); break;
      case 'DVIC': s.dvic.push({date:r.date, type:r.label, duration:r.extra.duration || 0}); break;
    }
  });

  logs.forEach(function(r) {
    const d = get(r);
    if (r.kind === 'ATTENDANCE') d.attendance.push(r);
    if (r.kind === 'RESCUE') d.rescues.push(r);
  });

  Object.keys(map).forEach(function(key) {
    const d = map[key];
    const emailRec = emails.byId[d.transporterId] || emails.byName[normalizeName_(d.name)] || {};
    d.email = emailRec.email || '';
    d.status = emailRec.status || '';
    d.sent = !!sentMap[key];
    d.sentAt = sentMap[key] || '';
    calculateDriverPoints_(d);
  });
  return Object.keys(map).map(function(k){ return map[k]; });
}

function calculateDriverPoints_(d) {
  let packages = 0, packagePoints = 0, complaintPoints = 0, infractionPoints = 0, dvicPoints = 0;
  Object.keys(d.byStation).forEach(function(st) {
    const s = d.byStation[st];
    packages += s.packages;
    packagePoints += s.packages * CONFIG.POINTS.PACKAGE;
    complaintPoints += s.complaints.length * CONFIG.POINTS.COMPLAINT;
    infractionPoints += s.infractions.length * CONFIG.POINTS.INFRACTION;
    dvicPoints += s.dvic.length * CONFIG.POINTS.DVIC;
  });
  let attendancePoints = 0;
  d.attendance.forEach(function(a) {
    if (a.category === 'LATE MORNING') attendancePoints += CONFIG.POINTS.LATE_MORNING;
    if (a.category === 'NCNS') attendancePoints += CONFIG.POINTS.NCNS;
    if (a.category === 'CO') attendancePoints += CONFIG.POINTS.CO;
  });
  let rescuePoints = 0;
  d.rescues.forEach(function(r) {
    const points = (Number(r.stops||0) + Number(r.packages||0)) * CONFIG.POINTS.RESCUE;
    rescuePoints += r.positive ? points : (r.affects ? -points : 0);
  });
  const total = packagePoints + rescuePoints + complaintPoints + infractionPoints + dvicPoints + attendancePoints;
  d.points = round2_(total);
  d.category = categoryForPoints_(total);
  d.packages = packages;
  d.breakdown = {
    packagePoints: round2_(packagePoints), rescuePoints: round2_(rescuePoints), complaintPoints: complaintPoints,
    infractionPoints: infractionPoints, dvicPoints: dvicPoints, attendancePoints: attendancePoints
  };
}

function stationView_(d, station) {
  const s = d.byStation[station] || newStationStats_();
  const localBase = (s.packages * CONFIG.POINTS.PACKAGE) + (s.complaints.length * CONFIG.POINTS.COMPLAINT) +
    (s.infractions.length * CONFIG.POINTS.INFRACTION) + (s.dvic.length * CONFIG.POINTS.DVIC);
  return {
    driverKey: d.driverKey, name: d.name, transporterId: d.transporterId, email: d.email, status: d.status,
    station: station, stations: d.stations, points: d.points, category: d.category, stationPoints: round2_(localBase),
    packages: s.packages, overallScore: s.overallScore, complaints: s.complaints, infractions: s.infractions,
    dsb: s.dsb, failedPickups: s.failedPickups, dvic: s.dvic, attendance: d.attendance, rescues: d.rescues,
    sent: d.sent, sentAt: d.sentAt
  };
}

function buildHome_(stations) {
  const home = {};
  CONFIG.STATIONS.forEach(function(station) {
    const list = stations[station] || [];
    home[station] = {
      top: list.slice().sort(compareDrivers_).slice(0, 10),
      complaints: list.slice().sort(function(a,b){ return b.complaints.length - a.complaints.length; }).filter(function(x){return x.complaints.length;}).slice(0,10),
      rescues: list.slice().map(function(x){
        const received = x.rescues.filter(function(r){return r.affects && !r.positive;});
        const total = received.reduce(function(sum,r){return sum + Number(r.stops||0) + Number(r.packages||0);},0);
        return {driverKey:x.driverKey,name:x.name,count:received.length,volume:total};
      }).filter(function(x){return x.count>0;}).sort(function(a,b){return b.volume-a.volume;}).slice(0,5)
    };
  });
  return home;
}

function readOperationalLogs_(week) {
  const bounds = weekBounds_(week);
  const ss = SpreadsheetApp.openById(CONFIG.LOG_SPREADSHEET_ID);
  const out = [];

  const infra = sheetObjects_(ss.getSheetByName(CONFIG.INFRA_SHEET));
  infra.forEach(function(r) {
    const date = parseLooseDate_(getObj_(r, ['date']));
    if (!date || date < bounds.start || date > bounds.end) return;
    const category = String(getObj_(r,['category']) || '').trim().toUpperCase();
    if (['CO','NCNS','LATE MORNING'].indexOf(category) === -1) return;
    const name = getObj_(r,['driver']);
    out.push({kind:'ATTENDANCE', driverKey:normalizeName_(name), name:name, transporterId:'', date:formatDate_(date), category:category});
  });

  const rescues = sheetObjects_(ss.getSheetByName(CONFIG.RESCUES_SHEET));
  rescues.forEach(function(r) {
    const date = parseLooseDate_(getObj_(r,['date']));
    if (!date || date < bounds.start || date > bounds.end) return;
    const name = getObj_(r,['driver']);
    const affectsRaw = String(getObj_(r,['affects']) || '').trim().toUpperCase();
    const notes = String(getObj_(r,['notes']) || '');
    const positive = affectsRaw === 'POSITIVE' || /\bPOSITIVE\b/i.test(notes);
    out.push({kind:'RESCUE', driverKey:normalizeName_(name), name:name, transporterId:'', date:formatDate_(date),
      stops:toNumber_(getObj_(r,['stop','stops'])), packages:toNumber_(getObj_(r,['packages'])),
      affects:affectsRaw === 'YES' || affectsRaw === 'SI' || affectsRaw === 'SÍ', positive:positive});
  });
  return out;
}

function buildDriverReport_(week, driverKey) {
  const dashboard = buildDashboard_(week);
  let found = null;
  CONFIG.STATIONS.some(function(st) {
    found = (dashboard.stations[st] || []).filter(function(x){return x.driverKey === driverKey;})[0] || null;
    return !!found;
  });
  if (!found) throw new Error('No encontré el driver para esta semana.');
  const stationData = {};
  CONFIG.STATIONS.forEach(function(st){
    const x = (dashboard.stations[st] || []).filter(function(d){return d.driverKey === driverKey;})[0];
    if (x) stationData[st] = x;
  });
  return Object.assign({}, found, {week:week, stationData:stationData});
}

function renderDriverEmail_(r) {
  const allComplaints = [], allInfractions = [], allDsb = [], allDvic = [];
  let packages = 0, failedPickups = 0;
  Object.keys(r.stationData).forEach(function(st) {
    const s = r.stationData[st]; packages += s.packages; failedPickups += s.failedPickups;
    s.complaints.forEach(function(x){allComplaints.push(x);}); s.infractions.forEach(function(x){allInfractions.push(x);});
    s.dsb.forEach(function(x){allDsb.push(x);}); s.dvic.forEach(function(x){allDvic.push(x);});
  });
  const row = function(label,value){return '<tr><td style="padding:7px 10px;color:#667085">'+esc_(label)+'</td><td style="padding:7px 10px;font-weight:700">'+esc_(value)+'</td></tr>';};
  let html = '<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#101828">';
  html += '<div style="background:#111827;color:#fff;padding:24px;border-radius:16px 16px 0 0"><h2 style="margin:0">Reporte semanal</h2><div style="opacity:.8;margin-top:6px">'+esc_(r.week)+'</div></div>';
  html += '<div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 16px 16px">';
  html += '<h3 style="margin-top:0">'+esc_(r.name)+'</h3><table style="border-collapse:collapse;width:100%">'+row('Categoría',r.category)+row('Puntos',r.points)+row('Paquetes entregados',packages)+'</table>';
  html += sectionList_('Customer complaints', allComplaints.map(function(x){return (x.date?x.date+' — ':'')+x.type+(x.details?' — '+x.details:'');}));
  html += sectionList_('Infracciones', allInfractions.map(function(x){return (x.date?x.date+' — ':'')+x.type;}));
  html += sectionList_('DSB - Oportunidades', allDsb.map(function(x){return (x.date?x.date+' — ':'')+x.category;}));
  if (failedPickups > 0) html += sectionList_('Pickups fallidos', [failedPickups + ' failed pickup(s)']);
  html += sectionList_('DVIC', allDvic.map(function(x){return (x.date?x.date+' — ':'')+'Inspección completada demasiado rápido';}));
  html += sectionList_('Asistencia', r.attendance.map(function(x){return x.date+' — '+x.category;}));
  const pos = r.rescues.filter(function(x){return x.positive;});
  const neg = r.rescues.filter(function(x){return x.affects && !x.positive;});
  html += sectionList_('Rescates positivos', pos.map(function(x){return x.date+' — '+x.stops+' stops / '+x.packages+' packages';}));
  html += sectionList_('Rescates recibidos que afectan', neg.map(function(x){return x.date+' — '+x.stops+' stops / '+x.packages+' packages';}));
  if (!allComplaints.length && !allInfractions.length && !allDsb.length && !failedPickups && !allDvic.length && !r.attendance.length && !neg.length) {
    html += '<div style="margin-top:22px;padding:14px;background:#ecfdf3;border-radius:10px"><b>Buen trabajo:</b> no encontramos eventos negativos en las fuentes cargadas para esta semana.</div>';
  }
  html += '</div></div>';
  return html;
}

function sectionList_(title, items) {
  if (!items || !items.length) return '';
  return '<div style="margin-top:22px"><h4 style="margin-bottom:8px">'+esc_(title)+'</h4><ul style="margin-top:0;padding-left:22px">'+items.map(function(x){return '<li style="margin:6px 0">'+esc_(x)+'</li>';}).join('')+'</ul></div>';
}

function ensureStorage_() {
  const ss = SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID);
  ensureSheet_(ss, CONFIG.DATA_SHEET, ['Week','Station','SourceType','DriverKey','DriverName','TransporterID','Kind','Date','Label','ExtraJSON']);
  ensureSheet_(ss, CONFIG.UPLOAD_SHEET, ['Timestamp','Week','Station','SourceType','FileName','Rows','Status','Error']);
  ensureSheet_(ss, CONFIG.SEND_SHEET, ['Timestamp','Week','DriverKey','DriverName','Email']);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,headers.length).setValues([headers]);
  sh.hideSheet();
  return sh;
}

function replaceSourceData_(meta, records) {
  const ss = SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  const values = sh.getDataRange().getValues();
  const keep = values.slice(1).filter(function(r){return !(String(r[0])===meta.week && String(r[1])===meta.station && String(r[2])===meta.type);});
  sh.clearContents();
  sh.getRange(1,1,1,10).setValues([['Week','Station','SourceType','DriverKey','DriverName','TransporterID','Kind','Date','Label','ExtraJSON']]);
  const all = keep.concat(records.map(function(r){return [r.week,r.station,r.sourceType,r.driverKey,r.name,r.transporterId,r.kind,r.date,r.label,JSON.stringify(r.extra||{})];}));
  if (all.length) sh.getRange(2,1,all.length,10).setValues(all);
  sh.hideSheet();
}

function readData_(week) {
  const sh = SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.DATA_SHEET);
  if (!sh || sh.getLastRow()<2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,10).getValues().filter(function(r){return String(r[0])===week;}).map(function(r){
    let extra={}; try{extra=JSON.parse(r[9]||'{}');}catch(e){}
    return {week:r[0],station:r[1],sourceType:r[2],driverKey:String(r[3]),name:r[4],transporterId:String(r[5]||''),kind:r[6],date:r[7],label:r[8],extra:extra};
  });
}

function recordUpload_(meta, filename, rows, status, error) {
  const sh = SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.UPLOAD_SHEET);
  sh.appendRow([new Date(),meta.week||'',meta.station||'',meta.type||'',filename,rows,status,error||'']);
}
function recordSend_(week,key,name,email){SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.SEND_SHEET).appendRow([new Date(),week,key,name,email]);}

function uploadStatus_(week) {
  const required = ['OVERVIEW','SAFETY','CDF','DSB','PSB','DVIC'];
  const sh = SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.UPLOAD_SHEET);
  const latest={};
  if (sh && sh.getLastRow()>1) sh.getRange(2,1,sh.getLastRow()-1,8).getValues().forEach(function(r){if(String(r[1])===week) latest[r[2]+'|'+r[3]]={file:r[4],rows:r[5],status:r[6],error:r[7],timestamp:r[0]};});
  const out=[]; CONFIG.STATIONS.forEach(function(st){required.forEach(function(type){const x=latest[st+'|'+type];out.push({station:st,type:type,status:x&&x.status==='LOADED'?'loaded':'pending',file:x?x.file:'',rows:x?x.rows:0,error:x?x.error:''});});});
  return out;
}

function getWeeks_(){
  const sh=SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.UPLOAD_SHEET); if(!sh||sh.getLastRow()<2)return[];
  const set={}; sh.getRange(2,2,sh.getLastRow()-1,1).getValues().forEach(function(r){if(r[0])set[String(r[0])]=1;});
  return Object.keys(set).sort().reverse();
}
function getLatestWeek_(){return getWeeks_()[0]||'';}
function readSendMap_(week){const sh=SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.SEND_SHEET),m={};if(sh&&sh.getLastRow()>1)sh.getRange(2,1,sh.getLastRow()-1,5).getValues().forEach(function(r){if(String(r[1])===week)m[String(r[2])]=r[0];});return m;}

function readEmailDirectory_(){
  const sh=SpreadsheetApp.openById(CONFIG.REPORT_SPREADSHEET_ID).getSheetByName(CONFIG.EMAIL_SHEET); const rows=sheetObjects_(sh),byId={},byName={};
  rows.forEach(function(r){const name=getObj_(r,['name and id','name','driver']),id=String(getObj_(r,['transporterid','transporter id'])||''),email=getObj_(r,['email']),status=getObj_(r,['status']);const obj={name:name,id:id,email:email,status:status};if(id)byId[id]=obj;if(name)byName[normalizeName_(name)]=obj;});
  return {byId:byId,byName:byName};
}

function detectFileMeta_(name){const upper=name.toUpperCase();const station=(upper.match(/DJX[34]/)||[])[0]||'';const week=(upper.match(/20\d{2}[-_ ]?W(?:EEK[-_ ]?)?\d{1,2}/)||[])[0]||'';let normalizedWeek='';if(week){const m=week.match(/(20\d{2}).*?(\d{1,2})/);if(m)normalizedWeek=m[1]+'-W'+('0'+m[2]).slice(-2);}let type='';if(/OVERVIEW/.test(upper))type='OVERVIEW';else if(/SAFETY/.test(upper))type='SAFETY';else if(/CUSTOMER.*DELIVERY.*FEEDBACK|CDF/.test(upper))type='CDF';else if(/DELIVERY.*CONCESSIONS|DSB/.test(upper))type='DSB';else if(/PSB/.test(upper))type='PSB';else if(/DVIC/.test(upper))type='DVIC';return{station:station,week:normalizedWeek,type:type};}
function baseRecord_(m,key,name,id,kind,date,label,extra){return{week:m.week,station:m.station,sourceType:m.type,driverKey:String(key),name:name||'',transporterId:String(id||''),kind:kind,date:String(date||''),label:String(label||''),extra:extra||{}};}
function newDriver_(key,name,id){return{driverKey:key,name:name||'',transporterId:id||'',stations:[],byStation:{},attendance:[],rescues:[],points:0,category:'Poor',packages:0,email:'',status:'',sent:false};}
function newStationStats_(){return{packages:0,overallScore:0,overallStanding:'',complaints:[],infractions:[],dsb:[],failedPickups:0,dvic:[]};}
function compareDrivers_(a,b){const rank={Fantastic:4,Great:3,Fair:2,Poor:1};return (rank[b.category]-rank[a.category]) || (b.points-a.points) || ((b.overallScore||0)-(a.overallScore||0)) || a.name.localeCompare(b.name);}
function categoryForPoints_(p){if(p>=100)return'Fantastic';if(p>=70)return'Great';if(p>=20)return'Fair';return'Poor';}
function emptyHome_(){return{DJX3:{top:[],complaints:[],rescues:[]},DJX4:{top:[],complaints:[],rescues:[]}};}
function cleanHeader_(v){return String(v||'').replace(/\s+/g,' ').trim().toLowerCase().replace(/[()]/g,'').trim();}
function originalHeader_(v){return String(v||'').replace(/\s+/g,' ').trim();}
function indexHeaders_(h){const x={};h.forEach(function(v,i){if(v)x[v]=i;});return x;}
function firstValue_(row,idx,names){for(let i=0;i<names.length;i++){const k=cleanHeader_(names[i]);if(Object.prototype.hasOwnProperty.call(idx,k)&&row[idx[k]]!==''&&row[idx[k]]!=null)return row[idx[k]];}return'';}
function isTruthyFlag_(v){return ['1','YES','TRUE','Y','SI','SÍ','X'].indexOf(String(v||'').trim().toUpperCase())!==-1;}
function toNumber_(v){const n=parseFloat(String(v||'0').replace(/,/g,''));return isNaN(n)?0:n;}
function normalizeName_(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]/g,'').toUpperCase();}
function sheetObjects_(sh){if(!sh||sh.getLastRow()<2)return[];const vals=sh.getDataRange().getDisplayValues(),heads=vals[0].map(cleanHeader_);return vals.slice(1).filter(function(r){return r.join('').trim()!=='';}).map(function(r){const o={};heads.forEach(function(h,i){o[h]=r[i];});return o;});}
function getObj_(o,names){for(let i=0;i<names.length;i++){const k=cleanHeader_(names[i]);if(o[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k];}return'';}
function weekBounds_(week){const m=String(week).match(/(20\d{2})-W(\d{2})/);if(!m)return{start:new Date(0),end:new Date(8640000000000000)};const y=+m[1],w=+m[2];const jan4=new Date(y,0,4);const day=jan4.getDay()||7;const mon=new Date(y,0,4-(day-1)+(w-1)*7);mon.setHours(0,0,0,0);const sun=new Date(mon);sun.setDate(mon.getDate()+6);sun.setHours(23,59,59,999);return{start:mon,end:sun};}
function parseLooseDate_(v){if(v instanceof Date)return v;const s=String(v||'').trim();let m=s.match(/^(\d{1,2})[-\/]([0-1]?\d)[-\/](20\d{2})/);if(m)return new Date(+m[3],+m[2]-1,+m[1]);m=s.match(/^(20\d{2})[-\/]([0-1]?\d)[-\/](\d{1,2})/);if(m)return new Date(+m[1],+m[2]-1,+m[3]);const d=new Date(s);return isNaN(d)?null:d;}
function formatDate_(d){return Utilities.formatDate(d,Session.getScriptTimeZone()||'America/New_York','MMM d, yyyy');}
function round2_(n){return Math.round((Number(n)||0)*100)/100;}
function esc_(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
