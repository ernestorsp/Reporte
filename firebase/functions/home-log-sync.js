const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');
const XLSX = require('xlsx');

const db = getFirestore();
const googleAuth = new GoogleAuth({scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
const LOG_SHEET_ID = '1Hh-SaxsOQaBRadK7M1k-FWehlbi_s5CvZDAsluSF4ZU';

function clean(v){return String(v??'').trim().toLowerCase().replace(/\s+/g,' ');}
function normalizeName(v){return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function idxMap(headers){const out={};headers.forEach((h,i)=>{const k=clean(h);if(k&&out[k]===undefined)out[k]=i;});return out;}
function get(row,idx,names){for(const n of names){const i=idx[clean(n)];if(i!==undefined&&row[i]!==''&&row[i]!=null)return row[i];}return '';}
function num(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:0;}
function toDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value;
  if(typeof value==='number'){
    const p=XLSX.SSF.parse_date_code(value);
    if(p)return new Date(p.y,p.m-1,p.d,12);
  }
  const d=new Date(String(value||''));
  return Number.isNaN(d.getTime())?null:d;
}
function dateString(v){const d=toDate(v);return d?d.toISOString().slice(0,10):String(v??'').trim();}
function amazonWeekBounds(key){
  const m=String(key).match(/^(\d{4})-W(\d{2})$/);if(!m)return null;
  const year=Number(m[1]),week=Number(m[2]);
  const jan4=new Date(year,0,4,12),day=jan4.getDay()||7;
  const monday=new Date(jan4);monday.setDate(jan4.getDate()-(day-1)+7*(week-1));
  const start=new Date(monday);start.setDate(monday.getDate()-1);start.setHours(0,0,0,0);
  const end=new Date(start);end.setDate(start.getDate()+6);end.setHours(23,59,59,999);
  return {start,end};
}
function belongs(value,week){const d=toDate(value),b=amazonWeekBounds(week);return !!(d&&b&&d>=b.start&&d<=b.end);}

async function fetchSheet(name){
  const client=await googleAuth.getClient();
  const headers=await client.getRequestHeaders();
  const range=encodeURIComponent(`${name}!A:Z`);
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${LOG_SHEET_ID}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const res=await fetch(url,{headers});
  if(!res.ok)return null;
  const data=await res.json();
  return Array.isArray(data.values)&&data.values.length?data.values:null;
}

async function fetchRescueSheet(){
  const singular=await fetchSheet('RESCUE_LOG');
  if(singular)return {rows:singular,sheet:'RESCUE_LOG'};
  const plural=await fetchSheet('RESCUES_LOG');
  if(plural)return {rows:plural,sheet:'RESCUES_LOG'};
  throw new Error('No encontré la hoja RESCUE_LOG ni RESCUES_LOG en LOG.');
}

exports.syncHomeRescues = onCall({region:'us-east1',timeoutSeconds:120,memory:'512Mi'},async request=>{
  if(!request.auth)throw new HttpsError('unauthenticated','Acceso no preparado.');
  const week=String(request.data?.week||'').trim();
  if(!/^\d{4}-W\d{2}$/.test(week))throw new HttpsError('invalid-argument','Semana inválida.');

  const snap=await db.collection('records').where('week','==',week).get();
  const driverMap=new Map();
  const rescueDocs=[];
  snap.docs.forEach(d=>{
    const r=d.data();
    if(r.kind==='OVERVIEW'){
      const n=normalizeName(r.driverName);
      if(n)driverMap.set(n,{station:r.station,key:r.driverKey||r.transporterId||n,transporterId:r.transporterId||'',name:r.driverName||''});
    }
    if(r.sourceType==='LOG'&&r.kind==='RESCUE')rescueDocs.push(d);
  });

  const {rows,sheet}=await fetchRescueSheet();
  const idx=idxMap(rows[0]||[]),records=[];
  for(const row of rows.slice(1)){
    const name=String(get(row,idx,['driver'])||'').trim();
    const date=get(row,idx,['date']);
    if(!name||!belongs(date,week))continue;
    const match=driverMap.get(normalizeName(name));
    if(!match)continue;
    records.push({
      week,station:match.station,sourceType:'LOG',fileName:`LOG · Google Sheets · ${sheet}`,
      driverKey:match.key,driverName:match.name,transporterId:match.transporterId,
      kind:'RESCUE',date:dateString(date),label:'Rescue',
      extra:{stops:num(get(row,idx,['stop','stops'])),packages:num(get(row,idx,['packages'])),affects:String(get(row,idx,['affects'])||'').trim(),notes:String(get(row,idx,['notes'])||''),dispatcher:String(get(row,idx,['dispatcher'])||'')}
    });
  }

  for(let i=0;i<rescueDocs.length;i+=400){const batch=db.batch();rescueDocs.slice(i,i+400).forEach(d=>batch.delete(d.ref));await batch.commit();}
  for(let i=0;i<records.length;i+=400){const batch=db.batch();records.slice(i,i+400).forEach(r=>batch.set(db.collection('records').doc(),{...r,createdAt:FieldValue.serverTimestamp()}));await batch.commit();}

  return {ok:true,sheet,records:records.length,DJX3:records.filter(r=>r.station==='DJX3').length,DJX4:records.filter(r=>r.station==='DJX4').length};
});
