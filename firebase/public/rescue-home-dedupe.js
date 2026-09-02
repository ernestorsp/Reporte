import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {getFirestore,collection,query,where,getDocs} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const cfg={apiKey:'AIzaSyBhJpu2AQ4AcdAaKcq-U-BfJQlH-oFw_vg',authDomain:'reporte-c9c78.firebaseapp.com',projectId:'reporte-c9c78',storageBucket:'reporte-c9c78.firebasestorage.app',messagingSenderId:'332419212982',appId:'1:332419212982:web:4bcedf0fb8c25c75fba817'};
const app=getApps()[0]||initializeApp(cfg),auth=getAuth(app),db=getFirestore(app);
const norm=v=>String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0;};
function week(){return document.getElementById('week')?.value||'';}
function rescueRow(d,i){return `<div class="home-rank-row"><div class="home-rank-num">${i+1}</div><div class="home-rank-driver"><b>${esc(d.name)}</b><span>${esc(d.station)} · ${d.count} rescate(s)</span></div><div class="home-rank-value bad"><b>${d.stops} stops</b><span>${d.packages} packages</span></div></div>`;}
function findRescueGrid(){const kickers=[...document.querySelectorAll('.home-section-kicker')];const k=kickers.find(x=>x.textContent.includes('03')&&x.textContent.toUpperCase().includes('RESCUES'));const section=k?.closest('.home-section-title');return section?.nextElementSibling?.classList.contains('home-grid-two')?section.nextElementSibling:null;}
async function refreshRescues(){const w=week(),grid=findRescueGrid();if(!w||!grid)return;const snap=await getDocs(query(collection(db,'records'),where('week','==',w)));const rows=snap.docs.map(d=>d.data());
  const people=new Map(),byId=new Map(),byKey=new Map(),byName=new Map();
  for(const r of rows.filter(r=>r.kind==='OVERVIEW')){const id=String(r.transporterId||'').trim().toUpperCase(),key=String(r.driverKey||'').trim().toUpperCase(),nameKey=norm(r.driverName),gid=id?`I:${id}`:`N:${nameKey}`;let p=people.get(gid);if(!p){p={name:String(r.driverName||'').trim(),station:r.station,stationPkg:{DJX3:0,DJX4:0}};people.set(gid,p);}p.stationPkg[r.station]=(p.stationPkg[r.station]||0)+num(r.extra?.packages);if(id)byId.set(id,p);if(key)byKey.set(key,p);if(nameKey)byName.set(nameKey,p);}
  for(const p of people.values())p.station=(p.stationPkg.DJX4||0)>(p.stationPkg.DJX3||0)?'DJX4':'DJX3';
  const resolve=r=>byId.get(String(r.transporterId||'').trim().toUpperCase())||byKey.get(String(r.driverKey||'').trim().toUpperCase())||byName.get(norm(r.driverName));
  const seen=new Set(),agg=new Map();
  for(const r of rows){if(r.kind!=='RESCUE'||String(r.extra?.affects||'').trim().toLowerCase()!=='yes')continue;const p=resolve(r);if(!p)continue;const sig=[r.date,norm(r.driverName),num(r.extra?.stops),num(r.extra?.packages),'yes',norm(r.extra?.notes),norm(r.extra?.dispatcher)].join('|');if(seen.has(sig))continue;seen.add(sig);const key=p.name+'|'+p.station;let a=agg.get(key);if(!a){a={name:p.name,station:p.station,count:0,stops:0,packages:0};agg.set(key,a);}a.count++;a.stops+=num(r.extra?.stops);a.packages+=num(r.extra?.packages);}
  const top=st=>[...agg.values()].filter(x=>x.station===st).sort((a,b)=>b.count-a.count||(b.stops+b.packages)-(a.stops+a.packages)||a.name.localeCompare(b.name)).slice(0,5);
  const cards=[...grid.querySelectorAll('.home-card')];for(const [i,st] of ['DJX3','DJX4'].entries()){const card=cards[i];if(!card)continue;const head=card.querySelector('.home-card-head')?.outerHTML||'';const list=top(st);card.innerHTML=head+(list.length?list.map(rescueRow).join(''):'<div class="home-empty">Sin datos.</div>');}
}
let timer;function schedule(){clearTimeout(timer);timer=setTimeout(()=>refreshRescues().catch(console.warn),350);}onAuthStateChanged(auth,u=>{if(u)schedule();});document.getElementById('week')?.addEventListener('change',schedule);new MutationObserver(schedule).observe(document.getElementById('homeDashboard')||document.body,{childList:true,subtree:true});window.addEventListener('focus',schedule);
