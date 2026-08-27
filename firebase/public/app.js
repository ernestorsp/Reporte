import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, onSnapshot, getDocs, doc, setDoc, getDoc, serverTimestamp, deleteDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',
  authDomain: 'reporte-c9c78.firebaseapp.com',
  projectId: 'reporte-c9c78',
  storageBucket: 'reporte-c9c78.firebasestorage.app',
  messagingSenderId: '332419212982',
  appId: '1:332419212982:web:4bcedf0fb8c25c75fba817'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'us-east1');
const generateWeek = httpsCallable(functions, 'generateWeek');
const deleteUpload = httpsCallable(functions, 'deleteUpload');

const docs = ['OVERVIEW','SAFETY','CDF','DSB','PSB','DVIC'];
const stations = ['DJX3','DJX4'];
const DEFAULT_SCORING = {
  packages: 0.15,
  rescueYes: -0.20,
  rescuePositive: 0,
  ncns: 0,
  co: 0,
  lateMorning: 0,
  complaints: 0,
  safety: 0,
  pickups: 0,
  dsb: 0,
  dvic: 0,
  otherInfra: 0
};
const SCORE_FIELDS = [
  ['packages','Packages Delivered','Packages × multiplicador'],
  ['rescueYes','Rescue · Affects Yes','(Stops + Packages) × multiplicador'],
  ['rescuePositive','Rescue · Positive','(Stops + Packages) × multiplicador'],
  ['ncns','NCNS','Cantidad × multiplicador'],
  ['co','CO','Cantidad × multiplicador'],
  ['lateMorning','Late Morning','Cantidad × multiplicador'],
  ['complaints','Complaints','Cantidad × multiplicador'],
  ['safety','Safety','Cantidad × multiplicador'],
  ['pickups','Pickups','Cantidad × multiplicador'],
  ['dsb','DSB','Cantidad × multiplicador'],
  ['dvic','DVIC','Cantidad × multiplicador'],
  ['otherInfra','Otras infracciones LOG','Cantidad × multiplicador']
];

let selectedSlot = null;
let bulkMode = false;
let unsubUploads = null;
let uploadMap = {};
let currentPage = 'home';
let scoringConfig = {...DEFAULT_SCORING};

const authReady = new Promise((resolve, reject) => {
  let settled = false;
  const unsub = onAuthStateChanged(auth, user => {
    if (user && !settled) { settled = true; unsub(); resolve(user); }
  }, err => { if (!settled) { settled = true; reject(err); } });
  signInAnonymously(auth).catch(err => { if (!settled) { settled = true; unsub(); reject(err); } });
});

const weekEl = document.getElementById('week');
fillWeekOptions();

document.querySelectorAll('.nav button').forEach(btn=>btn.addEventListener('click',()=>showPage(btn.dataset.page)));
document.getElementById('addFiles').addEventListener('click',()=>{
  selectedSlot = null;
  bulkMode = true;
  const input=document.getElementById('fileInput');
  input.multiple=true;
  input.click();
});
document.getElementById('generateReport').addEventListener('click',generateSelectedWeek);
document.getElementById('fileInput').addEventListener('change',handleFiles);
document.getElementById('saveScoring').addEventListener('click',saveScoringSettings);
weekEl.addEventListener('change',()=>{ updateWeekText(); watchUploads(); if(stations.includes(currentPage)) loadStationPage(currentPage); });

authReady.then(async()=>{
  await loadScoringSettings();
  watchUploads();
}).catch(e=>toast('No pude preparar el acceso: '+e.message));

function showPage(page){
  currentPage=page;
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  const titles={home:'Home',uploads:'Archivos',reports:'Reportes',points:'Puntos',DJX3:'DJX3',DJX4:'DJX4'};
  const subtitles={home:'Histórico y reportes de drivers',uploads:'Carga por semana de Amazon',reports:'Histórico de reportes semanales',points:'Configuración de puntuación'};
  document.getElementById('title').textContent=titles[page]||page;
  document.getElementById('subtitle').textContent=subtitles[page]||'Drivers y reportes';
  if(stations.includes(page)) loadStationPage(page);
  if(page==='reports') loadReportsPage();
  if(page==='points') renderScoringPage();
}

function fillWeekOptions(){
  const today=new Date();
  const currentBounds=amazonWeekBounds(amazonWeekKey(today));
  const options=[];
  for(let i=0;i<28;i++){
    const d=new Date(currentBounds.start); d.setDate(d.getDate()-7*i);
    const key=amazonWeekKey(d), b=amazonWeekBounds(key);
    options.push(`<option value="${key}">${key} · ${shortDate(b.start)} - ${shortDate(b.end)}</option>`);
  }
  weekEl.innerHTML=options.join('');
  const previous=new Date(today); previous.setDate(previous.getDate()-7);
  weekEl.value=amazonWeekKey(previous);
  updateWeekText();
}

function updateWeekText(){
  const b=amazonWeekBounds(weekEl.value);
  document.getElementById('weekRange').textContent=`Semana seleccionada: ${weekEl.value} · domingo ${longDate(b.start)} → sábado ${longDate(b.end)}`;
}

async function watchUploads(){
  try { await authReady; } catch { return; }
  if (unsubUploads) unsubUploads();
  const q=query(collection(db,'uploads'),where('week','==',weekEl.value));
  unsubUploads=onSnapshot(q,snap=>{
    uploadMap={};
    snap.forEach(d=>{ const x=d.data(); uploadMap[`${x.station}_${x.type}`]=x; });
    renderUploadGrid();
  },e=>toast(e.message));
}

function renderUploadGrid(){
  const root=document.getElementById('uploadGrid');
  const logStatus=uploadMap['GLOBAL_LOG'];
  root.innerHTML=`
    <div class="station global-upload">
      <h3>LOG semanal</h3>
      <div class="muted">INFRA_LOG + RESCUES_LOG · NCNS, CO, Late Morning y rescates.</div>
      ${uploadRow('GLOBAL','LOG',logStatus)}
    </div>
    ${stations.map(st=>`<div class="station"><h3>${st}</h3>${docs.map(type=>uploadRow(st,type,uploadMap[`${st}_${type}`])).join('')}</div>`).join('')}
  `;
  root.querySelectorAll('[data-upload]').forEach(el=>el.addEventListener('click',()=>{
    selectedSlot={station:el.dataset.station,type:el.dataset.type};
    bulkMode=false;
    const input=document.getElementById('fileInput'); input.multiple=false; input.click();
  }));
  root.querySelectorAll('[data-delete]').forEach(btn=>btn.addEventListener('click',async e=>{
    e.stopPropagation();
    const station=btn.dataset.station, type=btn.dataset.type;
    if(!uploadMap[`${station}_${type}`]) return;
    if(!confirm(`¿Borrar ${label(type)} para ${weekEl.value} y dejarlo en blanco?`)) return;
    btn.disabled=true;
    try{
      await authReady;
      await deleteUpload({week:weekEl.value,station,type});
      toast(`✓ ${label(type)} eliminado.`);
      if(stations.includes(currentPage)) loadStationPage(currentPage);
    }catch(err){toast(err.message||String(err));btn.disabled=false;}
  }));
  const standardReady=stations.flatMap(st=>docs.map(type=>uploadMap[`${st}_${type}`])).filter(x=>x&&['uploaded','generated'].includes(x.status)).length;
  const logReady=logStatus&&['uploaded','generated'].includes(logStatus.status)?1:0;
  document.getElementById('weekProgress').textContent=`${standardReady + logReady} de 13 documentos cargados para ${weekEl.value}. Los datos todavía no se procesan hasta Generar reporte.`;
}

function uploadRow(st,type,status){
  const s=status?.status||'pending';
  const cls=s==='generated'?'loaded':s==='uploaded'?'processing':s==='error'?'error':'pending';
  const icon=s==='generated'||s==='uploaded'?'✓':s==='error'?'!':'•';
  const state=s==='generated'?'<span class="ok">✓ Generado</span>':s==='uploaded'?'<span class="ok">✓ Cargado</span>':s==='error'?'<span class="bad">Error</span>':'Pendiente';
  let meta=status?.fileName||(s==='error'?status?.error:'Haz clic para cargar');
  if(type==='LOG'&&status?.status==='generated') meta+=` · DJX3: ${status.matchedDJX3||0} · DJX4: ${status.matchedDJX4||0}`;
  const del=status?`<button class="delete-btn" data-delete="1" data-station="${st}" data-type="${type}" title="Borrar archivo" aria-label="Borrar archivo">🗑</button>`:'';
  return `<div class="row clickable" data-upload="1" data-station="${st}" data-type="${type}"><div class="left"><span class="dot ${cls}">${icon}</span><div><b>${label(type)}</b><div class="small">${escapeHtml(meta||'')}</div></div></div><div class="row-actions"><div class="small">${state}</div>${del}</div></div>`;
}

async function handleFiles(e){
  const files=[...(e.target.files||[])]; e.target.value=''; e.target.multiple=true;
  if(!files.length) return;
  try { toast('Preparando carga...'); await authReady; }
  catch(err){ toast('No pude preparar el acceso: '+(err.message||String(err))); return; }
  const week=weekEl.value, failures=[]; let uploaded=0;
  for(const file of files){
    const ext=(file.name.match(/\.(csv|xlsx|xls)$/i)||[])[1];
    if(!ext){failures.push(`${file.name}: formato no soportado`);continue;}
    let slot=selectedSlot;
    if(bulkMode||!slot) slot=detectSlotFromName(file.name);
    if(!slot){failures.push(`${file.name}: no pude identificar estación/tipo. Súbelo haciendo clic en su espacio.`);continue;}
    try{await uploadOne(file,week,slot);uploaded++;}
    catch(err){failures.push(`${file.name}: ${err.message||String(err)}`);}
  }
  selectedSlot=null; bulkMode=false;
  if(uploaded) toast(`✓ ${uploaded} archivo(s) cargado(s) para ${week}. Aún no se han generado los datos.`);
  else toast(failures[0]||'No se pudo subir ningún archivo');
  if(failures.length) console.warn(failures.join('\n'));
}

async function uploadOne(file,week,slot){
  const safeName=`${Date.now()}_${Math.random().toString(36).slice(2,7)}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  const path=`staging/${week}/${slot.station}/${slot.type}/${safeName}`;
  await uploadBytes(ref(storage,path),file,{contentType:file.type||'application/octet-stream'});
  const id=`${week}_${slot.station}_${slot.type}`;
  await setDoc(doc(db,'uploads',id),{week,station:slot.station,type:slot.type,fileName:file.name,storagePath:path,status:'uploaded',error:'',updatedAt:serverTimestamp()},{merge:true});
}

async function generateSelectedWeek(){
  try{await authReady;}catch(err){toast('No pude preparar el acceso: '+(err.message||String(err)));return;}
  const week=weekEl.value;
  const loaded=Object.values(uploadMap).filter(x=>x&&['uploaded','generated'].includes(x.status)).length;
  if(!loaded){toast('Primero carga los documentos de la semana');return;}
  if(loaded<13&&!confirm(`Hay ${loaded} de 13 documentos cargados para ${week}. ¿Quieres generar de todas formas?`))return;
  const btn=document.getElementById('generateReport');btn.disabled=true;btn.textContent='Generando...';
  try{
    const result=await generateWeek({week});
    const dc=result.data?.driverCounts||{};
    toast(`✓ ${week} generado · DJX3: ${dc.DJX3||0} drivers · DJX4: ${dc.DJX4||0} drivers.`);
    if(stations.includes(currentPage)) await loadStationPage(currentPage);
    if(currentPage==='reports') await loadReportsPage();
  }
  catch(err){toast(err.message||String(err));}
  finally{btn.disabled=false;btn.textContent='Generar reporte';}
}

async function loadScoringSettings(){
  try{
    await authReady;
    const snap=await getDoc(doc(db,'settings','scoring'));
    scoringConfig={...DEFAULT_SCORING,...(snap.exists()?snap.data():{})};
  }catch(err){
    console.warn('No pude cargar scoring:',err);
    scoringConfig={...DEFAULT_SCORING};
  }
}

function renderScoringPage(){
  const root=document.getElementById('scoringRows');
  if(!root)return;
  root.innerHTML=SCORE_FIELDS.map(([key,name,formula])=>`
    <div class="score-row">
      <div><b>${escapeHtml(name)}</b><div class="small">${escapeHtml(formula)}</div></div>
      <input type="number" step="0.01" data-score-key="${key}" value="${Number(scoringConfig[key]??0)}">
      <div class="score-preview ${Number(scoringConfig[key]||0)>0?'positive':Number(scoringConfig[key]||0)<0?'negative':''}">
        ${Number(scoringConfig[key]||0)>0?'Positivo':Number(scoringConfig[key]||0)<0?'Negativo':'No afecta'}
      </div>
    </div>
  `).join('');
  root.querySelectorAll('[data-score-key]').forEach(input=>input.addEventListener('input',()=>{
    const v=Number(input.value||0);
    const p=input.closest('.score-row').querySelector('.score-preview');
    p.className='score-preview '+(v>0?'positive':v<0?'negative':'');
    p.textContent=v>0?'Positivo':v<0?'Negativo':'No afecta';
  }));
}

async function saveScoringSettings(){
  try{
    await authReady;
    const next={};
    document.querySelectorAll('[data-score-key]').forEach(input=>next[input.dataset.scoreKey]=Number(input.value||0));
    await setDoc(doc(db,'settings','scoring'),{...next,updatedAt:serverTimestamp()},{merge:true});
    scoringConfig={...DEFAULT_SCORING,...next};
    toast('✓ Configuración de puntos guardada.');
    if(stations.includes(currentPage)) loadStationPage(currentPage);
  }catch(err){toast(err.message||String(err));}
}

async function loadStationPage(station){
  const root=document.getElementById(`drivers-${station}`);
  if(!root) return;
  root.innerHTML='<div class="empty">Cargando drivers...</div>';
  document.querySelectorAll(`[data-station-week="${station}"]`).forEach(x=>x.textContent=`${weekEl.value} · ${shortDate(amazonWeekBounds(weekEl.value).start)} - ${shortDate(amazonWeekBounds(weekEl.value).end)}`);
  try{
    await authReady;
    await loadScoringSettings();
    const q=query(collection(db,'records'),where('week','==',weekEl.value),where('station','==',station));
    const snap=await getDocs(q);
    const records=snap.docs.map(d=>({id:d.id,...d.data()}));
    const drivers=aggregateDrivers(records);
    document.querySelectorAll(`[data-station-count="${station}"]`).forEach(x=>x.textContent=`${drivers.length} drivers`);
    if(!drivers.length){
      root.innerHTML='<div class="empty">No hay drivers con Overview para esta estación en la semana seleccionada.</div>';
      return;
    }
    root.innerHTML=renderDriverTable(drivers);
  }catch(err){
    root.innerHTML=`<div class="empty bad">No pude cargar los drivers: ${escapeHtml(err.message||String(err))}</div>`;
  }
}

function aggregateDrivers(records){
  const map=new Map();
  for(const r of records.filter(x=>x.kind==='OVERVIEW')){
    const name=String(r.driverName||'').trim();
    const transporterId=String(r.transporterId||'').trim();
    const packages=Number(r.extra?.packages||0);
    if(!name||packages===0)continue;
    const key=String(r.driverKey||transporterId||name).trim();
    if(!key)continue;
    if(!map.has(key))map.set(key,{
      key,name,transporterId,packages:0,overallScore:null,standing:'',
      complaints:0,infractions:0,pickups:0,dsb:0,dvic:0,
      rescues:0,ncns:0,co:0,lateMorning:0,totalPoints:0,records:[]
    });
    const d=map.get(key);
    d.records.push(r);
    d.packages=Math.max(d.packages,packages);
    if(r.extra?.overallScore!==undefined)d.overallScore=Number(r.extra.overallScore||0);
    if(r.extra?.standing)d.standing=String(r.extra.standing);
  }

  for(const r of records.filter(x=>x.kind!=='OVERVIEW')){
    const key=String(r.driverKey||r.transporterId||'').trim();
    const d=map.get(key);
    if(!d)continue;
    d.records.push(r);
    if(r.kind==='COMPLAINT')d.complaints++;
    else if(r.kind==='INFRACTION')d.infractions++;
    else if(r.kind==='FAILED_PICKUP')d.pickups+=Number(r.extra?.count||1);
    else if(r.kind==='DSB')d.dsb++;
    else if(r.kind==='DVIC')d.dvic++;
    else if(r.kind==='RESCUE')d.rescues++;
    else if(r.kind==='LOG_INFRA'){
      const cat=canonicalCategory(r.extra?.category||r.label);
      if(cat==='NCNS')d.ncns++;
      else if(cat==='CO')d.co++;
      else if(cat==='LATE_MORNING')d.lateMorning++;
    }
  }

  for(const d of map.values()) d.totalPoints=scoreDriver(d);
  return [...map.values()].sort((a,b)=>b.totalPoints-a.totalPoints||a.name.localeCompare(b.name));
}

function scoreDriver(d){
  let total=d.packages*Number(scoringConfig.packages||0);
  for(const r of d.records.filter(x=>x.kind!=='OVERVIEW')) total+=scoreRecord(r);
  return round2(total);
}

function scoreRecord(r){
  if(r.kind==='COMPLAINT')return Number(scoringConfig.complaints||0);
  if(r.kind==='INFRACTION')return Number(scoringConfig.safety||0);
  if(r.kind==='FAILED_PICKUP')return Number(r.extra?.count||1)*Number(scoringConfig.pickups||0);
  if(r.kind==='DSB')return Number(scoringConfig.dsb||0);
  if(r.kind==='DVIC')return Number(scoringConfig.dvic||0);

  if(r.kind==='RESCUE'){
    const affects=String(r.extra?.affects||'').trim().toLowerCase();
    const base=Number(r.extra?.stops||0)+Number(r.extra?.packages||0);
    if(affects==='no')return 0;
    if(affects==='positive')return base*Number(scoringConfig.rescuePositive||0);
    if(affects==='yes')return base*Number(scoringConfig.rescueYes||0);
    return 0;
  }

  if(r.kind==='LOG_INFRA'){
    const affects=String(r.extra?.affects||'').trim().toLowerCase();
    if(affects==='no')return 0;
    const cat=canonicalCategory(r.extra?.category||r.label);
    const key=cat==='NCNS'?'ncns':cat==='CO'?'co':cat==='LATE_MORNING'?'lateMorning':'otherInfra';
    return Number(scoringConfig[key]||0);
  }
  return 0;
}

function canonicalCategory(v){
  const s=String(v||'').trim().toUpperCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
  if(s==='NCNS'||s.includes('NO CALL NO SHOW'))return'NCNS';
  if(s==='CO'||s==='CALL OUT'||s==='CALLOUT')return'CO';
  if(s.includes('LATE MORNING'))return'LATE_MORNING';
  return'OTHER';
}

function renderDriverTable(drivers){
  const rows=drivers.map(d=>{
    const details=d.records.map(r=>detailLine(r)).join('');
    return `<div class="driver-row"><div class="driver-main">
      <div class="driver-name"><b>${escapeHtml(d.name)}</b><span>${escapeHtml(d.transporterId||'')}</span></div>
      <div class="metric points ${d.totalPoints>0?'positive':d.totalPoints<0?'negative':''}"><b>${formatPoints(d.totalPoints)}</b><span>Puntos</span></div>
      <div class="metric"><b>${d.packages}</b><span>Paquetes</span></div>
      <div class="metric"><b>${d.rescues}</b><span>Rescates</span></div>
      <div class="metric"><b>${d.ncns}</b><span>NCNS</span></div>
      <div class="metric"><b>${d.co}</b><span>CO</span></div>
      <div class="metric"><b>${d.lateMorning}</b><span>Late</span></div>
      <div class="metric"><b>${d.complaints}</b><span>Complaints</span></div>
      <div class="metric"><b>${d.infractions}</b><span>Safety</span></div>
      <details class="driver-details"><summary>Ver detalle</summary><div class="detail-list">${details}</div></details>
    </div></div>`;
  }).join('');
  return `<div class="drivers-table"><div class="drivers-header">
    <span>Driver</span><span>Puntos</span><span>Paquetes</span><span>Rescates</span><span>NCNS</span><span>CO</span><span>Late</span><span>Complaints</span><span>Safety</span><span>Reporte</span>
  </div>${rows}</div>`;
}

function detailLine(r){
  const score=r.kind==='OVERVIEW'
    ? Number(r.extra?.packages||0)*Number(scoringConfig.packages||0)
    : scoreRecord(r);
  let meta='';
  if(r.kind==='OVERVIEW')meta=`${Number(r.extra?.packages||0)} packages × ${Number(scoringConfig.packages||0)}`;
  else if(r.kind==='RESCUE')meta=`Stops ${Number(r.extra?.stops||0)} + Packages ${Number(r.extra?.packages||0)} · Affects ${escapeHtml(r.extra?.affects||'')}`;
  else if(r.kind==='LOG_INFRA')meta=`${escapeHtml(r.extra?.category||r.label||'')} · Affects ${escapeHtml(r.extra?.affects||'')}${r.extra?.severity?` · Severity ${escapeHtml(r.extra.severity)}`:''}`;
  else meta=`${escapeHtml(kindLabel(r.kind))}${r.label?`: ${escapeHtml(r.label)}`:''}`;
  const notes=r.extra?.notes?` · ${escapeHtml(r.extra.notes)}`:'';
  const dispatcher=r.extra?.dispatcher?` · ${escapeHtml(r.extra.dispatcher)}`:'';
  return `<div class="detail-line">
    <div><b>${escapeHtml(kindLabel(r.kind))}</b>${r.date?` · ${escapeHtml(r.date)}`:''}<div class="small">${meta}${notes}${dispatcher}</div></div>
    <div class="detail-score ${score>0?'positive':score<0?'negative':''}">${formatPoints(score)}</div>
  </div>`;
}

async function loadReportsPage(){
  const root=document.getElementById('reportsList');
  if(!root) return;
  root.innerHTML='<div class="empty">Cargando reportes...</div>';
  try{
    await authReady;
    const snap=await getDocs(collection(db,'generations'));
    const reports=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status==='generated').sort((a,b)=>String(b.week||b.id).localeCompare(String(a.week||a.id)));
    if(!reports.length){root.innerHTML='<div class="empty">Todavía no hay reportes generados.</div>';return;}
    root.innerHTML=reports.map(r=>reportRow(r)).join('');
    root.querySelectorAll('[data-open-report]').forEach(btn=>btn.addEventListener('click',()=>{
      const week=btn.dataset.week;
      if([...weekEl.options].some(o=>o.value===week)) weekEl.value=week;
      updateWeekText(); watchUploads(); showPage('DJX3');
    }));
    root.querySelectorAll('[data-delete-report]').forEach(btn=>btn.addEventListener('click',async()=>{
      const week=btn.dataset.week;
      if(!confirm(`¿Borrar completamente el reporte ${week}? Los archivos quedan cargados para que puedas generarlo otra vez.`)) return;
      btn.disabled=true;
      try{await deleteGeneratedReport(week);toast(`✓ Reporte ${week} eliminado.`);await loadReportsPage();}
      catch(err){toast(err.message||String(err));btn.disabled=false;}
    }));
  }catch(err){root.innerHTML=`<div class="empty bad">No pude cargar los reportes: ${escapeHtml(err.message||String(err))}</div>`;}
}

function reportRow(r){
  const week=String(r.week||r.id||'');
  const short=week.replace(/^\d{4}-/,'');
  const b=amazonWeekBounds(week);
  const dc=r.driverCounts||{};
  return `<div class="row"><div class="left"><span class="dot loaded">✓</span><div><b>${escapeHtml(short)}</b><div class="small">${escapeHtml(week)} · ${shortDate(b.start)} - ${shortDate(b.end)} · DJX3 ${Number(dc.DJX3||0)} drivers · DJX4 ${Number(dc.DJX4||0)} drivers</div></div></div><div class="row-actions"><button class="btn secondary" data-open-report="1" data-week="${week}">Ver</button><button class="delete-btn" data-delete-report="1" data-week="${week}" title="Borrar reporte" aria-label="Borrar reporte">🗑</button></div></div>`;
}

async function deleteGeneratedReport(week){
  await authReady;
  const recSnap=await getDocs(query(collection(db,'records'),where('week','==',week)));
  for(let i=0;i<recSnap.docs.length;i+=400){
    const batch=writeBatch(db);
    recSnap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
  const upSnap=await getDocs(query(collection(db,'uploads'),where('week','==',week)));
  for(let i=0;i<upSnap.docs.length;i+=400){
    const batch=writeBatch(db);
    upSnap.docs.slice(i,i+400).forEach(d=>batch.set(d.ref,{status:'uploaded',rows:null,validation:'',error:'',updatedAt:serverTimestamp()},{merge:true}));
    await batch.commit();
  }
  await deleteDoc(doc(db,'generations',week));
  if(weekEl.value===week && stations.includes(currentPage)) await loadStationPage(currentPage);
}

function kindLabel(kind){return ({OVERVIEW:'Packages',COMPLAINT:'Complaint',INFRACTION:'Safety',FAILED_PICKUP:'Pickup',DSB:'DSB',DVIC:'DVIC',LOG_INFRA:'LOG',RESCUE:'Rescue'})[kind]||kind;}

function detectSlotFromName(name){
  const s=String(name||'').toLowerCase();
  if(/(^|[_\-. ])log([_\-. ]|$)/.test(s)||s==='log.xlsx'||s==='log.xls')return{station:'GLOBAL',type:'LOG'};
  const station=s.includes('djx3')?'DJX3':s.includes('djx4')?'DJX4':null;
  if(!station)return null;
  let type=null;
  if(/overview|dashboard/.test(s))type='OVERVIEW';
  else if(/safety|infraction|netradyne|fleet.?edge/.test(s))type='SAFETY';
  else if(/customer.?delivery.?feedback|\bcdf\b|feedback.?negative/.test(s))type='CDF';
  else if(/\bdsb\b|delivery.?success.?behavior/.test(s))type='DSB';
  else if(/\bpsb\b|pickup/.test(s))type='PSB';
  else if(/\bdvic\b|inspection/.test(s))type='DVIC';
  return type?{station,type}:null;
}

function amazonWeekKey(date){const d=new Date(date);d.setHours(12,0,0,0);d.setDate(d.getDate()+1);return isoWeekKey(d);}
function isoWeekKey(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=x.getUTCFullYear(),y0=new Date(Date.UTC(y,0,1));const w=Math.ceil((((x-y0)/86400000)+1)/7);return `${y}-W${String(w).padStart(2,'0')}`;}
function amazonWeekBounds(key){const m=String(key).match(/^(\d{4})-W(\d{2})$/);if(!m)return{start:new Date(),end:new Date()};const year=Number(m[1]),week=Number(m[2]),jan4=new Date(year,0,4,12),day=jan4.getDay()||7,monday=new Date(jan4);monday.setDate(jan4.getDate()-(day-1)+7*(week-1));const start=new Date(monday);start.setDate(monday.getDate()-1);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(start.getDate()+6);end.setHours(23,59,59,999);return{start,end};}
function shortDate(d){return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function longDate(d){return d.toLocaleDateString('es-US',{month:'short',day:'numeric',year:'numeric'});}
function label(x){return({OVERVIEW:'Overview / Packages',SAFETY:'Safety',CDF:'CDF Complaints',DSB:'DSB',PSB:'PSB Pickups',DVIC:'DVIC',LOG:'LOG (Infra + Rescues)'})[x]||x;}
function round2(v){return Math.round((Number(v)||0)*100)/100;}
function formatPoints(v){const n=round2(v);return `${n>0?'+':''}${n.toFixed(2)}`;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',5500);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

renderUploadGrid();
