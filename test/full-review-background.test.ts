import { execFileSync } from "node:child_process";
import test from "node:test";

function run(source: string) {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), timeout: 8000, stdio: "pipe" });
}
test("retired-summary persistence failure cannot escape its background promise", () => run(`
  import { ChannelTurnPresentation } from './src/channels/turn-presentation.ts';
  let fail = false; const gate = Promise.withResolvers();
  const client = { resumableTextStream: true, async sendText(){ return {messageId:'text'}; },
    async startTextStream(input){return {messageId:input.streamId};},
    async updateTextStream(input){if(input.finalize) await gate.promise;} };
  const stream = new ChannelTurnPresentation(client, 'room', {save(){if(fail)throw Error('journal unavailable');}});
  await stream.progress('first'); await stream.startSegment({id:'answer',kind:'answer'});
  fail = true; gate.resolve();
  await new Promise(resolve=>setTimeout(resolve,25)); fail = false; await stream.suspend();
`));
test("scheduled progress persistence failure cannot become an unhandled rejection", () => run(`
  import { ChannelTurnTextStream } from './src/channels/progress.ts';
  import { ChannelProgressError } from './src/channels/errors.ts';
  let fail = false;
  const client = { resumableTextStream:true, async sendText(){return {messageId:'text'};},
    async startTextStream(){return {messageId:'card'};},
    async updateTextStream(){throw new ChannelProgressError(false,'card',undefined,undefined,false,{stage:'stream',category:'transport'});} };
  const stream = new ChannelTurnTextStream(client,'room',{save(){if(fail)throw Error('journal unavailable');}});
  await stream.progress('first'); await stream.progress('next'); fail = true;
  await new Promise(resolve=>setTimeout(resolve,650)); fail = false; await stream.suspend();
`));
