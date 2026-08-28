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
const syncLogWeek=httpsCallable(functions,'syncLogWeek');

function waitForAuth(){return new Promise((resolve,reject)=>{if(auth.currentUser)return resolve(auth.currentUser);const off=onAuthStateChanged(auth,u=>{if(u){off();resolve(u);}},reject);});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function toast(msg){const t=document.getElementById('toast');if(!t)return; t.textContent=msg;t.style.display='block';clearTimeout(window.__logSyncToast);window.__logSyncToast=setTimeout(()=>t.style.display='none',7000);}

async function waitForGeneration(week){
  for(let i=0;i<150;i++){
    const snap=await getDoc(doc(db,'generations',week));
    const status=snap.exists()?snap.data()?.status:'';
    if(status==='generated')return true;
    if(status==='error')throw new Error(snap.data()?.error||'La generación terminó con error.');
    await sleep(2000);
  }
  throw new Error('La generación tardó demasiado y no pude sincronizar LOG automáticamente.');
}

async function syncAfterGenerate(){
  const week=document.getElementById('week')?.value||'';
  if(!/^\d{4}-W\d{2}$/.test(week))return;
  try{
    await waitForAuth();
    await sleep(800);
    await waitForGeneration(week);
    const result=await syncLogWeek({week});
    const d=result.data||{};
    toast(`✓ ${week}: LOG importado · ${d.infra||0} infracciones · ${d.rescues||0} rescates.`);
  }catch(err){
    console.warn('LOG automático:',err);
    toast(`Reporte generado, pero LOG no se pudo importar: ${err?.message||String(err)}`);
  }
}

document.getElementById('generateReport')?.addEventListener('click',()=>{syncAfterGenerate();});
