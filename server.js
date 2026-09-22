// 二枚舌の酒場 ― オンライン対戦サーバー
const path=require('path');
const http=require('http');
const express=require('express');
const {Server}=require('socket.io');
const {createGame}=require('./public/engine.js');

const PORT=process.env.PORT||3000;
const app=express();
app.use(express.static(path.join(__dirname,'public')));
app.get('/healthz',(req,res)=>res.send('ok'));
const server=http.createServer(app);
const io=new Server(server);

const TIMEOUTS={turn:60000,prep:45000,matta:15000,partner:30000,mitsudan:120000,accuse:90000};
const rooms=new Map();
const clean=s=>String(s||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,8)||'名無し';
function genCode(){const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let c;do{c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join('')}while(rooms.has(c));return c}
function info(r,key){return{code:r.code,n:r.n,started:!!r.game,isHost:r.host===key,
  members:r.members.map(m=>({name:m.name,host:m.key===r.host,connected:m.connected}))}}
function pushRoom(r){r.members.forEach(m=>m.socket&&m.socket.emit('room',info(r,m.key)))}
function uniqueName(r,key,name){let n=name,i=2;while(r.members.some(m=>m.key!==key&&m.name===n))n=name.slice(0,6)+i++;return n}

function startGame(r){
  r.logs={};r.members.forEach(m=>{r.logs[m.key]=[]});
  const emit=(to,type,data)=>{
    const targets=to==='*'?r.members:r.members.filter(m=>m.key===to);
    if(type==='log')targets.forEach(m=>{const L=r.logs[m.key]||(r.logs[m.key]=[]);L.push(data);if(L.length>600)L.shift()});
    targets.forEach(m=>m.socket&&m.socket.emit(type,data));
  };
  r.game=createGame({humans:r.members.map(m=>({id:m.key,name:m.name})),total:Math.max(r.n,r.members.length),speed:1,emit,timeouts:TIMEOUTS});
  pushRoom(r);r.game.start();
}
function cleanupLater(r){clearTimeout(r.cleanup);r.cleanup=setTimeout(()=>{if(r.members.every(m=>!m.connected))rooms.delete(r.code)},30*60*1000)}

io.on('connection',sock=>{
  let me=null,room=null;
  sock.on('hello',d=>{me={key:String(d&&d.key||sock.id).slice(0,64),name:clean(d&&d.name)}});
  function join(r){
    if(!me)return;
    let m=r.members.find(x=>x.key===me.key);
    if(!m){
      if(r.game)return sock.emit('errorMsg','このルームはゲーム中なので途中参加できない');
      if(r.members.length>=6)return sock.emit('errorMsg','ルームが満員（6人まで）');
      m={key:me.key};r.members.push(m);
    }
    if(!r.game)m.name=uniqueName(r,me.key,me.name);
    if(room&&room!==r)leave();
    m.socket=sock;m.connected=true;room=r;sock.join(r.code);clearTimeout(r.cleanup);
    pushRoom(r);
    if(r.game){sock.emit('logs',r.logs[me.key]||[]);r.game.setConnected(me.key,true);const v=r.game.view(me.key);if(v)sock.emit('state',v)}
  }
  function leave(){
    if(!room)return;const r=room;room=null;sock.leave(r.code);
    const m=r.members.find(x=>x.key===me.key);if(!m)return;
    if(r.game){m.connected=false;m.socket=null;r.game.setConnected(me.key,false)}
    else{r.members=r.members.filter(x=>x!==m);if(r.host===m.key&&r.members[0])r.host=r.members[0].key}
    if(!r.members.length)rooms.delete(r.code);else{pushRoom(r);if(r.members.every(x=>!x.connected))cleanupLater(r)}
  }
  sock.on('create',d=>{if(!me)return;const r={code:genCode(),host:me.key,n:[4,5,6].includes(d&&d.n)?d.n:5,members:[],game:null,logs:{}};rooms.set(r.code,r);join(r)});
  sock.on('join',d=>{const r=rooms.get(String(d&&d.code||'').toUpperCase());if(!r)return sock.emit('errorMsg','ルームが見つからない');join(r)});
  sock.on('settings',d=>{if(room&&!room.game&&room.host===me.key&&[4,5,6].includes(d&&d.n)){room.n=d.n;pushRoom(room)}});
  sock.on('start',()=>{if(room&&!room.game&&room.host===me.key)startGame(room)});
  sock.on('rematch',()=>{if(room&&room.game&&room.host===me.key&&room.game.isOver()){room.game=null;room.logs={};
    room.members=room.members.filter(m=>m.connected);pushRoom(room)}});
  sock.on('leave',leave);
  sock.on('respond',d=>{if(room&&room.game&&d)room.game.respond(me.key,d.kind,d.value)});
  sock.on('action',d=>{if(room&&room.game)room.game.action(me.key,d)});
  sock.on('chat',t=>{if(room&&room.game)room.game.chat(me.key,t)});
  sock.on('dm',d=>{if(room&&room.game)room.game.dm(me.key,d)});
  sock.on('disconnect',()=>{
    if(!room||!me)return;const r=room;const m=r.members.find(x=>x.key===me.key);
    if(!m||m.socket!==sock)return;
    if(r.game){m.connected=false;m.socket=null;r.game.setConnected(me.key,false);pushRoom(r);if(r.members.every(x=>!x.connected))cleanupLater(r)}
    else leave();
  });
});
server.listen(PORT,()=>console.log(`二枚舌の酒場 listening on :${PORT}`));
