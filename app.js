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
const ROSTER_KEY='ra-scanner-roster-v2';
const QUEUE_KEY='ra-scanner-queue-v2';
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
  const response=await fetch(`${CONFIG.backendUrl}?action=person&id=${encodeURIComponent(id)}&_=${Date.now()}`,{cache:'no-store'});
  const data=await response.json();
  if(!data.ok)return null;
  return data.person;
}

async function postBackend(payload,timeoutMs=20000){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(CONFIG.backendUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload),signal:controller.signal});
    return response.json();
  }finally{
    clearTimeout(timeout);
  }
}

async function registerPerson(event){
  if(CONFIG.demoMode||!CONFIG.backendUrl)return{ok:true,person:getCachedPerson(event.id),message:'Presenza registrata'};
  return postBackend({action:'register',id:event.id,eventId:event.eventId,pin:localStorage.getItem('ra-scanner-pin')||'',operator:event.operator||'Campo'});
}

function roster(){try{return JSON.parse(localStorage.getItem(ROSTER_KEY)||'{}')}catch{return{}}}
function saveRoster(value){localStorage.setItem(ROSTER_KEY,JSON.stringify(value));renderUpcomingTrials()}
function getCachedPerson(id){return roster()[normalizedId(id)]||null}
function queue(){try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]')}catch{return[]}}
function saveQueue(value){localStorage.setItem(QUEUE_KEY,JSON.stringify(value));updateSyncStatus()}
function eventId(){return self.crypto&&crypto.randomUUID?crypto.randomUUID():`ra-${Date.now()}-${Math.random().toString(16).slice(2)}`}

async function syncRoster(silent=false){
  if(!ensurePin()){if(!silent)alert('Questo dispositivo non è autorizzato. Apri il link scanner privato.');return false}
  try{
    const data=await postBackend({action:'sync',pin:localStorage.getItem('ra-scanner-pin')||''},12000);
    if(!data.ok)throw new Error(data.error||'Sincronizzazione non riuscita');
    const map={};data.people.forEach(person=>map[person.id]=person);saveRoster(map);
    localStorage.setItem('ra-roster-synced-at',data.syncedAt||new Date().toISOString());
    updateSyncStatus();flushQueue();
    return true;
  }catch(error){
    if(!silent)alert(error.message||'Impossibile aggiornare l’elenco. Controlla la connessione.');
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

function dateAtMidnight(date){return new Date(date.getFullYear(),date.getMonth(),date.getDate())}
function dateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
function parseRequestedDate(value){
  const match=String(value||'').trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if(!match)return null;
  const date=new Date(Number(match[3]),Number(match[2])-1,Number(match[1]));
  return Number.isNaN(date.getTime())?null:date;
}
function shortDate(date){return new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'2-digit'}).format(date)}
function upcomingTrialLabel(person){
  if(Number(person.requestTrials||0)>0)return 'Presenza registrata';
  if(Number(person.trials||0)>=Number(person.maxTrials||2))return 'Prove terminate';
  return Number(person.trials||0)===0?'Prima prova':'Seconda e ultima prova';
}
function renderUpcomingTrials(){
  const target=document.querySelector('#upcoming-trials');
  if(!target||!ensurePin())return;
  const previouslyOpen=new Set([...target.querySelectorAll('.trial-day[open]')].map(day=>day.dataset.offset));
  const hasRendered=target.dataset.rendered==='true';
  const today=dateAtMidnight(new Date());
  const days=['Oggi','Domani','Dopodomani'].map((label,offset)=>{
    const date=new Date(today);date.setDate(today.getDate()+offset);
    const people=Object.values(roster()).filter(person=>{
      if(String(person.state||'PROVA').toUpperCase()!=='PROVA')return false;
      const requested=parseRequestedDate(person.requestedDate);
      return requested&&dateKey(requested)===dateKey(date);
    }).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'it',{sensitivity:'base'}));
    return{label,offset,date,people};
  });
  target.dataset.rendered='true';
  target.innerHTML=`<div class="upcoming-heading"><span>Prove in arrivo</span><small>oggi, domani e dopodomani</small></div>${days.map(day=>{
    const open=hasRendered?previouslyOpen.has(String(day.offset)):day.offset===0;
    const rows=day.people.length?`<ul class="trial-list">${day.people.map(person=>{
      const registered=Number(person.requestTrials||0)>0;
      const year=String(person.birthYear||'').trim();
      return `<li class="trial-person${registered?' registered':''}"><span class="trial-name">${escapeHtml(person.name)}${year?` <small>· ${escapeHtml(year)}</small>`:''}</span><span class="trial-label">${registered?'✓ ':''}${escapeHtml(upcomingTrialLabel(person))}</span></li>`;
    }).join('')}</ul>`:'<p class="trial-empty">Nessuna prova prevista.</p>';
    return `<details class="trial-day" data-offset="${day.offset}"${open?' open':''}><summary><span>${day.label}<small>${shortDate(day.date)}</small></span><strong>${day.people.length}</strong></summary>${rows}</details>`;
  }).join('')}`;
}

async function card(){
  loading();
  try{
    const id=normalizedId(params.get('id'));
    const p=await getPerson(id);
    if(!p)return unknown();
    const active=p.state==='ISCRITTO';
    const ended=!active&&p.trials>=p.maxTrials;
    shell(`<div class="eyebrow">${active?'Tessera personale Romatletica':'Tessera personale per le prove gratuite'}</div><h1>${escapeHtml(p.name)}</h1><p class="card-intro">${active?'Conserva questa tessera personale e mostra il QR all’ingresso del campo.':'Le prove gratuite permettono di conoscere il corso, gli allenatori e il gruppo prima dell’iscrizione. In base alla categoria è possibile partecipare a una o due giornate di prova.<br><strong>Conserva questa tessera personale e mostra il QR all’ingresso del campo.</strong>'}</p><div class="status ${active?'green':ended?'red':'orange'}">${active?'ISCRITTO':ended?'2 PROVE GRATUITE COMPLETATE':completedTrialsLabel(p)}</div>${!active&&!ended?`<p><strong>${nextTrialLabel(p)}</strong></p>`:''}${p.requestedDate?`<p class="requested-date"><strong>Prova richiesta per:</strong> ${escapeHtml(p.requestedDate)}</p>`:''}<div id="qr" class="qr" aria-label="QR personale"></div><div class="id">${escapeHtml(p.id)}</div>${ended&&p.signupUrl&&!String(p.signupUrl).startsWith('DA_INSERIRE')?`<a class="button" href="${escapeHtml(p.signupUrl)}">ISCRIVITI A ROMATLETICA</a>`:''}<p>Il QR è personale e resta valido per entrambe le prove.</p>`);
    new QRCode(document.querySelector('#qr'),{text:p.id,width:280,height:280,colorDark:'#123d73',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }catch(error){connectionError(error)}
}

function scanner(){
  shell(`<div class="eyebrow">Ingresso campo</div><h1>Scansiona il QR</h1><div id="reader"></div><button id="start" disabled>PREPARAZIONE…</button><p id="scanner-message" class="scanner-message" hidden></p><button id="retry-sync" class="secondary compact" hidden>RIPROVA AGGIORNAMENTO</button><section id="upcoming-trials" class="upcoming-trials" aria-label="Prove previste nei prossimi tre giorni"></section>`);
  flushQueue();
  const button=document.querySelector('#start');
  button.onclick=()=>startCamera();
  document.querySelector('#retry-sync').onclick=()=>prepareScanner(button);
  renderUpcomingTrials();
  prepareScanner(button);
}

function scannerMessage(text='',showRetry=false){
  const message=document.querySelector('#scanner-message');
  const retry=document.querySelector('#retry-sync');
  if(!message||!retry)return;
  message.hidden=!text;
  message.textContent=text;
  retry.hidden=!showRetry;
}

async function prepareScanner(button){
  if(!ensurePin()){
    button.disabled=true;
    button.textContent='DISPOSITIVO NON AUTORIZZATO';
    scannerMessage('Apri il link scanner privato fornito da Romatletica. Una volta autorizzato, questo telefono resterà pronto per gli accessi.');
    return;
  }
  const prepared=Boolean(localStorage.getItem('ra-roster-synced-at'));
  button.disabled=!navigator.onLine&&!prepared;
  button.textContent=button.disabled?'COLLEGATI A INTERNET':'ATTIVA FOTOCAMERA';
  if(!navigator.onLine){
    scannerMessage(prepared?'Modalità offline attiva: puoi continuare a scansionare. Le presenze saranno inviate automaticamente appena torna la connessione.':'Per il primo avvio serve una connessione. Controlla la rete e poi tocca “Riprova aggiornamento”.',true);
    return;
  }
  scannerMessage(prepared?'':'Aggiornamento dell’elenco in corso. Puoi già attivare la fotocamera.');
  const updated=await syncRoster(true);
  if(updated){
    scannerMessage();
    button.disabled=false;
    button.textContent='ATTIVA FOTOCAMERA';
    flushQueue();
    return;
  }
  const usable=prepared||Object.keys(roster()).length>0;
  button.disabled=!usable;
  button.textContent=usable?'ATTIVA FOTOCAMERA':'RIPROVA TRA POCO';
  scannerMessage(usable?'L’elenco salvato è disponibile: puoi continuare a scansionare normalmente. Per cercare nuove prenotazioni, riprova l’aggiornamento.':'Non siamo riusciti ad aggiornare l’elenco. Verifica la rete, chiudi e riapri la pagina oppure tocca “Riprova aggiornamento”.',true);
}

function ensurePin(){
  return Boolean(localStorage.getItem('ra-scanner-pin'));
}

async function startCamera(){
  const button=document.querySelector('#start');button.disabled=true;button.textContent='FOTOCAMERA ATTIVA';
  try{
    scannerInstance=new Html5Qrcode('reader');
    await scannerInstance.start({facingMode:'environment'},{fps:10,qrbox:{width:240,height:240}},async text=>{await stopCamera();openPerson(text)},()=>{});
  }catch(error){button.disabled=false;button.textContent='RIPROVA FOTOCAMERA';alert('La fotocamera non si è avviata. Chiudi e riapri questa pagina e riprova. Se il problema continua, controlla nelle impostazioni del browser che l’uso della fotocamera sia consentito.')}
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
  if(local.state!=='ISCRITTO'){
    local.trials=Math.min(Number(local.maxTrials||2),Number(local.trials||0)+1);
    local.requestTrials=Number(local.requestTrials||0)+1;
  }
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
