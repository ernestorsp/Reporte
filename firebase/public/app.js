import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, onSnapshot, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDUFcQC1ZE1x8SHJhffLpp1FmE082rrc3k',
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

const docs = ['OVERVIEW','SAFETY','CDF','DSB','PSB','DVIC'];
const stations = ['DJX3','DJX4'];
let selectedSlot = null;
let bulkMode = false;
let unsubUploads = null;
let uploadMap = {};

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
weekEl.addEventListener('change',()=>{ updateWeekText(); watchUploads(); });

onAuthStateChanged(auth,user=>{
  if (user) watchUploads();
});
signInAnonymously(auth).catch(e=>toast('No pude preparar el acceso: '+e.message));

function showPage(page){
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  document.getElementById('title').textContent=page==='home'?'Home':page==='uploads'?'Archivos':page;
  document.getElementById('subtitle').textContent=page==='uploads'?'Carga por semana de Amazon':page==='home'?'Histórico y reportes de drivers':'Drivers y reportes';
}

function fillWeekOptions(){
  const today=new Date();
  const current=amazonWeekKey(today);
  const currentBounds=amazonWeekBounds(current);
  const baseStart=currentBounds.start;
  const options=[];
  for(let i=0;i<28;i++){
    const d=new Date(baseStart); d.setDate(d.getDate()-7*i);
    const key=amazonWeekKey(d);
    const b=amazonWeekBounds(key);
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

function watchUploads(){
  if (!auth.currentUser) return;
  if (unsubUploads) unsubUploads();
  const week=weekEl.value;
  const q=query(collection(db,'uploads'),where('week','==',week));
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
  const ready=stations.flatMap(st=>docs.map(type=>uploadMap[`${st}_${type}`])).filter(x=>x && ['uploaded','generated'].includes(x.status)).length;
  document.getElementById('weekProgress').textContent=`${ready} de 12 documentos cargados para ${weekEl.value}. Los datos todavía no se procesan hasta Generar reporte.`;
}

function uploadRow(st,type,status){
  const s=status?.status || 'pending';
  const cls=s==='generated'?'loaded':s==='uploaded'?'processing':s==='error'?'error':'pending';
  const icon=s==='generated'?'✓':s==='uploaded'?'✓':s==='error'?'!':'•';
  const right=s==='generated'?'<span class="ok">✓ Generado</span>':s==='uploaded'?'<span class="ok">✓ Cargado</span>':s==='error'?'<span class="bad">Error</span>':'Pendiente';
  const meta=status?.fileName || (s==='error'?status?.error:'Haz clic para cargar');
  return `<div class="row clickable" data-upload="1" data-station="${st}" data-type="${type}"><div class="left"><span class="dot ${cls}">${icon}</span><div><b>${label(type)}</b><div class="small">${escapeHtml(meta||'')}</div></div></div><div class="small">${right}</div></div>`;
}

async function handleFiles(e){
  const files=[...(e.target.files||[])]; e.target.value=''; e.target.multiple=true;
  if(!files.length) return;
  if(!auth.currentUser){toast('Preparando acceso... intenta otra vez en un segundo');return;}
  const week=weekEl.value;
  const failures=[]; let uploaded=0;
  for(const file of files){
    const ext=(file.name.match(/\.(csv|xlsx|xls)$/i)||[])[1];
    if(!ext){failures.push(`${file.name}: formato no soportado`);continue;}
    let slot=selectedSlot;
    if(bulkMode || !slot) slot=detectSlotFromName(file.name);
    if(!slot){failures.push(`${file.name}: no pude identificar estación/tipo. Súbelo haciendo clic en su espacio.`);continue;}
    try{ await uploadOne(file,week,slot); uploaded++; }
    catch(err){ failures.push(`${file.name}: ${err.message||String(err)}`); }
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
  await setDoc(doc(db,'uploads',id),{
    week,station:slot.station,type:slot.type,fileName:file.name,storagePath:path,status:'uploaded',error:'',updatedAt:serverTimestamp()
  },{merge:true});
}

async function generateSelectedWeek(){
  if(!auth.currentUser){toast('Preparando acceso...');return;}
  const week=weekEl.value;
  const loaded=stations.flatMap(st=>docs.map(type=>uploadMap[`${st}_${type}`])).filter(x=>x && ['uploaded','generated'].includes(x.status)).length;
  if(!loaded){toast('Primero carga los documentos de la semana');return;}
  if(loaded<12 && !confirm(`Hay ${loaded} de 12 documentos cargados para ${week}. ¿Quieres generar de todas formas?`)) return;
  const btn=document.getElementById('generateReport');
  btn.disabled=true; btn.textContent='Generando...';
  try{
    const result=await generateWeek({week});
    toast(`✓ ${week} generado: ${result.data?.records||0} registros procesados.`);
  }catch(err){ toast(err.message||String(err)); }
  finally{ btn.disabled=false; btn.textContent='Generar reporte'; }
}

function detectSlotFromName(name){
  const s=String(name||'').toLowerCase();
  const station=s.includes('djx3')?'DJX3':s.includes('djx4')?'DJX4':null;
  if(!station) return null;
  let type=null;
  if(/overview|dashboard/.test(s)) type='OVERVIEW';
  else if(/safety|infraction|netradyne|fleet.?edge/.test(s)) type='SAFETY';
  else if(/customer.?delivery.?feedback|\bcdf\b|feedback.?negative/.test(s)) type='CDF';
  else if(/\bdsb\b|delivery.?success.?behavior/.test(s)) type='DSB';
  else if(/\bpsb\b|pickup/.test(s)) type='PSB';
  else if(/\bdvic\b|inspection/.test(s)) type='DVIC';
  return type?{station,type}:null;
}

function amazonWeekKey(date){
  const d=new Date(date); d.setHours(12,0,0,0); d.setDate(d.getDate()+1);
  return isoWeekKey(d);
}
function isoWeekKey(d){
  const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const day=x.getUTCDay()||7; x.setUTCDate(x.getUTCDate()+4-day);
  const y=x.getUTCFullYear(); const y0=new Date(Date.UTC(y,0,1));
  const w=Math.ceil((((x-y0)/86400000)+1)/7);
  return `${y}-W${String(w).padStart(2,'0')}`;
}
function amazonWeekBounds(key){
  const m=String(key).match(/^(\d{4})-W(\d{2})$/); if(!m) return {start:new Date(),end:new Date()};
  const year=Number(m[1]), week=Number(m[2]);
  const jan4=new Date(year,0,4,12); const day=jan4.getDay()||7;
  const monday=new Date(jan4); monday.setDate(jan4.getDate()-(day-1)+7*(week-1));
  const start=new Date(monday); start.setDate(monday.getDate()-1); start.setHours(0,0,0,0);
  const end=new Date(start); end.setDate(start.getDate()+6); end.setHours(23,59,59,999);
  return {start,end};
}
function shortDate(d){return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function longDate(d){return d.toLocaleDateString('es-US',{month:'short',day:'numeric',year:'numeric'});}
function label(x){return ({OVERVIEW:'Overview / Packages',SAFETY:'Safety',CDF:'CDF Complaints',DSB:'DSB',PSB:'PSB Pickups',DVIC:'DVIC'})[x]||x;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',5500);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

renderUploadGrid();
