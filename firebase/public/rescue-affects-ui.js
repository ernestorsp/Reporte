function applyRescueLabels(){
  const root=document.getElementById('scoringRows');
  if(!root)return;
  const rows=root.querySelectorAll('.score-row');
  for(const row of rows){
    const input=row.querySelector('[data-score-key]');
    const title=row.querySelector('b');
    const help=row.querySelector('.small');
    if(!input||!title)continue;
    let nextTitle='',nextHelp='';
    if(input.dataset.scoreKey==='rescueYes'){
      nextTitle='Rescate recibido · Affects = Yes';
      nextHelp='(Stops + Packages) × multiplicador · impacto negativo';
    }else if(input.dataset.scoreKey==='rescuePositive'){
      nextTitle='Rescate realizado · Affects = Positive';
      nextHelp='(Stops + Packages) × multiplicador · puntos positivos';
    }else continue;
    if(title.textContent!==nextTitle)title.textContent=nextTitle;
    if(help&&help.textContent!==nextHelp)help.textContent=nextHelp;
  }
}
function startRescueLabelObserver(){
  const root=document.getElementById('scoringRows');
  if(!root||root.dataset.rescueObserver==='1')return;
  root.dataset.rescueObserver='1';
  let timer=null;
  const obs=new MutationObserver(()=>{
    clearTimeout(timer);
    timer=setTimeout(applyRescueLabels,25);
  });
  obs.observe(root,{childList:true,subtree:true});
  applyRescueLabels();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startRescueLabelObserver,{once:true});
else startRescueLabelObserver();
document.querySelector('[data-page="points"]')?.addEventListener('click',()=>setTimeout(()=>{startRescueLabelObserver();applyRescueLabels();},0));