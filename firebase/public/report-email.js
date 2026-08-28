import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const config={
  apiKey:'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',
  authDomain:'reporte-c9c78.firebaseapp.com',
  projectId:'reporte-c9c78',
  storageBucket:'reporte-c9c78.firebasestorage.app',
  messagingSenderId:'332419212982',
  appId:'1:332419212982:web:4bcedf0fb8c25c75fba817'
};
const app=getApps()[0]||initializeApp(config);
const db=getFirestore(app);

const stationRoots=['DJX3','DJX4'];

function selectedWeek(){return document.getElementById('week')?.value||'';}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

async function getDirectory(transporterId){
  if(!transporterId)return null;
  const snap=await getDoc(doc(db,'driverDirectory',transporterId));
  return snap.exists()?snap.data():null;
}

async function getSent(week,station,transporterId){
  if(!week||!station||!transporterId)return false;
  const snap=await getDoc(doc(db,'reportSends',`${week}_${station}_${transporterId}`));
  return snap.exists()&&snap.data()?.sent===true;
}

async function markSent(week,station,transporterId,email){
  await setDoc(doc(db,'reportSends',`${week}_${station}_${transporterId}`),{
    week,station,transporterId,email:email||'',sent:true,sentAt:serverTimestamp()
  },{merge:true});
}

function buildMailto(email,name,week,station,points){
  const subject=`Reporte semanal ${week} · ${station}`;
  const body=`Hola ${name},\n\nTu reporte semanal ${week} está listo.\n\nPuntuación: ${points}\n\nSi necesitas más detalle, responde a este correo.\n`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function extractRow(row){
  const driverCell=row.querySelector('.driver-name');
  const name=driverCell?.querySelector('b')?.textContent?.trim()||'';
  const transporterId=driverCell?.querySelector('span')?.textContent?.trim()||'';
  const points=row.querySelector('.metric.points b')?.textContent?.trim()||'0.00';
  return{name,transporterId,points};
}

async function decorateStation(station){
  const root=document.getElementById(`drivers-${station}`);
  if(!root)return;
  const table=root.querySelector('.drivers-table');
  if(!table||table.dataset.emailReady==='1')return;
  table.dataset.emailReady='1';
  table.classList.add('compact-report');

  const header=table.querySelector('.drivers-header');
  if(header){
    header.innerHTML='<span>Driver</span><span>Puntos</span><span>Estado</span><span>Acciones</span>';
  }

  const rows=[...table.querySelectorAll('.driver-row')];
  const week=selectedWeek();
  for(const row of rows){
    const main=row.querySelector('.driver-main');
    if(!main)continue;
    const details=main.querySelector('.driver-details');
    const detailHtml=details?.querySelector('.detail-list')?.innerHTML||'<span class="muted">Sin detalle adicional.</span>';
    if(details)details.remove();

    const {name,transporterId,points}=extractRow(row);
    const directory=await getDirectory(transporterId);
    const email=String(directory?.email||'').trim();
    const sent=await getSent(week,station,transporterId);

    const status=document.createElement('div');
    status.className='report-status';
    status.innerHTML=sent?'<span class="sent-badge">✓ Enviado</span>':'<span class="muted">Pendiente</span>';

    const actions=document.createElement('div');
    actions.className='report-actions';
    actions.innerHTML=`<button class="report-detail-btn" type="button">Ver detalle</button>${email?'<button class="report-send-btn" type="button">Enviar email</button>':'<span class="email-missing">Sin email</span>'}`;

    const panel=document.createElement('div');
    panel.className='driver-detail-panel';
    panel.innerHTML=`<div class="detail-list">${detailHtml}</div>`;

    main.append(status,actions,panel);

    actions.querySelector('.report-detail-btn')?.addEventListener('click',e=>{
      const open=panel.classList.toggle('open');
      e.currentTarget.textContent=open?'Ocultar detalle':'Ver detalle';
    });

    actions.querySelector('.report-send-btn')?.addEventListener('click',async()=>{
      window.location.href=buildMailto(email,name,week,station,points);
      await markSent(week,station,transporterId,email);
      status.innerHTML='<span class="sent-badge">✓ Enviado</span>';
    });
  }

  addSendAll(station,rows);
}

function addSendAll(station,rows){
  const page=document.getElementById(`page-${station}`);
  const head=page?.querySelector('.station-head');
  if(!head||head.querySelector('.report-toolbar'))return;
  const toolbar=document.createElement('div');
  toolbar.className='report-toolbar';
  toolbar.innerHTML='<button class="btn send-all-btn" type="button">Enviar todos</button><span class="muted">Los enviados quedan marcados con ✓</span>';
  head.appendChild(toolbar);
  toolbar.querySelector('button').addEventListener('click',async()=>{
    const week=selectedWeek();
    const recipients=[];
    for(const row of rows){
      const {name,transporterId,points}=extractRow(row);
      const d=await getDirectory(transporterId);
      const email=String(d?.email||'').trim();
      if(email)recipients.push({email,name,transporterId,points});
    }
    if(!recipients.length){alert('No encontré emails guardados para estos drivers.');return;}
    const subject=`Reportes semanales ${week} · ${station}`;
    const body=`Hola,\n\nLos reportes semanales ${week} ya están disponibles.\n\nGracias.`;
    window.location.href=`mailto:?bcc=${encodeURIComponent(recipients.map(x=>x.email).join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    for(const r of recipients)await markSent(week,station,r.transporterId,r.email);
    document.querySelectorAll(`#drivers-${station} .report-status`).forEach(x=>x.innerHTML='<span class="sent-badge">✓ Enviado</span>');
  });
}

const observer=new MutationObserver(()=>stationRoots.forEach(decorateStation));
observer.observe(document.body,{childList:true,subtree:true});
stationRoots.forEach(decorateStation);
