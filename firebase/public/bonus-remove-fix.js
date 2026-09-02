import {getApps} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {getFirestore,doc,getDoc,setDoc,serverTimestamp} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const app=getApps()[0];
if(app){
  const auth=getAuth(app),db=getFirestore(app);
  const waitAuth=()=>auth.currentUser?Promise.resolve(auth.currentUser):new Promise((resolve,reject)=>{const off=onAuthStateChanged(auth,u=>{if(u){off();resolve(u);}},reject);});
  const week=()=>document.getElementById('week')?.value||'';
  const toast=msg=>{const t=document.getElementById('toast');if(!t)return; t.textContent=msg;t.style.display='block';clearTimeout(window.__bonusRemoveToast);window.__bonusRemoveToast=setTimeout(()=>t.style.display='none',4000);};
  const spinner=(btn)=>{btn.dataset.oldHtml=btn.innerHTML;btn.disabled=true;btn.style.cursor='wait';btn.innerHTML='<span style="display:inline-block;width:12px;height:12px;border:2px solid #fecdca;border-top-color:#b42318;border-radius:50%;animation:aaxiSpin .65s linear infinite"></span>';};
  const restoreBtn=(btn)=>{btn.disabled=false;btn.style.cursor='pointer';btn.innerHTML=btn.dataset.oldHtml||'×';};
  if(!document.getElementById('aaxiSpinStyle')){const s=document.createElement('style');s.id='aaxiSpinStyle';s.textContent='@keyframes aaxiSpin{to{transform:rotate(360deg)}}';document.head.appendChild(s);}

  async function saveRemoval(station,gid){
    const w=week();if(!w||!station||!gid)throw new Error('Faltan datos para sacar el driver.');
    await waitAuth();
    const ref=doc(db,'homeBonusExclusions',w),snap=await getDoc(ref),data=snap.exists()?snap.data():{};
    const set=new Set(Array.isArray(data?.[station])?data[station]:[]);set.add(gid);
    await setDoc(ref,{week:w,[station]:[...set],updatedAt:serverTimestamp()},{merge:true});
    window.AAXIHomeCache?.clear?.(w);
    await window.AAXIHomeCache?.refresh?.();
  }

  async function restoreStation(station){
    const w=week();if(!w||!station)throw new Error('Faltan datos para restaurar.');
    await waitAuth();
    const ref=doc(db,'homeBonusExclusions',w);
    await setDoc(ref,{week:w,[station]:[],updatedAt:serverTimestamp()},{merge:true});
    window.AAXIHomeCache?.clear?.(w);
    await window.AAXIHomeCache?.refresh?.();
  }

  document.addEventListener('click',async e=>{
    const remove=e.target.closest?.('[data-bonus-remove]');
    const restore=e.target.closest?.('[data-bonus-restore]');
    if(!remove&&!restore)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    const btn=remove||restore;spinner(btn);
    if(remove){const row=remove.closest('.home-rank-row');if(row){row.style.transition='opacity .2s ease';row.style.opacity='.45';}}
    try{
      if(remove)await saveRemoval(remove.dataset.station,remove.dataset.gid);
      else await restoreStation(restore.dataset.station);
    }catch(err){
      if(remove){const row=remove.closest('.home-rank-row');if(row)row.style.opacity='1';}
      restoreBtn(btn);toast('No pude actualizar el Top: '+(err.message||String(err)));console.warn(err);
    }
  },true);
}
