document.querySelector('[data-page="home"]')?.addEventListener('click',()=>{setTimeout(()=>document.getElementById('week')?.dispatchEvent(new Event('change')),120);});
