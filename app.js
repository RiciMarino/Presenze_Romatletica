const CONFIG=window.ROMATLETICA_CONFIG||{};
const DEMO={"RA-P-7K4M9Q":{id:"RA-P-7K4M9Q",name:"Mario Rossi",state:"PROVA",trials:0,maxTrials:2,signupUrl:""},"RA-P-2F8X3N":{id:"RA-P-2F8X3N",name:"Giulia Bianchi",state:"PROVA",trials:2,maxTrials:2,signupUrl:""},"RA-I-9T6C2V":{id:"RA-I-9T6C2V",name:"Andrea Verdi",state:"ISCRITTO",trials:2,maxTrials:2,signupUrl:""}};
const app=document.querySelector('#app');
const params=new URLSearchParams(location.search);
const view=params.get('view')||'home';
const accessKey=params.get('key');
if(accessKey){
  localStorage.setItem('ra-scanner-pin',accessKey.trim());
  const clean=new URL(location.href);clean.searchParams.delete('key');history.replaceState({},'',clean.pathname+clean.search);
}
let scannerInstance=null;
const ROSTER_KEY='ra-scanner-roster-v1';
const QUEUE_KEY='ra-scanner-queue-v1';
let syncing=false;

function shell(html){app.innerHTML=`<section class="card">${html}</section>`}
function loading(){shell('<div class="spinner" aria-label="Caricamento"></div><p>Caricamento…</p>')}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function normalizedId(value){const raw=String(value||'').trim();try{const url=new URL(raw);return String(url.searchParams.get('id')||raw).trim().toUpperCase()}catch{return raw.toUpperCase()}}
function completedTrialsLabel(p){const n=Number(p.trials||0);return n===0?'NESSUNA PROVA EFFETTUATA':n===1?'1 PROVA EFFETTUATA':`${n} PROVE EFFETTUATE`}
function nextTrialLabel(p){const n=Number(p.trials||0);return n===0?'Prossima: prima prova gratuita':n===1?'Prossima: seconda e ultima prova gratuita':''}

async function getPerson(id){
  id=normalizedId(id);
  if(CONFIG.demoMode||!CONFIG.backendUrl){const local=JSON.parse(localStorage.getItem(`ra-demo-${id}`)||'null');return local||DEMO[id]||null}
  const response=await fetch(`${CONFIG.backendUrl}?action=person&id=${encodeURIComponent(id)}`,{cache:'no-store'});
  const data=await response.json();
  if(!data.ok)return null;
  return data.person;
}

async function postBackend(payload){
  const response=await fetch(CONFIG.backendUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)});
  return response.json();
}

async function registerPerson(event){
  if(CONFIG.demoMode||!CONFIG.backendUrl)return{ok:true,person:getCachedPerson(event.id),message:'Presenza registrata'};
  return postBackend({action:'register',id:event.id,eventId:event.eventId,pin:localStorage.getItem('ra-scanner-pin')||'',operator:event.operator||'Campo'});
}

function roster(){try{return JSON.parse(localStorage.getItem(ROSTER_KEY)||'{}')}catch{return{}}}
function saveRoster(value){localStorage.setItem(ROSTER_KEY,JSON.stringify(value))}
function getCachedPerson(id){return roster()[normalizedId(id)]||null}
function queue(){try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]')}catch{return[]}}
function saveQueue(value){localStorage.setItem(QUEUE_KEY,JSON.stringify(value));updateSyncStatus()}
function eventId(){return self.crypto&&crypto.randomUUID?crypto.randomUUID():`ra-${Date.now()}-${Math.random().toString(16).slice(2)}`}

async function syncRoster(silent=false){
  if(!ensurePin()){if(!silent)alert('Questo dispositivo non è autorizzato. Apri il link scanner privato.');return false}
  try{
    const data=await postBackend({action:'sync',pin:localStorage.getItem('ra-scanner-pin')||''});
    if(!data.ok)throw new Error(data.error||'Sincronizzazione non riuscita');
    const map={};data.people.forEach(person=>map[person.id]=person);saveRoster(map);
    localStorage.setItem('ra-roster-synced-at',data.syncedAt||new Date().toISOString());
    updateSyncStatus();flushQueue();
    return true;
  }catch(error){
    if(!silent||!Object.keys(roster()).length)alert(error.message||'Impossibile preparare l’elenco. Controlla la connessione.');
    return false;
  }
}

function updateSyncStatus(){
  const target=document.querySelector('#sync-status');if(!target)return;
  const count=queue().length;const people=Object.keys(roster()).length;
  target.className=`status ${count?'orange':'green'}`;
  target.textContent=count?`${count} REGISTRAZION${count===1?'E':'I'} DA SINCRONIZZARE`:people?`PRONTO · ${people} ATLETI · TUTTO SINCRONIZZATO`:'ELENCO DA PREPARARE';
}

async function flushQueue(){
  if(syncing||!CONFIG.backendUrl||!navigator.onLine)return;
  syncing=true;
  try{
    let pending=queue();
    while(pending.length){
      const result=await registerPerson(pending[0]);
      if(!result||!result.ok)break;
      if(result.person){const map=roster();map[result.person.id]=result.person;saveRoster(map)}
      pending.shift();saveQueue(pending);
    }
  }catch(error){
    updateSyncStatus();
  }finally{
    syncing=false;updateSyncStatus();
  }
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
    shell(`<div class="eyebrow">${active?'Tessera personale Romatletica':'Tessera personale per le prove gratuite'}</div><h1>${escapeHtml(p.name)}</h1><p class="card-intro">${active?'Conserva questa tessera e mostra il QR all’ingresso del campo.':'Questa tessera identifica la tua prenotazione: conservala e mostra il QR all’ingresso per registrare ciascuna prova gratuita.'}</p><div class="status ${active?'green':ended?'red':'orange'}">${active?'ISCRITTO':ended?'2 PROVE GRATUITE COMPLETATE':completedTrialsLabel(p)}</div>${!active&&!ended?`<p><strong>${nextTrialLabel(p)}</strong></p>`:''}${p.requestedDate?`<p class="requested-date"><strong>Prova richiesta per:</strong> ${escapeHtml(p.requestedDate)}</p>`:''}<div id="qr" class="qr" aria-label="QR personale"></div><div class="id">${escapeHtml(p.id)}</div>${ended&&p.signupUrl&&!String(p.signupUrl).startsWith('DA_INSERIRE')?`<a class="button" href="${escapeHtml(p.signupUrl)}">ISCRIVITI A ROMATLETICA</a>`:''}<p>Il QR è personale e resta valido per entrambe le prove.</p>`);
    new QRCode(document.querySelector('#qr'),{text:p.id,width:280,height:280,colorDark:'#123d73',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }catch(error){connectionError(error)}
}

function scanner(){
  shell(`<div class="eyebrow">Ingresso campo</div><h1>Scansiona il QR</h1><div id="reader"></div><button id="start">ATTIVA FOTOCAMERA</button>`);
  flushQueue();
  syncRoster(true);
  document.querySelector('#start').onclick=async()=>{
    if(!ensurePin()){alert('Apri il link scanner privato fornito da Romatletica.');return}
    if(!Object.keys(roster()).length&&!(await syncRoster()))return;
    startCamera();
  };
}

function ensurePin(){
  return Boolean(localStorage.getItem('ra-scanner-pin'));
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
  let p=getCachedPerson(id);
  if(!p){
    loading();
    try{p=await getPerson(id)}catch(error){return connectionError(error)}
  }
  if(!p)return unknown();
  const active=p.state==='ISCRITTO';const ended=!active&&p.trials>=p.maxTrials;
  shell(`<div class="eyebrow">Verifica atleta</div><h1>${escapeHtml(p.name)}</h1><div class="status ${active?'green':ended?'red':'orange'}">${active?'ISCRITTO':ended?'PROVE GRATUITE TERMINATE':`PROSSIMA: PROVA ${p.trials+1} DI ${p.maxTrials}`}</div>${p.requestedDate?`<p class="requested-date"><strong>Prova richiesta per:</strong> ${escapeHtml(p.requestedDate)}</p>`:''}${ended?`<p>Per continuare è necessario completare l’iscrizione.</p>${p.signupUrl&&!String(p.signupUrl).startsWith('DA_INSERIRE')?`<a class="button" href="${escapeHtml(p.signupUrl)}">VAI ALL’ISCRIZIONE DEL CORSO 2026/27</a>`:''}`:`<button id="register">${active?'REGISTRA PRESENZA':'REGISTRA PROVA'}</button>`}<a class="button secondary" href="?view=scanner">ANNULLA / ALTRO QR</a>`);
  const button=document.querySelector('#register');if(button)button.onclick=()=>register(id,p,button);
}

async function register(id,p,button){
  button.disabled=true;
  const event={eventId:eventId(),id,operator:localStorage.getItem('ra-operator')||'Campo',createdAt:new Date().toISOString()};
  const map=roster();const local={...p};
  if(local.state!=='ISCRITTO')local.trials=Math.min(Number(local.maxTrials||2),Number(local.trials||0)+1);
  map[id]=local;saveRoster(map);
  const pending=queue();pending.push(event);saveQueue(pending);
  const label=local.state==='ISCRITTO'?'PRESENZA ACQUISITA':`PROVA ${local.trials} ACQUISITA`;
  shell(`<p class="success">✓</p><h1>${label}</h1><div class="status green">${escapeHtml(local.name)}</div><p>Salvata sul telefono. Sincronizzazione automatica in corso.</p><a class="button" href="?view=scanner">SCANSIONA IL PROSSIMO</a>`);
  flushQueue();
  setTimeout(()=>location.href='?view=scanner',1100);
}

function unknown(){shell(`<div class="status red">QR NON RICONOSCIUTO</div><p>Controlla il codice e riprova.</p><a class="button" href="?view=scanner">TORNA ALLO SCANNER</a>`)}
function connectionError(){shell(`<div class="status red">CONNESSIONE NON DISPONIBILE</div><p>La presenza non è stata registrata. Controlla la rete e riprova.</p><a class="button" href="?view=scanner">RIPROVA</a>`)}

window.addEventListener('online',flushQueue);
({home,card,scanner}[view]||home)();
