const CONFIG=window.ROMATLETICA_CONFIG||{};
const DEMO={"RA-P-7K4M9Q":{id:"RA-P-7K4M9Q",name:"Mario Rossi",state:"PROVA",trials:0,maxTrials:2,signupUrl:""},"RA-P-2F8X3N":{id:"RA-P-2F8X3N",name:"Giulia Bianchi",state:"PROVA",trials:2,maxTrials:2,signupUrl:""},"RA-I-9T6C2V":{id:"RA-I-9T6C2V",name:"Andrea Verdi",state:"ISCRITTO",trials:2,maxTrials:2,signupUrl:""}};
const app=document.querySelector('#app');
const params=new URLSearchParams(location.search);
const view=params.get('view')||'home';
let scannerInstance=null;

function shell(html){app.innerHTML=`<section class="card">${html}</section>`}
function loading(){shell('<div class="spinner" aria-label="Caricamento"></div><p>Caricamento…</p>')}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function normalizedId(value){const raw=String(value||'').trim();try{const url=new URL(raw);return String(url.searchParams.get('id')||raw).trim().toUpperCase()}catch{return raw.toUpperCase()}}

async function getPerson(id){
  id=normalizedId(id);
  if(CONFIG.demoMode||!CONFIG.backendUrl){const local=JSON.parse(localStorage.getItem(`ra-demo-${id}`)||'null');return local||DEMO[id]||null}
  const response=await fetch(`${CONFIG.backendUrl}?action=person&id=${encodeURIComponent(id)}`,{cache:'no-store'});
  const data=await response.json();
  if(!data.ok)return null;
  return data.person;
}

async function registerPerson(id){
  id=normalizedId(id);
  if(CONFIG.demoMode||!CONFIG.backendUrl){const person=await getPerson(id);if(!person)return null;if(person.state==='PROVA')person.trials=Math.min(person.maxTrials||2,person.trials+1);localStorage.setItem(`ra-demo-${id}`,JSON.stringify(person));return{ok:true,person,message:person.state==='PROVA'?'Prova registrata':'Presenza registrata'}}
  const response=await fetch(CONFIG.backendUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'register',id,pin:localStorage.getItem('ra-scanner-pin')||'',operator:localStorage.getItem('ra-operator')||'Campo'})});
  return response.json();
}

function home(){shell(`<div class="eyebrow">Sistema presenze</div><h1>Presenze Romatletica</h1><p>Un solo QR personale per prove gratuite e allenamenti.</p><a class="button" href="?view=scanner">SCANSIONA UN QR</a>${CONFIG.demoMode?'<a class="button secondary" href="?view=card&id=RA-P-7K4M9Q">Tessera dimostrativa</a><a class="button secondary" href="?view=card&id=RA-I-9T6C2V">Esempio iscritto</a><p class="notice">Modalità dimostrativa: nessun dato reale è pubblicato.</p>':''}`)}

async function card(){
  loading();
  try{
    const id=normalizedId(params.get('id'));
    const p=await getPerson(id);
    if(!p)return unknown();
    const active=p.state==='ISCRITTO';
    const ended=!active&&p.trials>=p.maxTrials;
    shell(`<div class="eyebrow">Tessera digitale</div><h1>${escapeHtml(p.name)}</h1><div class="status ${active?'green':ended?'red':'orange'}">${active?'ISCRITTO':ended?'PROVE GRATUITE TERMINATE':`PROVA ${p.trials+1} DI ${p.maxTrials}`}</div><div id="qr" class="qr" aria-label="QR personale"></div><div class="id">${escapeHtml(p.id)}</div>${ended&&p.signupUrl&&!String(p.signupUrl).startsWith('DA_INSERIRE')?`<a class="button" href="${escapeHtml(p.signupUrl)}">ISCRIVITI A ROMATLETICA</a>`:''}<p>Mostra questo QR all’ingresso del campo.</p>`);
    new QRCode(document.querySelector('#qr'),{text:p.id,width:280,height:280,colorDark:'#123d73',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }catch(error){connectionError(error)}
}

function scanner(){
  shell(`<div class="eyebrow">Ingresso campo</div><h1>Scansiona il QR</h1><div id="reader"></div><button id="start">ATTIVA FOTOCAMERA</button><label for="manual">Oppure inserisci il codice</label><input id="manual" placeholder="RA-P-…" autocomplete="off"><button class="secondary" id="lookup">CERCA</button><p class="notice">Dopo la registrazione la schermata torna automaticamente pronta per il prossimo atleta.</p>`);
  document.querySelector('#start').onclick=()=>{if(ensurePin())startCamera()};
  document.querySelector('#lookup').onclick=()=>{if(ensurePin())openPerson(document.querySelector('#manual').value)};
  document.querySelector('#manual').addEventListener('keydown',e=>{if(e.key==='Enter'&&ensurePin())openPerson(e.target.value)});
}

function ensurePin(){
  if(localStorage.getItem('ra-scanner-pin'))return true;
  const pin=prompt('Inserisci il PIN operatore');
  if(!pin)return false;
  localStorage.setItem('ra-scanner-pin',pin.trim());
  return true;
}

async function startCamera(){
  const button=document.querySelector('#start');button.disabled=true;button.textContent='FOTOCAMERA ATTIVA';
  try{
    scannerInstance=new Html5Qrcode('reader');
    await scannerInstance.start({facingMode:'environment'},{fps:10,qrbox:{width:240,height:240}},async text=>{await stopCamera();openPerson(text)},()=>{});
  }catch(error){button.disabled=false;button.textContent='RIPROVA FOTOCAMERA';alert('Fotocamera non disponibile. Puoi inserire il codice scritto sotto al QR.')}
}

async function stopCamera(){try{if(scannerInstance&&scannerInstance.isScanning)await scannerInstance.stop()}catch{}scannerInstance=null}

async function openPerson(rawId){
  const id=normalizedId(rawId);if(!id)return;
  loading();
  try{
    const p=await getPerson(id);if(!p)return unknown();
    const active=p.state==='ISCRITTO';const ended=!active&&p.trials>=p.maxTrials;
    shell(`<div class="eyebrow">Verifica atleta</div><h1>${escapeHtml(p.name)}</h1><div class="status ${active?'green':ended?'red':'orange'}">${active?'ISCRITTO':ended?'PROVE GRATUITE TERMINATE':`PROVA ${p.trials+1} DI ${p.maxTrials}`}</div>${ended?'<p>Per continuare è necessario completare l’iscrizione.</p>':`<button id="register">${active?'REGISTRA PRESENZA':'REGISTRA PROVA'}</button>`}<a class="button secondary" href="?view=scanner">ANNULLA / ALTRO QR</a>`);
    const button=document.querySelector('#register');if(button)button.onclick=()=>register(id,button);
  }catch(error){connectionError(error)}
}

async function register(id,button){
  button.disabled=true;button.textContent='REGISTRAZIONE…';
  try{
    const result=await registerPerson(id);
    if(!result||!result.ok){if(result&&result.blocked)return openPerson(id);throw new Error(result&&result.error||'Registrazione non riuscita')}
    shell(`<p class="success">✓</p><h1>${escapeHtml(result.message||'Presenza registrata')}</h1><div class="status green">${escapeHtml(result.person.name)}</div><a class="button" href="?view=scanner">SCANSIONA IL PROSSIMO</a>`);
    setTimeout(()=>location.href='?view=scanner',2200);
  }catch(error){connectionError(error)}
}

function unknown(){shell(`<div class="status red">QR NON RICONOSCIUTO</div><p>Controlla il codice e riprova.</p><a class="button" href="?view=scanner">TORNA ALLO SCANNER</a>`)}
function connectionError(){shell(`<div class="status red">CONNESSIONE NON DISPONIBILE</div><p>La presenza non è stata registrata. Controlla la rete e riprova.</p><a class="button" href="?view=scanner">RIPROVA</a>`)}

({home,card,scanner}[view]||home)();
