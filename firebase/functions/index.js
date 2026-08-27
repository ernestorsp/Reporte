const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

initializeApp();
const db = getFirestore();

const REQUIRED = {
  OVERVIEW: [
    ['delivery associate'],
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
    ['impacts scorecard'],
    ['early arrivals','late arrivals','geo location','not attempted','contact compliance','out of return label','picked up, not returned']
  ],
  DVIC: [
    ['transporter name','transporter_name','delivery associate','driver','transporter id','transporterid','transporter_id'],
    ['start date','start_date','date'],
    ['duration']
  ]
};

exports.processWeeklyUpload = onObjectFinalized({region:'us-east1'}, async (event) => {
  const name = event.data?.name || '';
  if (name.startsWith('staging/')) return;
});

exports.deleteUpload = onCall({region:'us-east1'}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated','Acceso no preparado. Recarga la app.');
  const week=String(request.data?.week||'').trim();
  const station=String(request.data?.station||'').toUpperCase();
  const type=String(request.data?.type||'').toUpperCase();
  if(!/^\d{4}-W\d{2}$/.test(week)||!['DJX3','DJX4'].includes(station)||!Object.keys(REQUIRED).includes(type)){
    throw new HttpsError('invalid-argument','Documento inválido.');
  }
  const id=`${week}_${station}_${type}`;
  const ref=db.collection('uploads').doc(id);
  const snap=await ref.get();
  if(snap.exists){
    const data=snap.data()||{};
    if(data.storagePath){
      try{await getStorage().bucket().file(data.storagePath).delete();}
      catch(err){if(err.code!==404) console.warn('No se pudo borrar archivo:',err.message||err);}
    }
  }
  await deleteRecords(week,station,type);
  await ref.delete();
  await db.collection('generations').doc(week).set({status:'draft',updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {ok:true};
});

exports.generateWeek = onCall({region:'us-east1', timeoutSeconds:540, memory:'1GiB'}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated','Acceso no preparado. Recarga la app.');
  const week = String(request.data?.week || '').trim();
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new HttpsError('invalid-argument','Semana inválida.');

  const snap = await db.collection('uploads').where('week','==',week).get();
  const uploads = snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.storagePath);
  if (!uploads.length) throw new HttpsError('failed-precondition',`No hay documentos cargados para ${week}.`);

  await db.collection('generations').doc(week).set({week,status:'processing',startedAt:FieldValue.serverTimestamp(),documentCount:uploads.length,error:''},{merge:true});

  const prepared=[];
  const errors=[];
  for (const u of uploads) {
    try {
      const [buffer]=await getStorage().bucket().file(u.storagePath).download();
      const rows=parseFile(buffer,u.fileName || u.storagePath.split('/').pop());
      if (!rows.length || rows.length<2) throw new Error('El archivo no contiene datos suficientes.');
      const validation=validate(rows[0],u.type);
      if (!validation.ok) throw new Error(validation.message);
      prepared.push({upload:u,records:normalize(rows,{week,station:u.station,type:u.type,fileName:u.fileName})});
    } catch(err) {
      errors.push(`${u.station} ${u.type}: ${err.message||String(err)}`);
      await db.collection('uploads').doc(u.id).set({status:'error',error:String(err.message||err),updatedAt:FieldValue.serverTimestamp()},{merge:true});
    }
  }

  if (errors.length) {
    await db.collection('generations').doc(week).set({status:'error',error:errors.join(' | '),updatedAt:FieldValue.serverTimestamp()},{merge:true});
    throw new HttpsError('failed-precondition',`No se generó ${week}. ${errors.join(' | ')}`);
  }

  let totalRecords=0;
  for (const p of prepared) {
    await replaceRecords(week,p.upload.station,p.upload.type,p.records);
    totalRecords += p.records.length;
    await db.collection('uploads').doc(p.upload.id).set({status:'generated',rows:p.records.length,validation:'OK',error:'',generatedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  }

  await db.collection('generations').doc(week).set({week,status:'generated',documentCount:prepared.length,records:totalRecords,error:'',generatedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {week,documents:prepared.length,records:totalRecords};
});

function parseFile(buffer,fileName){
  if (/\.csv$/i.test(fileName)) return parse(buffer.toString('utf8'),{skip_empty_lines:true,relax_column_count:true});
  if (/\.xlsx?$/i.test(fileName)) {
    const wb=XLSX.read(buffer,{type:'buffer',cellDates:true});
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:false});
  }
  throw new Error('Formato no soportado. Usa CSV, XLS o XLSX.');
}

function clean(v){return String(v??'').trim().toLowerCase().replace(/\s+/g,' ');}
function idxMap(headers){const out={};headers.forEach((h,i)=>{const k=clean(h);if(k&&out[k]===undefined)out[k]=i;});return out;}
function get(row,idx,names){for(const n of names){const i=idx[clean(n)];if(i!==undefined&&row[i]!==''&&row[i]!=null)return row[i];}return '';}
function validate(headers,type){const normalized=headers.map(clean),missing=[];for(const alternatives of REQUIRED[type]||[]){if(!alternatives.some(x=>normalized.includes(clean(x))))missing.push(alternatives[0]);}return missing.length?{ok:false,message:`Archivo incorrecto para ${type}. Faltan columnas: ${missing.join(', ')}`}:{ok:true};}
function truthy(v){const s=clean(v);return v===1||s==='1'||s==='y'||s==='yes'||s==='true'||s==='x';}
function num(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:0;}
function driverKey(name,transporterId){if(String(transporterId||'').trim())return String(transporterId).trim();return clean(name).replace(/[^a-z0-9]+/g,'_');}
function base(meta,key,name,transporterId,kind,date,label,extra={}){return{week:meta.week,station:meta.station,sourceType:meta.type,fileName:meta.fileName,driverKey:key,driverName:String(name||''),transporterId:String(transporterId||''),kind,date:String(date||''),label:String(label||''),extra};}

function normalize(rows,meta){
  const headers=rows[0],cleaned=headers.map(clean),idx=idxMap(headers),out=[];
  for(const row of rows.slice(1)){
    if(!row||row.every(v=>String(v??'').trim()===''))continue;

    if(meta.type==='OVERVIEW'){
      const name=String(get(row,idx,['delivery associate'])||'').trim();
      const packages=num(get(row,idx,['packages delivered']));
      if(!name || packages===0) continue;
      const transporterId=String(get(row,idx,['transporter id','transporterid','transporter_id'])||'').trim();
      const key=driverKey(name,transporterId); if(!key)continue;
      out.push(base(meta,key,name,transporterId,'OVERVIEW','','',{standing:get(row,idx,['overall standing']),overallScore:num(get(row,idx,['overall score'])),packages}));
      continue;
    }

    const name=get(row,idx,['delivery associate','driver','transporter name','transporter_name','name']);
    const transporterId=get(row,idx,['transporter id','transporterid','transporter_id']);
    const key=driverKey(name,transporterId); if(!key)continue;

    if(meta.type==='SAFETY'){
      const date=get(row,idx,['date station local time','date (station local time)','date']);
      const metric=get(row,idx,['metric type']);
      if(metric)out.push(base(meta,key,name,transporterId,'INFRACTION',date,metric));
    } else if(meta.type==='CDF'){
      const date=get(row,idx,['delivery date','date']);
      const details=get(row,idx,['feedback details']);
      const skip=new Set(['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','feedback details','delivery date','station']);
      cleaned.forEach((h,i)=>{if(h&&!skip.has(h)&&truthy(row[i]))out.push(base(meta,key,name,transporterId,'COMPLAINT',date,headers[i],{details:String(details||'')}));});
    } else if(meta.type==='DSB'){
      if(!truthy(get(row,idx,['impacts scorecard'])))continue;
      const date=get(row,idx,['delivery date','date']);
      const skip=new Set(['week','delivery associate','driver','transporter id','transporterid','tracking id','delivery group id','delivery date','impacts scorecard','station']);
      cleaned.forEach((h,i)=>{if(h&&!skip.has(h)&&truthy(row[i]))out.push(base(meta,key,name,transporterId,'DSB',date,headers[i]));});
    } else if(meta.type==='PSB'){
      if(!truthy(get(row,idx,['impacts scorecard'])))continue;
      const date=get(row,idx,['pickup date','date']);
      const categories=['early arrivals','late arrivals','geo location','not attempted','contact compliance','out of return label','picked up, not returned'];
      let found=0;
      for(const category of categories){
        const i=idx[clean(category)];
        if(i!==undefined&&truthy(row[i])){out.push(base(meta,key,name,transporterId,'FAILED_PICKUP',date,headers[i],{count:1}));found++;}
      }
      if(!found) out.push(base(meta,key,name,transporterId,'FAILED_PICKUP',date,'Failed Pickup',{count:1}));
    } else if(meta.type==='DVIC'){
      const date=get(row,idx,['start date','start_date','date']);
      const inspection=get(row,idx,['inspection type','inspection_type'])||'Pre-Trip';
      const duration=num(get(row,idx,['duration']));
      out.push(base(meta,key,name,transporterId,'DVIC',date,inspection,{duration}));
    }
  }
  return out;
}

async function deleteRecords(week,station,type){
  const existing=await db.collection('records').where('week','==',week).where('station','==',station).where('sourceType','==',type).get();
  for(let i=0;i<existing.docs.length;i+=400){const batch=db.batch();existing.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));await batch.commit();}
}
async function replaceRecords(week,station,type,records){
  await deleteRecords(week,station,type);
  for(let i=0;i<records.length;i+=400){const batch=db.batch();records.slice(i,i+400).forEach(r=>batch.set(db.collection('records').doc(),{...r,createdAt:FieldValue.serverTimestamp()}));await batch.commit();}
}
