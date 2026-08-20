function getHistoryHome(request) {
  ensureStorage_();
  request = request || {};
  const weeks = getWeeks_();
  const selected = selectWeeksForPeriod_(weeks, request);
  const stationMaps = {DJX3:{}, DJX4:{}};

  selected.weeks.forEach(function(week) {
    const dash = buildDashboard_(week);
    CONFIG.STATIONS.forEach(function(station) {
      (dash.stations[station] || []).forEach(function(d) {
        const map = stationMaps[station];
        const key = d.driverKey;
        if (!map[key]) {
          map[key] = {
            driverKey:key, name:d.name, packages:0, points:0, complaints:0,
            infractions:0, dvic:0, failedPickups:0, rescueCount:0, rescueVolume:0,
            positiveRescues:0, weeks:0, overallScores:[]
          };
        }
        const x = map[key];
        x.name = d.name || x.name;
        x.packages += Number(d.packages || 0);
        x.points += Number(d.points || 0);
        x.complaints += (d.complaints || []).length;
        x.infractions += (d.infractions || []).length;
        x.dvic += (d.dvic || []).length;
        x.failedPickups += Number(d.failedPickups || 0);
        const received = (d.rescues || []).filter(function(r){ return r.affects && !r.positive; });
        x.rescueCount += received.length;
        x.rescueVolume += received.reduce(function(sum,r){ return sum + Number(r.stops||0) + Number(r.packages||0); },0);
        x.positiveRescues += (d.rescues || []).filter(function(r){ return r.positive; }).length;
        if (Number(d.overallScore || 0)) x.overallScores.push(Number(d.overallScore));
        x.weeks += 1;
      });
    });
  });

  const home = {};
  CONFIG.STATIONS.forEach(function(station) {
    const rows = Object.keys(stationMaps[station]).map(function(k) {
      const x = stationMaps[station][k];
      x.points = round2_(x.points);
      x.avgOverallScore = x.overallScores.length ? round2_(x.overallScores.reduce(function(a,b){return a+b;},0) / x.overallScores.length) : 0;
      return x;
    });
    home[station] = {
      top: rows.slice().sort(function(a,b){
        if (b.points !== a.points) return b.points - a.points;
        return b.avgOverallScore - a.avgOverallScore;
      }).slice(0,10),
      complaints: rows.slice().filter(function(x){return x.complaints>0;}).sort(function(a,b){return b.complaints-a.complaints;}).slice(0,10),
      rescues: rows.slice().filter(function(x){return x.rescueCount>0;}).sort(function(a,b){
        if (b.rescueVolume !== a.rescueVolume) return b.rescueVolume-a.rescueVolume;
        return b.rescueCount-a.rescueCount;
      }).slice(0,5)
    };
  });

  return {
    mode:selected.mode,
    label:selected.label,
    weeksIncluded:selected.weeks,
    availableWeeks:weeks,
    home:home
  };
}

function selectWeeksForPeriod_(weeks, request) {
  const mode = String(request.mode || 'week').toLowerCase();
  if (!weeks.length) return {mode:mode,label:'Sin datos',weeks:[]};

  if (mode === 'week') {
    const week = request.week && weeks.indexOf(request.week) !== -1 ? request.week : weeks[0];
    return {mode:'week', label:week, weeks:[week]};
  }

  let start, end, label;
  if (mode === 'month') {
    const ym = String(request.month || '').match(/^(\d{4})-(\d{2})$/);
    if (!ym) throw new Error('Selecciona un mes válido.');
    start = new Date(Number(ym[1]), Number(ym[2])-1, 1);
    end = new Date(Number(ym[1]), Number(ym[2]), 0, 23, 59, 59, 999);
    label = ym[1] + '-' + ym[2];
  } else {
    start = parseIsoLocalDate_(request.startDate);
    end = parseIsoLocalDate_(request.endDate);
    if (!start || !end) throw new Error('Selecciona fecha inicial y fecha final.');
    end.setHours(23,59,59,999);
    if (start > end) throw new Error('La fecha inicial no puede ser mayor que la final.');
    label = formatDate_(start) + ' a ' + formatDate_(end);
  }

  const included = weeks.filter(function(week) {
    const b = weekBounds_(week);
    return b.start <= end && b.end >= start;
  });
  return {mode:mode === 'month' ? 'month' : 'custom', label:label, weeks:included};
}

function parseIsoLocalDate_(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
}
