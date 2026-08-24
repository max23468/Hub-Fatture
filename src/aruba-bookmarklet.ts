export interface ArubaBookmarkletOptions {
  hubOrigin: string;
  panelOrigin: string;
}

function runtime(options: ArubaBookmarkletOptions) {
  const source = String.raw`(async()=>{
const HUB=__HUB__;
const PANEL=__PANEL__;
const TYPE="HF_ARUBA";
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(code)=>{throw new Error(code)};
const visible=(element)=>Boolean(element&&element.getClientRects().length);
const normalized=(value)=>String(value??"").replace(/\s+/g," ").trim();
const matchText=(value)=>normalized(value).normalize("NFKD").replace(/\p{Diacritic}/gu,"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
const browserName=()=>{const ua=navigator.userAgent;if(/Mobile\//.test(ua))fail("BROWSER_UNSUPPORTED");if(/Edg\//.test(ua))return"msedge";if(/(?:Chrome|Chromium|CriOS)\//.test(ua))return"chrome";if(/Version\/\d+(?:\.\d+)*.*Safari\//.test(ua))return"safari";fail("BROWSER_UNSUPPORTED")};
let bridge=null;
let sequence=0;
const pending=new Map();
let statusBox=document.getElementById("hub-fatture-aruba-status");
if(statusBox){statusBox.remove()}
statusBox=document.createElement("aside");
statusBox.id="hub-fatture-aruba-status";
statusBox.setAttribute("role","status");
statusBox.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));padding:14px 16px;border:1px solid #3bc9db;border-radius:10px;background:#071f2b;color:#f7fbfc;font:600 14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 12px 30px #0008;overflow-wrap:anywhere";
document.body.append(statusBox);
const setStatus=(message,error=false)=>{statusBox.textContent=message;statusBox.style.borderColor=error?"#ff7b72":"#3bc9db"};
const failureMessage=(code)=>code==="POPUP_BLOCKED"?"Consenti l’apertura della finestra e riprova.":code==="ARUBA_ORIGIN_MISMATCH"?"Apri il pannello Aruba e usa lì questo preferito.":code==="DOM_UNRECOGNIZED"?"La pagina Aruba non ha completato il caricamento previsto. Ricaricala e riprova.":code==="HUB_TIMEOUT"||code==="HUB_BRIDGE_TIMEOUT"?"Il collegamento con Hub Fatture è scaduto. Torna a Hub Fatture e riprova.":"La lettura si è interrotta prima del completamento. Torna a Hub Fatture e riprova.";
const post=(message)=>bridge&&bridge.postMessage(message,HUB);
const rpc=(path,method="GET",body)=>new Promise((resolve,reject)=>{
  const id=String(++sequence);
  const timeout=setTimeout(()=>{pending.delete(id);reject(new Error("HUB_TIMEOUT"))},30000);
  pending.set(id,{resolve,reject,timeout});
  post({type:TYPE+"_REQUEST",id,path,method,body});
});
const onMessage=(event)=>{
  if(event.origin!==HUB||event.source!==bridge||!event.data)return;
  if(event.data.type===TYPE+"_RESPONSE"){
    const item=pending.get(String(event.data.id));
    if(!item)return;
    clearTimeout(item.timeout);pending.delete(String(event.data.id));
    event.data.ok?item.resolve(event.data.payload):item.reject(new Error(event.data.code||"HUB_ERROR"));
  }
};
addEventListener("message",onMessage);
const waitForStart=()=>new Promise((resolve,reject)=>{
  let hello;
  const timeout=setTimeout(()=>{clearInterval(hello);reject(new Error("HUB_BRIDGE_TIMEOUT"))},60000);
  const receive=(event)=>{
    if(event.origin!==HUB||event.source!==bridge||event.data?.type!==TYPE+"_START")return;
    clearTimeout(timeout);clearInterval(hello);removeEventListener("message",receive);resolve(event.data);
  };
  addEventListener("message",receive);
  hello=setInterval(()=>post({type:TYPE+"_HELLO"}),400);
});
const integer=(value)=>{const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<0)fail("DOM_UNRECOGNIZED");return parsed};
const italianDate=(value)=>{const match=String(value).match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);if(!match)fail("DOM_UNRECOGNIZED");return match[3]+"-"+match[2]+"-"+match[1]};
const italianAmount=(value)=>{const match=String(value).match(/(?:€\s*)?(-?\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(?:\s*€)?/);if(!match)fail("DOM_UNRECOGNIZED");const cents=Number(match[1].replaceAll(".","")+match[2]);if(!Number.isSafeInteger(cents)||cents<0)fail("DOM_UNRECOGNIZED");return cents};
const remoteStatus=(value)=>/non consegnat|mancata consegna/i.test(value)?"NOT_DELIVERED":/consegnat/i.test(value)?"DELIVERED":/scartat|rifiutat/i.test(value)?"REJECTED":/elaborazione|in lavorazione|inoltrat[oa] a sdi/i.test(value)?"SDI_PROCESSING":/inviat|trasmess/i.test(value)?"SUBMITTED":"UNKNOWN";
const fiscalNumber=(value,year)=>{const match=/^(\S+)\s+(\d+)\/(\d{2}|\d{4})$/.exec(normalized(value));if(!match)fail("DOM_UNRECOGNIZED");const number=Number(match[2]);const expected=String(year);if(!Number.isSafeInteger(number)||number<=0||(match[3]!==expected&&match[3]!==expected.slice(-2)))fail("DOM_UNRECOGNIZED");return{series:match[1],fiscalNumber:String(number)}};
const orderReferences=(value)=>{if(!normalized(value))return[];const hash=[...String(value).matchAll(/#\s*[A-Z0-9][A-Z0-9._/-]*/gi)].map(match=>match[0].replace(/\s+/g,""));const labelled=String(value).split(/[,;\n]+/).map(item=>{const parts=item.split(":");return /^(?:ordine|ordini|riferimento|riferimenti|causale)$/i.test(normalized(parts[0]))?normalized(parts.slice(1).join(":")):normalized(item)}).filter(item=>item&&item.length<=100);const result=[...new Set([...hash,...labelled])];if(result.length>20)fail("DOM_UNRECOGNIZED");return result};
const streamParts=(stream)=>{const match=/^(invoices|credit-notes):(\d{4})$/.exec(stream);if(!match)fail("DOM_UNRECOGNIZED");return{type:match[1]==="invoices"?"TD01":"TD04",year:Number(match[2])}};
const assertAccount=(identity)=>{const expected=normalized(identity);const selectors='[data-aruba-account],.main-toolbar-info-user,[aria-current="true"],[aria-selected="true"],[data-active="true"]';const candidates=[...document.querySelectorAll(selectors)].filter(visible).filter(element=>normalized(element.getAttribute("data-aruba-account")??element.textContent)===expected);if(candidates.length!==1)fail("ARUBA_ACCOUNT_MISMATCH")};
const semanticNext=()=>{const candidates=[...document.querySelectorAll("button")].filter(visible).filter(button=>/Pagina successiva|Successiva/i.test(normalized(button.getAttribute("aria-label")||button.textContent)));if(candidates.length>1)fail("DOM_UNRECOGNIZED");return candidates[0]};
const productionNext=()=>{const selector='.aruba-grid-fatture-inviate button[aria-label*="nextPage"],.aruba-grid-fatture-inviate button[title*="nextPage"],.aruba-grid-fatture-inviate [title*="nextPage"] button';const candidates=[...document.querySelectorAll(selector)].filter(visible);if(candidates.length!==1)fail("DOM_UNRECOGNIZED");return candidates[0]};
const enabled=(element)=>Boolean(element&&!element.disabled&&!element.closest(".x-disabled,[aria-disabled='true']"));
const fingerprint=()=>{const values=[...document.querySelectorAll(".aruba-grid-fatture-inviate .x-gridrow[data-recordindex] .x-gridcell:nth-child(18)")].map(element=>normalized(element.textContent)).filter(Boolean);if(!values.length)fail("DOM_UNRECOGNIZED");return values.join("|")};
const armReload=()=>{
  const state={active:true,requested:0,pending:0,failed:false,observed:false,lastMutationAt:0};
  const touchesGrid=(node)=>{const element=node instanceof Element?node:node?.parentElement;return Boolean(element?.closest?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]")||element?.matches?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]")||element?.querySelector?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]"))};
  const observer=new MutationObserver(mutations=>{if(mutations.some(mutation=>touchesGrid(mutation.target)||[...mutation.addedNodes,...mutation.removedNodes].some(touchesGrid))){state.observed=true;state.lastMutationAt=performance.now()}});
  observer.observe(document.body,{attributes:true,childList:true,subtree:true});
  const originalFetch=window.fetch;
  const originalOpen=XMLHttpRequest.prototype.open;
  const originalSend=XMLHttpRequest.prototype.send;
  const xhrRequests=new WeakMap();
  const begin=(value)=>{try{if(!state.active||new URL(String(value),location.href).origin!==location.origin)return false;state.requested+=1;state.pending+=1;queueMicrotask(()=>{state.active=false});return true}catch{return false}};
  window.fetch=function(input,init){const request=input instanceof Request?input:null;const active=begin(request?.url??input);let response;try{response=Reflect.apply(originalFetch,this,[input,init])}catch(error){if(active){state.pending-=1;state.failed=true}throw error}return Promise.resolve(response).then(value=>{if(active&&!value.ok)state.failed=true;return value},error=>{if(active)state.failed=true;throw error}).finally(()=>{if(active)state.pending-=1})};
  XMLHttpRequest.prototype.open=function(method,url,...args){xhrRequests.set(this,{url:new URL(String(url),location.href).href});return Reflect.apply(originalOpen,this,[method,url,...args])};
  XMLHttpRequest.prototype.send=function(...args){const request=xhrRequests.get(this);const active=Boolean(request&&begin(request.url));if(active){this.addEventListener("loadend",()=>{state.pending-=1;if(this.status<200||this.status>=400)state.failed=true},{once:true})}return Reflect.apply(originalSend,this,args)};
  return{state,stop:()=>{observer.disconnect();window.fetch=originalFetch;XMLHttpRequest.prototype.open=originalOpen;XMLHttpRequest.prototype.send=originalSend}};
};
const reloadReady=()=>{if(document.querySelector(".aruba-grid-fatture-inviate")){try{productionNext();return true}catch{return false}}return visible(document.querySelector('[data-aruba-state="inventory-ready"]'))};
const waitForReload=async(monitor,before=null)=>{for(let attempt=0;attempt<120;attempt+=1){await sleep(250);if(monitor.state.failed)fail("DOM_UNRECOGNIZED");let changed=!before;if(before){try{changed=fingerprint()!==before}catch{changed=false}}const networkReady=monitor.state.requested===0||monitor.state.pending===0;if(networkReady&&changed&&monitor.state.observed&&performance.now()-monitor.state.lastMutationAt>=500&&reloadReady())return}fail("DOM_UNRECOGNIZED")};
const clickProduction=async(control,requireChange=false)=>{let before=null;if(requireChange){try{before=fingerprint()}catch{}}const monitor=armReload();try{control.click();await waitForReload(monitor,before)}finally{monitor.stop()}};
const waitForNativeReload=async(control)=>{const monitor=await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timeout);document.removeEventListener("pointerdown",start,true);document.removeEventListener("click",start,true)};const start=(event)=>{if(!event.isTrusted||!(event.target instanceof Node)||!control.contains(event.target))return;cleanup();resolve(armReload())};const timeout=setTimeout(()=>{cleanup();reject(new Error("DOM_UNRECOGNIZED"))},60000);document.addEventListener("pointerdown",start,true);document.addEventListener("click",start,true)});try{await waitForReload(monitor)}finally{monitor.stop()}};
const sentDestination=()=>{const matches=(selector)=>[...document.querySelectorAll(selector)].filter(visible).filter(item=>/^(?:Fatture inviate|Documenti inviati|Inviate)$/i.test(normalized(item.textContent)));const semantic=matches('[role="menuitem"]');if(semantic.length===1)return semantic[0];if(semantic.length>1)fail("DOM_UNRECOGNIZED");const fallback=matches("a,button");if(fallback.length!==1)fail("DOM_UNRECOGNIZED");return fallback[0]};
const waitForInventory=async(stream)=>{for(let attempt=0;attempt<120;attempt+=1){if(visible(document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]'))||visible(document.querySelector('[data-aruba-state="inventory-ready"]'))||(visible(document.querySelector(".main-toolbar-info-fiscalyear"))&&visible(document.querySelector(".aruba-grid-fatture-inviate"))))return;await sleep(250)}fail("DOM_UNRECOGNIZED")};
const openInventory=async(stream)=>{if(visible(document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]'))||visible(document.querySelector('[data-aruba-state="inventory-ready"]'))||visible(document.querySelector(".aruba-grid-fatture-inviate")))return;const sent=sentDestination();setStatus("Seleziona Fatture inviate nel menu Aruba per continuare.");await waitForNativeReload(sent);await waitForInventory(stream)};
const applyDateFilter=async(value)=>{const candidates=[...document.querySelectorAll('[data-aruba-filter-from],input[name="dataDa"]')].filter(visible);if(candidates.length!==1)fail("DOM_UNRECOGNIZED");const from=candidates[0];const next=value?String(value).slice(0,10):"";const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;if(!(from instanceof HTMLInputElement)||!setter)fail("DOM_UNRECOGNIZED");const apply=[...document.querySelectorAll("button")].filter(visible).find(button=>/^(?:Applica(?: filtri)?|Cerca|Filtra)$/i.test(normalized(button.textContent)));if(!apply)fail("DOM_UNRECOGNIZED");const monitor=armReload();try{setter.call(from,next);from.dispatchEvent(new Event("input",{bubbles:true}));from.dispatchEvent(new Event("change",{bubbles:true}));apply.click();await waitForReload(monitor)}finally{monitor.stop()}};
const selectStream=async(stream,overlapFrom)=>{
  await openInventory(stream);
  const synthetic=document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]');
  if(synthetic){synthetic.click();await sleep(100);await applyDateFilter(overlapFrom);return true}
  if(document.querySelector('[data-aruba-state="inventory-ready"]'))return false;
  const parts=streamParts(stream);
  const yearControl=document.querySelector(".main-toolbar-info-fiscalyear");
  if(!visible(yearControl))fail("DOM_UNRECOGNIZED");
  if(!normalized(yearControl.textContent).includes(String(parts.year))){
    const button=yearControl.querySelector("button");if(!button)fail("DOM_UNRECOGNIZED");button.click();await sleep(250);
    const years=[...document.querySelectorAll(".x-menuitem-sub-menu-mainToolbar")].filter(visible).filter(item=>normalized(item.textContent)===String(parts.year));if(years.length!==1)fail("DOM_UNRECOGNIZED");await clickProduction(years[0]);
  }
  const sent=sentDestination();
  if(sent.classList.contains("x-treelist-item-selected")){
    const first=[...document.querySelectorAll(".aruba-grid-fatture-inviate .pagingtoolbar-first button")].filter(visible);if(first.length!==1)fail("DOM_UNRECOGNIZED");if(enabled(first[0]))await clickProduction(first[0],true);
  }else{setStatus("Seleziona Fatture inviate nel menu Aruba per continuare.");await waitForNativeReload(sent)}
  await applyDateFilter(overlapFrom);
  productionNext();
  return true;
};
const readSynthetic=(stream)=>{const expected=streamParts(stream);const rows=[...document.querySelectorAll("tr[data-aruba-remote-id][data-document-type]")].filter(visible);if(rows.length>300)fail("DOM_UNRECOGNIZED");return rows.map(row=>({remoteId:row.dataset.arubaRemoteId||"",documentType:row.dataset.documentType,fiscalYear:integer(row.dataset.fiscalYear),series:row.dataset.series||null,fiscalNumber:row.dataset.fiscalNumber||null,documentDate:row.dataset.documentDate,recipientName:row.dataset.recipientName||null,recipientTaxId:row.dataset.recipientTaxId||null,recipientTaxIdentifiers:[],recipientCountryCode:row.dataset.recipientCountry||null,recipientAddress:row.dataset.recipientAddress||null,totalAmount:integer(row.dataset.totalCents),currency:"EUR",status:row.dataset.remoteStatus,providerObservedAt:row.dataset.observedAt||null,xmlSha256:null,orderReferences:(row.dataset.orderReferences||"").split(",").map(normalized).filter(Boolean)})).filter(document=>document.documentType===expected.type&&document.fiscalYear===expected.year)};
const readExtGrid=(stream)=>{const expected=streamParts(stream);const rows=[...document.querySelectorAll(".aruba-grid-fatture-inviate .x-gridrow[data-recordindex]")].filter(visible);if(rows.length>600)fail("DOM_UNRECOGNIZED");if(!rows.length)return[];const primary=new Map(),statuses=new Map();for(const row of rows){const index=row.getAttribute("data-recordindex");if(!index||!/^[0-9]+$/.test(index))fail("DOM_UNRECOGNIZED");const target=row.querySelectorAll(".x-gridcell").length>=18?primary:statuses;if(target.has(index))fail("DOM_UNRECOGNIZED");target.set(index,row)}if(!primary.size||primary.size>300||primary.size!==statuses.size)fail("DOM_UNRECOGNIZED");const documents=[];for(const [index,row] of primary){const statusRow=statuses.get(index);const cells=[...row.querySelectorAll(".x-gridcell")].map(cell=>normalized(cell.textContent));const statusCells=[...statusRow.querySelectorAll(".x-gridcell")].map(cell=>normalized(cell.textContent));if(cells.length<18||!statusCells.length)fail("DOM_UNRECOGNIZED");const type=cells[8].match(/\b(TD01|TD04)\b/i)?.[1]?.toUpperCase();if(type!=="TD01"&&type!=="TD04")continue;const documentDate=italianDate(cells[4]);const year=Number(documentDate.slice(0,4));const identity=fiscalNumber(cells[5],year);const remoteId=normalized(cells[17]);if(!/^\d{6,30}$/.test(remoteId))fail("DOM_UNRECOGNIZED");if(type!==expected.type||year!==expected.year)continue;documents.push({remoteId,documentType:type,fiscalYear:year,series:identity.series,fiscalNumber:identity.fiscalNumber,documentDate,recipientName:cells[7]||null,recipientTaxId:null,recipientTaxIdentifiers:[],recipientCountryCode:null,recipientAddress:null,totalAmount:italianAmount(cells[10]),currency:"EUR",status:remoteStatus(statusCells[0]),providerObservedAt:null,xmlSha256:null,orderReferences:[]})}return documents};
const headerIndex=(headers,pattern)=>headers.findIndex(header=>pattern.test(header));
const readSemantic=(stream)=>{const expected=streamParts(stream);const tables=[...document.querySelectorAll("table")].filter(visible).filter(table=>{const headers=[...table.querySelectorAll("thead th")].map(cell=>normalized(cell.textContent));return headers.some(value=>/data/i.test(value))&&headers.some(value=>/stato/i.test(value))&&headers.some(value=>/totale|importo/i.test(value))});if(tables.length!==1)fail("DOM_UNRECOGNIZED");const table=tables[0];const headers=[...table.querySelectorAll("thead th")].map(cell=>normalized(cell.textContent));const indices={remoteId:headerIndex(headers,/^(?:id|identificativo)(?:\s+(?:aruba|remoto))?$/i),type:headerIndex(headers,/tipo|documento/i),number:headerIndex(headers,/numero/i),date:headerIndex(headers,/data/i),recipient:headerIndex(headers,/destinatario|cliente/i),tax:headerIndex(headers,/codice fiscale|partita iva|identificativo fiscale/i),address:headerIndex(headers,/indirizzo/i),orders:headerIndex(headers,/riferiment|ordine|causale/i),total:headerIndex(headers,/totale|importo/i),status:headerIndex(headers,/stato/i)};if([indices.remoteId,indices.date,indices.orders,indices.total,indices.status].some(value=>value<0))fail("DOM_UNRECOGNIZED");const rows=[...table.querySelectorAll("tbody tr")].filter(visible);if(rows.length>300)fail("DOM_UNRECOGNIZED");return rows.map(row=>{const cells=[...row.querySelectorAll("td")].map(cell=>normalized(cell.textContent));if(cells.length!==headers.length)fail("DOM_UNRECOGNIZED");const text=cells.join(" ");const typeText=indices.type>=0?cells[indices.type]:text;const type=/\bTD0?4\b/i.test(typeText)?"TD04":/\bTD0?1\b/i.test(typeText)?"TD01":null;const remoteId=cells[indices.remoteId];if(!type||!remoteId||remoteId.length>200)fail("DOM_UNRECOGNIZED");const documentDate=italianDate(cells[indices.date]);const year=Number(documentDate.slice(0,4));const identity=indices.number>=0?fiscalNumber(cells[indices.number],year):{series:null,fiscalNumber:null};return{remoteId,documentType:type,fiscalYear:year,series:identity.series,fiscalNumber:identity.fiscalNumber,documentDate,recipientName:indices.recipient>=0?cells[indices.recipient]||null:null,recipientTaxId:indices.tax>=0?cells[indices.tax]||null:null,recipientTaxIdentifiers:[],recipientCountryCode:null,recipientAddress:indices.address>=0?cells[indices.address]||null:null,totalAmount:italianAmount(cells[indices.total]),currency:"EUR",status:remoteStatus(cells[indices.status]),providerObservedAt:null,xmlSha256:null,orderReferences:orderReferences(cells[indices.orders])}}).filter(document=>document.documentType===expected.type&&document.fiscalYear===expected.year)};
const readPage=(stream)=>document.querySelector("tr[data-aruba-remote-id]")?readSynthetic(stream):document.querySelector(".aruba-grid-fatture-inviate")?readExtGrid(stream):readSemantic(stream);
const hasNext=()=>{const button=document.querySelector(".aruba-grid-fatture-inviate")?productionNext():semanticNext();return enabled(button)};
const advance=async()=>{if(document.querySelector(".aruba-grid-fatture-inviate")){await clickProduction(productionNext(),true)}else{const next=semanticNext();if(!enabled(next))fail("DOM_UNRECOGNIZED");next.click();await sleep(300)}};
let inventoryCompleted=false;
try{
  if(location.origin!==PANEL)fail("ARUBA_ORIGIN_MISMATCH");
  setStatus("Collegamento sicuro a Hub Fatture…");
  bridge=open(HUB+"/aruba-ponte","hub_fatture_aruba_bridge","popup,width=520,height=620");
  if(!bridge)fail("POPUP_BLOCKED");
  await waitForStart();
  const manifest=await rpc("/api/aruba/sync/manifest");
  const preflight=await rpc("/api/aruba/sync/preflight");
  const browser=browserName();
  await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
  assertAccount(manifest.accountIdentity);
  const fullScan=true;
  const observed=[];
  for(const streamInfo of manifest.streams){
    const stream=streamInfo.name;
    setStatus("Lettura "+stream+"…");
    const available=await selectStream(stream,null);
    let pageOrdinal=1;
    while(true){
      await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
      const documents=available?readPage(stream):[];
      observed.push(...documents);
      const terminal=!available||!hasNext();
      await rpc("/api/aruba/sync/pagine","POST",{stream,scanOrdinal:1,pageOrdinal,cursor:stream+":"+pageOrdinal,terminal,fullScan,documents});
      if(terminal)break;
      await advance();pageOrdinal+=1;
    }
  }
  await rpc("/api/aruba/sync/completa","POST",{streams:manifest.streams.map(item=>item.name),scanOrdinal:1,fullScan});
  inventoryCompleted=true;
  let preflightFailed=false;
  for(const work of preflight.work??[]){
    await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
    const searches=work.request_json?.searches??[];
    const candidates=observed.filter(document=>document.status!=="REJECTED"&&searches.length&&searches.every(search=>search.documentType===document.documentType)&&searches.some(search=>document.orderReferences.map(matchText).includes(matchText(search.displayNumber)))).map(document=>document.remoteId);
    try{await rpc("/api/aruba/sync/preflight","POST",{receiptId:work.id,candidateRemoteIds:[...new Set(candidates)],searchesCompleted:true})}catch{preflightFailed=true}
  }
  await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
  await rpc("/api/aruba/sync/termina","POST",{});
  setStatus(preflightFailed?"Inventario aggiornato. Una verifica collegata richiede un nuovo tentativo.":"Sincronizzazione completata. Puoi tornare a Hub Fatture.",preflightFailed);
  setTimeout(()=>{bridge?.close();removeEventListener("message",onMessage)},2500);
}catch(error){
  const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:"READ_SYNC_FAILED";
  if(inventoryCompleted){try{await rpc("/api/aruba/sync/termina","POST",{})}catch{}setStatus("Inventario aggiornato. Una verifica collegata richiede un nuovo tentativo.",true)}else{try{await rpc("/api/aruba/sync/fallita","POST",{code})}catch{}setStatus(failureMessage(code),true)}
  removeEventListener("message",onMessage);
}
})()`;
  return source
    .replace("__HUB__", JSON.stringify(options.hubOrigin))
    .replace("__PANEL__", JSON.stringify(options.panelOrigin));
}

export function buildArubaBookmarklet(options: ArubaBookmarkletOptions): string {
  const hubOrigin = new URL(options.hubOrigin).origin;
  const panelOrigin = new URL(options.panelOrigin).origin;
  return `javascript:${runtime({ hubOrigin, panelOrigin })}`;
}
