import { ARUBA_IMPORT_MAX_BYTES } from "./aruba-browser-constants.ts";
import {
  ARUBA_UNKNOWN_STATUS_PAGE_MAX_RATIO,
  ARUBA_UNKNOWN_STATUS_PAGE_MIN_DOCUMENTS,
} from "./aruba-inbound.ts";

export interface ArubaBookmarkletOptions {
  hubOrigin: string;
  panelOrigin: string;
}

export function buildArubaBookmarkletRuntime(options: ArubaBookmarkletOptions): string {
  const source = String.raw`(async()=>{
const HUB=__HUB__;
const PANEL=__PANEL__;
const TYPE="HF_ARUBA";
const ACTIVE="__HUB_FATTURE_ARUBA_RUNTIME_ACTIVE__";
if(globalThis[ACTIVE])return;
globalThis[ACTIVE]=true;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(code)=>{throw new Error(code)};
const visible=(element)=>Boolean(element&&element.getClientRects().length);
const normalized=(value)=>String(value??"").replace(/\s+/g," ").trim();
const matchText=(value)=>normalized(value).normalize("NFKD").replace(/\p{Diacritic}/gu,"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
const browserName=()=>{const ua=navigator.userAgent;if(/Mobile\//.test(ua))fail("BROWSER_UNSUPPORTED");if(/Edg\//.test(ua))return"msedge";if(/(?:Chrome|Chromium|CriOS)\//.test(ua))return"chrome";if(/Version\/\d+(?:\.\d+)*.*Safari\//.test(ua))return"safari";fail("BROWSER_UNSUPPORTED")};
const TRANSPORT="__HUB_FATTURE_ARUBA_TRANSPORT__";
const transport=globalThis[TRANSPORT]??null;
delete globalThis[TRANSPORT];
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
const failureMessage=(code)=>code==="POPUP_BLOCKED"?"Consenti l’apertura della finestra e riprova.":code==="ARUBA_ORIGIN_MISMATCH"?"Apri il pannello Aruba e usa lì questo preferito.":code==="ARUBA_ACCOUNT_MISMATCH"?"L’account Aruba aperto non coincide con quello già collegato a Hub Fatture.":code==="ARUBA_FILTER_ACTIVE"?"Rimuovi il filtro data nella pagina Aruba e riprova.":code==="ARUBA_REMOTE_STATUS_UNRECOGNIZED"?"Aruba mostra molti stati non riconosciuti. La sincronizzazione è stata fermata senza considerarli allineati.":code==="DOM_UNRECOGNIZED"?"La pagina Aruba non ha completato il caricamento previsto. Ricaricala e riprova.":code==="HUB_BRIDGE_TIMEOUT"?"La finestra Hub Fatture non ha completato il collegamento. Chiudila e riprova.":code==="HUB_RESPONSE_TIMEOUT"?"Hub Fatture non ha risposto alla richiesta. Torna alle impostazioni e controlla lo stato della sincronizzazione.":"La lettura si è interrotta prima del completamento. Torna a Hub Fatture e riprova.";
let confirmBridge;
const onBridgeMessage=(message)=>{
  if(message?.type===TYPE+"_BRIDGE_READY"){confirmBridge();return}
  if(message?.type!==TYPE+"_RESPONSE")return;
  const item=pending.get(String(message.id));
  if(!item)return;
  clearTimeout(item.timeout);pending.delete(String(message.id));
  message.ok?item.resolve(message.payload):item.reject(new Error(message.code||"HUB_ERROR"));
};
let bridgeTimeout;
let bridgeConnected=false;
const bridgeReady=new Promise((resolve,reject)=>{
  confirmBridge=()=>{clearTimeout(bridgeTimeout);resolve()};
  bridgeTimeout=setTimeout(()=>reject(new Error("HUB_BRIDGE_TIMEOUT")),20000);
});
let transportConnected=false;
try{transportConnected=Boolean(transport&&typeof transport.post==="function"&&typeof transport.subscribe==="function"&&typeof transport.close==="function"&&transport.subscribe(onBridgeMessage)===true)}catch{}
const post=(message)=>{if(!transportConnected)fail("HUB_BRIDGE_TIMEOUT");transport.post(message)};
const closeBridge=()=>{clearTimeout(bridgeTimeout);try{transport?.close()}catch{}};
const releaseRuntime=()=>{delete globalThis[ACTIVE]};
const rpc=(path,method="GET",body)=>new Promise((resolve,reject)=>{
  const id=String(++sequence);
  const timeout=setTimeout(()=>{pending.delete(id);reject(new Error("HUB_RESPONSE_TIMEOUT"))},30000);
  pending.set(id,{resolve,reject,timeout});
  post({type:TYPE+"_REQUEST",id,path,method,body});
});
const integer=(value)=>{const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<0)fail("DOM_UNRECOGNIZED");return parsed};
const italianDate=(value)=>{const match=String(value).match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);if(!match)fail("DOM_UNRECOGNIZED");return match[3]+"-"+match[2]+"-"+match[1]};
const italianAmount=(value)=>{const match=String(value).match(/(?:€\s*)?(-?\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(?:\s*€)?/);if(!match)fail("DOM_UNRECOGNIZED");const cents=Number(match[1].replaceAll(".","")+match[2]);if(!Number.isSafeInteger(cents)||cents<0)fail("DOM_UNRECOGNIZED");return cents};
const remoteStatus=(value)=>{const label=matchText(value);if(label.includes("EMESSAENONCONS")||label.includes("NONCONSEGNAT")||label.includes("MANCATACONSEGNA")||label.includes("RECAPITOIMPOSSIBILE"))return"NOT_DELIVERED";if(label.includes("EMESSAECONSEGNAT")||label.includes("CONSEGNAT")||label==="ACCETTATA"||label.includes("DECORRENZATERMINI"))return"DELIVERED";if(label.includes("SCARTAT")||label.includes("RIFIUTAT")||label.includes("ERROREELABORAZIONE"))return"REJECTED";if(label.includes("PRESAINCARICO")||label.includes("INLAVORAZIONE")||label.includes("INOLTRATOASDI")||label.includes("INOLTRATAASDI"))return"SDI_PROCESSING";if(label==="EMESSA"||label==="EMESSAEDINVIATA"||label==="ANNULLATA")return"UNKNOWN";if(label.includes("INVIAT")||label.includes("TRASMESS"))return"SUBMITTED";return"UNKNOWN"};
const knownUncertainStatus=(value)=>{const label=matchText(value);return label==="EMESSA"||label==="EMESSAEDINVIATA"||label==="ANNULLATA"};
const anomalousStatuses=(documents)=>documents.length>=__UNKNOWN_MIN__&&documents.filter(document=>document.status==="UNKNOWN"&&!knownUncertainStatus(document.providerStatusLabel)).length/documents.length>=__UNKNOWN_RATIO__;
const fiscalNumber=(value,year)=>{const match=/^(\S+)\s+(\d+)\/(\d{2}|\d{4})$/.exec(normalized(value));if(!match)fail("DOM_UNRECOGNIZED");const number=Number(match[2]);const expected=String(year);if(!Number.isSafeInteger(number)||number<=0||(match[3]!==expected&&match[3]!==expected.slice(-2)))fail("DOM_UNRECOGNIZED");return{series:match[1],fiscalNumber:String(number)}};
const orderReferences=(value)=>{if(!normalized(value))return[];const hash=[...String(value).matchAll(/#\s*[A-Z0-9][A-Z0-9._/-]*/gi)].map(match=>match[0].replace(/\s+/g,""));const labelled=String(value).split(/[,;\n]+/).map(item=>{const parts=item.split(":");return /^(?:ordine|ordini|riferimento|riferimenti|causale)$/i.test(normalized(parts[0]))?normalized(parts.slice(1).join(":")):normalized(item)}).filter(item=>item&&item.length<=100);const result=[...new Set([...hash,...labelled])];if(result.length>20)fail("DOM_UNRECOGNIZED");return result};
const streamParts=(stream)=>{const match=/^(invoices|credit-notes):(\d{4})$/.exec(stream);if(!match)fail("DOM_UNRECOGNIZED");return{type:match[1]==="invoices"?"TD01":"TD04",year:Number(match[2])}};
const preflightScanFrom=(work,stream,fallback,incremental)=>{const type=streamParts(stream).type,searches=work.flatMap(item=>item.request_json?.searches??[]).filter(search=>search.documentType===type);if(!searches.length)return incremental;const dates=searches.map(search=>typeof search.orderDate==="string"?search.orderDate.slice(0,10):String(fallback).slice(0,10));if(dates.some(date=>!/^\d{4}-\d{2}-\d{2}$/.test(date)))fail("READ_SYNC_FAILED");return[incremental,...dates].sort()[0]};
const semanticNext=()=>{const candidates=[...document.querySelectorAll("button")].filter(visible).filter(button=>/Pagina successiva|Successiva/i.test(normalized(button.getAttribute("aria-label")||button.textContent)));if(candidates.length>1)fail("DOM_UNRECOGNIZED");return candidates[0]};
const productionNext=()=>{const selector='.aruba-grid-fatture-inviate button[aria-label*="nextPage"],.aruba-grid-fatture-inviate button[title*="nextPage"],.aruba-grid-fatture-inviate [title*="nextPage"] button';const candidates=[...document.querySelectorAll(selector)].filter(visible);if(candidates.length!==1)fail("DOM_UNRECOGNIZED");return candidates[0]};
const enabled=(element)=>{if(!element||element.disabled||element.getAttribute("aria-disabled")==="true")return false;const control=element.closest(".x-button");return !control||(!control.classList.contains("x-disabled")&&control.getAttribute("aria-disabled")!=="true")};
const pageIdentity=()=>{const values=[...document.querySelectorAll(".aruba-grid-fatture-inviate .x-gridrow[data-recordindex] .x-gridcell:nth-child(18)")].map(element=>normalized(element.textContent)).filter(Boolean);if(!values.length)fail("DOM_UNRECOGNIZED");return values.join("|")};
const fingerprint=()=>{const rows=[...document.querySelectorAll(".aruba-grid-fatture-inviate .x-gridrow[data-recordindex]")];if(!rows.length)fail("DOM_UNRECOGNIZED");return rows.map(row=>row.getAttribute("data-recordindex")+":"+[...row.querySelectorAll(".x-gridcell")].map(cell=>normalized(cell.textContent)).join("\u001f")).join("\u001e")};
const armReload=()=>{
  const state={active:true,requested:0,pending:0,failed:false,observed:false,lastMutationAt:0};
  const touchesGrid=(node)=>{const element=node instanceof Element?node:node?.parentElement;return Boolean(element?.closest?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]")||element?.matches?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]")||element?.querySelector?.(".aruba-grid-fatture-inviate,[data-aruba-state=\"inventory-ready\"]"))};
  const observer=new MutationObserver(mutations=>{if(mutations.some(mutation=>touchesGrid(mutation.target)||[...mutation.addedNodes,...mutation.removedNodes].some(touchesGrid))){state.observed=true;state.lastMutationAt=performance.now()}});
  observer.observe(document.body,{attributes:true,characterData:true,childList:true,subtree:true});
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
const waitForReload=async(monitor,before=null)=>{let current=null;let lastChangeAt=performance.now();for(let attempt=0;attempt<120;attempt+=1){await sleep(250);if(monitor.state.failed)fail("DOM_UNRECOGNIZED");const now=performance.now();let changed=!before;let stable=monitor.state.observed&&now-monitor.state.lastMutationAt>=500;if(before){try{const next=fingerprint();if(next!==current){current=next;lastChangeAt=now}changed=pageIdentity()!==before;stable=changed&&now-lastChangeAt>=500&&monitor.state.observed&&now-monitor.state.lastMutationAt>=500}catch{changed=false;stable=false}}const networkReady=monitor.state.requested===0||monitor.state.pending===0;if(networkReady&&changed&&stable&&reloadReady())return}fail("DOM_UNRECOGNIZED")};
const clickProduction=async(control,requireChange=false)=>{let before=null;if(requireChange){try{before=pageIdentity()}catch{}}const monitor=armReload();try{control.click();await waitForReload(monitor,before)}finally{monitor.stop()}};
const waitForNativeReload=async(control)=>{const monitor=await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timeout);document.removeEventListener("pointerdown",start,true);document.removeEventListener("click",start,true)};const start=(event)=>{if(!event.isTrusted||!(event.target instanceof Node)||!control.contains(event.target))return;cleanup();resolve(armReload())};const timeout=setTimeout(()=>{cleanup();reject(new Error("DOM_UNRECOGNIZED"))},60000);document.addEventListener("pointerdown",start,true);document.addEventListener("click",start,true)});try{await waitForReload(monitor)}finally{monitor.stop()}};
const sentDestination=()=>{const matches=(selector)=>[...document.querySelectorAll(selector)].filter(visible).filter(item=>/^(?:Fatture inviate|Documenti inviati|Inviate)$/i.test(normalized(item.textContent)));const semantic=matches('[role="menuitem"]');if(semantic.length===1)return semantic[0];if(semantic.length>1)fail("DOM_UNRECOGNIZED");const fallback=matches("a,button");if(fallback.length!==1)fail("DOM_UNRECOGNIZED");return fallback[0]};
const waitForInventory=async(stream)=>{for(let attempt=0;attempt<120;attempt+=1){if(visible(document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]'))||visible(document.querySelector('[data-aruba-state="inventory-ready"]'))||(visible(document.querySelector(".main-toolbar-info-fiscalyear"))&&visible(document.querySelector(".aruba-grid-fatture-inviate"))))return;await sleep(250)}fail("DOM_UNRECOGNIZED")};
const openInventory=async(stream)=>{if(visible(document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]'))||visible(document.querySelector('[data-aruba-state="inventory-ready"]'))||visible(document.querySelector(".aruba-grid-fatture-inviate")))return;const sent=sentDestination();setStatus("Seleziona Fatture inviate nel menu Aruba per continuare.");await waitForNativeReload(sent);await waitForInventory(stream)};
const assertDateFilterInactive=()=>{const synthetic=[...document.querySelectorAll('[data-aruba-filter-from]')].filter(visible);const production=[...document.querySelectorAll('[data-reference="arubacombobox-filterDate"]')].filter(visible);const candidates=synthetic.length?synthetic:production;if(candidates.length!==1)fail("DOM_UNRECOGNIZED");const input=candidates[0] instanceof HTMLInputElement?candidates[0]:candidates[0].querySelector("input");if(!(input instanceof HTMLInputElement))fail("DOM_UNRECOGNIZED");if(normalized(input.value))fail("ARUBA_FILTER_ACTIVE")};
const selectStream=async(stream)=>{
  await openInventory(stream);
  const synthetic=document.querySelector('[data-aruba-stream="'+CSS.escape(stream)+'"]');
  if(synthetic){synthetic.click();await sleep(100);assertDateFilterInactive();return true}
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
  assertDateFilterInactive();
  productionNext();
  return true;
};
const ensureIncrementalOrder=async()=>{const root=document.querySelector(".aruba-grid-fatture-inviate");if(!root)fail("DOM_UNRECOGNIZED");const runtime=globalThis.Ext;if(!runtime?.ComponentQuery?.query||!runtime?.util?.Sorter){if(root.dataset.arubaSortProperty==="data"&&root.dataset.arubaSortDirection==="DESC")return true;fail("DOM_UNRECOGNIZED")}const stores=new Set();for(const component of runtime.ComponentQuery.query("grid,arubalockedgrid")){const element=component?.element?.dom;if(!element||(!element.contains(root)&&!root.contains(element)))continue;const store=component.getStore?.();if(store?.getSorters&&store?.loadPage)stores.add(store)}const matching=[...stores].filter(store=>store.getModel?.().$className?.includes("FatturaInviataSingoloList"));if(matching.length!==1)fail("DOM_UNRECOGNIZED");const store=matching[0],first=store.getSorters().getAt(0);if(first?.getProperty?.()==="data"&&String(first.getDirection?.()).toUpperCase()==="DESC"&&store.currentPage===1)return true;const monitor=armReload();try{store.currentPage=1;store.getSorters().removeAll();store.getSorters().add(new runtime.util.Sorter({property:"data",direction:"DESC"}));store.loadPage(1);await waitForReload(monitor)}finally{monitor.stop()}return true};
const readSynthetic=(stream)=>{const expected=streamParts(stream);const rows=[...document.querySelectorAll("tr[data-aruba-remote-id][data-document-type]")].filter(visible);if(rows.length>300)fail("DOM_UNRECOGNIZED");return rows.map(row=>({remoteId:row.dataset.arubaRemoteId||"",documentType:row.dataset.documentType,fiscalYear:integer(row.dataset.fiscalYear),series:row.dataset.series||null,fiscalNumber:row.dataset.fiscalNumber||null,documentDate:row.dataset.documentDate,recipientName:row.dataset.recipientName||null,recipientTaxId:row.dataset.recipientTaxId||null,recipientTaxIdentifiers:[],recipientCountryCode:row.dataset.recipientCountry||null,recipientAddress:row.dataset.recipientAddress||null,totalAmount:integer(row.dataset.totalCents),currency:"EUR",status:row.dataset.remoteStatus,providerStatusLabel:row.dataset.providerStatusLabel||row.dataset.remoteStatus||null,providerObservedAt:row.dataset.observedAt||null,xmlSha256:null,orderReferences:(row.dataset.orderReferences||"").split(",").map(normalized).filter(Boolean)})).filter(document=>document.documentType===expected.type&&document.fiscalYear===expected.year)};
const readExtGrid=(stream)=>{const expected=streamParts(stream);const rows=[...document.querySelectorAll(".aruba-grid-fatture-inviate .x-gridrow[data-recordindex]")].filter(visible);if(rows.length>600)fail("DOM_UNRECOGNIZED");if(!rows.length)return[];const primary=new Map(),statuses=new Map();for(const row of rows){const index=row.getAttribute("data-recordindex");if(!index||!/^[0-9]+$/.test(index))fail("DOM_UNRECOGNIZED");const target=row.querySelectorAll(".x-gridcell").length>=18?primary:statuses;if(target.has(index))fail("DOM_UNRECOGNIZED");target.set(index,row)}if(!primary.size||primary.size>300||primary.size!==statuses.size)fail("DOM_UNRECOGNIZED");const documents=[];for(const [index,row] of primary){const statusRow=statuses.get(index);const cells=[...row.querySelectorAll(".x-gridcell")].map(cell=>normalized(cell.textContent));const statusCells=[...statusRow.querySelectorAll(".x-gridcell")].map(cell=>normalized(cell.textContent));if(cells.length<18||!statusCells.length)fail("DOM_UNRECOGNIZED");const type=cells[8].match(/\b(TD01|TD04)\b/i)?.[1]?.toUpperCase();if(type!=="TD01"&&type!=="TD04")continue;const documentDate=italianDate(cells[4]);const year=Number(documentDate.slice(0,4));const identity=fiscalNumber(cells[5],year);const remoteId=normalized(cells[17]);if(!/^\d{6,30}$/.test(remoteId))fail("DOM_UNRECOGNIZED");if(type!==expected.type||year!==expected.year)continue;documents.push({remoteId,documentType:type,fiscalYear:year,series:identity.series,fiscalNumber:identity.fiscalNumber,documentDate,recipientName:cells[7]||null,recipientTaxId:null,recipientTaxIdentifiers:[],recipientCountryCode:null,recipientAddress:null,totalAmount:italianAmount(cells[10]),currency:"EUR",status:remoteStatus(statusCells[0]),providerStatusLabel:statusCells[0]||null,providerObservedAt:null,xmlSha256:null,orderReferences:[]})}return documents};
const headerIndex=(headers,pattern)=>headers.findIndex(header=>pattern.test(header));
const readSemantic=(stream)=>{const expected=streamParts(stream);const tables=[...document.querySelectorAll("table")].filter(visible).filter(table=>{const headers=[...table.querySelectorAll("thead th")].map(cell=>normalized(cell.textContent));return headers.some(value=>/data/i.test(value))&&headers.some(value=>/stato/i.test(value))&&headers.some(value=>/totale|importo/i.test(value))});if(tables.length!==1)fail("DOM_UNRECOGNIZED");const table=tables[0];const headers=[...table.querySelectorAll("thead th")].map(cell=>normalized(cell.textContent));const indices={remoteId:headerIndex(headers,/^(?:id|identificativo)(?:\s+(?:aruba|remoto))?$/i),type:headerIndex(headers,/tipo|documento/i),number:headerIndex(headers,/numero/i),date:headerIndex(headers,/data/i),recipient:headerIndex(headers,/destinatario|cliente/i),tax:headerIndex(headers,/codice fiscale|partita iva|identificativo fiscale/i),address:headerIndex(headers,/indirizzo/i),orders:headerIndex(headers,/riferiment|ordine|causale/i),total:headerIndex(headers,/totale|importo/i),status:headerIndex(headers,/stato/i)};if([indices.remoteId,indices.date,indices.orders,indices.total,indices.status].some(value=>value<0))fail("DOM_UNRECOGNIZED");const rows=[...table.querySelectorAll("tbody tr")].filter(visible);if(rows.length>300)fail("DOM_UNRECOGNIZED");return rows.map(row=>{const cells=[...row.querySelectorAll("td")].map(cell=>normalized(cell.textContent));if(cells.length!==headers.length)fail("DOM_UNRECOGNIZED");const text=cells.join(" ");const typeText=indices.type>=0?cells[indices.type]:text;const type=/\bTD0?4\b/i.test(typeText)?"TD04":/\bTD0?1\b/i.test(typeText)?"TD01":null;const remoteId=cells[indices.remoteId];if(!type||!remoteId||remoteId.length>200)fail("DOM_UNRECOGNIZED");const documentDate=italianDate(cells[indices.date]);const year=Number(documentDate.slice(0,4));const identity=indices.number>=0?fiscalNumber(cells[indices.number],year):{series:null,fiscalNumber:null};return{remoteId,documentType:type,fiscalYear:year,series:identity.series,fiscalNumber:identity.fiscalNumber,documentDate,recipientName:indices.recipient>=0?cells[indices.recipient]||null:null,recipientTaxId:indices.tax>=0?cells[indices.tax]||null:null,recipientTaxIdentifiers:[],recipientCountryCode:null,recipientAddress:indices.address>=0?cells[indices.address]||null:null,totalAmount:italianAmount(cells[indices.total]),currency:"EUR",status:remoteStatus(cells[indices.status]),providerStatusLabel:cells[indices.status]||null,providerObservedAt:null,xmlSha256:null,orderReferences:orderReferences(cells[indices.orders])}}).filter(document=>document.documentType===expected.type&&document.fiscalYear===expected.year)};
const readPage=(stream)=>document.querySelector("tr[data-aruba-remote-id]")?readSynthetic(stream):document.querySelector(".aruba-grid-fatture-inviate")?readExtGrid(stream):readSemantic(stream);
const xmlSources=()=>{
  const sources=new Map();
  for(const row of [...document.querySelectorAll("tr[data-aruba-remote-id]")].filter(visible)){const remoteId=normalized(row.getAttribute("data-aruba-remote-id"));const url=row.getAttribute("data-aruba-xml-url");if(remoteId&&url)sources.set(remoteId,{url})}
  const grid=document.querySelector(".aruba-grid-fatture-inviate");
  if(grid){const primary=new Map([...grid.querySelectorAll(".x-gridrow[data-recordindex]")].filter(row=>row.querySelectorAll(".x-gridcell").length>=18).map(row=>[row.getAttribute("data-recordindex"),row]));for(const statusRow of grid.querySelectorAll(".x-gridrow[data-recordindex]")){if(statusRow.querySelectorAll(".x-gridcell").length>=18||!statusRow.querySelector(".x-gridcell:nth-child(2) .aru-xml"))continue;const index=statusRow.getAttribute("data-recordindex"),remoteId=normalized(primary.get(index)?.querySelectorAll(".x-gridcell")?.[17]?.textContent);if(remoteId)sources.set(remoteId,{recordIndex:index})}}
  for(const link of [...document.querySelectorAll("a")].filter(visible).filter(link=>/Scarica XML/i.test(normalized(link.getAttribute("aria-label")||link.textContent)))){const row=link.closest("tr");if(!row)continue;const table=row.closest("table"),headers=[...(table?.querySelectorAll("thead th")??[])].map(cell=>normalized(cell.textContent)),index=headerIndex(headers,/^(?:id|identificativo)(?:\s+(?:aruba|remoto))?$/i),cells=[...row.querySelectorAll("td")];const remoteId=index>=0?normalized(cells[index]?.textContent):"";if(remoteId&&link.href)sources.set(remoteId,{url:link.href})}
  return sources;
};
const allowedXmlUrl=(value)=>{const url=new URL(String(value),location.href);if(url.origin!==PANEL||!/^https?:$/.test(url.protocol))fail("OFFICIAL_FILE_DOWNLOAD_FAILED");return url.href};
const xmlBytesFromUrl=async(value)=>{const response=await fetch(allowedXmlUrl(value),{credentials:"include"});if(!response.ok)fail("OFFICIAL_FILE_DOWNLOAD_FAILED");const bytes=await response.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>__IMPORT_MAX__)fail("OFFICIAL_FILE_DOWNLOAD_FAILED");return bytes};
const xmlBytesFromTool=async(recordIndex)=>{
  if(!/^\d+$/.test(String(recordIndex)))fail("DOM_UNRECOGNIZED");
  const selector='.aruba-grid-fatture-inviate .locked-grid-border-left .x-gridrow[data-recordindex="'+CSS.escape(String(recordIndex))+'"] .x-gridcell:nth-child(2) .aru-xml';
  const icons=[...document.querySelectorAll(selector)].filter(visible);if(icons.length!==1)fail("DOM_UNRECOGNIZED");const tool=icons[0].closest(".x-tool");if(!tool)fail("DOM_UNRECOGNIZED");
  let settle;const captured=new Promise(resolve=>{settle=resolve});let done=false;const remember=(value)=>{if(done||!value)return;done=true;settle(value)};
  const originalCreate=URL.createObjectURL,originalOpen=window.open,originalAnchorClick=HTMLAnchorElement.prototype.click,originalSubmit=HTMLFormElement.prototype.submit;
  const interceptClick=(event)=>{const anchor=event.target instanceof Element?event.target.closest("a[href]"):null;if(!anchor)return;event.preventDefault();event.stopImmediatePropagation();remember(anchor.href)};
  const observer=new MutationObserver(mutations=>{for(const mutation of mutations)for(const node of mutation.addedNodes){if(!(node instanceof Element))continue;for(const element of [node,...node.querySelectorAll("a[href],iframe[src]")])remember(element instanceof HTMLAnchorElement?element.href:element instanceof HTMLIFrameElement?element.src:null)}});
  URL.createObjectURL=function(value){if(value instanceof Blob)remember(value);return Reflect.apply(originalCreate,this,[value])};
  window.open=function(value,...args){if(value)remember(String(value));return null};
  HTMLAnchorElement.prototype.click=function(){remember(this.href)};
  HTMLFormElement.prototype.submit=function(){remember(this.action)};
  document.addEventListener("click",interceptClick,true);observer.observe(document.body,{childList:true,subtree:true});
  try{tool.click();const source=await Promise.race([captured,sleep(10000).then(()=>null)]);if(!source)fail("OFFICIAL_FILE_DOWNLOAD_FAILED");const bytes=source instanceof Blob?await source.arrayBuffer():await xmlBytesFromUrl(source);if(!bytes.byteLength||bytes.byteLength>__IMPORT_MAX__)fail("OFFICIAL_FILE_DOWNLOAD_FAILED");return bytes}finally{URL.createObjectURL=originalCreate;window.open=originalOpen;HTMLAnchorElement.prototype.click=originalAnchorClick;HTMLFormElement.prototype.submit=originalSubmit;document.removeEventListener("click",interceptClick,true);observer.disconnect()}
};
const uploadRequestedXml=async(ingest,sources)=>{for(const request of ingest?.requestedFiles??[]){if(request?.kind!=="ARUBA_XML")continue;const source=sources.get(String(request.remoteId));if(!source)fail("OFFICIAL_FILE_DOWNLOAD_FAILED");setStatus("Importazione XML ufficiale…");const bytes=source.url?await xmlBytesFromUrl(source.url):await xmlBytesFromTool(source.recordIndex);await rpc("/api/aruba/sync/file","POST",{remoteId:String(request.remoteId),kind:"ARUBA_XML",bytes})}};
const hasNext=()=>{const button=document.querySelector(".aruba-grid-fatture-inviate")?productionNext():semanticNext();return enabled(button)};
const advance=async()=>{if(document.querySelector(".aruba-grid-fatture-inviate")){await clickProduction(productionNext(),true)}else{const next=semanticNext();if(!enabled(next))fail("DOM_UNRECOGNIZED");next.click();await sleep(300)}};
let inventoryCompleted=false;
try{
  if(location.origin!==PANEL)fail("ARUBA_ORIGIN_MISMATCH");
  setStatus("Collegamento sicuro a Hub Fatture…");
  if(!transportConnected)fail("HUB_BRIDGE_TIMEOUT");
  post({type:TYPE+"_RUNTIME_READY"});
  await bridgeReady;
  bridgeConnected=true;
  const manifest=await rpc("/api/aruba/sync/manifest");
  const preflight=await rpc("/api/aruba/sync/preflight");
  const browser=browserName();
  await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
  const fullScan=manifest.fullScanRequired===true;
  const observed=[];
  let accountVerified=false;
  verifyAccount:
  for(const streamInfo of manifest.streams){
    const stream=streamInfo.name;
    setStatus("Verifica dell’account Aruba…");
    const available=await selectStream(stream);
    while(true){
      await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
      const documents=available?readPage(stream):[];
      if(anomalousStatuses(documents))fail("ARUBA_REMOTE_STATUS_UNRECOGNIZED");
      const proof=await rpc("/api/aruba/sync/verifica-account","POST",{documents});
      if(proof?.verified===true){accountVerified=true;break verifyAccount}
      if(!available||!hasNext())break;
      await advance();
    }
  }
  if(!accountVerified)fail("ARUBA_ACCOUNT_MISMATCH");
  for(const streamInfo of manifest.streams){
    const stream=streamInfo.name;
    const incrementalFrom=typeof streamInfo.incrementalFrom==="string"?streamInfo.incrementalFrom.slice(0,10):null;
    if(!fullScan&&!incrementalFrom)fail("READ_SYNC_FAILED");
    const scanFrom=fullScan?null:preflightScanFrom(preflight.work??[],stream,manifest.oldestReconciliationDate,incrementalFrom);
    setStatus("Lettura "+stream+"…");
    const available=await selectStream(stream);
    const incrementalOrderVerified=!fullScan&&available&&document.querySelector(".aruba-grid-fatture-inviate")?await ensureIncrementalOrder():false;
    let pageOrdinal=1;
    while(true){
      await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
      const documents=available?readPage(stream):[];
      if(anomalousStatuses(documents))fail("ARUBA_REMOTE_STATUS_UNRECOGNIZED");
      observed.push(...documents);
      const boundaryReached=!fullScan&&incrementalOrderVerified&&documents.length>0&&documents.every(document=>document.documentDate<scanFrom);
      const terminal=!available||!hasNext()||boundaryReached;
      const page={stream,scanOrdinal:1,pageOrdinal,cursor:stream+":"+pageOrdinal,terminal,fullScan,documents};
      const sources=xmlSources();
      const ingest=await rpc("/api/aruba/sync/pagine","POST",page);
      await uploadRequestedXml(ingest,sources);
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
    try{await rpc("/api/aruba/sync/preflight","POST",{receiptId:work.id,candidateRemoteIds:[...new Set(candidates)],searchesCompleted:searches.length>0})}catch{preflightFailed=true}
  }
  await rpc("/api/aruba/sync/heartbeat","POST",{helperVersion:"preferito-1",browser});
  await rpc("/api/aruba/sync/termina","POST",{});
  setStatus(preflightFailed?"Inventario aggiornato. Una verifica collegata richiede un nuovo tentativo.":"Sincronizzazione completata. Puoi tornare a Hub Fatture.",preflightFailed);
  setTimeout(()=>{releaseRuntime();closeBridge()},2500);
}catch(error){
  const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:"READ_SYNC_FAILED";
  if(inventoryCompleted){if(bridgeConnected)try{await rpc("/api/aruba/sync/termina","POST",{})}catch{}setStatus("Inventario aggiornato. Una verifica collegata richiede un nuovo tentativo.",true)}else{if(bridgeConnected)try{await rpc("/api/aruba/sync/fallita","POST",{code})}catch{}setStatus(failureMessage(code),true)}
  releaseRuntime();
  closeBridge();
}
})()`;
  return source
    .replace("__HUB__", JSON.stringify(options.hubOrigin))
    .replace("__PANEL__", JSON.stringify(options.panelOrigin))
    .replace("__UNKNOWN_MIN__", String(ARUBA_UNKNOWN_STATUS_PAGE_MIN_DOCUMENTS))
    .replace("__UNKNOWN_RATIO__", String(ARUBA_UNKNOWN_STATUS_PAGE_MAX_RATIO))
    .replaceAll("__IMPORT_MAX__", String(ARUBA_IMPORT_MAX_BYTES));
}

export function buildArubaBookmarklet(options: ArubaBookmarkletOptions): string {
  const hubOrigin = new URL(options.hubOrigin).origin;
  const panelOrigin = new URL(options.panelOrigin).origin;
  const source = String.raw`(()=>{
const HUB=__HUB__;
const PANEL=__PANEL__;
const TYPE="HF_ARUBA";
const TRANSPORT="__HUB_FATTURE_ARUBA_TRANSPORT__";
if(location.origin!==PANEL){alert("Apri il pannello Aruba e usa lì questo preferito.");return}
const bridge=open(HUB+"/aruba-ponte","hub_fatture_aruba_bridge","popup,width=520,height=620");
if(!bridge){alert("Consenti l’apertura della finestra e riprova.");return}
let hello;
let timeout;
let runtimeReceive=null;
let started=false;
let closed=false;
const stopHello=()=>{clearInterval(hello);clearTimeout(timeout)};
const cleanup=()=>{if(closed)return;closed=true;stopHello();removeEventListener("message",receive);runtimeReceive=null;if(globalThis[TRANSPORT]===transport)delete globalThis[TRANSPORT];try{bridge.close()}catch{}};
const transport=Object.freeze({
  post:(message)=>{if(closed)throw new Error("HUB_BRIDGE_CLOSED");bridge.postMessage(message,HUB)},
  subscribe:(receiveMessage)=>{if(closed||runtimeReceive||typeof receiveMessage!=="function")return false;runtimeReceive=receiveMessage;return true},
  close:cleanup
});
const receive=(event)=>{
  if(event.origin!==HUB||event.source!==bridge||!event.data)return;
  if(event.data.type!==TYPE+"_START"){
    if(runtimeReceive&&(event.data.type===TYPE+"_BRIDGE_READY"||event.data.type===TYPE+"_RESPONSE"))runtimeReceive(event.data);
    return;
  }
  if(started)return;
  const runtime=event.data.runtimeSource;
  if(typeof runtime!=="string"||runtime.length<1000||runtime.length>100000){cleanup();alert("Hub Fatture non ha restituito un lettore valido. Riprova.");return}
  const marker="__HUB_FATTURE_ARUBA_RUNTIME_STARTED__";
  delete globalThis[marker];
  started=true;
  globalThis[TRANSPORT]=transport;
  try{
    const script=document.createElement("script");
    script.textContent="globalThis."+marker+"=true;"+runtime;
    document.documentElement.append(script);script.remove();
    if(globalThis[marker]!==true)throw new Error("RUNTIME_BLOCKED");
    stopHello();
  }catch{
    cleanup();
    alert("Il browser ha bloccato il lettore di Hub Fatture. Aggiorna la pagina Aruba e riprova.");
  }finally{delete globalThis[marker]}
};
addEventListener("message",receive);
hello=setInterval(()=>bridge.postMessage({type:TYPE+"_HELLO"},HUB),400);
timeout=setTimeout(()=>{cleanup();alert("Il collegamento con Hub Fatture è scaduto. Torna a Hub Fatture e riprova.")},60000);
})()`;
  return `javascript:${source
    .replace("__HUB__", JSON.stringify(hubOrigin))
    .replace("__PANEL__", JSON.stringify(panelOrigin))}`;
}
