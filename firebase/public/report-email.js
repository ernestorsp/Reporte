import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
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
const previewDriverReport=httpsCallable(functions,'previewDriverReport');
const sendDriverReport=httpsCallable(functions,'sendDriverReport');
const sendStationReports=httpsCallable(functions,'sendStationReports');
const stationRoots=['DJX3','DJX4'];

function selectedWeek(){return document.getElementById('week')?.value||'';}
function waitForAuth(){return new Promise((resolve,reject)=>{if(auth.currentUser)return resolve(auth.currentUser);const off=onAuthStateChanged(auth,u=>{if(u){off();resolve(u);}},reject);});}
function showMessage(msg){const t=document.getElementById('toast');if(t){t.textContent=msg;t.style.display='block';clearTimeout(window.__reportToast);window.__reportToast=setTimeout(()=>t.style.display='none',6000);}else alert(msg);}

function base64ToBlob(base64,type='application/pdf'){
  const binary=atob(base64);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type});
}

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

function extractRow(row){
  const driverCell=row.querySelector('.driver-name');
  return{
    name:driverCell?.querySelector('b')?.textContent?.trim()||'',
    transporterId:driverCell?.querySelector('span')?.textContent?.trim()||'',
    points:row.querySelector('.metric.points b')?.textContent?.trim()||'0.00'
  };
}

async function decorateStation(station){
  const root=document.getElementById(`drivers-${station}`);
  if(!root)return;
  const table=root.querySelector('.drivers-table');
  if(!table||table.dataset.emailReady==='1')return;
  table.dataset.emailReady='1';
  table.classList.add('compact-report');

  const header=table.querySelector('.drivers-header');
  if(header)header.innerHTML='<span>Driver</span><span>Puntos</span><span>Estado</span><span>Acciones</span>';

  const rows=[...table.querySelectorAll('.driver-row')];
  const week=selectedWeek();
  for(const row of rows){
    const main=row.querySelector('.driver-main');
    if(!main)continue;
    const details=main.querySelector('.driver-details');
    const detailHtml=details?.querySelector('.detail-list')?.innerHTML||'<span class="muted">Sin detalle adicional.</span>';
    if(details)details.remove();

    const {name,transporterId}=extractRow(row);
    const directory=await getDirectory(transporterId);
    const email=String(directory?.email||'').trim();
    const sent=await getSent(week,station,transporterId);

    const status=document.createElement('div');
    status.className='report-status';
    status.innerHTML=sent?'<span class="sent-badge">✓ Enviado</span>':'<span class="muted">Pendiente</span>';

    const actions=document.createElement('div');
    actions.className='report-actions';
    actions.innerHTML=`<button class="report-detail-btn" type="button">Ver detalle</button><button class="report-preview-btn" type="button">Ver PDF</button>${email?'<button class="report-send-btn" type="button">Enviar PDF</button>':'<span class="email-missing">Sin email</span>'}`;

    const panel=document.createElement('div');
    panel.className='driver-detail-panel';
    panel.innerHTML=`<div class="detail-list">${detailHtml}</div>`;
    main.append(status,actions,panel);

    actions.querySelector('.report-detail-btn')?.addEventListener('click',e=>{
      const open=panel.classList.toggle('open');
      e.currentTarget.textContent=open?'Ocultar detalle':'Ver detalle';
    });

    const previewBtn=actions.querySelector('.report-preview-btn');
    previewBtn?.addEventListener('click',async()=>{
      const original=previewBtn.textContent;
      previewBtn.disabled=true;previewBtn.textContent='Abriendo...';
      const previewWindow=window.open('','_blank');
      if(previewWindow)previewWindow.document.write('<title>Generando PDF...</title><p style="font-family:Arial;padding:24px">Generando PDF de AAXI Xpress...</p>');
      try{
        await waitForAuth();
        const result=await previewDriverReport({week:selectedWeek(),station,transporterId});
        const d=result.data||{};
        if(!d.pdfBase64)throw new Error('No se recibió el PDF.');
        const blob=base64ToBlob(d.pdfBase64);
        const url=URL.createObjectURL(blob);
        if(previewWindow)previewWindow.location.href=url;
        else window.open(url,'_blank');
        setTimeout(()=>URL.revokeObjectURL(url),120000);
      }catch(err){
        if(previewWindow)previewWindow.close();
        console.error(err);
        showMessage(err?.message||'No se pudo abrir el PDF.');
      }finally{previewBtn.disabled=false;previewBtn.textContent=original;}
    });

    const sendBtn=actions.querySelector('.report-send-btn');
    sendBtn?.addEventListener('click',async()=>{
      const original=sendBtn.textContent;
      sendBtn.disabled=true;sendBtn.textContent='Enviando...';
      try{
        await waitForAuth();
        const result=await sendDriverReport({week:selectedWeek(),station,transporterId});
        status.innerHTML='<span class="sent-badge">✓ Enviado</span>';
        showMessage(`✓ PDF enviado a ${result.data?.email||email}`);
      }catch(err){
        console.error(err);
        showMessage(err?.message||'No se pudo enviar el reporte.');
      }finally{sendBtn.disabled=false;sendBtn.textContent=original;}
    });
  }
  addSendAll(station);
}

function addSendAll(station){
  const page=document.getElementById(`page-${station}`);
  const head=page?.querySelector('.station-head');
  if(!head||head.querySelector('.report-toolbar'))return;
  const toolbar=document.createElement('div');
  toolbar.className='report-toolbar';
  toolbar.innerHTML='<button class="btn send-all-btn" type="button">Enviar todos los PDF</button><span class="muted">Cada driver recibe su reporte individual.</span>';
  head.appendChild(toolbar);
  const btn=toolbar.querySelector('button');
  btn.addEventListener('click',async()=>{
    const week=selectedWeek();
    if(!confirm(`¿Enviar por email todos los reportes PDF de ${station} para ${week}?`))return;
    const original=btn.textContent;btn.disabled=true;btn.textContent='Enviando todos...';
    try{
      await waitForAuth();
      const result=await sendStationReports({week,station});
      const d=result.data||{};
      showMessage(`✓ ${d.sent||0} enviados. ${d.failed||0} sin enviar.`);
      document.querySelectorAll(`#drivers-${station} .driver-row`).forEach(async row=>{
        const {transporterId}=extractRow(row);
        if(await getSent(week,station,transporterId))row.querySelector('.report-status').innerHTML='<span class="sent-badge">✓ Enviado</span>';
      });
    }catch(err){console.error(err);showMessage(err?.message||'No se pudieron enviar los reportes.');}
    finally{btn.disabled=false;btn.textContent=original;}
  });
}

const observer=new MutationObserver(()=>stationRoots.forEach(decorateStation));
observer.observe(document.body,{childList:true,subtree:true});
stationRoots.forEach(decorateStation);
