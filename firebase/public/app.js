import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';

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
const docs = ['OVERVIEW','SAFETY','CDF','DSB','PSB','DVIC'];
let selectedSlot = null;
let bulkMode = false;
let unsubUploads = null;

const weekEl = document.getElementById('week');
weekEl.value = isoWeek(new Date());

document.querySelectorAll('.nav button').forEach(btn=>btn.addEventListener('click',()=>showPage(btn.dataset.page)));
document.getElementById('addFiles').addEventListener('click',()=>{
  showPage('uploads');
  selectedSlot = null;
  bulkMode = true;
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change',handleFiles);
weekEl.addEventListener('change',watchUploads);

onAuthStateChanged(auth,user=>{
  renderUploadGrid({});
  if (user) watchUploads();
});

signInAnonymously(auth).catch(e=>toast('No pude iniciar la sesión automática: '+e.message));

function showPage(page){
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  document.getElementById('title').textContent=page==='home'?'Home':page==='uploads'?'Archivos':page;
  document.getElementById('subtitle').textContent=page==='uploads'?'Carga directa a Firebase Storage':page==='home'?'Firebase · histórico de drivers':'Drivers y reportes';
}

function watchUploads(){
  if (!auth.currentUser) return;
  if (unsubUploads) unsubUploads();
  const week = weekEl.value.trim();
  if (!week) return;
  const q = query(collection(db,'uploads'),where('week','==',week));
  unsubUploads = onSnapshot(q,snap=>{
    const map={};
    snap.forEach(d=>{const x=d.data();map[`${x.station}_${x.type}`]=x;});
    renderUploadGrid(map);
  },e=>toast(e.message));
}

function renderUploadGrid(map){
  const root=document.getElementById('uploadGrid');
  root.innerHTML=['DJX3','DJX4'].map(st=>`<div class="station"><h3>${st}</h3>${docs.map(type=>uploadRow(st,type,map[`${st}_${type}`])).join('')}</div>`).join('');
  root.querySelectorAll('[data-upload]').forEach(el=>el.addEventListener('click',()=>{
    selectedSlot={station:el.dataset.station,type:el.dataset.type};
    bulkMode=false;
    const input=document.getElementById('fileInput');
    input.multiple=false;
    input.click();
  }));
}

function uploadRow(st,type,status){
  const s=status?.status || 'pending';
  const cls=s==='loaded'?'loaded':s==='processing'?'processing':s==='error'?'error':'pending';
  const icon=s==='loaded'?'✓':s==='processing'?'…':s==='error'?'!':'•';
  const right=s==='loaded'?'<span class="ok">✓ Listo</span>':s==='error'?'<span class="bad">Error</span>':s==='processing'?'Procesando':'Pendiente';
  const meta=status?.fileName || (s==='error'?status?.error:'Haz clic para cargar');
  return `<div class="row clickable" data-upload="1" data-station="${st}" data-type="${type}"><div class="left"><span class="dot ${cls}">${icon}</span><div><b>${label(type)}</b><div class="small">${escapeHtml(meta||'')}</div></div></div><div class="small">${right}</div></div>`;
}

async function handleFiles(e){
  const files=[...(e.target.files||[])];
  e.target.value='';
  e.target.multiple=true;
  if(!files.length) return;
  if(!auth.currentUser){toast('Preparando acceso... intenta otra vez en un segundo');return;}

  const week=weekEl.value.trim();
  if(!/^\d{4}-W\d{2}$/.test(week)){toast('Usa una semana como 2026-W33');return;}

  const failures=[];
  let uploaded=0;
  for(const file of files){
    const ext=(file.name.match(/\.(csv|xlsx|xls)$/i)||[])[1];
    if(!ext){failures.push(`${file.name}: formato no soportado`);continue;}

    let slot=selectedSlot;
    if(bulkMode || !slot) slot=detectSlotFromName(file.name);
    if(!slot){
      failures.push(`${file.name}: no pude identificar DJX3/DJX4 y tipo. Haz clic en el espacio específico y súbelo ahí.`);
      continue;
    }

    try{
      await uploadOne(file,week,slot);
      uploaded++;
    }catch(err){
      failures.push(`${file.name}: ${err.message||String(err)}`);
    }
  }

  selectedSlot=null;
  bulkMode=false;
  if(uploaded && !failures.length) toast(`✓ ${uploaded} archivo(s) subido(s). Validando en segundo plano.`);
  else if(uploaded) toast(`✓ ${uploaded} subido(s). ${failures.length} con problema.`);
  else toast(failures[0]||'No se pudo subir ningún archivo');
  if(failures.length) console.warn(failures.join('\n'));
}

async function uploadOne(file,week,slot){
  const safeName=`${Date.now()}_${Math.random().toString(36).slice(2,7)}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  const path=`weekly/${week}/${slot.station}/${slot.type}/${safeName}`;
  await uploadBytes(ref(storage,path),file,{contentType:file.type||'application/octet-stream'});
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

function label(x){return ({OVERVIEW:'Overview / Packages',SAFETY:'Safety',CDF:'CDF Complaints',DSB:'DSB',PSB:'PSB Pickups',DVIC:'DVIC'})[x]||x;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',5000);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));}
function isoWeek(d){const date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=date.getUTCDay()||7;date.setUTCDate(date.getUTCDate()+4-day);const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1));const week=Math.ceil((((date-yearStart)/86400000)+1)/7);return `${date.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;}

renderUploadGrid({});
