// client.template.html + base.css + client.js から
//  public/index.html（サーバー用）と standalone.html（CPU戦のみ・1ファイル）を作る
const fs=require('fs');
const tpl=fs.readFileSync('client.template.html','utf8');
const css=fs.readFileSync('base.css','utf8');
const client=fs.readFileSync('client.js','utf8');
const engine=fs.readFileSync('public/engine.js','utf8');
const base=tpl.replace('/*BASECSS*/',()=>css).replace('/*CLIENT*/',()=>client);
fs.writeFileSync('public/index.html',base.replace('<!--SOCKETIO-->','<script src="/socket.io/socket.io.js"></script>').replace('<!--ENGINE-->','<script src="engine.js"></script>'));
fs.writeFileSync('standalone.html',base.replace('<!--SOCKETIO-->','').replace('<!--ENGINE-->',()=>`<script>\n${engine}\n</script>`));
console.log('built public/index.html and standalone.html');
