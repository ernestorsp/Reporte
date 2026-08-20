import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';

const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const provider = new GoogleAuthProvider();
const docs = ['OVERVIEW','SAFETY','CDF','DSB','PSB','DVIC'];
let selectedSlot = null;
let unsubUploads = null;

const weekEl = document.getElementById('week');
weekEl.value = isoWeek(new Date());

document.querySelectorAll('.nav button').forEach(btn=>btn.addEventListener('click',()=>showPage(btn.dataset.page)));
document.getElementById('signIn').addEventListener('click',()=>signInWithPopup(auth,provider).catch(e=>toast(e.message)));
document.getElementById('fileInput').addEventListener('change',handleFile);
weekEl.addEventListener('change',watchUploads);

onAuthStateChanged(auth,user=>{
  document.getElementById('signIn').textContent = user ? user.email : 'Entrar con Google';
  renderUploadGrid({});
  if (user) watchUploads();
});

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
    if(!auth.currentUser){toast('Primero entra con Google');return;}
    selectedSlot={station:el.dataset.station,type:el.dataset.type};
    document.getElementById('fileInput').click();
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

async function handleFile(e){
  const file=e.target.files?.[0]; e.target.value='';
  if(!file || !selectedSlot) return;
  const week=weekEl.value.trim();
  if(!/^\d{4}-W\d{2}$/.test(week)){toast('Usa una semana como 2026-W33');return;}
  const ext=(file.name.match(/\.(csv|xlsx|xls)$/i)||[])[1];
  if(!ext){toast('Solo CSV, XLS o XLSX');return;}
  const safeName=`${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  const path=`weekly/${week}/${selectedSlot.station}/${selectedSlot.type}/${safeName}`;
  try{
    toast(`Subiendo ${file.name}...`);
    await uploadBytes(ref(storage,path),file,{contentType:file.type||'application/octet-stream'});
    toast('Archivo subido. Se está validando en segundo plano.');
  }catch(err){toast(err.message||String(err));}
}

function label(x){return ({OVERVIEW:'Overview / Packages',SAFETY:'Safety',CDF:'CDF Complaints',DSB:'DSB',PSB:'PSB Pickups',DVIC:'DVIC'})[x]||x;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',4500);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function isoWeek(d){const date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=date.getUTCDay()||7;date.setUTCDate(date.getUTCDate()+4-day);const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1));const week=Math.ceil((((date-yearStart)/86400000)+1)/7);return `${date.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;}

renderUploadGrid({});
