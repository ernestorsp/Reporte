import { getApps, getApp, initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, collection, getDocs, doc, setDoc, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const firebaseConfig={
  apiKey:'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',
  authDomain:'reporte-c9c78.firebaseapp.com',
  projectId:'reporte-c9c78',
  storageBucket:'reporte-c9c78.firebasestorage.app',
  messagingSenderId:'332419212982',
  appId:'1:332419212982:web:4bcedf0fb8c25c75fba817'
};
const app=getApps().length?getApp():initializeApp(firebaseConfig);
const auth=getAuth(app);
const db=getFirestore(app);
let rows=[];
let readyPromise=null;

function authReady(){
  if(readyPromise)return readyPromise;
  readyPromise=new Promise((resolve,reject)=>{
    if(auth.currentUser){resolve(auth.currentUser);return;}
    const unsub=onAuthStateChanged(auth,u=>{if(u){unsub();resolve(u);}},reject);
    signInAnonymously(auth).catch(reject);
  });
  return readyPromise;
}

const dirButton=document.querySelector('[data-page="directory"]');
if(dirButton){
  dirButton.addEventListener('click',()=>{
    document.getElementById('title').textContent='Directorio';
    document.getElementById('subtitle').textContent='Emails y datos de drivers';
    loadDirectory();
  });
}

document.getElementById('directoryFile')?.addEventListener('change',handleDirectoryFile);
document.getElementById('directorySearch')?.addEventListener('input',renderDirectory);
document.getElementById('directoryStatus')?.addEventListener('change',renderDirectory);
document.getElementById('directoryRows')?.addEventListener('click',handleRowClick);

async function loadDirectory(){
  const root=document.getElementById('directoryRows');
  if(!root)return;
  root.innerHTML='<div class="empty">Cargando directorio...</div>';
  try{
    await authReady();
    const snap=await getDocs(collection(db,'driverDirectory'));
    rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    document.getElementById('directoryCount').textContent=`${rows.length} drivers guardados`;
    renderDirectory();
  }catch(err){root.innerHTML=`<div class="empty bad">${escapeHtml(err.message||String(err))}</div>`;}
}

async function handleDirectoryFile(e){
  const file=e.target.files?.[0];
  e.target.value='';
  if(!file)return;
  const button=document.getElementById('directoryUpdateBtn');
  button.disabled=true; button.textContent='Actualizando...';
  try{
    await authReady();
    const text=await file.text();
    const data=parseCSV(text);
    if(data.length<2)throw new Error('El CSV no contiene datos.');
    const headers=data[0].map(cleanHeader);
    const col=name=>headers.indexOf(cleanHeader(name));
    const iName=col('Name and ID'), iId=col('TransporterID'), iEmail=col('Email');
    if(iName<0||iId<0||iEmail<0)throw new Error('El archivo debe contener Name and ID, TransporterID y Email.');
    const imported=[];
    for(const r of data.slice(1)){
      const transporterId=String(r[iId]||'').trim();
      const name=String(r[iName]||'').trim();
      if(!transporterId||!name)continue;
      imported.push({
        transporterId,name,
        position:value(r,headers,'Position'),
        qualifications:value(r,headers,'Qualifications'),
        idExpiration:value(r,headers,'ID expiration'),
        personalPhone:value(r,headers,'Personal Phone Number'),
        workPhone:value(r,headers,'Work Phone Number'),
        email:String(r[iEmail]||'').trim(),
        status:value(r,headers,'Status')||'ACTIVE'
      });
    }
    for(let i=0;i<imported.length;i+=350){
      const batch=writeBatch(db);
      imported.slice(i,i+350).forEach(x=>batch.set(doc(db,'driverDirectory',x.transporterId),{...x,updatedAt:serverTimestamp()},{merge:true}));
      await batch.commit();
    }
    toast(`✓ Directorio actualizado: ${imported.length} drivers.`);
    await loadDirectory();
  }catch(err){toast(err.message||String(err));}
  finally{button.disabled=false;button.textContent='Actualizar desde CSV';}
}

function renderDirectory(){
  const root=document.getElementById('directoryRows');
  if(!root)return;
  const q=String(document.getElementById('directorySearch')?.value||'').trim().toLowerCase();
  const status=document.getElementById('directoryStatus')?.value||'ALL';
  const filtered=rows.filter(x=>{
    if(status!=='ALL'&&String(x.status||'').toUpperCase()!==status)return false;
    if(!q)return true;
    return [x.name,x.transporterId,x.email,x.personalPhone,x.workPhone].some(v=>String(v||'').toLowerCase().includes(q));
  });
  if(!filtered.length){root.innerHTML='<div class="empty">No hay resultados.</div>';return;}
  root.innerHTML=filtered.map(x=>`<div class="directory-row" data-id="${escapeHtml(x.transporterId)}">
    <div class="directory-name"><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.transporterId)}</span></div>
    <input class="directory-email" type="email" value="${escapeAttr(x.email||'')}" placeholder="email@ejemplo.com">
    <div>${escapeHtml(x.personalPhone||'')}</div>
    <div>${escapeHtml(x.workPhone||'')}</div>
    <div><span class="status-pill ${String(x.status||'').toUpperCase()==='ACTIVE'?'active':'inactive'}">${escapeHtml(x.status||'')}</span></div>
    <button class="btn secondary directory-save" data-save-email="${escapeHtml(x.transporterId)}">Guardar</button>
  </div>`).join('');
}

async function handleRowClick(e){
  const btn=e.target.closest('[data-save-email]');
  if(!btn)return;
  const id=btn.dataset.saveEmail;
  const row=btn.closest('.directory-row');
  const email=row.querySelector('.directory-email').value.trim();
  btn.disabled=true;
  try{
    await authReady();
    await setDoc(doc(db,'driverDirectory',id),{email,updatedAt:serverTimestamp()},{merge:true});
    const local=rows.find(x=>x.transporterId===id); if(local)local.email=email;
    toast('✓ Email actualizado.');
  }catch(err){toast(err.message||String(err));}
  finally{btn.disabled=false;}
}

function parseCSV(text){
  const out=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=false;
      else cell+=c;
    }else{
      if(c==='"')quoted=true;
      else if(c===','){row.push(cell);cell='';}
      else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}
      else cell+=c;
    }
  }
  if(cell.length||row.length){row.push(cell.replace(/\r$/,''));out.push(row);}
  return out.filter(r=>r.some(v=>String(v).trim()!==''));
}
function cleanHeader(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
function value(row,headers,name){const i=headers.indexOf(cleanHeader(name));return i>=0?String(row[i]||'').trim():'';}
function toast(msg){const t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.style.display='block';clearTimeout(window.__directoryToast);window.__directoryToast=setTimeout(()=>t.style.display='none',5500);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function escapeAttr(s){return escapeHtml(s).replace(/`/g,'&#096;');}
