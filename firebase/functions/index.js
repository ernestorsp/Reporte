const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

initializeApp();
const db = getFirestore();

const REQUIRED = {
  OVERVIEW: [
    ['delivery associate','driver','transporter name','transporter_name','transporter id','transporterid','transporter_id'],
    ['overall score'],
    ['packages delivered']
  ],
  SAFETY: [
    ['delivery associate','driver','transporter name','transporter_name','transporter id','transporterid','transporter_id'],
    ['date station local time','date (station local time)','date'],
    ['metric type']
  ],
  CDF: [
    ['delivery associate','driver','transporter id','transporterid','transporter_id'],
    ['delivery date','date'],
    ['feedback details']
  ],
  DSB: [
    ['delivery associate','driver','transporter id','transporterid','transporter_id'],
    ['impacts scorecard']
  ],
  PSB: [
    ['delivery associate','driver','transporter id','transporterid','transporter_id'],
    ['failed stops']
  ],
  DVIC: [
    ['transporter name','transporter_name','delivery associate','driver','transporter id','transporterid','transporter_id'],
    ['start date','start_date','date'],
    ['duration']
  ]
};

exports.processWeeklyUpload = onObjectFinalized(async (event) => {
  const object = event.data;
  const name = object.name || '';
  const m = name.match(/^weekly\/([^/]+)\/(DJX3|DJX4)\/(OVERVIEW|SAFETY|CDF|DSB|PSB|DVIC)\/([^/]+)$/i);
  if (!m) return;

  const week = m[1];
  const station = m[2].toUpperCase();
  const type = m[3].toUpperCase();
  const fileName = m[4];
  const uploadId = `${week}_${station}_${type}`;
  const uploadRef = db.collection('uploads').doc(uploadId);

  await uploadRef.set({week, station, type, fileName, storagePath:name, status:'processing', updatedAt:FieldValue.serverTimestamp()}, {merge:true});

  try {
    const bucket = getStorage().bucket(object.bucket);
    const [buffer] = await bucket.file(name).download();
    const rows = parseFile(buffer, fileName);
    if (!rows.length || rows.length < 2) throw new Error('El archivo no contiene datos suficientes.');

    const validation = validate(rows[0], type);
    if (!validation.ok) throw new Error(validation.message);

    const normalized = normalize(rows, {week, station, type, fileName});
    await replaceRecords(week, station, type, normalized);

    await uploadRef.set({
      week, station, type, fileName, storagePath:name,
      status:'loaded', rows:normalized.length,
      validation:'OK', error:'', updatedAt:FieldValue.serverTimestamp()
    }, {merge:true});
  } catch (err) {
    await uploadRef.set({status:'error', error:String(err.message || err), updatedAt:FieldValue.serverTimestamp()}, {merge:true});
    console.error(err);
  }
});

function parseFile(buffer, fileName) {
  if (/\.csv$/i.test(fileName)) {
    return parse(buffer.toString('utf8'), {skip_empty_lines:true, relax_column_count:true});
  }
  if (/\.xlsx?$/i.test(fileName)) {
    const wb = XLSX.read(buffer, {type:'buffer', cellDates:true});
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false});
  }
  throw new Error('Formato no soportado. Usa CSV, XLS o XLSX.');
}

function clean(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g,' ');
}
function idxMap(headers) {
  const out = {};
  headers.forEach((h,i)=>{ const k=clean(h); if (k && out[k] === undefined) out[k]=i; });
  return out;
}
function get(row, idx, names) {
  for (const n of names) {
    const i = idx[clean(n)];
    if (i !== undefined && row[i] !== '' && row[i] != null) return row[i];
  }
  return '';
}
function validate(headers, type) {
  const normalized = headers.map(clean);
  const missing = [];
  for (const alternatives of REQUIRED[type] || []) {
    if (!alternatives.some(x=>normalized.includes(clean(x)))) missing.push(alternatives[0]);
  }
  return missing.length ? {ok:false, message:`Archivo incorrecto para ${type}. Faltan columnas: ${missing.join(', ')}`} : {ok:true};
}
function truthy(v) {
  const s = clean(v);
  return v === 1 || s === '1' || s === 'yes' || s === 'true' || s === 'x';
}
function num(v) {
  const n = Number(String(v ?? '').replace(/,/g,''));
  return Number.isFinite(n) ? n : 0;
}
function driverKey(name, transporterId) {
  if (String(transporterId || '').trim()) return String(transporterId).trim();
  return clean(name).replace(/[^a-z0-9]+/g,'_');
}
function base(meta, key, name, transporterId, kind, date, label, extra={}) {
  return {week:meta.week, station:meta.station, sourceType:meta.type, fileName:meta.fileName, driverKey:key, driverName:String(name||''), transporterId:String(transporterId||''), kind, date:String(date||''), label:String(label||''), extra};
}
function normalize(rows, meta) {
  const headers = rows[0];
  const cleaned = headers.map(clean);
  const idx = idxMap(headers);
  const out = [];
  for (const row of rows.slice(1)) {
    if (!row || row.every(v=>String(v??'').trim()==='')) continue;
    const name = get(row, idx, ['delivery associate','driver','transporter name','transporter_name','name']);
    const transporterId = get(row, idx, ['transporter id','transporterid','transporter_id']);
    const key = driverKey(name, transporterId);
    if (!key) continue;

    if (meta.type === 'OVERVIEW') {
      out.push(base(meta,key,name,transporterId,'OVERVIEW','','',{
        standing:get(row,idx,['overall standing']),
        overallScore:num(get(row,idx,['overall score'])),
        packages:num(get(row,idx,['packages delivered']))
      }));
    } else if (meta.type === 'SAFETY') {
      const date=get(row,idx,['date station local time','date (station local time)','date']);
      const metric=get(row,idx,['metric type']);
      if (metric) out.push(base(meta,key,name,transporterId,'INFRACTION',date,metric));
    } else if (meta.type === 'CDF') {
      const date=get(row,idx,['delivery date','date']);
      const details=get(row,idx,['feedback details']);
      const skip=new Set(['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','feedback details','delivery date','station']);
      cleaned.forEach((h,i)=>{ if(h && !skip.has(h) && truthy(row[i])) out.push(base(meta,key,name,transporterId,'COMPLAINT',date,headers[i],{details:String(details||'')})); });
    } else if (meta.type === 'DSB') {
      if (!truthy(get(row,idx,['impacts scorecard']))) continue;
      const date=get(row,idx,['delivery date','date']);
      const skip=new Set(['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','delivery date','impacts scorecard','station']);
      cleaned.forEach((h,i)=>{ if(h && !skip.has(h) && truthy(row[i])) out.push(base(meta,key,name,transporterId,'DSB',date,headers[i])); });
    } else if (meta.type === 'PSB') {
      const failed=num(get(row,idx,['failed stops']));
      if (failed>0) out.push(base(meta,key,name,transporterId,'FAILED_PICKUP','','Failed Pickups',{count:failed}));
    } else if (meta.type === 'DVIC') {
      const date=get(row,idx,['start date','start_date','date']);
      const inspection=get(row,idx,['inspection type','inspection_type']) || 'Pre-Trip';
      const duration=num(get(row,idx,['duration']));
      out.push(base(meta,key,name,transporterId,'DVIC',date,inspection,{duration}));
    }
  }
  return out;
}

async function replaceRecords(week, station, type, records) {
  const existing = await db.collection('records').where('week','==',week).where('station','==',station).where('sourceType','==',type).get();
  const deletes = existing.docs.map(d=>({ref:d.ref}));
  for (let i=0;i<deletes.length;i+=400) {
    const batch=db.batch();
    deletes.slice(i,i+400).forEach(x=>batch.delete(x.ref));
    await batch.commit();
  }
  for (let i=0;i<records.length;i+=400) {
    const batch=db.batch();
    records.slice(i,i+400).forEach(r=>batch.set(db.collection('records').doc(), {...r, createdAt:FieldValue.serverTimestamp()}));
    await batch.commit();
  }
}
