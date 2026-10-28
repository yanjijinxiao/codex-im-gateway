import assert from "node:assert/strict";
import test from "node:test";
import { OptionalObservation } from "../src/server/optional-observation.js";

test("optional observations bound outstanding probes, share timed-out work and free capacity on settlement",async()=>{
  const observation=new OptionalObservation(5),gates=Array.from({length:16},()=>Promise.withResolvers<string>());
  let probes=0;
  const first=await Promise.all(gates.map((gate,index)=>observation.read(String(index),()=>{probes++;return gate.promise;},"unverified")));
  assert.deepEqual(first,Array(16).fill("unverified"));assert.equal(probes,16);
  assert.equal(await observation.read("0",async()=>{probes++;return"duplicated";},"still unverified"),"still unverified");
  assert.equal(await observation.read("overflow",async()=>{probes++;return"overflow";},"capacity"),"capacity");
  assert.equal(probes,16);
  gates[0].resolve("settled");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await observation.read("overflow",async()=>{probes++;return"fresh";},"capacity"),"fresh");
  assert.equal(probes,17);gates.forEach(gate=>gate.resolve("settled"));
});

test("optional probe rejection is contained and a later read can verify again",async()=>{
  const observation=new OptionalObservation(100);
  assert.equal(await observation.read("read",async()=>{throw Error("synthetic provider failure");},"fallback"),"fallback");
  assert.equal(await observation.read("read",async()=>"verified","fallback"),"verified");
  assert.equal(await observation.read("sync",()=>{throw Error("synthetic sync failure");},"fallback"),"fallback");
});
