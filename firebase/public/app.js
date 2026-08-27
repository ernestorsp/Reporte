import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, onSnapshot, getDocs, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
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
let selectedSlot = null;
let bulkMode = false;
let unsubUploads = null;
let uploadMap = {};
let currentPage = 'home';

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
weekEl.addEventListener('change',()=>{ updateWeekText(); watchUploads(); if(stations.includes(currentPage)) loadStationPage(currentPage); });
authReady.then(()=>watchUploads()).catch(e=>toast('No pude preparar el acceso: '+e.message));

function showPage(page){
  currentPage=page;
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  document.getElementById('title').textContent=page==='home'?'Home':page==='uploads'?'Archivos':page;
  document.getElementById('subtitle').textContent=page==='uploads'?'Carga por semana de Amazon':page==='home'?'Histórico y reportes de drivers':'Drivers y reportes';
  if(stations.includes(page)) loadStationPage(page);
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
  root.innerHTML=stations.map(st=>`<div class="station"><h3>${st}</h3>${docs.map(type=>uploadRow(st,type,uploadMap[`${st}_${type}`])).join('')}</div>`).join('');
  root.querySelectorAll('[data-upload]').forEach(el=>el.addEventListener('click',()=>{
    selectedSlot={station:el.dataset.station,type:el.dataset.type};
    bulkMode=false;
    const input=document.getElementById('fileInput'); input.multiple=false; input.click();
  }));
  root.querySelectorAll('[data-delete]').forEach(btn=>btn.addEventListener('click',async e=>{
    e.stopPropagation();
    const station=btn.dataset.station, type=btn.dataset.type;
    if(!uploadMap[`${station}_${type}`]) return;
    if(!confirm(`¿Borrar ${label(type)} de ${station} para ${weekEl.value} y dejarlo en blanco?`)) return;
    btn.disabled=true;
    try{
      await authReady;
      await deleteUpload({week:weekEl.value,station,type});
      toast(`✓ ${label(type)} de ${station} eliminado.`);
      if(currentPage===station) loadStationPage(station);
    }catch(err){toast(err.message||String(err));btn.disabled=false;}
  }));
  const ready=stations.flatMap(st=>docs.map(type=>uploadMap[`${st}_${type}`])).filter(x=>x&&['uploaded','generated'].includes(x.status)).length;
  document.getElementById('weekProgress').textContent=`${ready} de 12 documentos cargados para ${weekEl.value}. Los datos todavía no se procesan hasta Generar reporte.`;
}

function uploadRow(st,type,status){
  const s=status?.status||'pending';
  const cls=s==='generated'?'loaded':s==='uploaded'?'processing':s==='error'?'error':'pending';
  const icon=s==='generated'||s==='uploaded'?'✓':s==='error'?'!':'•';
  const state=s==='generated'?'<span class="ok">✓ Generado</span>':s==='uploaded'?'<span class="ok">✓ Cargado</span>':s==='error'?'<span class="bad">Error</span>':'Pendiente';
  const meta=status?.fileName||(s==='error'?status?.error:'Haz clic para cargar');
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
  const loaded=stations.flatMap(st=>docs.map(type=>uploadMap[`${st}_${type}`])).filter(x=>x&&['uploaded','generated'].includes(x.status)).length;
  if(!loaded){toast('Primero carga los documentos de la semana');return;}
  if(loaded<12&&!confirm(`Hay ${loaded} de 12 documentos cargados para ${week}. ¿Quieres generar de todas formas?`))return;
  const btn=document.getElementById('generateReport');btn.disabled=true;btn.textContent='Generando...';
  try{
    const result=await generateWeek({week});
    toast(`✓ ${week} generado: ${result.data?.records||0} registros procesados.`);
    if(stations.includes(currentPage)) await loadStationPage(currentPage);
  }
  catch(err){toast(err.message||String(err));}
  finally{btn.disabled=false;btn.textContent='Generar reporte';}
}

async function loadStationPage(station){
  const root=document.getElementById(`drivers-${station}`);
  if(!root) return;
  root.innerHTML='<div class="empty">Cargando drivers...</div>';
  document.querySelectorAll(`[data-station-week="${station}"]`).forEach(x=>x.textContent=`${weekEl.value} · ${shortDate(amazonWeekBounds(weekEl.value).start)} - ${shortDate(amazonWeekBounds(weekEl.value).end)}`);
  try{
    await authReady;
    const q=query(collection(db,'records'),where('week','==',weekEl.value),where('station','==',station));
    const snap=await getDocs(q);
    const records=snap.docs.map(d=>({id:d.id,...d.data()}));
    const drivers=aggregateDrivers(records);
    document.querySelectorAll(`[data-station-count="${station}"]`).forEach(x=>x.textContent=`${drivers.length} drivers · ${records.length} registros`);
    if(!drivers.length){
      root.innerHTML='<div class="empty">No hay datos generados para esta estación en la semana seleccionada.</div>';
      return;
    }
    root.innerHTML=renderDriverTable(drivers);
  }catch(err){
    root.innerHTML=`<div class="empty bad">No pude cargar los drivers: ${escapeHtml(err.message||String(err))}</div>`;
  }
}

function aggregateDrivers(records){
  const map=new Map();
  for(const r of records){
    const key=String(r.driverKey||r.transporterId||r.driverName||'').trim();
    if(!key) continue;
    if(!map.has(key)) map.set(key,{key,name:r.driverName||'',transporterId:r.transporterId||'',packages:0,overallScore:null,standing:'',complaints:0,infractions:0,pickups:0,dsb:0,dvic:0,records:[]});
    const d=map.get(key);
    if(r.driverName&&!d.name)d.name=r.driverName;
    if(r.transporterId&&!d.transporterId)d.transporterId=r.transporterId;
    d.records.push(r);
    if(r.kind==='OVERVIEW'){
      d.packages=Math.max(d.packages,Number(r.extra?.packages||0));
      if(r.extra?.overallScore!==undefined)d.overallScore=Number(r.extra.overallScore||0);
      if(r.extra?.standing)d.standing=String(r.extra.standing);
    } else if(r.kind==='COMPLAINT') d.complaints++;
    else if(r.kind==='INFRACTION') d.infractions++;
    else if(r.kind==='FAILED_PICKUP') d.pickups+=Number(r.extra?.count||1);
    else if(r.kind==='DSB') d.dsb++;
    else if(r.kind==='DVIC') d.dvic++;
  }
  return [...map.values()].sort((a,b)=>(a.name||a.key).localeCompare(b.name||b.key));
}

function renderDriverTable(drivers){
  const rows=drivers.map(d=>{
    const details=d.records.filter(r=>r.kind!=='OVERVIEW').map(r=>`<span class="detail-pill"><b>${escapeHtml(kindLabel(r.kind))}</b>${r.label?`: ${escapeHtml(r.label)}`:''}${r.date?` · ${escapeHtml(r.date)}`:''}</span>`).join('')||'<span class="muted">Sin incidencias en los documentos generados.</span>';
    return `<div class="driver-row"><div class="driver-main"><div class="driver-name"><b>${escapeHtml(d.name||d.key)}</b><span>${escapeHtml(d.transporterId||'')}</span></div><div class="metric"><b>${d.packages}</b><span>Paquetes</span></div><div class="metric"><b>${d.complaints}</b><span>Complaints</span></div><div class="metric"><b>${d.infractions}</b><span>Safety</span></div><div class="metric"><b>${d.pickups}</b><span>Pickups</span></div><div class="metric"><b>${d.dsb}</b><span>DSB</span></div><div class="metric"><b>${d.dvic}</b><span>DVIC</span></div><details class="driver-details"><summary>Ver detalle</summary><div class="detail-list">${details}</div></details></div></div>`;
  }).join('');
  return `<div class="drivers-table"><div class="drivers-header"><span>Driver</span><span>Paquetes</span><span>Complaints</span><span>Safety</span><span>Pickups</span><span>DSB</span><span>DVIC</span><span>Reporte</span></div>${rows}</div>`;
}

function kindLabel(kind){return ({COMPLAINT:'Complaint',INFRACTION:'Safety',FAILED_PICKUP:'Pickup',DSB:'DSB',DVIC:'DVIC'})[kind]||kind;}

function detectSlotFromName(name){
  const s=String(name||'').toLowerCase();
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
function label(x){return({OVERVIEW:'Overview / Packages',SAFETY:'Safety',CDF:'CDF Complaints',DSB:'DSB',PSB:'PSB Pickups',DVIC:'DVIC'})[x]||x;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',5500);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));}

renderUploadGrid();
