import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {getFirestore,collection,getDocs,doc,setDoc,deleteDoc,serverTimestamp} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
const cfg={apiKey:'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',authDomain:'reporte-c9c78.firebaseapp.com',projectId:'reporte-c9c78',storageBucket:'reporte-c9c78.firebasestorage.app',messagingSenderId:'332419212982',appId:'1:332419212982:web:4bcedf0fb8c25c75fba817'};
const app=getApps()[0]||initializeApp(cfg),auth=getAuth(app),db=getFirestore(app);let ready=false,leads=[],drivers=[],assignments=new Map(),driverStations=new Map(),loaded=false,loading=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function toast(m){const t=document.getElementById('toast');if(!t)return;t.textContent=m;t.style.display='block';clearTimeout(window.__leadToast);window.__leadToast=setTimeout(()=>t.style.display='none',5000);}
function idSafe(v){return String(v||'').trim().replace(/\//g,'_');}
async function loadData(force=false){
  if(!ready||loading||(!force&&loaded))return;
  loading=true;
  try{
    const [ls,ds,as,rs]=await Promise.all([
      getDocs(collection(db,'leads')),
      getDocs(collection(db,'driverDirectory')),
      getDocs(collection(db,'driverLeadAssignments')),
      getDocs(collection(db,'records'))
    ]);
    leads=ls.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    drivers=ds.docs.map(x=>({id:x.id,...x.data()})).filter(x=>String(x.transporterId||x.id).trim()).sort((a,b)=>String(a.name||a['Name and ID']||'').localeCompare(String(b.name||b['Name and ID']||'')));
    assignments=new Map(as.docs.map(x=>[x.id,x.data()]));
    driverStations=new Map();
    const latestByDriver=new Map();
    rs.docs.forEach(x=>{
      const r={id:x.id,...x.data()};
      const tid=String(r.transporterId||'').trim();
      const station=String(r.station||'').trim().toUpperCase();
      const week=String(r.week||'');
      if(!tid||!['DJX3','DJX4'].includes(station))return;
      const previous=latestByDriver.get(tid);
      if(!previous||week>previous.week)latestByDriver.set(tid,{station,week});
    });
    latestByDriver.forEach((v,k)=>driverStations.set(k,v.station));
    loaded=true;
    if(document.getElementById('page-leads')?.classList.contains('active'))render();
  }finally{loading=false;}
}
function render(){renderLeads();renderAssignments();}
function renderLeads(){
  const root=document.getElementById('leadList');
  if(!root)return;
  if(!leads.length){root.innerHTML='<div class="lead-empty">Todavía no has creado LEADs.</div>';return;}
  const counts=new Map();
  assignments.forEach(a=>{
    const leadId=String(a?.leadId||'').trim();
    if(leadId)counts.set(leadId,(counts.get(leadId)||0)+1);
  });
  root.innerHTML=leads.map(l=>{
    const count=counts.get(l.id)||0;
    return `<div class="lead-item"><div style="min-width:0"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><b>${esc(l.name||'LEAD')}</b><span style="display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;background:#eef4ff;color:#3538cd;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:900">${count} driver${count===1?'':'s'}</span></div><span>${esc(l.email||'Sin email')}</span></div><div class="lead-actions"><button class="lead-edit" data-lead-edit="${esc(l.id)}">Editar</button><button class="lead-delete" data-lead-delete="${esc(l.id)}">Borrar</button></div></div>`;
  }).join('');
  root.querySelectorAll('[data-lead-edit]').forEach(b=>b.onclick=()=>editLead(b.dataset.leadEdit));
  root.querySelectorAll('[data-lead-delete]').forEach(b=>b.onclick=()=>removeLead(b.dataset.leadDelete));
}
function driverName(d){return String(d.name||d['Name and ID']||d.driverName||d.id||'').trim();}
function transporterId(d){return String(d.transporterId||d.TransporterID||d.id||'').trim();}
function renderAssignments(){
  const root=document.getElementById('leadAssignments');
  if(!root)return;
  const q=String(document.getElementById('leadSearch')?.value||'').trim().toLowerCase();
  const filtered=drivers.filter(d=>{const n=driverName(d).toLowerCase(),id=transporterId(d).toLowerCase();return !q||n.includes(q)||id.includes(q);});
  if(!filtered.length){root.innerHTML='<div class="lead-empty">No hay drivers para mostrar.</div>';return;}
  const opts=leads.map(l=>`<option value="${esc(l.id)}">${esc(l.name||'LEAD')} · ${esc(l.email||'')}</option>`).join('');
  const stationOf=d=>driverStations.get(transporterId(d))||'SIN ESTACIÓN';
  const sorted=[...filtered].sort((a,b)=>driverName(a).localeCompare(driverName(b)));
  const djx3=sorted.filter(d=>stationOf(d)==='DJX3');
  const djx4=sorted.filter(d=>stationOf(d)==='DJX4');
  const unknown=sorted.filter(d=>!['DJX3','DJX4'].includes(stationOf(d)));
  function section(station,list){
    if(!list.length)return '';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:#101828;color:#fff;font-size:16px;font-weight:900"><span>${station}</span><span style="font-size:12px;opacity:.8">${list.length} drivers</span></div><div class="lead-row header"><span>Driver</span><span>LEAD asignado</span><span>Acción</span></div>${list.map(d=>{const tid=transporterId(d);return`<div class="lead-row"><div class="lead-driver"><b>${esc(driverName(d))}</b><span>${esc(tid)}</span></div><select class="lead-assign-select" data-assign-tid="${esc(tid)}"><option value="">Sin LEAD</option>${opts}</select><button class="lead-save-assignment" data-save-tid="${esc(tid)}">Guardar</button></div>`;}).join('')}`;
  }
  root.innerHTML=section('DJX3',djx3)+section('DJX4',djx4)+(unknown.length?section('SIN ESTACIÓN',unknown):'');
  root.querySelectorAll('[data-assign-tid]').forEach(s=>{const a=assignments.get(idSafe(s.dataset.assignTid));s.value=a?.leadId||'';});
  root.querySelectorAll('[data-save-tid]').forEach(b=>b.onclick=()=>saveAssignment(b.dataset.saveTid,b));
}
async function createLead(){const name=document.getElementById('leadName')?.value.trim(),email=document.getElementById('leadEmail')?.value.trim();if(!name||!email){toast('Escribe nombre y email del LEAD.');return;}if(!/^\S+@\S+\.\S+$/.test(email)){toast('Email del LEAD inválido.');return;}const ref=doc(collection(db,'leads'));await setDoc(ref,{name,email,updatedAt:serverTimestamp(),createdAt:serverTimestamp()});document.getElementById('leadName').value='';document.getElementById('leadEmail').value='';toast('✓ LEAD creado.');loaded=false;await loadData(true);}
async function editLead(id){const l=leads.find(x=>x.id===id);if(!l)return;const name=prompt('Nombre del LEAD',l.name||'');if(name===null)return;const email=prompt('Email del LEAD',l.email||'');if(email===null)return;if(!name.trim()||!/^\S+@\S+\.\S+$/.test(email.trim())){toast('Nombre o email inválido.');return;}await setDoc(doc(db,'leads',id),{name:name.trim(),email:email.trim(),updatedAt:serverTimestamp()},{merge:true});toast('✓ LEAD actualizado.');loaded=false;await loadData(true);}
async function removeLead(id){const l=leads.find(x=>x.id===id);if(!confirm(`¿Borrar a ${l?.name||'este LEAD'}? Los drivers asignados quedarán sin LEAD.`))return;await deleteDoc(doc(db,'leads',id));const snaps=await getDocs(collection(db,'driverLeadAssignments'));for(const d of snaps.docs){if(d.data()?.leadId===id)await deleteDoc(d.ref);}toast('✓ LEAD eliminado.');loaded=false;await loadData(true);}
async function saveAssignment(tid,btn){const select=document.querySelector(`[data-assign-tid="${CSS.escape(tid)}"]`),leadId=select?.value||'',ref=doc(db,'driverLeadAssignments',idSafe(tid));btn.disabled=true;const old=btn.textContent;btn.textContent='Guardando...';try{if(!leadId){await deleteDoc(ref);assignments.delete(idSafe(tid));}else{const lead=leads.find(x=>x.id===leadId);await setDoc(ref,{transporterId:tid,leadId,leadName:lead?.name||'',leadEmail:lead?.email||'',updatedAt:serverTimestamp()},{merge:true});assignments.set(idSafe(tid),{transporterId:tid,leadId,leadName:lead?.name||'',leadEmail:lead?.email||''});}renderLeads();toast('✓ LEAD asignado al driver.');window.dispatchEvent(new Event('aaxi-data-changed'));}catch(e){toast(e.message||String(e));}finally{btn.disabled=false;btn.textContent=old;}}
function unloadLeadDom(){const table=document.getElementById('leadAssignments');if(table)table.innerHTML='<div class="lead-empty">Abre LEADs para cargar las asignaciones.</div>';}
function setup(){document.getElementById('createLeadBtn')?.addEventListener('click',()=>createLead().catch(e=>toast(e.message||String(e))));document.getElementById('leadSearch')?.addEventListener('input',renderAssignments);document.querySelectorAll('.nav button').forEach(btn=>btn.addEventListener('click',()=>{if(btn.dataset.page==='leads'){document.getElementById('title').textContent='LEADs';document.getElementById('subtitle').textContent='Coaching y asignación de drivers';const list=document.getElementById('leadList'),table=document.getElementById('leadAssignments');if(!loaded){if(list)list.innerHTML='<div class="lead-empty">Cargando LEADs...</div>';if(table)table.innerHTML='<div class="lead-empty">Cargando drivers...</div>';loadData().catch(e=>toast(e.message||String(e)));}else requestAnimationFrame(render);}else{requestAnimationFrame(unloadLeadDom);}}));}
onAuthStateChanged(auth,u=>{ready=!!u;if(!u)return;setup();});