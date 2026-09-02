function applyRescueLabels(){
  const rows=[...document.querySelectorAll('#scoringRows .score-row')];
  for(const row of rows){
    const input=row.querySelector('[data-score-key]');
    const title=row.querySelector('b');
    const help=row.querySelector('.small');
    if(!input||!title)continue;
    if(input.dataset.scoreKey==='rescueYes'){
      title.textContent='Rescate recibido · Affects = Yes';
      if(help)help.textContent='(Stops + Packages) × multiplicador · impacto negativo';
    }
    if(input.dataset.scoreKey==='rescuePositive'){
      title.textContent='Rescate realizado · Affects = Positive';
      if(help)help.textContent='(Stops + Packages) × multiplicador · puntos positivos';
    }
  }
}
const obs=new MutationObserver(applyRescueLabels);
obs.observe(document.body,{childList:true,subtree:true});
document.addEventListener('DOMContentLoaded',applyRescueLabels);
applyRescueLabels();
