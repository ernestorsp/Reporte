import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js';

const config={
  apiKey:'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',
  authDomain:'reporte-c9c78.firebaseapp.com',
  projectId:'reporte-c9c78',
  storageBucket:'reporte-c9c78.firebasestorage.app',
  messagingSenderId:'332419212982',
  appId:'1:332419212982:web:4bcedf0fb8c25c75fba817'
};
const app=getApps()[0]||initializeApp(config);
const auth=getAuth(app);
const db=getFirestore(app);
const functions=getFunctions(app,'us-east1');
const syncHomeRescues=httpsCallable(functions,'syncHomeRescues');
const DEFAULT_SCORING={packages:.15,rescueYes:-.2,rescuePositive:0,ncns:0,co:0,lateMorning:0,complaints:0,safety:0,pickups:0,dsb:0,dvic:0,otherInfra:0};
let authReady=false,lastWeek='';

onAuthStateChanged(auth,u=>{authReady=!!u;if(u)refreshHome();});

function week(){return document.getElementById('week')?.value||'';}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0;}
function fmt(v){const n=Math.round(num(v)*100)/100;return `${n>0?'+':''}${n.toFixed(2)}`;}
function lower(v){return String(v??'').trim().toLowerCase();}
function norm(v){return lower(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function cat(v){const s=String(v||'').trim().toUpperCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');if(s==='NCNS'||s.includes('NO CALL NO SHOW'))return'NCNS';if(s==='CO'||s==='CALL OUT'||s==='CALLOUT')return'CO';if(s.includes('LATE MORNING'))return'LATE_MORNING';return'OTHER';}

function scoreRecord(r,s){
  if(r.kind==='COMPLAINT')return num(s.complaints);
  if(r.kind==='INFRACTION')return num(s.safety);
  if(r.kind==='FAILED_PICKUP')return num(r.extra?.count||1)*num(s.pickups);
  if(r.kind==='DSB')return num(s.dsb);
  if(r.kind==='DVIC')return num(s.dvic);
  if(r.kind==='RESCUE'){
    const a=lower(r.extra?.affects),base=num(r.extra?.stops)+num(r.extra?.packages);
    if(a==='yes')return base*num(s.rescueYes);if(a==='positive')return base*num(s.rescuePositive);return 0;
  }
  if(r.kind==='LOG_INFRA'){
    if(lower(r.extra?.affects)==='no')return 0;
    const c=cat(r.extra?.category||r.label),k=c==='NCNS'?'ncns':c==='CO'?'co':c==='LATE_MORNING'?'lateMorning':'otherInfra';return num(s[k]);
  }
  return 0;
}

function buildRoster(records){
  const byId=new Map(),byKey=new Map(),byName=new Map();
  for(const r of records.filter(x=>x.kind==='OVERVIEW')){
    const person={name:String(r.driverName||'').trim(),station:r.station,transporterId:String(r.transporterId||'').trim(),key:String(r.driverKey||'').trim()};
    if(person.transporterId)byId.set(`${r.station}|${person.transporterId.toUpperCase()}`,person);
    if(person.key)byKey.set(`${r.station}|${person.key.toUpperCase()}`,person);
    const n=norm(person.name);if(n)byName.set(`${r.station}|${n}`,person);
  }
  return {byId,byKey,byName};
}

function resolvePerson(r,roster){
  const station=String(r.station||'');
  const tid=String(r.transporterId||'').trim();
  const key=String(r.driverKey||'').trim();
  const name=String(r.driverName||'').trim();
  return (tid&&roster.byId.get(`${station}|${tid.toUpperCase()}`)) ||
         (key&&roster.byKey.get(`${station}|${key.toUpperCase()}`)) ||
         (name&&roster.byId.get(`${station}|${name.toUpperCase()}`)) ||
         (name&&roster.byKey.get(`${station}|${name.toUpperCase()}`)) ||
         (name&&roster.byName.get(`${station}|${norm(name)}`)) || null;
}

function aggregateDrivers(records,s){
  const map=new Map(),byName=new Map();
  for(const r of records.filter(x=>x.kind==='OVERVIEW')){
    const key=String(r.driverKey||r.transporterId||r.driverName||'').trim();if(!key)continue;
    const d={key,name:String(r.driverName||'').trim(),station:r.station,packages:num(r.extra?.packages),points:num(r.extra?.packages)*num(s.packages)};
    map.set(key,d);const n=norm(d.name);if(n)byName.set(`${r.station}|${n}`,d);
  }
  for(const r of records.filter(x=>x.kind!=='OVERVIEW')){
    const key=String(r.driverKey||r.transporterId||'').trim();
    const d=map.get(key)||byName.get(`${r.station}|${norm(r.driverName)}`);if(!d)continue;
    d.points+=scoreRecord(r,s);
  }
  return [...map.values()].map(d=>({...d,points:Math.round(d.points*100)/100}));
}

function groupComplaints(records,roster){
  const m=new Map();
  for(const r of records.filter(x=>x.kind==='COMPLAINT')){
    const person=resolvePerson(r,roster);
    const name=String(person?.name||r.driverName||'').trim();if(!name)continue;
    const station=person?.station||r.station;
    const stable=String(person?.transporterId||person?.key||norm(name));
    const k=`${station}|${stable}`;
    if(!m.has(k))m.set(k,{name,station,complaints:0});
    m.get(k).complaints++;
  }
  return [...m.values()].sort((a,b)=>b.complaints-a.complaints||a.name.localeCompare(b.name)).slice(0,10);
}

function groupRescues(records,station,roster){
  const m=new Map();
  for(const r of records.filter(x=>x.kind==='RESCUE'&&x.station===station&&lower(x.extra?.affects)==='yes')){
    const person=resolvePerson(r,roster);
    const name=String(person?.name||r.driverName||'').trim();if(!name)continue;
    const stable=String(person?.transporterId||person?.key||norm(name));
    if(!m.has(stable))m.set(stable,{name,station,rescueCount:0,rescueStops:0,rescuePackages:0});
    const d=m.get(stable);d.rescueCount++;d.rescueStops+=num(r.extra?.stops);d.rescuePackages+=num(r.extra?.packages);
  }
  return [...m.values()].sort((a,b)=>b.rescueCount-a.rescueCount||(b.rescueStops+b.rescuePackages)-(a.rescueStops+a.rescuePackages)).slice(0,5);
}

function rankRows(list,valueKey,valueLabel,kind='good'){
  if(!list.length)return '<div class="home-empty">Sin datos para esta semana.</div>';
  return list.map((d,i)=>`<div class="home-rank-row"><div class="home-rank-num">${i+1}</div><div class="home-rank-driver"><b>${esc(d.name)}</b><span>${esc(d.station||'')}</span></div><div class="home-rank-value ${kind}"><b>${esc(valueKey(d))}</b><span>${esc(valueLabel)}</span></div></div>`).join('');
}
function stationTop(drivers,station){return drivers.filter(d=>d.station===station).sort((a,b)=>b.points-a.points||b.packages-a.packages).slice(0,10);}

async function refreshHome(){
  const root=document.getElementById('homeDashboard');if(!root||!authReady)return;
  const w=week();if(!w)return;lastWeek=w;
  root.innerHTML='<div class="home-loading">Cargando dashboard...</div>';
  try{
    // Fallback para semanas antiguas: refresca rescates desde LOG. Las semanas nuevas ya los importan al generar reporte.
    try{await syncHomeRescues({week:w});}catch(syncErr){console.warn('No pude refrescar RESCUE_LOG:',syncErr);}
    const [snap,scoreSnap]=await Promise.all([
      getDocs(query(collection(db,'records'),where('week','==',w))),
      getDoc(doc(db,'settings','scoring'))
    ]);
    if(w!==week())return;
    const records=snap.docs.map(d=>d.data());
    const scoring={...DEFAULT_SCORING,...(scoreSnap.exists()?scoreSnap.data():{})};
    const roster=buildRoster(records);
    const drivers=aggregateDrivers(records,scoring);
    const t3=stationTop(drivers,'DJX3'),t4=stationTop(drivers,'DJX4');
    const complaints=groupComplaints(records,roster);
    const r3=groupRescues(records,'DJX3',roster),r4=groupRescues(records,'DJX4',roster);
    const totalDrivers=drivers.length;
    const totalComplaints=records.filter(r=>r.kind==='COMPLAINT').length;
    const totalSafety=records.filter(r=>r.kind==='INFRACTION'&&r.sourceType==='SAFETY').length;
    root.innerHTML=`
      <div class="home-hero">
        <div><div class="home-eyebrow">AAXI XPRESS · ${esc(w)}</div><h2>Weekly Performance Center</h2><p>Resumen ejecutivo de DJX3 y DJX4 basado en el reporte generado de la semana.</p></div>
        <div class="home-kpis"><div><b>${totalDrivers}</b><span>Drivers</span></div><div><b>${totalComplaints}</b><span>Complaints CDF</span></div><div><b>${totalSafety}</b><span>Violaciones Safety</span></div></div>
      </div>
      <div class="home-section-title"><div><span class="home-section-kicker">01 · PERFORMANCE</span><h3>Top drivers por estación</h3></div><span class="home-pill">Ordenado por puntos</span></div>
      <div class="home-grid-two">
        <div class="home-card"><div class="home-card-head"><div><span>DJX3</span><h4>Top 10 Drivers</h4></div><div class="home-medal">🏆</div></div>${rankRows(t3,d=>fmt(d.points),'Puntos','good')}</div>
        <div class="home-card"><div class="home-card-head"><div><span>DJX4</span><h4>Top 10 Drivers</h4></div><div class="home-medal">🏆</div></div>${rankRows(t4,d=>fmt(d.points),'Puntos','good')}</div>
      </div>
      <div class="home-section-title"><div><span class="home-section-kicker danger">02 · ATTENTION</span><h3>Complaints · ambas estaciones</h3></div><span class="home-pill danger">CDF · Top 10</span></div>
      <div class="home-card home-wide"><div class="home-card-head"><div><span>DJX3 + DJX4</span><h4>Drivers con más complaints</h4></div><div class="home-medal">⚠️</div></div>${rankRows(complaints,d=>String(d.complaints),'Complaints','bad')}</div>
      <div class="home-section-title"><div><span class="home-section-kicker danger">03 · RESCUES</span><h3>Drivers que más rescates reciben</h3></div><span class="home-pill danger">LOG · Affects = Yes</span></div>
      <div class="home-grid-two">
        <div class="home-card"><div class="home-card-head"><div><span>DJX3</span><h4>Top 5 rescates negativos</h4></div><div class="home-medal">↓</div></div>${rankRows(r3,d=>String(d.rescueCount),'Rescates recibidos','bad')}<div class="home-footnote">Desempate por Stops + Packages recibidos.</div></div>
        <div class="home-card"><div class="home-card-head"><div><span>DJX4</span><h4>Top 5 rescates negativos</h4></div><div class="home-medal">↓</div></div>${rankRows(r4,d=>String(d.rescueCount),'Rescates recibidos','bad')}<div class="home-footnote">Desempate por Stops + Packages recibidos.</div></div>
      </div>`;
  }catch(err){root.innerHTML=`<div class="home-empty">No pude cargar HOME: ${esc(err.message||String(err))}</div>`;}
}

const weekEl=document.getElementById('week');weekEl?.addEventListener('change',refreshHome);
const observer=new MutationObserver(()=>{
  const home=document.getElementById('page-home');
  if(home?.classList.contains('active')&&week()!==lastWeek)refreshHome();
});
observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
window.addEventListener('focus',()=>{if(document.getElementById('page-home')?.classList.contains('active'))refreshHome();});
