import fs from 'node:fs';import readline from 'node:readline';
const file=process.argv[2],items=[];const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
if(process.argv.includes('--delayed-exit'))process.on('SIGTERM',()=>{setTimeout(()=>{fs.appendFileSync(file,'process-exited\n');process.exit(0);},100);});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;fs.appendFileSync(file,m.method+'\n');
if(m.method==='initialize'){reply(m.id,{userAgent:'isolated external queue'});return;}
if(m.method==='thread/queue/add'&&!process.argv.includes('--unsupported')){const item={id:'q-'+(items.length+1),clientUserMessageId:m.params.clientUserMessageId,input:m.params.input};items.push(item);reply(m.id,{queuedSubmission:item});return;}
if(m.method==='thread/queue/list'){reply(m.id,{data:items,nextCursor:null});return;}
if(m.method==='thread/queue/delete'){const i=items.findIndex(x=>x.id===m.params.queuedSubmissionId);if(i>=0)items.splice(i,1);reply(m.id,{deleted:i>=0});return;}
process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Method not found: '+m.method}})+'\n');});
