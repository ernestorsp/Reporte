const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');
const XLSX = require('xlsx');

const db=getFirestore();
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
const SHEET_ID='1Hh-SaxsOQaBRadK7M1k-FWehlbi_s5CvZDAsluSF4ZU';

function clean(v){return String(v??'').trim();}
function norm(v){return clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function idxMap(headers){const out={};headers.forEach((h,i)=>{const k=clean(h).toLowerCase().replace(/\s+/g,' ');if(k&&out[k]===undefined)out[k]=i;});return out;}
function get(row,idx,names){for(const n of names){const i=idx[String(n).toLowerCase()];if(i!==undefined&&row[i]!==''&&row[i]!=null)return row[i];}return '';}
function num(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:0;}
function toDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value;
  if(typeof value==='number'){const p=XLSX.SSF.parse_date_code(value);if(p)return new Date(p.y,p.m-1,p.d,12);}
  const s=clean(value);if(!s)return null;
  let m=s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);if(m){const d=Number(m[1]),mo=Number(m[2]),y=Number(m[3]);return new Date(y,mo-1,d,12);}
  m=s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);if(m){const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);return new Date(y,mo-1,d,12);}
  const d=new Date(s);return Number.isNaN(d.getTime())?null:d;
}
function weekBounds(key){
  const m=String(key).match(/^(\d{4})-W(\d{2})$/);if(!m)return null;
  const year=Number(m[1]),week=Number(m[2]);
  const jan4=new Date(year,0,4,12),isoDay=jan4.getDay()||7;
  const monday=new Date(jan4);monday.setDate(jan4.getDate()-(isoDay-1)+7*(week-1));
  const start=new Date(monday);start.setDate(monday.getDate()-1);start.setHours(0,0,0,0);
  const end=new Date(start);end.setDate(start.getDate()+6);end.setHours(23,59,59,999);
  return {start,end};
}
async function fetchSheet(){
  const client=await auth.getClient(),headers=await client.getRequestHeaders();
  for(const name of ['RESCUES_LOG','RESCUE_LOG']){
    const range=encodeURIComponent(`${name}!A:G`),url=`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const res=await fetch(url,{headers});if(!res.ok)continue;const data=await res.json();if(Array.isArray(data.values)&&data.values.length)return data.values;
  }
  throw new Error('No pude leer RESCUES_LOG.');
}
exports.getHomeRescueSummary=onCall({region:'us-east1',timeoutSeconds:120,memory:'256MiB'},async request=>{
  if(!request.auth)throw new HttpsError('unauthenticated','Acceso no preparado.');
  const week=clean(request.data?.week);const bounds=weekBounds(week);if(!bounds)throw new HttpsError('invalid-argument','Semana inválida.');
  const snap=await db.collection('records').where('week','==',week).where('sourceType','==','OVERVIEW').get();
  const roster=new Map();snap.docs.forEach(d=>{const r=d.data(),n=norm(r.driverName);if(n)roster.set(n,{name:r.driverName,station:r.station});});
  const rows=await fetchSheet(),idx=idxMap(rows[0]||[]),groups=new Map();
  for(const row of rows.slice(1)){
    const affects=clean(get(row,idx,['affects'])).toLowerCase();if(affects!=='yes')continue;
    const d=toDate(get(row,idx,['date']));if(!d||d<bounds.start||d>bounds.end)continue;
    const raw=clean(get(row,idx,['driver'])),person=roster.get(norm(raw));if(!person)continue;
    const key=`${person.station}|${norm(person.name)}`;let g=groups.get(key);if(!g){g={name:person.name,station:person.station,rescueCount:0,stops:0,packages:0};groups.set(key,g);}
    g.rescueCount++;g.stops+=num(get(row,idx,['stop','stops']));g.packages+=num(get(row,idx,['packages']));
  }
  const byStation={DJX3:[],DJX4:[]};for(const g of groups.values())byStation[g.station]?.push(g);
  for(const st of ['DJX3','DJX4'])byStation[st].sort((a,b)=>b.stops-a.stops||b.packages-a.packages||b.rescueCount-a.rescueCount||a.name.localeCompare(b.name));
  return {week,start:`${bounds.start.getFullYear()}-${String(bounds.start.getMonth()+1).padStart(2,'0')}-${String(bounds.start.getDate()).padStart(2,'0')}`,end:`${bounds.end.getFullYear()}-${String(bounds.end.getMonth()+1).padStart(2,'0')}-${String(bounds.end.getDate()).padStart(2,'0')}`,DJX3:byStation.DJX3.slice(0,5),DJX4:byStation.DJX4.slice(0,5)};
});
