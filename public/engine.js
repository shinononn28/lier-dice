/* 二枚舌の酒場 ― ゲームエンジン（サーバーとブラウザで共通） */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.NimaiEngine=factory()})(typeof self!=='undefined'?self:this,function(){
'use strict';
const TEAM={red:'赤',blue:'青',rogue:'詐欺師'};
const CARDS={
  investigate:{name:'調査',desc:'1人を選び、陣営を見る',n:1},
  compare:{name:'照合',desc:'2人を選び、同じ陣営か見る',n:2},
  frame:{name:'濡れ衣',desc:'以後、自分を調べた人には陣営が逆に見える',n:0},
  wiretap:{name:'盗聴',desc:'1人を選び、その人の密談を読む',n:1},
  peek:{name:'のぞき',desc:'1人を選び、数ラウンドの間その人のダイスを見続ける（4人卓は2ラウンド、5・6人卓は3ラウンド）',n:1},
  swap:{name:'陣営交換',desc:'密談後のみ。1人と陣営をまるごと入れ替える（金貨は各自が持ったまま）',n:1,late:true},
  cheat:{name:'イカサマ',desc:'宣言中に使う。自分のダイス1個を好きな目に変える',n:0,die:true,biddingOnly:true},
  scapegoat:{name:'身代わり',desc:'このラウンド、ダウトで負けたら支払いを次の手番の人に押し付ける',n:0},
  double:{name:'賭け金倍',desc:'このラウンドの賭け金を2倍にする',n:0},
  matta:{name:'待った',desc:'自分の宣言がダウトされた瞬間に使う。公開前に自分のダイスを2個まで好きな目に変える',n:0,reaction:true},
};
const WEIGHTS={investigate:.15,compare:.1,frame:.12,wiretap:.08,peek:.08,swap:.1,cheat:.1,scapegoat:.09,double:.08,matta:.1};
const BOT_NAMES=['ガレス','ミレイ','ボルド','シオン','ルゥ','ヴェナ','トト','イルゼ'];
const PIPS={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
function dieHTML(f,cls=''){
  if(!f)return `<span class="die back ${cls}" role="img" aria-label="伏せたダイス"></span>`;
  let s='';for(let i=0;i<9;i++)s+=`<i class="${PIPS[f].includes(i)?'on':''}"></i>`;
  return `<span class="die ${cls}" role="img" aria-label="${f}の目">${s}</span>`;
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rnd=a=>a[Math.floor(Math.random()*a.length)];
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const sig=x=>1/(1+Math.exp(-x));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function comb(n,k){let r=1;for(let i=1;i<=k;i++)r=r*(n-k+i)/i;return r}
function tail(k,m,p=1/6){if(k<=0)return 1;if(k>m)return 0;let s=0;for(let i=k;i<=m;i++)s+=comb(m,i)*p**i*(1-p)**(m-i);return s}

function createGame(opts){
  const emit=opts.emit,speed=opts.speed||1;
  const T=Object.assign({turn:null,prep:null,matta:null,partner:null,mitsudan:null,accuse:null},opts.timeouts||{});
  const BONUS_GAP=opts.bonusGap??3,BONUS=opts.bonus??2,BOTCHAT=opts.botChat||'on';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms*speed));
  const raw=ms=>new Promise(r=>setTimeout(r,ms));
  const G={players:[],order:[],rounds:0,mid:0,round:0,bid:null,history:[],maxDecl:[0,0,0,0,0,0,0],mult:1,
    phase:'start',revealed:false,lastReveal:null,turn:null,mitsudanDone:false,threads:{},pendingTaps:[],cardQueue:[],
    pending:{},ready:new Set(),over:false,result:null,effects:[],review:[],allThreads:[]};
  let promptSeq=0,paused=0;

  /* ---- players ---- */
  const n=Math.max(opts.total||0,opts.humans.length);
  const names=shuffle(BOT_NAMES.filter(x=>!opts.humans.some(h=>h.name===x)));
  const ps=opts.humans.map(h=>({id:String(h.id),name:String(h.name).slice(0,10)||'名無し',isBot:false,connected:true}));
  for(let i=ps.length;i<n;i++)ps.push({id:'bot'+i,name:names.shift()||'CPU'+i,isBot:true,connected:true});
  const k=Math.floor(n/2),roles=[];for(let i=0;i<k;i++)roles.push('red','blue');if(n%2)roles.push('rogue');shuffle(roles);
  // 人数ごとの設定：配るカード枚数・使える枚数・のぞきの持続ラウンド
  const RULE={4:{deal:3,use:2,peek:2,exclude:['compare']},5:{deal:3,use:2,peek:3},6:{deal:4,use:3,peek:3}}[n]||{deal:3,use:2,peek:3};
  const DEAL=RULE.deal,USE=RULE.use,PEEK=RULE.peek;
  // 4人卓の照合は「照合しなかった1人を調査する」のと同じ情報になるので山札から抜く
  const total=DEAL*n;let deck=[];for(const t in WEIGHTS)if(!(RULE.exclude||[]).includes(t))for(let i=0;i<Math.round(WEIGHTS[t]*total);i++)deck.push(t);
  while(deck.length<total)deck.push('investigate');deck=shuffle(deck).slice(0,total);
  ps.forEach((p,i)=>{Object.assign(p,{team:roles[i],coins:10,dice:[],cardsUsed:0,usedThisRound:false,framed:false,scapegoat:false,peek:null,
    cards:deck.slice(i*DEAL,i*DEAL+DEAL).map(t=>({type:t,used:false,reserved:false})),ai:{lo:{},susp:{},results:[]},useRounds:[],revealed:[],myLog:[]});
    p.cover=p.team==='rogue'?rnd(['red','blue']):p.team;p.origTeam=p.team;});
  ps.forEach(p=>ps.forEach(q=>{if(q!==p){p.ai.lo[q.id]=0;p.ai.susp[q.id]=0}}));
  G.players=ps;G.parents=new Set();G.rule=RULE;G.rounds=n;G.mid=Math.ceil(n/2);

  const byId=id=>G.players.find(p=>p.id===String(id));
  const humans=()=>G.players.filter(p=>!p.isBot);
  const bots=()=>G.players.filter(p=>p.isBot);
  const others=p=>G.players.filter(q=>q!==p);
  const totalDice=()=>G.players.length*5;
  const roll=()=>Array.from({length:5},()=>1+Math.floor(Math.random()*6)).sort((a,b)=>a-b);
  const trueColor=p=>p.team==='rogue'?p.cover:p.team;
  const apparent=p=>{const t=trueColor(p);return p.framed?(t==='red'?'blue':'red'):t};

  /* ---- output ---- */
  const pub=(kind,html,extra)=>emit('*','log',Object.assign({kind,html},extra||{}));
  const sys=t=>pub('sys',esc(t));
  // 感想戦用の記録（ゲーム終了まで誰にも見せない）
  const TT=t=>TEAM[t];
  const rv=(cat,text,extra)=>G.review.push(Object.assign({round:G.round,phase:G.phase,cat,text},extra||{}));
  function rvClaim(sp,cl){
    if(cl.k==='self'){const real=sp.team;rv('claim',`${sp.name}「自分は${cl.red?'赤':'青'}」`,{truth:real!=='rogue'&&(real==='red')===cl.red,real:TT(real)});return}
    if(cl.k==='target'){const t=byId(cl.t);if(!t)return;rv('claim',`${sp.name}「${t.name}は${cl.red?'赤':'青'}」`,{truth:t.team!=='rogue'&&(t.team==='red')===cl.red,real:TT(t.team)})}
    if(cl.k==='pair'){const a=byId(cl.a),b=byId(cl.b);const same=a.team===b.team;rv('claim',`${sp.name}「${a.name}と${b.name}は${cl.same?'同じ':'別の'}陣営」`,{truth:same===cl.same,real:`${TT(a.team)}と${TT(b.team)}`})}
  }
  const pubPopup=(title,lines,except)=>humans().forEach(h=>{if(h!==except)emit(h.id,'popup',{title,lines})});
  const say=(p,t)=>pub('chat',`<b>${esc(p.name)}</b><span>${esc(t)}</span>`,{from:p.id});
  // CPUの発言：kind = claim（推理に関わる主張）/ banter（雑談・リアクション）/ reply（返事）
  const botOK=kind=>BOTCHAT==='on'||(BOTCHAT==='low'&&kind==='claim');
  const bsay=(p,t,kind)=>{if(!botOK(kind))return false;say(p,t);return true};
  function priv(p,text,isHtml){if(p.isBot)return;
    const label=`${G.round?`ラウンド${G.round}`:'開始時'}${G.phase==='mitsudan'?'・密談':''}`;
    emit(p.id,'log',{kind:'priv',html:`<span class="rd">${label}</span>${isHtml?text:esc(text)}`})}
  let stTimer=null;
  function sync(){if(stTimer)return;stTimer=setTimeout(()=>{stTimer=null;humans().forEach(p=>emit(p.id,'state',view(p)))},0)}
  async function untilFree(){while(paused>0)await raw(150)}

  /* ---- asking humans ---- */
  function ask(p,kind,data,ms){
    if(p.connected===false)ms=1500;
    return new Promise(res=>{
      const pd={kind,data:data||{},id:++promptSeq,deadline:ms?Date.now()+ms:null};
      pd.fin=v=>{if(G.pending[p.id]!==pd)return;clearTimeout(pd.t);delete G.pending[p.id];sync();res(v)};
      if(ms)pd.t=setTimeout(()=>pd.fin(null),ms);
      G.pending[p.id]=pd;sync();
    });
  }
  function respond(pid,kind,v){const pd=G.pending[String(pid)];if(pd&&pd.kind===kind)pd.fin(v===undefined?true:v)}
  function setConnected(pid,on){const p=byId(pid);if(!p)return;p.connected=on;
    const pd=G.pending[p.id];if(!on&&pd){clearTimeout(pd.t);pd.t=setTimeout(()=>pd.fin(null),1500)}sync()}

  /* ---- beliefs (bots) ---- */
  function loOf(o,id){return id===o.id?(trueColor(o)==='red'?6:-6):o.ai.lo[id]}
  function addLO(o,id,d){if(id===o.id||!o.isBot)return;o.ai.lo[id]=clamp(o.ai.lo[id]+d,-6,6)}
  function pTeammate(o,p){if(p===o)return 1;if(o.team==='rogue')return 0;const pr=sig(o.ai.lo[p.id]);return o.team==='red'?pr:1-pr}
  function pairEvidence(o,a,b,same,str){if(!o.isBot)return;const la=loOf(o,a),lb=loOf(o,b),s=same?1:-1;
    addLO(o,b,s*str*Math.tanh(la/2)*1.5);addLO(o,a,s*str*Math.tanh(lb/2)*1.5)}
  function applyClaim(o,sp,cl,scale=1){
    if(!o.isBot||o===sp)return;
    if(cl.k==='self'){addLO(o,sp.id,(cl.red?1:-1)*0.5*scale);return}
    const tp=o.team==='rogue'?0.4:pTeammate(o,sp),w=(0.25+1.2*(tp-0.5))*scale;
    if(cl.k==='target'){if(cl.t===o.id){if(cl.red!==(trueColor(o)==='red')&&!o.framed){pairEvidence(o,sp.id,o.id,false,0.8);o.ai.susp[sp.id]+=1}return}
      if(o.ai.lo[cl.t]!==undefined)addLO(o,cl.t,(cl.red?1:-1)*w*1.3)}
    if(cl.k==='pair')pairEvidence(o,cl.a,cl.b,cl.same,clamp(w,-0.4,1)*0.9);
  }
  const broadcastClaim=(sp,cl,scale=1)=>bots().forEach(o=>applyClaim(o,sp,cl,scale));
  function speakTruth(o,l){if(o.team==='rogue')return Math.random()<0.35;const tp=pTeammate(o,l);if(tp>0.6)return true;if(tp<0.4)return Math.random()<0.25;return Math.random()<0.6}
  function teamClaim(o,l,truth){if(truth)return trueColor(o);const x=loOf(o,l.id);return Math.abs(x)<0.3?rnd(['red','blue']):(x>0?'red':'blue')}
  function suspectClaim(o,l,truth){const pool=shuffle(G.players.filter(q=>q!==o&&q!==l)).sort((a,b)=>Math.abs(o.ai.lo[b.id])-Math.abs(o.ai.lo[a.id]));
    const t=pool[0];if(!t)return null;let red=o.ai.lo[t.id]>0||(o.ai.lo[t.id]===0&&Math.random()<.5);if(!truth)red=!red;return{t,red}}

  /* ---- dice logic ---- */
  const maxOf=f=>G.maxDecl[f]||0;
  const isValid=(c,f)=>Number.isInteger(c)&&Number.isInteger(f)&&f>=1&&f<=6&&c>maxOf(f)&&c<=totalDice();
  function knownDice(o){const a=[...o.dice],pk=o.peek;if(pk&&G.round<=pk.until&&pk.id!==o.id)a.push(...byId(pk.id).dice);return a}
  function probTrue(o,c,f,bonus=0){const kd=knownDice(o);return tail(c-kd.filter(d=>d===f).length-bonus,totalDice()-kd.length)}
  function candidates(){const out=[];for(let f=1;f<=6;f++)for(let c=maxOf(f)+1;c<=totalDice();c++)out.push([c,f]);return out}
  function botDecide(o,next){
    const tpN=pTeammate(o,next),cnt=[0,0,0,0,0,0,0];o.dice.forEach(d=>cnt[d]++);
    const target=Math.max(0.6,0.88-0.025*G.history.length)+(Math.random()-0.5)*0.12;
    let best=null,bs=-1e9;
    for(const[c,f]of candidates()){const pt=probTrue(o,c,f);if(pt<0.2)continue;
      const s=-Math.abs(pt-target)*1.6+cnt[f]*0.04+(0.5-tpN)*0.05*(f-3.5)-(1-pt)*f*0.015+(Math.random()-0.5)*0.15;
      if(s>bs){bs=s;best={c,f,pt}}}
    if(!G.bid)return best?{type:'bid',c:best.c,f:best.f}:{type:'bid',c:maxOf(1)+1,f:1};
    const pc=probTrue(o,G.bid.c,G.bid.f),tpB=pTeammate(o,G.bid.by);
    let th=0.22;if(tpB>0.65)th=0.1;if(!best||best.pt<0.45)th+=0.12;th+=(Math.random()-0.5)*0.08;
    if(!best||pc<th)return{type:'doubt'};
    return{type:'bid',c:best.c,f:best.f};
  }
  function observeBid(b,f,next){if(f>=5||f<=2)bots().forEach(o=>{if(o!==b)pairEvidence(o,b.id,next.id,f<=2,o===next?0.45:0.15)})}

  /* ---- cards ---- */
  const note=(p,text)=>{p.myLog.push({round:G.round,text})};
  function framedHit(t){priv(t,'……誰かに調べられた気配がする。濡れ衣が働いたようだ。');note(t,'誰かに調べられた（濡れ衣が働いた）')}
  const teamDesc=q=>`【${TEAM[q.team]}】${q.team==='rogue'?`（調べられると${TEAM[q.cover]}に見える。金貨単独1位かつ告発で吊られなければ単独勝利）`:''}`;
  function applyCard(p,ci,targets,extra,silent){
    const lens=new Map(humans().map(h=>[h,h.myLog.length])),name=CARDS[p.cards[ci].type].name;
    const type=p.cards[ci].type,t0=targets[0],before=t0?{team:t0.team}:null,myBefore=p.team,oldDie=extra?p.dice[extra.i]:null;
    const res=applyCardInner(p,ci,targets,extra,silent);
    let d='';
    switch(type){
      case 'investigate':d=`${t0.name}を調査 → ${res.red?'赤':'青'}に見えた`+((res.red?'red':'blue')!==trueColor(t0)?`（本当は${TT(t0.team)}・濡れ衣で反転）`:t0.team==='rogue'?'（本当は詐欺師）':'');break;
      case 'compare':{const[a,b]=targets;d=`${a.name}と${b.name}を照合 → ${res.same?'同じ':'別の'}陣営に見えた（本当は${TT(a.team)}と${TT(b.team)}）`;break}
      case 'frame':d='濡れ衣を仕込んだ';break;
      case 'wiretap':d=`${t0.name}の密談を盗聴`;break;
      case 'peek':d=`${t0.name}のダイスをのぞき（ラウンド${p.peek.until}まで）`;break;
      case 'swap':d=`${t0.name}と陣営交換（自分：${TT(myBefore)}→${TT(p.team)}、${t0.name}：${TT(before.team)}→${TT(t0.team)}）`;break;
      case 'cheat':d=`イカサマ：ダイスの${oldDie}を${extra.face}に`;break;
      case 'scapegoat':d='身代わりを仕込んだ';break;
      case 'double':d=`賭け金倍（×${G.mult}）`;break;
    }
    rv('card',`${p.name}：${d}`,{who:p.name,card:CARDS[type].name});
    humans().forEach(h=>{const add=h.myLog.slice(lens.get(h));if(add.length)emit(h.id,'popup',{private:true,title:h===p?`${name}を使った`:'カードの効果を受けた',lines:add.map(x=>x.text)})});
    return res;
  }
  function applyCardInner(p,ci,targets,extra,silent){
    const c=p.cards[ci];c.used=true;c.reserved=false;p.cardsUsed++;p.usedThisRound=true;p.useRounds.push(G.round);
    if(!silent&&G.mitsudanDone){sys(`${p.name}がカードを使った`);pubPopup('カード使用',[`${p.name}がカードを使った`],p)}
    const t=targets[0];
    switch(c.type){
      case 'investigate':{const seen=apparent(t);if(t.framed)framedHit(t);
        priv(p,`調査：${t.name} は【${TEAM[seen]}】に見えた`);note(p,`調査 → ${t.name}：【${TEAM[seen]}】に見えた`);
        if(p.isBot){addLO(p,t.id,seen==='red'?2.2:-2.2);p.ai.results.push({k:'inv',t:t.id,red:seen==='red'})}
        return{k:'inv',t,red:seen==='red'}}
      case 'compare':{const[a,b]=targets;const same=apparent(a)===apparent(b);if(a.framed)framedHit(a);if(b.framed)framedHit(b);
        priv(p,`照合：${a.name} と ${b.name} は【${same?'同じ陣営':'別の陣営'}】に見えた`);note(p,`照合 → ${a.name}・${b.name}：【${same?'同じ陣営':'別の陣営'}】`);
        if(p.isBot){pairEvidence(p,a.id,b.id,same,1.4);p.ai.results.push({k:'cmp',a:a.id,b:b.id,same})}
        return{k:'cmp',a,b,same}}
      case 'frame':p.framed=true;note(p,'濡れ衣を仕込んだ');priv(p,'濡れ衣を仕込んだ。これ以降、あなたを調査・照合した人には陣営が逆に見える。');return null;
      case 'wiretap':note(p,`盗聴 → ${t.name}${G.mitsudanDone?'：密談の中身を手帳に記録':'：密談後に中身が届く'}`);if(G.mitsudanDone)deliverTap(p,t);else{G.pendingTaps.push({p:p.id,t:t.id});priv(p,`盗聴：${t.name} の密談に耳を澄ませる。密談のあとに中身が届く。`)}return null;
      case 'peek':p.peek={id:t.id,until:G.round+PEEK-1};note(p,`のぞき → ${t.name}：ラウンド${G.round+PEEK-1}までダイスが見える`);
        priv(p,`のぞき：${esc(t.name)} のダイス（ラウンド${G.round+PEEK-1}まで毎回見える）<br>${t.dice.map(d=>dieHTML(d)).join(' ')}`,true);return null;
      case 'swap':{const pt=p.team,pc=p.cover;p.team=t.team;p.cover=t.cover;t.team=pt;t.cover=pc;
        priv(p,`陣営交換：${t.name}と陣営を入れ替えた。あなたは今${teamDesc(p)}`);note(p,`陣営交換 → ${t.name}：あなたは今【${TEAM[p.team]}】`);note(t,`何者かに陣営を入れ替えられた：今は【${TEAM[t.team]}】`);
        if(p.isBot&&p.team!=='rogue')addLO(p,t.id,trueColor(t)==='red'?3:-3);
        priv(t,`何者かに陣営を入れ替えられた！ あなたは今${teamDesc(t)}`);return null}
      case 'cheat':{const i=extra.i,old=p.dice[i];p.dice[i]=extra.face;priv(p,`イカサマ：ダイスの${old}を${extra.face}に変えた`);note(p,`イカサマ：${old}の目を${extra.face}に`);return null}
      case 'scapegoat':p.scapegoat=true;note(p,'身代わりを仕込んだ');priv(p,'身代わりを仕込んだ。このラウンド、ダウトで負けたら支払いは次の手番の人に回る。');return null;
      case 'double':G.mult*=2;pubPopup('賭け金倍',[`このラウンドの賭け金が${G.mult}倍になった！`],p);note(p,`賭け金倍：このラウンド×${G.mult}`);G.effects.push({round:G.round,text:`賭け金が${G.mult}倍に（使用者は${G.mitsudanDone?'通知参照':'非公開'}）`});sys(`このラウンドの賭け金が${G.mult}倍になった！`);return null;
    }
    return null;
  }
  function botPlanCard(p){
    if(p.usedThisRound||p.cardsUsed>=USE)return null;
    const need=USE-p.cardsUsed,left=G.rounds-G.round+1;
    if(Math.random()>(left<=need?1:need/left*0.85))return null;
    const oth=others(p);
    const pr=q=>q===p?(trueColor(p)==='red'?1:0):sig(p.ai.lo[q.id]);
    const red=G.players.reduce((s,q)=>s+q.coins*pr(q),0),blue=G.players.reduce((s,q)=>s+q.coins*(1-pr(q)),0);
    const mine=p.team==='red'?red:blue,theirs=p.team==='red'?blue:red,losing=p.team!=='rogue'&&mine<theirs-2;
    let swapT=null;
    if(G.mitsudanDone&&losing){swapT=[...oth].sort((a,b)=>(pTeammate(p,a)*20+a.coins)-(pTeammate(p,b)*20+b.coins))[0];if(swapT&&pTeammate(p,swapT)>=0.35)swapT=null}
    const base={frame:G.round<=2?3:1.2,investigate:G.mitsudanDone?1.6:2.6,compare:2,peek:G.round<=G.rounds-2?2.2:0.6,wiretap:G.mitsudanDone?2.2:1,
      swap:swapT?3+(theirs-mine)*0.15:-9,scapegoat:1.5,double:losing&&G.mitsudanDone?2.6:0.7};
    const avail=p.cards.map((c,i)=>({c,i,s:(base[c.type]??-9)+Math.random()*1.5}))
      .filter(x=>!x.c.used&&!x.c.reserved&&!CARDS[x.c.type].reaction&&!CARDS[x.c.type].biddingOnly&&!(CARDS[x.c.type].late&&!G.mitsudanDone)&&x.s>-5).sort((a,b)=>b.s-a.s);
    const pick=avail[0];if(!pick)return null;
    const unc=shuffle([...oth]).sort((a,b)=>Math.abs(p.ai.lo[a.id])-Math.abs(p.ai.lo[b.id]));
    let targets=[];
    switch(pick.c.type){
      case 'investigate':targets=[unc[0]];break;
      case 'compare':{const known=shuffle([...oth]).sort((a,b)=>Math.abs(p.ai.lo[b.id])-Math.abs(p.ai.lo[a.id]));targets=[known[0],unc.find(x=>x!==known[0])];break}
      case 'wiretap':targets=[rnd(oth)];break;
      case 'peek':{const i=G.order.indexOf(p);targets=[G.order[(i+1)%G.order.length]];break}
      case 'swap':targets=[swapT];break;
    }
    return{ci:pick.i,targets,extra:null};
  }
  function botAnnounce(p,res){
    if(!res||!botOK('claim')||Math.random()>0.55)return;
    const honest=Math.random()<(p.team==='rogue'?0.4:0.8);
    if(res.k==='inv'){const red=honest?res.red:!res.red;say(p,rnd([`${res.t.name}を調べた。${TEAM[red?'red':'blue']}だったぞ`,`調査結果、${res.t.name}は${TEAM[red?'red':'blue']}`]));broadcastClaim(p,{k:'target',t:res.t.id,red});rvClaim(p,{k:'target',t:res.t.id,red})}
    else{const same=honest?res.same:!res.same;say(p,`${res.a.name}と${res.b.name}を照合した。${same?'同じ陣営':'別の陣営'}だった`);broadcastClaim(p,{k:'pair',a:res.a.id,b:res.b.id,same});rvClaim(p,{k:'pair',a:res.a.id,b:res.b.id,same})}
  }
  function reactCard(user){if(G.mitsudanDone&&Math.random()<0.3){const o=rnd(bots().filter(x=>x!==user));o&&setTimeout(()=>bsay(o,rnd(['何を使った？','今のは何のカードだ','動いたな','……ほう']),'banter'),900*speed)}}
  function botCheat(p,act){
    const ci=p.cards.findIndex(c=>c.type==='cheat'&&!c.used);
    if(ci<0||p.cardsUsed>=USE||p.usedThisRound||Math.random()>0.45)return;
    let i=-1,face=0;
    if(act.type==='doubt'&&G.bid){i=p.dice.findIndex(d=>d===G.bid.f);face=G.bid.f===1?2:1}
    else if(act.type==='bid'){i=p.dice.findIndex(d=>d!==act.f);face=act.f}
    if(i<0)return;applyCard(p,ci,[],{i,face});
  }
  function botMatta(b,c,f){
    if(probTrue(b,c,f)>=0.5)return null;
    const idx=b.dice.map((d,i)=>d!==f?i:-1).filter(i=>i>=0);
    for(let k=1;k<=Math.min(2,idx.length);k++)if(probTrue(b,c,f,k)>=0.55)return idx.slice(0,k).map(i=>({i,face:f}));
    return null;
  }
  async function resolvePrepCards(){
    bots().forEach(p=>{const plan=botPlanCard(p);if(plan){p.usedThisRound=true;p.cards[plan.ci].reserved=true;G.cardQueue.push({p,...plan})}});
    const q=G.cardQueue;G.cardQueue=[];if(!q.length)return;
    if(G.mitsudanDone){const nm=shuffle(q.map(x=>x.p.name));sys(`カードを使った：${nm.join('、')}`);pubPopup('カード使用',[`${nm.join('、')}がカードを使った`])}
    const ty=x=>x.p.cards[x.ci].type;
    const results=[...q.filter(x=>ty(x)==='frame'),...shuffle(q.filter(x=>ty(x)!=='frame'&&ty(x)!=='swap')),...q.filter(x=>ty(x)==='swap')]
      .map(x=>[x.p,applyCard(x.p,x.ci,x.targets,x.extra,true)]);
    sync();
    const bs=bots();if(G.mitsudanDone&&bs.length&&Math.random()<0.4)bsay(rnd(bs),rnd(['一斉に動いたな','何を仕込んだ？','怪しい手が多いな']),'banter');
    for(const[p,res]of shuffle(results))if(p.isBot&&res){await sleep(500);botAnnounce(p,res)}
  }

  /* ---- human actions ---- */
  function action(pid,a){
    const p=byId(pid);if(!p||p.isBot||!a||a.type!=='card')return;
    const ci=a.ci|0,c=p.cards[ci];if(!c||c.used||c.reserved)return;
    const def=CARDS[c.type];
    if(def.reaction||!(G.phase==='prep'||G.phase==='bidding')||G.revealed)return;
    if(p.usedThisRound||p.cardsUsed>=USE)return;
    if(def.late&&!G.mitsudanDone)return;
    if(def.biddingOnly&&G.phase!=='bidding')return;
    const targets=(Array.isArray(a.targets)?a.targets:[]).map(byId);
    if(targets.length!==def.n||targets.some(t=>!t||t===p)||new Set(targets).size!==targets.length)return;
    let extra=null;
    if(def.die){const i=a.i|0,face=a.face|0;if(i<0||i>4||face<1||face>6)return;extra={i,face}}
    if(G.phase==='prep'){c.reserved=true;p.usedThisRound=true;G.cardQueue.push({p,ci,targets,extra});sync();return}
    applyCard(p,ci,targets,extra);sync();reactCard(p);
  }
  function parseClaims(text,sp){
    const out=[];
    G.players.forEach(p=>{if(p===sp)return;const i=text.indexOf(p.name);if(i<0)return;
      const seg=text.slice(i+p.name.length,i+p.name.length+10),r=/赤/.test(seg),b=/青/.test(seg);if(r!==b)out.push({k:'target',t:p.id,red:r})});
    const m=text.match(/(私|俺|僕|自分|わたし|あたし|おれ|ぼく|うち)[はがも]?(赤|青)/);if(m)out.push({k:'self',red:m[2]==='赤'});
    return out;
  }
  function replyTo(o,t,cls,from){
    const about=cls.find(c=>c.k==='target'&&c.t===o.id);
    if(about){const correct=about.red===(trueColor(o)==='red'),truth=speakTruth(o,from);
      return truth?(correct?rnd(['……さあね','否定はしないでおく']):rnd(['違うね','的外れだな'])):(correct?rnd(['違うね','見当違いだよ']):rnd(['さあ、どうだろうね','ご想像にお任せする']))}
    if(/[?？]/.test(t))return rnd(['さあね','それは言えないな','どうだろうな','タダでは教えられないな']);
    return rnd(['なるほど','ほう','覚えておくよ','へえ','ふふ']);
  }
  function chat(pid,text){
    const p=byId(pid);if(!p)return;const t=String(text||'').trim().slice(0,100);if(!t)return;
    say(p,t);if(G.over)return;
    const cls=parseClaims(t,p);cls.forEach(c=>{broadcastClaim(p,c,1);rvClaim(p,c)});
    const named=bots().filter(b=>t.includes(b.name));const r=named.length?rnd(named):(Math.random()<0.3?rnd(bots()):null);
    if(r)setTimeout(()=>bsay(r,replyTo(r,t,cls,p),'reply'),(900+Math.random()*900)*speed);
  }

  /* ---- round ---- */
  function roundChatter(){
    if(G.round<2||Math.random()<0.4||!bots().length||!botOK('claim'))return;const p=rnd(bots());
    const t=shuffle(others(p)).sort((a,b)=>Math.abs(p.ai.lo[b.id])-Math.abs(p.ai.lo[a.id]))[0];
    if(Math.abs(p.ai.lo[t.id])<0.4){bsay(p,rnd(['まだ誰が誰だか見えないな','そろそろ誰か正体を明かしてくれよ','静かなやつほど怪しいんだよな']),'banter');return}
    let red=p.ai.lo[t.id]>0;if(Math.random()>(p.team==='rogue'?0.4:0.75))red=!red;
    say(p,`${t.name}は${TEAM[red?'red':'blue']}だと睨んでる`);broadcastClaim(p,{k:'target',t:t.id,red},0.7);rvClaim(p,{k:'target',t:t.id,red});
  }
  const validAct=a=>a&&((a.type==='doubt'&&G.bid)||(a.type==='bid'&&isValid(a.c,a.f)));
  async function playRound(r){
    Object.assign(G,{round:r,bid:null,revealed:false,lastReveal:null,history:[],maxDecl:[0,0,0,0,0,0,0],mult:1,phase:'prep',turn:null});
    G.players.forEach(p=>{p.dice=roll();p.usedThisRound=false;p.scapegoat=false});
    // 手番順を丸ごとシャッフルし、まだ親をやっていない人のうち一番前にいる人を先頭（親）に移す
    const sh=shuffle([...G.players]);let fi=sh.findIndex(p=>!G.parents.has(p));if(fi<0)fi=0;
    const first=sh.splice(fi,1)[0];G.order=[first,...sh];G.parents.add(first);(G.parentLog=G.parentLog||{})[r]=first.name;
    sys(`ラウンド${r} 開始 ｜ 親は${first.name} ｜ 手番順：${G.order.map(p=>p.name).join(' → ')}`);
    humans().forEach(h=>{const pk=h.peek;if(pk&&r<=pk.until){const t=byId(pk.id);priv(h,`のぞき：${esc(t.name)} の今回のダイス<br>${t.dice.map(d=>dieHTML(d)).join(' ')}`,true)}});
    roundChatter();
    G.ready=new Set();sync();
    await Promise.all(humans().map(async h=>{await ask(h,'ready',{},T.prep);G.ready.add(h.id);sync()}));
    G.phase='bidding';
    await resolvePrepCards();sync();
    let i=0;
    while(true){
      const p=G.order[i%G.order.length],next=G.order[(i+1)%G.order.length];G.turn=p;sync();
      let act;
      if(!p.isBot){act=await ask(p,'turn',{},T.turn);if(!validAct(act)){act=botDecide(p,next);if(!validAct(act))act={type:'doubt'}}
        if(act.type==='doubt'&&!G.bid)act=botDecide(p,next)}
      else{await sleep(650+Math.random()*700);await untilFree();act=botDecide(p,next);botCheat(p,act);sync()}
      if(act.type==='bid'){
        G.bid={c:act.c,f:act.f,by:p};G.maxDecl[act.f]=act.c;G.history.push({n:p.name,c:act.c,f:act.f});
        pub('bid',`<b>${esc(p.name)}</b><span>${act.c}個の</span>${dieHTML(act.f)}`);observeBid(p,act.f,next);
        if(next.isBot&&act.f>=5&&Math.random()<.35)setTimeout(()=>bsay(next,rnd(['強気だねぇ',`その${act.f}、本当にあるのか？`,'重いのを押し付けてくるな','ほう…']),'banter'),400*speed);
        else if(next.isBot&&act.f<=2&&Math.random()<.15)setTimeout(()=>bsay(next,rnd(['優しいねぇ','軽いな、助かるよ']),'banter'),400*speed);
        i++;
      }else{await resolveDoubt(p);break}
    }
    G.turn=null;sync();
  }
  async function resolveDoubt(ch){
    const b=G.bid.by,{c,f}=G.bid;
    if(ch.isBot){if(!bsay(ch,rnd(['ダウトだ！','それは無いな','嘘だね']),'banter'))sys(`${ch.name}がダウト！`)}else say(ch,'ダウト！');
    bots().forEach(o=>pairEvidence(o,ch.id,b.id,false,0.2));
    G.phase='reveal';G.turn=null;sync();
    let matta=null;
    const mi=b.cards.findIndex(x=>x.type==='matta'&&!x.used&&!x.reserved);
    if(mi>=0&&b.cardsUsed<USE){
      let ch2=null;
      if(b.isBot)ch2=botMatta(b,c,f);
      else{const v=await ask(b,'matta',{c,f,by:ch.name},T.matta);ch2=v&&Array.isArray(v.changes)?v.changes:null}
      if(ch2){const seen=new Set();ch2=ch2.map(x=>({i:x.i|0,face:x.face|0})).filter(x=>x.i>=0&&x.i<5&&x.face>=1&&x.face<=6&&!seen.has(x.i)&&seen.add(x.i)).slice(0,2)}
      if(ch2&&ch2.length){const card=b.cards[mi];card.used=true;b.cardsUsed++;
        const changed=ch2.map(x=>x.i);ch2.forEach(x=>{b.dice[x.i]=x.face});matta={name:b.name,n:ch2.length,changed};b.useRounds.push(G.round);b.revealed.push('待った');note(b,`待った：ダイスを${ch2.length}個変えた`);G.effects.push({round:G.round,text:`${b.name}の待った！（ダイス${ch2.length}個変更）`});
        rv('card',`${b.name}：待った（ダイス${ch2.length}個を変更）`,{who:b.name,card:'待った'});
        sys(`${b.name}の「待った！」 ダイスを${ch2.length}個変えた`)}
    }
    const actual=G.players.reduce((s,p)=>s+p.dice.filter(d=>d===f).length,0),truth=actual>=c;
    const loser=truth?ch:b,winner=truth?b:ch,amount=f*G.mult,bonus=!truth&&c-actual>=BONUS_GAP?BONUS:0;
    let payer=loser,sg=null;
    if(loser.scapegoat){const idx=G.order.indexOf(loser);
      for(let k=1;k<G.order.length;k++){const q=G.order[(idx+k)%G.order.length];if(q!==winner&&q!==loser){payer=q;break}}
      if(payer!==loser){sg={from:loser.name,to:payer.name};loser.revealed.push('身代わり');G.effects.push({round:G.round,text:`身代わり発動：${loser.name}の支払いを${payer.name}がかぶった`})}}
    emit('*','doubt',{ch:ch.name,by:b.name,c,f,mult:G.mult,truth,bonus,actual,loser:loser.name,payer:payer.name,winner:winner.name,ids:{ch:ch.id,by:b.id,loser:loser.id,payer:payer.id,winner:winner.id},amount,matta,sg,speed,
      rows:G.order.map(p=>({name:p.name,dice:[...p.dice],changed:matta&&p===b?matta.changed:[]}))});
    const nd=G.players.length*5;
    await sleep(1000+(matta?1200:0)+150*nd+220*G.players.length+700+2600);
    pub('rv',G.order.map(p=>`<div class="r"><b>${esc(p.name)}</b>${p.dice.map(d=>dieHTML(d,d===f?'hit':'dim')).join('')}</div>`).join(''));
    rv('doubt',`${ch.name}が${b.name}の「${c}個の${f}」をダウト → 実際${actual}個で${truth?'本当':'嘘'}。${payer.name}→${winner.name} ${amount+bonus}枚${sg?'（身代わり）':''}${bonus?'（看破ボーナス込み）':''}`);
    sys(`「${f}」は${actual}個。宣言は${truth?'本当':'嘘'}だった！ ${loser.name}の負け`);
    if(sg)sys(`身代わり発動！ ${loser.name}の支払いを${payer.name}がかぶった`);
    sys(`${payer.name} → ${winner.name}に金貨${amount}枚${G.mult>1?`（賭け金${G.mult}倍）`:''}`);
    payer.coins-=amount+bonus;winner.coins+=amount+bonus;
    if(bonus){sys(`看破ボーナス！ 宣言が実際より${c-actual}個も多かった。${payer.name}からさらに金貨${bonus}枚を奪取`);
      G.effects.push({round:G.round,text:`看破ボーナス：${ch.name}が${payer.name}から+${bonus}（宣言${c}個／実際${actual}個）`})}
    G.lastReveal={f,c,actual,truth,by:b.name,loser:loser.name,payer:payer.name,amount:amount+bonus};G.revealed=true;sync();
    if(loser.isBot&&Math.random()<.6)bsay(loser,rnd(['くっ…','やられた','次は取り返す','読まれてたか']),'banter');
    else if(winner.isBot&&Math.random()<.4)bsay(winner,rnd(['読み通り','ごちそうさま','悪いね']),'banter');
    if(sg&&payer.isBot)setTimeout(()=>bsay(payer,rnd(['なんで俺が払うんだ！','身代わりだと…？','覚えてろよ']),'banter'),500*speed);
    await sleep(900);
  }

  /* ---- 密談 ---- */
  const QS={team:'どっち側？',cards:'使ったカードは？',sus:'誰が怪しい？',res:'何か調べた？'};
  const threadKey=(a,b)=>[a.id,b.id].sort().join('|');
  const threadsOf=p=>Object.values(G.threads).filter(t=>t.a===p.id||t.b===p.id);
  function pushT(th,sp,text,claims=[]){
    th.log.push({from:sp.id,name:sp.name,text,claims});
    const other=byId(th.a===sp.id?th.b:th.a);claims.forEach(c=>applyClaim(other,sp,c,1.4));sync();
  }
  function shareResult(o,r,truth,th){
    if(r.k==='inv'){const red=truth?r.red:!r.red;pushT(th,o,`${byId(r.t).name}を調べたら${TEAM[red?'red':'blue']}だった`,[{k:'target',t:r.t,red}])}
    else{const same=truth?r.same:!r.same;pushT(th,o,`${byId(r.a).name}と${byId(r.b).name}は${same?'同じ陣営':'別の陣営'}だった`,[{k:'pair',a:r.a,b:r.b,same}])}
  }
  function botAnswer(o,h,q,th){
    const truth=speakTruth(o,h);
    if(q==='team'){const c=teamClaim(o,h,truth);pushT(th,o,`${TEAM[c]}だ`,[{k:'self',red:c==='red'}])}
    else if(q==='cards'){const used=o.cards.filter(c=>c.used).map(c=>CARDS[c.type].name);const nm=truth?used:used.map(()=>rnd(Object.values(CARDS)).name);pushT(th,o,nm.length?`${nm.join('と')}を使った`:'まだ何も使ってない')}
    else if(q==='sus'){const s=suspectClaim(o,h,truth);if(!s)pushT(th,o,'まだ見当がつかない');else pushT(th,o,`${s.t.name}は${TEAM[s.red?'red':'blue']}だと思う`,[{k:'target',t:s.t.id,red:s.red}])}
    else if(q==='res'){const r=o.ai.results[o.ai.results.length-1];if(!r)pushT(th,o,truth?'何も調べてない':rnd(['調べたけど言えないな','何も調べてない']));else shareResult(o,r,truth,th)}
  }
  function genBotPair(a,b,th){
    pushT(th,a,'で、どっち側だ？');
    const tb=teamClaim(b,a,speakTruth(b,a));pushT(th,b,`${TEAM[tb]}だよ`,[{k:'self',red:tb==='red'}]);
    const ta=teamClaim(a,b,speakTruth(a,b));pushT(th,a,ta===tb?`奇遇だな、こっちも${TEAM[ta]}だ`:`こっちは${TEAM[ta]}だ`,[{k:'self',red:ta==='red'}]);
    const s=suspectClaim(a,b,speakTruth(a,b));if(s)pushT(th,a,`${s.t.name}は${TEAM[s.red?'red':'blue']}だと思う`,[{k:'target',t:s.t.id,red:s.red}]);
    const r=b.ai.results[b.ai.results.length-1];if(r)shareResult(b,r,speakTruth(b,a),th);else pushT(th,b,rnd(['覚えておくよ','ふむ、参考にする']));
  }
  function dm(pid,d){
    const p=byId(pid);if(!p||G.phase!=='mitsudan'||!d)return;const th=G.threads[d.key];if(!th||(th.a!==p.id&&th.b!==p.id))return;
    const o=byId(th.a===p.id?th.b:th.a);
    if(d.ans&&th.needAnswer===p.id){th.needAnswer=null;
      if(d.ans==='none'){pushT(th,p,'言えないね');if(o.isBot)setTimeout(()=>pushT(th,o,rnd(['慎重だな','ふうん、まあいい'])),500*speed);return}
      const red=d.ans==='red';pushT(th,p,red?'赤だ':'青だ',[{k:'self',red}]);
      if(o.isBot)setTimeout(()=>{const c=teamClaim(o,p,speakTruth(o,p));pushT(th,o,c===(red?'red':'blue')?`奇遇だな、こっちも${TEAM[c]}だ`:`そうか。こっちは${TEAM[c]}だ`,[{k:'self',red:c==='red'}])},600*speed);return}
    if(d.q&&QS[d.q]&&o.isBot&&!th.asked.includes(d.q)){th.asked.push(d.q);pushT(th,p,QS[d.q]);setTimeout(()=>botAnswer(o,p,d.q,th),600*speed);return}
    const t=String(d.text||'').trim().slice(0,100);if(!t)return;
    const cls=parseClaims(t,p);pushT(th,p,t,cls);
    if(o.isBot)setTimeout(()=>pushT(th,o,cls.length?rnd(['なるほど、覚えておく','本当か？','ふむ…']):rnd(['ほう','それで？','まあ、そうかもな'])),600*speed);
  }
  function deliverTap(p,t){
    const ths=threadsOf(t);
    if(!p.isBot)priv(p,`盗聴：${t.name}の密談\n`+(ths.length?ths.map(th=>th.log.map(e=>`${e.name}「${e.text}」`).join('\n')).join('\n―\n'):'（誰とも話していなかった）'));
    else ths.forEach(th=>th.log.forEach(e=>{if(e.from!==p.id)(e.claims||[]).forEach(c=>applyClaim(p,byId(e.from),c,1.1))}));
  }
  async function mitsudan(){
    Object.assign(G,{phase:'mitsudan',bid:null,revealed:false,history:[],turn:null,threads:{}});sync();sys('— 密談の時間 —');
    const picks={};
    await Promise.all(humans().map(async h=>{const v=await ask(h,'partner',{},T.partner);const t=byId(v);picks[h.id]=t&&t!==h?t:rnd(others(h))}));
    bots().forEach(b=>{picks[b.id]=rnd(others(b))});
    for(const[aid,t]of Object.entries(picks)){const a=byId(aid),key=threadKey(a,t);if(!G.threads[key])G.threads[key]={key,a:a.id,b:t.id,log:[],asked:[],needAnswer:null}}
    for(const th of Object.values(G.threads)){const a=byId(th.a),b=byId(th.b);
      if(a.isBot&&b.isBot)genBotPair(a,b,th);
      else if(a.isBot||b.isBot){const bot=a.isBot?a:b,hu=a.isBot?b:a;pushT(th,bot,rnd(['で、あんたはどっち側だい？','単刀直入に聞く。どっちの陣営だ？']));th.needAnswer=hu.id}}
    sync();
    await Promise.all(humans().map(h=>ask(h,'mitsudan',{},T.mitsudan)));
    G.allThreads=Object.values(G.threads).map(th=>({a:byId(th.a).name,b:byId(th.b).name,log:th.log.map(e=>{const sp=byId(e.from);
      const cl=(e.claims||[]).map(c=>{const n0=G.review.length;rvClaim(sp,c);const r=G.review.length>n0?G.review.pop():null;return r?{truth:r.truth,real:r.real}:null}).filter(Boolean);return{name:e.name,text:e.text,check:cl}})}));
    humans().forEach(h=>threadsOf(h).forEach(th=>{const o=byId(th.a===h.id?th.b:th.a);
      priv(h,`密談：${o.name}との会話\n`+th.log.map(e=>`${e.name}「${e.text}」`).join('\n'))}));
    G.mitsudanDone=true;
    sys(`前半のカード使用数を公開：${G.players.map(p=>`${p.name} ${p.cardsUsed}枚`).join('、')}`);
    G.pendingTaps.forEach(x=>deliverTap(byId(x.p),byId(x.t)));G.pendingTaps=[];
    G.phase='between';sync();
  }

  /* ---- 告発 ---- */
  const accuseOpts=p=>G.players.length%2===1&&p.team!=='rogue'?['red','blue','rogue']:['red','blue'];
  function botGuesses(o){
    const oth=others(o),g={};
    oth.forEach(q=>{const l=o.isBot?o.ai.lo[q.id]:0;g[q.id]=l>0?'red':l<0?'blue':rnd(['red','blue'])});
    if(G.players.length%2===1&&o.team!=='rogue'&&o.isBot){
      const kk=Math.floor(G.players.length/2),cnt={red:0,blue:0};cnt[o.team]++;oth.forEach(q=>cnt[g[q.id]]++);
      const pool=cnt.red>kk?oth.filter(q=>g[q.id]==='red'):cnt.blue>kk?oth.filter(q=>g[q.id]==='blue'):[...oth];
      pool.sort((a,b)=>(Math.abs(o.ai.lo[a.id])-o.ai.susp[a.id]*0.6)-(Math.abs(o.ai.lo[b.id])-o.ai.susp[b.id]*0.6));
      if(pool[0])g[pool[0].id]='rogue';
    }
    return g;
  }
  async function accusation(){
    Object.assign(G,{phase:'accuse',turn:null,bid:null,revealed:false,history:[]});sync();sys('— 告発の時間 —');
    const guesses={};
    await Promise.all(humans().map(async h=>{const v=await ask(h,'accuse',{opts:accuseOpts(h)},T.accuse);const g=botGuesses(h);
      if(v&&typeof v==='object')others(h).forEach(q=>{if(accuseOpts(h).includes(v[q.id]))g[q.id]=v[q.id]});guesses[h.id]=g}));
    bots().forEach(b=>{guesses[b.id]=botGuesses(b)});
    G.players.forEach(p=>{let ok=0;for(const id in guesses[p.id])if(guesses[p.id][id]===byId(id).team)ok++;p.correct=ok;p.coins+=ok});
    const rogue=G.players.find(p=>p.team==='rogue');let exposed=false;
    if(rogue){rogue.votes=G.players.filter(p=>p!==rogue&&guesses[p.id][rogue.id]==='rogue').length;exposed=rogue.votes>(G.players.length-1)/2}
    const sum=t=>G.players.filter(p=>p.team===t).reduce((s,p)=>s+p.coins,0),red=sum('red'),blue=sum('blue');
    let winner;
    if(rogue&&!exposed&&G.players.every(p=>p===rogue||rogue.coins>p.coins))winner='rogue';else winner=red>blue?'red':blue>red?'blue':'draw';
    const head=winner==='draw'?'引き分け':winner==='rogue'?`詐欺師 ${rogue.name} の単独勝利`:`${TEAM[winner]}陣営の勝利`;
    G.result={winner,head,red,blue,rogue:rogue?{name:rogue.name,coins:rogue.coins,votes:rogue.votes,exposed}:null,
      rows:G.players.map(p=>({id:p.id,name:p.name,team:p.team,origTeam:p.origTeam,coins:p.coins,correct:p.correct,cards:p.cards.map(c=>({name:CARDS[c.type].name,used:c.used}))}))};
    G.over=true;G.phase='over';sys(`— ${head} —`);sync();
  }

  /* ---- view ---- */
  function view(p){
    const pd=G.pending[p.id],pk=p.peek&&G.round<=p.peek.until?byId(p.peek.id):null;
    return{
      you:p.id,phase:G.phase,round:G.round,rounds:G.rounds,mid:G.mid,mitsudanDone:G.mitsudanDone,over:G.over,
      totalDice:totalDice(),bid:G.bid?{c:G.bid.c,f:G.bid.f,by:G.bid.by.name}:null,history:G.history,maxDecl:G.maxDecl,mult:G.mult,
      turn:G.turn?G.turn.id:null,lastReveal:G.revealed?G.lastReveal:null,
      order:(G.order.length?G.order:G.players).map(q=>({id:q.id,name:q.name,coins:q.coins,isBot:q.isBot,connected:q.connected,
        cardsUsed:(G.mitsudanDone||q===p||G.over)?q.cardsUsed:null,team:(q===p||G.over)?q.team:null})),
      me:{dice:p.dice,team:p.team,cover:p.cover,framed:p.framed,scapegoat:p.scapegoat,cards:p.cards.map(c=>({type:c.type,used:c.used,reserved:c.reserved})),
        cardsUsed:p.cardsUsed,usedThisRound:p.usedThisRound,peek:pk?{name:pk.name,dice:pk.dice,until:p.peek.until}:null},
      prompt:pd?{kind:pd.kind,id:pd.id,deadline:pd.deadline,data:pd.data}:null,
      ready:G.phase==='prep'?{n:G.ready.size,of:humans().length}:null,
      threads:G.phase==='mitsudan'?threadsOf(p).map(th=>{const o=byId(th.a===p.id?th.b:th.a);
        return{key:th.key,with:{id:o.id,name:o.name,isBot:o.isBot},log:th.log.map(e=>({from:e.from,name:e.name,text:e.text})),asked:th.asked,needAnswer:th.needAnswer===p.id}}):[],
      result:G.result,rule:G.rule,review:G.over?{events:G.review,threads:G.allThreads,rounds:G.rounds,mid:G.mid,parents:G.parentLog}:null,
      cardlog:{mid:G.mid,mitsudanDone:G.mitsudanDone,effects:G.effects,mine:p.myLog,
        players:G.players.map(q=>{const open=G.mitsudanDone||q===p||G.over;
          return{name:q.name,me:q===p,first:open?q.useRounds.filter(r=>r<=G.mid).length:null,
            late:(q===p||G.over||G.mitsudanDone)?q.useRounds.filter(r=>r>G.mid):[],revealed:q.revealed}})},
    };
  }

  function intro(){
    rv('start',`配役：${G.players.map(p=>`${p.name}=${TT(p.team)}`).join('、')}`);
    G.players.forEach(p=>rv('hand',`${p.name}の手札：${p.cards.map(c=>CARDS[c.type].name).join('・')}`));
    sys('— 酒場の卓に着いた —');
    humans().forEach(h=>{
      priv(h,h.team==='rogue'?`あなたは【詐欺師】。調べられると【${TEAM[h.cover]}】に見える。\n金貨が単独1位で、最後の告発で過半数に名指しされなければ単独勝利。`
        :`あなたは【${TEAM[h.team]}】陣営。仲間が誰かはわからない。\n最後に${TEAM[h.team]}陣営の金貨合計が多ければ勝ち。`);
      priv(h,`配られたカード：${h.cards.map(c=>CARDS[c.type].name).join('・')}\nこのうち${USE}枚を、好きなラウンドで1枚ずつ使える。`);
    });
  }
  async function start(){
    try{intro();sync();
      for(let r=1;r<=G.rounds;r++){await playRound(r);if(r===G.mid)await mitsudan()}
      await accusation();
    }catch(e){console.error(e);sys('エラーが起きた：'+e.message)}
  }
  return{start,respond,action,chat,dm,setConnected,pause:d=>{paused=Math.max(0,paused+d)},view:pid=>{const p=byId(pid);return p?view(p):null},isOver:()=>G.over};
}
return{createGame,CARDS,TEAM,dieHTML,esc};
});
