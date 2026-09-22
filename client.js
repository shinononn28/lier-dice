const {CARDS,TEAM,dieHTML,esc,createGame}=NimaiEngine;
const $=s=>document.querySelector(s);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const ONLINE_OK=typeof io==='function';
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
let myKey=store.get('nimai-key');if(!myKey){myKey=Math.random().toString(36).slice(2)+Date.now().toString(36);store.set('nimai-key',myKey)}

let lastSheet=null,S=null,net=null,mode=null,socket=null,room=null;
let marks={},sel={c:1,f:1},opened=new Set(),sheetOpen=0,lastDoubt=null,resultShown=false,promptSheet=null,mitsu=null,lobbyW=null,readySent=null;

/* ---------- sheets ---------- */
function pauseEngine(d){if(mode==='cpu'&&net)net.send('pause',d)}
function openSheet(html,cls=''){const w=document.createElement('div');w.className='sheet-wrap';
  w.innerHTML=`<div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div>`;document.body.appendChild(w);sheetOpen++;pauseEngine(1);lastSheet=w;
  setTimeout(()=>{const f=w.querySelector('button.primary,button,input');f&&f.focus({preventScroll:true})},30);return w}
function closeSheet(w){if(!w||!w.isConnected)return;w.remove();sheetOpen--;pauseEngine(-1);render()}
function toast(t){const d=document.createElement('div');d.className='toast';d.textContent=t;document.body.appendChild(d);setTimeout(()=>d.remove(),2600)}
function confirmSheet(title,body,yes='使う',no='やめる'){return new Promise(res=>{
  const w=openSheet(`<h3>${esc(title)}</h3><p class="muted">${esc(body)}</p><div class="row end"><button data-x="n">${esc(no)}</button><button class="primary" data-x="y">${esc(yes)}</button></div>`);
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;closeSheet(w);res(b.dataset.x==='y')})})}
function pickPlayers(title,list,count,cancelable=true){return new Promise(res=>{const sel=new Set();
  const w=openSheet(`<h3>${esc(title)}</h3><div class="picks">${list.map(p=>`<button data-id="${esc(p.id)}" aria-pressed="false">${esc(p.name)}</button>`).join('')}</div>
    <div class="row end">${cancelable?'<button data-x="cancel">やめる</button>':''}<button class="primary" data-x="ok" disabled>決定</button></div>`);
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.id){const id=b.dataset.id;if(sel.has(id))sel.delete(id);else{if(count===1)sel.clear();if(sel.size<count)sel.add(id)}
      w.querySelectorAll('[data-id]').forEach(x=>x.setAttribute('aria-pressed',sel.has(x.dataset.id)));w.querySelector('[data-x=ok]').disabled=sel.size!==count}
    else if(b.dataset.x==='cancel'){closeSheet(w);res(null)}
    else if(b.dataset.x==='ok'){closeSheet(w);res([...sel])}});
  w._cancel=()=>{closeSheet(w);res(null)}})}

/* ---------- log panes ---------- */
const panes={talk:$('#talk'),glog:$('#glog'),notes:$('#notes'),cards:$('#cards')};
let unread={talk:0,notes:0},chatOpen=false,curTab='talk';
function setBadge(){const b=$('#badge');b.textContent=unread.talk>99?'99+':unread.talk;b.hidden=!unread.talk;$('#ndot').hidden=!unread.notes;$('#tb-talk').hidden=!unread.talk;$('#tb-notes').hidden=!unread.notes}
function clearLogs(){Object.values(panes).forEach(p=>p.innerHTML='');unread={talk:0,notes:0};setBadge();$('#ticker').innerHTML=''}
function addLog(e){
  const kind=e.kind==='chat'&&S&&e.from===S.you?'chat me':e.kind;
  const pane=e.kind==='chat'?'talk':e.kind==='priv'?'notes':'glog';
  const el=document.createElement('div');el.className='msg '+kind;el.innerHTML=e.html;
  const pe=panes[pane];pe.appendChild(el);pe.scrollTop=pe.scrollHeight;
  if(!(chatOpen&&curTab===pane)){if(pane==='talk'&&kind!=='chat me')unread.talk++;if(pane==='notes')unread.notes++;setBadge()}
  if(pane!=='talk'&&e.kind!=='rv'){const t=$('#ticker');t.className='ticker'+(e.kind==='priv'?' priv':'');t.innerHTML=(e.kind==='priv'?'🔒 ':'')+e.html.replace(/<span class="rd">.*?<\/span>/,'')}
}
function showTab(tab){curTab=tab;document.querySelectorAll('.tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===tab));
  Object.entries(panes).forEach(([k,p])=>p.hidden=k!==tab);$('#chatIn').hidden=tab!=='talk';if(tab==='cards')renderCardTab();if(tab in unread){unread[tab]=0;setBadge()}panes[tab].scrollTop=panes[tab].scrollHeight}
function openChat(){if(!S)return;chatOpen=true;$('#chatWrap').hidden=false;pauseEngine(1);showTab(unread.talk?'talk':unread.notes?'notes':curTab)}
function closeChat(){if(!chatOpen)return;chatOpen=false;$('#chatWrap').hidden=true;pauseEngine(-1);render()}
$('#chatBtn').addEventListener('click',openChat);$('#chatClose').addEventListener('click',closeChat);
$('#chatWrap').addEventListener('click',e=>{if(e.target.id==='chatWrap')closeChat()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeChat()});
document.querySelector('.tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b)showTab(b.dataset.tab)});
function sendChat(){const i=$('#chatInput'),t=i.value.trim();if(!t||!net)return;i.value='';net.send('chat',t)}
$('#chatSend').addEventListener('click',sendChat);
$('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing)sendChat()});
$('#rulesBtn').addEventListener('click',showRules);

/* ---------- helpers on view ---------- */
const meP=()=>S.order.find(p=>p.id===S.you);
const maxOf=f=>S.maxDecl[f]||0;
const isValid=(c,f)=>f>=1&&f<=6&&c>maxOf(f)&&c<=S.totalDice;
function minRaise(){const T=S.totalDice,cnt=[0,0,0,0,0,0,0];S.me.dice.forEach(d=>cnt[d]++);
  const fs=[1,2,3,4,5,6].filter(f=>maxOf(f)<T).sort((a,b)=>cnt[b]-cnt[a]);const f=fs[0]||6;return{c:Math.min(T,maxOf(f)+1),f}}
const myTurn=()=>S&&S.prompt&&S.prompt.kind==='turn';
function cardReady(c){const d=CARDS[c.type];return!c.used&&!c.reserved&&!d.reaction&&!(d.late&&!S.mitsudanDone)&&!(d.biddingOnly&&S.phase!=='bidding')}
const canUseCards=()=>S&&(S.phase==='prep'||S.phase==='bidding')&&!S.lastReveal&&!S.me.usedThisRound&&S.me.cardsUsed<2&&sheetOpen===0;

/* ---------- render ---------- */
const MARK={red:'赤?',blue:'青?',both:'赤青?'};
function seatHTML(p){
  const tag=p.team?`<span class="tag ${p.team}">${TEAM[p.team]}</span>`:'';
  const pips=p.cardsUsed===null?'<span class="hid" title="前半は非公開"></span>':[0,1].map(i=>`<span class="${i<p.cardsUsed?'on':''}"></span>`).join('');
  const isMe=p.id===S.you,mk=marks[p.id];
  const mark=isMe?'':`<span class="mark ${mk||'none'}" aria-hidden="true">${mk?MARK[mk]:'?'}</span>`;
  const el=isMe?'div':'button';
  const attr=isMe?'':` data-mark="${esc(p.id)}" aria-label="${esc(p.name)}：陣営予想 ${mk?MARK[mk]:'なし'}（タップで切り替え）"`;
  return `<${el} class="seat ${S.turn===p.id?'turn':''}"${attr}><div class="nm"><span class="n">${esc(p.name)}</span>${tag}${p.connected===false?'<span class="off">切断中</span>':''}${mark}</div>
    <div class="st"><span class="coins"><span class="coin"></span>${p.coins}</span><span class="cardpips">${pips}</span></div></${el}>`;
}
function cdText(){const pr=S&&S.prompt;if(!pr||!pr.deadline)return'';const s=Math.max(0,Math.ceil((pr.deadline-Date.now())/1000));return `残り${s}秒`}
setInterval(()=>{const el=document.querySelector('.cd');if(el)el.textContent=cdText()},500);
function render(){
  if(!S)return;const me=S.me,T=S.totalDice;
  $('#round').textContent=S.over?'終了':S.round?`R${S.round} / ${S.rounds}`:'';
  $('#seats').innerHTML=S.order.map(seatHTML).join('');
  const bd=$('#board'),hi=$('#hist'),rv=S.lastReveal;
  const mult=(S.mult>1&&!S.over&&S.phase!=='accuse'?`<span class="mult">賭け金×${S.mult}</span>`:'');
  if(rv){bd.innerHTML=`<div class="bidnum disp">${rv.actual}<small>個</small></div>${dieHTML(rv.f,'big')}
      <div class="bidby">${esc(rv.by)}の「${rv.c}個の${rv.f}」は<b>${rv.truth?'本当':'嘘'}</b><br>${esc(rv.payer)}が${rv.amount}枚払った</div>`;
    hi.innerHTML=lastDoubt?`<div class="rvt">${lastDoubt.rows.map(r=>`<div class="r"><b>${esc(r.name)}</b>${r.dice.map(d=>dieHTML(d,d===rv.f?'hit':'dim')).join('')}</div>`).join('')}</div>`:''}
  else{
    if(S.bid)bd.innerHTML=`<div class="bidnum disp">${S.bid.c}<small>個の</small></div>${dieHTML(S.bid.f,'big')}<div class="bidby">${esc(S.bid.by)}の宣言${mult}<br>賭け金 ${S.bid.f*S.mult}枚</div>`;
    else bd.innerHTML=`<div class="bidwait">${S.phase==='prep'?`ラウンド${S.round}　親は${esc(S.order[0].name)}`:S.phase==='bidding'?'最初の宣言を待っています':S.phase==='mitsudan'?'密談の時間':S.phase==='accuse'?'告発の時間':S.over?'ゲーム終了':'—'}</div>${mult?`<div class="bidby">${mult}</div>`:''}`;
    hi.innerHTML=(S.history||[]).map(x=>`<span>${esc(x.n)} ${x.c}個の${dieHTML(x.f)}</span>`).join('');
  }
  const turn=myTurn(),dis=turn?'':'disabled';
  if(turn&&!isValid(sel.c,sel.f))sel=minRaise();
  const own=me.dice.filter(d=>d===sel.f).length,pr=S.prompt;
  let ctrl;
  if(S.over)ctrl=`<button class="primary" data-act="result">結果を見る</button>`;
  else if(pr&&pr.kind==='ready'){const rd=S.ready;ctrl=`<div class="info">ラウンド${S.round}の準備中。${me.usedThisRound?'カードを予約した。宣言開始と同時に発動する。':'今使うカードは全員同時に発動する（濡れ衣が最優先）。'}<span class="cd">${cdText()}</span></div>
      <button class="primary" data-act="ready">${rd&&rd.of>1?`準備完了（${rd.n}/${rd.of}）`:'宣言を始める'}</button>`}
  else if(S.phase==='prep'){const rd=S.ready;ctrl=`<div class="info">ほかの人の準備を待っています${rd?`（${rd.n}/${rd.of}）`:''}</div><button class="primary" disabled>待機中</button>`}
  else if(S.phase==='mitsudan'||S.phase==='accuse'||S.phase==='between'){ctrl=`<div class="info">${S.phase==='mitsudan'?'密談中…':S.phase==='accuse'?'告発中…':'…'}<span class="cd">${cdText()}</span></div>${pr&&['partner','mitsudan','accuse'].includes(pr.kind)?'<button class="primary" data-act="reopen">画面を開く</button>':''}`}
  else ctrl=`<div class="line">
      <div class="stepper"><button data-act="cm" aria-label="個数を減らす" ${dis}>−</button><span class="cnt disp">${sel.c}</span><span class="u">個の</span><button data-act="cp" aria-label="個数を増やす" ${dis}>＋</button></div>
      <div class="acts"><button class="primary" data-act="bid" ${turn&&isValid(sel.c,sel.f)?'':'disabled'}>宣言</button><button class="doubt" data-act="doubt" ${turn&&S.bid?'':'disabled'}>ダウト</button></div></div>
    <div class="faces" role="group" aria-label="目を選ぶ">${[1,2,3,4,5,6].map(f=>`<button data-act="face" data-f="${f}" aria-pressed="${sel.f===f}" aria-label="${f}の目（これまで最大${maxOf(f)}個）" ${dis}>${dieHTML(f,'btn')}${maxOf(f)?`<span class="mx">${maxOf(f)}</span>`:''}</button>`).join('')}</div>
    <div class="info">${S.phase!=='bidding'?'…':turn?`あなたの番<span class="cd">${cdText()}</span> ・ 「${sel.f}」はこれまで最大${maxOf(sel.f)}個 ・ 手に${own}個`:`${S.turn?esc((S.order.find(p=>p.id===S.turn)||{}).name||'')+'が考えています…':'…'}`}</div>`;
  const can=canUseCards();
  const cards=me.cards.map((c,i)=>{const d=CARDS[c.type];
    const note=c.reserved?'（予約）':d.reaction&&!c.used?'<small>ダウトされた時</small>':d.late&&!S.mitsudanDone&&!c.used?'<small>後半から</small>':'';
    return `<button class="card ${c.used?'used':''} ${c.reserved?'reserved':''}" data-act="card" data-i="${i}" ${cardReady(c)&&can?'':'disabled'}>${d.name}${note}</button>`}).join('');
  const pk=me.peek;
  $('#mine').innerHTML=`<div class="head"><div class="who">${esc(meP().name)}<span class="tag ${me.team}">${TEAM[me.team]}</span>${me.framed?'<span class="small muted">濡れ衣中</span>':''}${me.scapegoat?'<span class="small muted">身代わり中</span>':''}</div>
    <div class="hand">${me.dice.map(d=>dieHTML(d,'mid')).join('')}</div></div>${ctrl}
    ${pk&&!S.over?`<div class="info peekl">のぞき中：${esc(pk.name)} ${pk.dice.map(d=>dieHTML(d)).join('')}<span>ラウンド${pk.until}まで</span></div>`:''}
    <div class="cards" aria-label="カード（あと${2-me.cardsUsed}枚使える）">${cards}</div>`;
}

function renderCardTab(){
  const el=panes.cards;if(!S||!S.cardlog||el.hidden)return;const L=S.cardlog;
  const rows=L.players.map(q=>`<tr class="${q.me?'me':''}"><td><b>${esc(q.name)}</b></td>
    <td>${q.first===null?'<span class="muted">非公開</span>':q.first+'枚'}</td>
    <td>${q.late.length?q.late.map(r=>`<span class="rchip">R${r}</span>`).join(''):L.mitsudanDone||q.me?'—':'<span class="muted">密談後</span>'}</td>
    <td>${q.revealed.length?q.revealed.map(esc).join('・'):'—'}</td></tr>`).join('');
  const eff=L.effects.length?L.effects.map(e=>`<div><b>R${e.round}</b><span>${esc(e.text)}</span></div>`).join(''):'<div class="muted">まだなし</div>';
  const mine=L.mine.length?L.mine.map(e=>`<div><b>R${e.round}</b><span>${esc(e.text)}</span></div>`).join(''):'<div class="muted">まだなし</div>';
  const hand=S.me.cards.map(c=>`<span class="rchip">${CARDS[c.type].name}${c.used?'（使用済）':c.reserved?'（予約）':''}</span>`).join('');
  el.innerHTML=`<h4>みんなの使用状況</h4>
    <table class="ct"><thead><tr><th>席</th><th>前半（R1〜${L.mid}）</th><th>後半の使用</th><th>判明したカード</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted" style="margin:4px 0 0">前半の使用数は密談のあとに公開。後半は使ったラウンドが記録される。</p>
    <h4>公開された効果</h4><div class="elist">${eff}</div>
    <h4>あなたのカード</h4><div>${hand}</div><div class="elist" style="margin-top:6px">${mine}</div>`;
}

/* ---------- input ---------- */
document.addEventListener('click',e=>{
  if(!S)return;
  const m=e.target.closest('[data-mark]');
  if(m&&!m.closest('.sheet')){const id=m.dataset.mark,cyc=[undefined,'red','blue','both'];const nx=cyc[(cyc.indexOf(marks[id])+1)%cyc.length];if(nx)marks[id]=nx;else delete marks[id];render();return}
  const b=e.target.closest('[data-act]');if(!b||b.closest('.sheet'))return;const a=b.dataset.act,T=S.totalDice;
  if(a==='cm'){sel.c=clamp(sel.c-1,maxOf(sel.f)+1,T);render()}
  else if(a==='cp'){sel.c=clamp(sel.c+1,1,T);render()}
  else if(a==='face'){sel.f=+b.dataset.f;sel.c=Math.min(T,maxOf(sel.f)+1);render()}
  else if(a==='bid'&&myTurn()&&isValid(sel.c,sel.f)){net.send('respond',{kind:'turn',value:{type:'bid',c:sel.c,f:sel.f}})}
  else if(a==='doubt'&&myTurn()&&S.bid){net.send('respond',{kind:'turn',value:{type:'doubt'}})}
  else if(a==='ready'&&S.prompt&&S.prompt.kind==='ready'){net.send('respond',{kind:'ready',value:true})}
  else if(a==='card')useCard(+b.dataset.i);
  else if(a==='result')showResult();
  else if(a==='reopen'&&S.prompt){opened.delete(S.prompt.id);handlePrompt()}
});
async function useCard(i){
  if(!canUseCards())return;const c=S.me.cards[i],d=CARDS[c.type];if(!cardReady(c))return;
  const others=S.order.filter(p=>p.id!==S.you);let payload={type:'card',ci:i,targets:[]};
  if(d.n>0){const t=await pickPlayers(`${d.name}（${d.desc}）：${d.n===1?'1人':'2人'}選ぶ`,others,d.n);if(!t)return;payload.targets=t}
  else if(d.die){const r=await diePicker(`${d.name}：変えるダイスと目を選ぶ`,1);if(!r)return;payload.i=r[0].i;payload.face=r[0].face}
  else if(!await confirmSheet(`${d.name}を使う？`,d.desc))return;
  if(!canUseCards())return;net.send('action',payload);
}
function diePicker(title,max,note=''){return new Promise(res=>{
  const dice=S.me.dice,ch=[];let cur=null;
  const w=openSheet(`<h3>${esc(title)}</h3>${note?`<p class="muted small">${esc(note)}</p>`:''}<div class="small muted">変えるダイス</div><div class="pickdie" data-g="d"></div>
    <div class="small muted">変更後の目</div><div class="pickdie" data-g="f">${[1,2,3,4,5,6].map(f=>`<button data-f="${f}" aria-pressed="false">${dieHTML(f,'btn')}</button>`).join('')}</div>
    <div class="mtrow small" data-g="sum"></div><div class="row end"><button data-x="cancel">やめる</button><button class="primary" data-x="ok" disabled>決定</button></div>`);
  const draw=()=>{w.querySelector('[data-g=d]').innerHTML=dice.map((d,i)=>{const c=ch.find(x=>x.i===i);return `<button data-i="${i}" aria-pressed="${cur===i}">${dieHTML(c?c.face:d,'btn')}</button>`}).join('');
    w.querySelector('[data-g=sum]').textContent=ch.length?`変更：${ch.map(x=>`${dice[x.i]}→${x.face}`).join('、')}`:'';
    w.querySelector('[data-x=ok]').disabled=!ch.length;
    w.querySelectorAll('[data-g=f] button').forEach(b=>b.disabled=cur===null)};
  draw();
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.i!==undefined){const i=+b.dataset.i;if(ch.some(x=>x.i===i)){ch.splice(ch.findIndex(x=>x.i===i),1);cur=null}else if(ch.length<max)cur=i;draw()}
    else if(b.dataset.f&&cur!==null){ch.push({i:cur,face:+b.dataset.f});cur=null;draw()}
    else if(b.dataset.x==='cancel'){closeSheet(w);res(null)}
    else if(b.dataset.x==='ok'){closeSheet(w);res(ch)}});
  w._cancel=()=>{closeSheet(w);res(null)};
})}

/* ---------- prompts ---------- */
function handlePrompt(){
  const pr=S.prompt;
  if(promptSheet&&(!pr||pr.id!==promptSheet.id)){const w=promptSheet.w;promptSheet=null;if(w&&w.isConnected){w._cancel?w._cancel():closeSheet(w)}mitsu=null}
  if(!pr||opened.has(pr.id))return;
  if(!['matta','partner','mitsudan','accuse'].includes(pr.kind))return;
  opened.add(pr.id);promptSheet={id:pr.id,w:null};
  if(pr.kind==='matta'){
    diePicker(`待った！ ${pr.data.by}にダウトされた`,2,`あなたの「${pr.data.c}個の${pr.data.f}」。カード「待った」でダイスを2個まで変えられる。変えなければ「やめる」。`)
      .then(ch=>net.send('respond',{kind:'matta',value:{changes:ch||[]}}));promptSheet.w=lastSheet;
  }else if(pr.kind==='partner'){
    pickPlayers('密談の相手を1人選ぶ',S.order.filter(p=>p.id!==S.you),1,false).then(t=>{if(t)net.send('respond',{kind:'partner',value:t[0]})});promptSheet.w=lastSheet;
  }else if(pr.kind==='mitsudan')openMitsudan();
  else if(pr.kind==='accuse')openAccuse(pr);
}
const QS={team:'どっち側？',cards:'使ったカードは？',sus:'誰が怪しい？',res:'何か調べた？'};
function openMitsudan(){
  const w=openSheet(`<h3>密談 <span class="cd">${cdText()}</span></h3><p class="muted small">ここでの会話は相手と2人だけ。ただし盗聴されているかもしれない。会話は終了時に手帳へ保存される。</p>
    <div class="thtabs"></div><div class="mlog"></div><div class="mbtns"></div>
    <div class="chatin"><input placeholder="自由に話す（例：ボルドは青だと思う）" maxlength="100" aria-label="密談の入力"><button data-x="send">送る</button></div>
    <div class="row end"><button class="primary" data-x="end">密談を終える</button></div>`);
  mitsu={w,key:null};promptSheet.w=w;
  const inp=w.querySelector('input');
  const send=()=>{const t=inp.value.trim();if(!t||!mitsu.key)return;inp.value='';net.send('dm',{key:mitsu.key,text:t})};
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing)send()});
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.key){mitsu.key=b.dataset.key;drawMitsudan()}
    else if(b.dataset.ans)net.send('dm',{key:mitsu.key,ans:b.dataset.ans});
    else if(b.dataset.q)net.send('dm',{key:mitsu.key,q:b.dataset.q});
    else if(b.dataset.x==='send')send();
    else if(b.dataset.x==='end'){net.send('respond',{kind:'mitsudan',value:true});promptSheet=null;mitsu=null;closeSheet(w)}});
  w._cancel=()=>{mitsu=null;closeSheet(w)};
  drawMitsudan();
}
function drawMitsudan(){
  if(!mitsu||!S)return;const w=mitsu.w,ths=S.threads||[];
  if(!mitsu.key||!ths.some(t=>t.key===mitsu.key))mitsu.key=ths[0]?ths[0].key:null;
  w.querySelector('.thtabs').innerHTML=ths.length>1?ths.map(t=>`<button data-key="${esc(t.key)}" aria-pressed="${t.key===mitsu.key}">${esc(t.with.name)}</button>`).join(''):'';
  const th=ths.find(t=>t.key===mitsu.key);
  const lg=w.querySelector('.mlog');
  lg.innerHTML=th?`<div class="msg sys">${esc(th.with.name)}との密談</div>`+th.log.map(e=>`<div class="msg chat ${e.from===S.you?'me':''}"><b>${esc(e.name)}</b><span>${esc(e.text)}</span></div>`).join(''):'<div class="msg sys">相手を待っています…</div>';
  lg.scrollTop=lg.scrollHeight;
  let btns='';
  if(th&&th.needAnswer)btns=`<button data-ans="red">赤だ</button><button data-ans="blue">青だ</button><button data-ans="none">言えないね</button>`;
  else if(th&&th.with.isBot)btns=Object.entries(QS).filter(([k])=>!th.asked.includes(k)).map(([k,l])=>`<button data-q="${k}">${l}</button>`).join('');
  w.querySelector('.mbtns').innerHTML=btns;
  const cd=w.querySelector('.cd');if(cd)cd.textContent=cdText();
}
function openAccuse(pr){
  const others=S.order.filter(p=>p.id!==S.you),opts=pr.data.opts,g={};
  others.forEach(p=>{const m=marks[p.id];if(m==='red'||m==='blue')g[p.id]=m});
  const w=openSheet(`<h3>告発 <span class="cd">${cdText()}</span></h3><p class="muted small">全員の陣営を予想する。当たるたびに金貨+1。${opts.includes('rogue')?'詐欺師は過半数に名指しされると単独勝利を失う。':''}</p>
    <div class="acc">${others.map(p=>`<div class="r"><b>${esc(p.name)}</b><div class="seg" data-id="${esc(p.id)}">${opts.map(o=>`<button data-v="${o}" aria-pressed="${g[p.id]===o}">${TEAM[o]}</button>`).join('')}</div></div>`).join('')}</div>
    <div class="row end"><button class="primary" data-x="ok" ${Object.keys(g).length===others.length?'':'disabled'}>告発する</button></div>`);
  promptSheet.w=w;
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const seg=b.closest('.seg');
    if(seg){g[seg.dataset.id]=b.dataset.v;seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b));w.querySelector('[data-x=ok]').disabled=Object.keys(g).length!==others.length;return}
    if(b.dataset.x==='ok'){net.send('respond',{kind:'accuse',value:g});promptSheet=null;closeSheet(w)}});
}

/* ---------- doubt show ---------- */
const rawSleep=ms=>new Promise(r=>setTimeout(r,ms));
async function doubtShow(d){
  lastDoubt=d;const sp=d.speed||1,sl=ms=>rawSleep(ms*sp);
  const w=document.createElement('div');w.className='dz';
  w.innerHTML=`<div class="dzp" role="dialog" aria-modal="true" aria-label="ダウト">
    <div class="dzt disp">ダウト！</div>
    <div class="dzs">${esc(d.ch)}が${esc(d.by)}の「${d.c}個の${d.f}」を疑った${d.mult>1?`<span class="mult">賭け金×${d.mult}</span>`:''}</div>
    <div class="dzm disp" hidden>${d.matta?`${esc(d.matta.name)}の待った！`:''}</div>
    <div class="dzcnt">${dieHTML(d.f,'mid')}<span class="disp n">0</span><span class="u">個 ／ 宣言${d.c}個</span></div>
    <div class="dzrows">${d.rows.map(r=>`<div class="dzr"><b>${esc(r.name)}</b>${r.dice.map((x,i)=>`<span class="flip ${r.changed.includes(i)?'chg':''}" data-d="${x}"><span class="fi"><span class="fa">${dieHTML(0)}</span><span class="fb">${dieHTML(x)}</span></span></span>`).join('')}</div>`).join('')}</div>
    <div class="row end"><button data-x="skip" class="small">スキップ</button></div></div>`;
  document.body.appendChild(w);
  let skip=false;w.addEventListener('click',e=>{if(e.target.closest('[data-x=skip]'))skip=true});
  const wait=ms=>skip?Promise.resolve():sl(ms);
  await wait(1000);
  if(d.matta){w.querySelector('.dzm').hidden=false;await wait(1200)}
  let n=0;const nEl=w.querySelector('.n'),cnt=w.querySelector('.dzcnt');
  for(const row of w.querySelectorAll('.dzr')){for(const fl of row.querySelectorAll('.flip')){
    fl.classList.add('up');
    if(+fl.dataset.d===d.f){n++;fl.classList.add('hit');nEl.textContent=n;cnt.classList.remove('bump');void cnt.offsetWidth;cnt.classList.add('bump');if(n>=d.c)cnt.classList.add('ok')}
    else fl.classList.add('miss');
    await wait(150)}
    await wait(220)}
  w.querySelector('.dzp .row').remove();
  await sl(skip?300:700);
  await verdictShow(d,sp);
  w.remove();render();
}
function verdictShow(d,sp){return new Promise(res=>{
  const me=S&&S.you,ids=d.ids||{};
  let top='',cls='';
  if(me===ids.winner){top='あなたの勝ち！';cls='win'}
  else if(me===ids.payer&&d.sg){top='身代わりで払わされた…';cls='lose'}
  else if(me===ids.loser){top=d.sg?'負けたが、支払いは身代わりへ':'あなたの負け…';cls=d.sg?'':'lose'}
  const total=d.amount+(d.bonus||0);
  const v=document.createElement('div');v.className='vdict';
  v.innerHTML=`<div class="vdc ${cls}" role="dialog" aria-live="assertive">
    ${top?`<div class="vtop">${top}</div>`:''}
    <div class="vstamp disp ${d.truth?'t':'l'}">${d.truth?'宣言は本当':'嘘を見破った'}</div>
    <div class="vline">「${d.f}」は${d.actual}個 ／ 宣言は${d.c}個</div>
    <div class="vline"><b>${esc(d.loser)}</b>の負け</div>
    <div class="vcoins">${esc(d.payer)} → ${esc(d.winner)}<b class="disp">${total}枚</b></div>
    ${d.sg?`<div class="vnote">身代わり発動！ ${esc(d.loser)}の支払いを${esc(d.payer)}がかぶった</div>`:''}
    ${d.bonus?`<div class="vnote">看破ボーナス：宣言より${d.c-d.actual}個少ない。+${d.bonus}枚込み</div>`:''}
    <div class="vhint small muted">タップで閉じる</div></div>`;
  document.body.appendChild(v);
  let done=false;const close=()=>{if(done)return;done=true;v.classList.add('out');setTimeout(()=>{v.remove();res()},180)};
  v.addEventListener('click',close);setTimeout(close,3800*sp);
})}

/* ---------- card popups ---------- */
const popQ=[];let popBusy=false;
function queuePopup(d){popQ.push(d);runPop()}
async function runPop(){if(popBusy)return;popBusy=true;
  while(popQ.length){while(document.querySelector('.dz,.vdict'))await rawSleep(200);await showPop(popQ.shift())}popBusy=false}
const colorize=t=>esc(t).replace(/【赤】/g,'<span class="tag red">赤</span>').replace(/【青】/g,'<span class="tag blue">青</span>').replace(/【詐欺師】/g,'<span class="tag rogue">詐欺師</span>');
function showPop(d){return new Promise(res=>{
  const w=document.createElement('div');w.className='pop'+(d.private?' priv':'');
  w.innerHTML=`<div class="popc" role="dialog" aria-live="polite">${d.private?'<div class="pl">あなただけ</div>':'<div class="pl">🂠</div>'}
    <div class="pt disp">${esc(d.title)}</div>${d.lines.map(l=>`<div class="pb">${colorize(l)}</div>`).join('')}
    ${d.private?'<div class="row end"><button class="primary">OK</button></div>':''}</div>`;
  document.body.appendChild(w);let done=false;
  const close=()=>{if(done)return;done=true;w.classList.add('out');setTimeout(()=>{w.remove();res()},180)};
  w.addEventListener('click',close);setTimeout(close,d.private?12000:2200);
  if(d.private)setTimeout(()=>{const b=w.querySelector('button');b&&b.focus({preventScroll:true})},30);
})}

/* ---------- result ---------- */
async function showFinal(){
  while(document.querySelector('.dz,.vdict,.pop'))await rawSleep(200);
  const r=S.result;if(!r)return;const me=r.rows.find(x=>x.id===S.you);
  const st=r.winner==='draw'?'draw':r.winner===me.team?'win':'lose';
  const v=document.createElement('div');v.className='vdict';
  v.innerHTML=`<div class="vdc ${st==='draw'?'':st}" role="dialog" aria-live="assertive">
    <div class="vtop">${esc(r.head)}</div>
    <div class="vstamp disp fin ${st}">${st==='win'?'勝利！':st==='lose'?'敗北…':'引き分け'}</div>
    <div class="vline">あなたは<span class="tag ${me.team}">${TEAM[me.team]}</span>${me.origTeam!==me.team?`（元は${TEAM[me.origTeam]}）`:''} ・ 金貨${me.coins}枚</div>
    <div class="vline small">赤 ${r.red}枚 ／ 青 ${r.blue}枚${r.rogue?` ／ 詐欺師${esc(r.rogue.name)} ${r.rogue.coins}枚${r.rogue.exposed?'（吊られた）':''}`:''}</div>
    <div class="row" style="justify-content:center"><button class="primary" data-x="detail">結果の詳細</button></div></div>`;
  document.body.appendChild(v);
  v.addEventListener('click',e=>{if(e.target===v||e.target.closest('[data-x=detail]')){v.remove();showResult()}});
  setTimeout(()=>{const b=v.querySelector('button');b&&b.focus({preventScroll:true})},30);
}
function showResult(){
  const r=S.result;if(!r)return;resultShown=true;
  const me=r.rows.find(x=>x.id===S.you),win=r.winner==='draw'?null:r.winner===me.team;
  const rows=r.rows.map(p=>`<tr><td><b>${esc(p.name)}</b><br><span class="tag ${p.team}">${TEAM[p.team]}</span>${p.origTeam!==p.team?`<br><span class="small muted">元は${TEAM[p.origTeam]}</span>`:''}</td><td>${p.coins}</td><td>${p.correct}</td>
    <td class="small">${p.cards.map(c=>c.used?`<b>${c.name}</b>`:`<span class="muted">${c.name}</span>`).join('・')}</td></tr>`).join('');
  const again=mode==='cpu'?'<button class="primary" data-x="again">もう一度遊ぶ</button>':room&&room.isHost?'<button class="primary" data-x="rematch">ロビーに戻る</button>':'';
  const w=openSheet(`<p class="muted small">結果</p><div class="win disp">${esc(r.head)}</div>
    <p>${win===null?'決着つかず。':win?'あなたの勝ち。':'あなたの負け。'} 赤 ${r.red}枚 ／ 青 ${r.blue}枚${r.rogue?` ／ 詐欺師 ${r.rogue.coins}枚（名指し ${r.rogue.votes}票${r.rogue.exposed?'・吊られた':''}）`:''}</p>
    <table class="res"><thead><tr><th>席</th><th>金貨</th><th>告発正解</th><th>カード（太字＝使用）</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row end"><button data-x="close">卓を見る</button>${again}</div>`);
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;closeSheet(w);
    if(b.dataset.x==='again')showHome();if(b.dataset.x==='rematch'&&socket)socket.emit('rematch')});
}

/* ---------- event handling ---------- */
function onEvent(type,data){
  if(type==='state'){S=data;render();renderCardTab();handlePrompt();drawMitsudan();if(S.over&&!resultShown){resultShown=true;setTimeout(showFinal,600)}}
  else if(type==='log')addLog(data);
  else if(type==='logs'){clearLogs();data.forEach(addLog)}
  else if(type==='doubt')doubtShow(data);
  else if(type==='popup')queuePopup(data);
}
function resetClient(){S=null;marks={};opened=new Set();lastDoubt=null;resultShown=false;promptSheet=null;mitsu=null;clearLogs();
  document.querySelectorAll('.sheet-wrap,.dz').forEach(x=>x.remove());sheetOpen=0;
  ['#seats','#board','#hist','#mine','#round'].forEach(s=>$(s).innerHTML='')}

/* ---------- CPU mode ---------- */
function startCpu(o){
  resetClient();mode='cpu';
  const eng=createGame({humans:[{id:'me',name:o.name}],total:o.n,speed:o.speed,emit:(to,type,data)=>{if(to==='*'||to==='me')onEvent(type,data)}});
  net={send(t,p){if(t==='respond')eng.respond('me',p.kind,p.value);else if(t==='action')eng.action('me',p);else if(t==='chat')eng.chat('me',p);else if(t==='dm')eng.dm('me',p);else if(t==='pause')eng.pause(p)}};
  eng.start();
}

/* ---------- online ---------- */
function connect(){
  if(socket)return socket;
  socket=io();net={send(t,p){if(t!=='pause')socket.emit(t,p)}};
  socket.on('connect',()=>{socket.emit('hello',{key:myKey,name:store.get('nimai-name')||'名無し'});if(room)socket.emit('join',{code:room.code})});
  socket.on('room',r=>{const was=room&&room.started;room=r;
    if(r.started){if(lobbyW){closeSheet(lobbyW);lobbyW=null}if(!was){resetClient();mode='online'}}
    else{if(was){resetClient()}mode='online';showLobby()}});
  ['state','log','logs','doubt'].forEach(t=>socket.on(t,d=>onEvent(t,d)));
  socket.on('errorMsg',m=>{toast(m);if(!room&&!document.querySelector('.home'))showHome()});
  return socket;
}
function showLobby(){
  const r=room;const url=location.origin+location.pathname+'?room='+r.code;
  const html=`<p class="muted small">ルームコード</p><div class="codebig disp">${esc(r.code)}</div>
    <div class="row"><button data-x="copy">招待リンクをコピー</button></div>
    <p class="small muted" style="margin-top:8px">${esc(url)}</p>
    <h3 style="margin-top:12px">参加者（${r.members.length}人）</h3><div class="members">${r.members.map(m=>`<div>${esc(m.name)}${m.host?' <span class="tag rogue">ホスト</span>':''}${m.connected?'':' <span class="small muted">切断中</span>'}</div>`).join('')}</div>
    ${r.isHost?`<fieldset><legend>卓の人数（足りない分はCPU）</legend><div class="seg" data-g="n">${[4,5,6].map(n=>`<button data-v="${n}" aria-pressed="${r.n===n}">${n}人</button>`).join('')}</div></fieldset>
      <div class="row end"><button data-x="leave">退出</button><button class="primary" data-x="start">ゲーム開始</button></div>`
      :`<p class="muted">ホストの開始を待っています…（卓は${r.n}人）</p><div class="row end"><button data-x="leave">退出</button></div>`}`;
  if(lobbyW&&lobbyW.isConnected){lobbyW.querySelector('.sheet').innerHTML=html;return}
  lobbyW=openSheet(html);
  lobbyW.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const seg=b.closest('.seg');
    if(seg){socket.emit('settings',{n:+b.dataset.v});return}
    if(b.dataset.x==='copy'){const u=location.origin+location.pathname+'?room='+room.code;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>toast('コピーした'),()=>toast(u))}
    if(b.dataset.x==='start')socket.emit('start');
    if(b.dataset.x==='leave'){socket.emit('leave');room=null;closeSheet(lobbyW);lobbyW=null;history.replaceState(null,'',location.pathname);showHome()}});
}

/* ---------- home ---------- */
function showHome(){
  resetClient();mode=null;const qs=new URLSearchParams(location.search).get('room');
  const opt={n:5,s:1};const name=store.get('nimai-name')||'';
  const w=openSheet(`<h1 class="disp title">二枚舌の酒場</h1><p>誰が味方かわからないまま、ダイスの嘘を読み合う。</p>
    <label>あなたの名前<input id="h-name" value="${esc(name)}" maxlength="8" placeholder="8文字まで"></label>
    ${ONLINE_OK?`<div class="opt"><h3>みんなで遊ぶ</h3>
      <div class="line2"><button class="primary" data-x="create">ルームを作る</button></div>
      <div class="line2"><input class="code" id="h-code" maxlength="4" placeholder="コード" value="${esc(qs||'')}" aria-label="ルームコード"><button data-x="join">参加する</button></div></div>`:''}
    <div class="opt"><h3>CPUとひとりで遊ぶ</h3>
      <div class="seg" data-g="n">${[4,5,6].map(n=>`<button data-v="${n}" aria-pressed="${n===5}">${n}人</button>`).join('')}</div>
      <div class="seg" data-g="s"><button data-v="1" aria-pressed="true">ふつう</button><button data-v="0.45" aria-pressed="false">速い</button></div>
      <div class="line2"><button data-x="cpu">CPU戦をはじめる</button></div></div>
    <p class="muted small">ラウンド数は人数と同じで、全員が1回ずつ親になる。奇数人数だと詐欺師が1人混ざる。</p>
    <div class="row end"><button data-x="rules">ルールを読む</button></div>`,'home');
  const getName=()=>{const v=w.querySelector('#h-name').value.trim().slice(0,8)||'名無し';store.set('nimai-name',v);return v};
  w.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const seg=b.closest('.seg');
    if(seg){opt[seg.dataset.g]=+b.dataset.v;seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b));return}
    if(b.dataset.x==='rules')showRules();
    if(b.dataset.x==='cpu'){const nm=getName();closeSheet(w);startCpu({n:opt.n,speed:opt.s,name:nm})}
    if(b.dataset.x==='create'){const nm=getName();closeSheet(w);connect();socket.emit('hello',{key:myKey,name:nm});socket.emit('create',{n:5})}
    if(b.dataset.x==='join'){const code=w.querySelector('#h-code').value.trim().toUpperCase();if(!code){toast('コードを入れてください');return}
      const nm=getName();closeSheet(w);connect();socket.emit('hello',{key:myKey,name:nm});socket.emit('join',{code})}});
}
function showRules(){
  const w=openSheet(`<h3>ルール</h3><div class="rules"><ul>
  <li>全員がこっそり<b>赤</b>と<b>青</b>に分かれる。奇数人数なら1人は<b>詐欺師</b>。</li>
  <li>ラウンド数は人数と同じ。親（最初に宣言する人）は持ち回りで、ほかの席順は毎ラウンドシャッフル。</li>
  <li>毎ラウンド全員がダイス5個を振る。手番順に「○個の□」と、全員のダイスの合計についての宣言をしていく。</li>
  <li>宣言は<b>目ごとに独立</b>。ある目を宣言するときは、その目でこれまで宣言された個数より多くする。目のボタン右上の数字が、その目のこれまでの最大宣言。</li>
  <li>直前の人の宣言が嘘だと思ったら<b>ダウト</b>。全員のダイスを公開し、その目が宣言以上あれば宣言は本当。</li>
  <li>負けた人は<b>宣言された目と同じ枚数</b>の金貨を勝った人に払う（6なら6枚）。</li>
  <li><b>看破ボーナス</b>：ダウトで嘘を見破ったとき、宣言が実際の個数より3個以上多かったら、嘘をついた側からさらに金貨2枚を奪う。1や2の目で大きく盛った嘘ほど痛い。</li>
  <li>カードは開始時に3枚。ゲーム中に2枚まで、1ラウンド1枚ずつ使える（待ったはダウトされた瞬間に使う）。</li>
  <li>前半（密談まで）は、カードを使ったこと自体が誰にも通知されない。密談のあとに前半の使用枚数が公開され、後半は使うたびに通知される。</li>
  <li>ラウンド開始前の準備中に使ったカードは、全員同時に発動する。<b>濡れ衣が最優先</b>、<b>陣営交換は最後</b>に処理される。</li>
  <li>折り返しで<b>密談</b>。1人を選んで2人だけで話す（選ばれた側も会話に加わる）。</li>
  <li>ほかの人の席をタップすると、自分だけに見える陣営予想のバッジ（赤? → 青? → 赤青? → なし）を付けられる。告発の初期値にもなる。</li>
  <li>最後に<b>告発</b>。全員の陣営を予想し、当たった数だけ金貨+1。</li>
  <li>金貨の合計が多い陣営の勝ち。詐欺師は、金貨が単独1位かつ告発で過半数に名指しされなければ単独勝利。</li></ul>
  <b>カード</b><ul>${Object.values(CARDS).map(c=>`<li><b>${c.name}</b>：${c.desc}</li>`).join('')}</ul>
  <p class="muted small">濡れ衣：2人とも濡れ衣の照合は反転が打ち消し合う。濡れ衣が働くと、本人にだけ「調べられた気配」が届く。</p></div>
  <div class="row end"><button class="primary" data-x="ok">閉じる</button></div>`);
  w.addEventListener('click',e=>{if(e.target.closest('[data-x=ok]'))closeSheet(w)});
}
if(ONLINE_OK&&new URLSearchParams(location.search).get('room')&&store.get('nimai-name')){
  connect();socket.emit('hello',{key:myKey,name:store.get('nimai-name')});socket.emit('join',{code:new URLSearchParams(location.search).get('room').toUpperCase()});
}else showHome();
