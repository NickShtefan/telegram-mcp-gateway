#!/usr/bin/env node
// Run only by the owner in a private TTY. This program never publishes a release.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { terminalIo } from '../../dist/cli/io.js';
import { OWNER_PIN, signCandidates } from './batch-sign.mjs';
import { REPOSITORY } from './plan.mjs';
import { prepareDraft, failureRecord } from './draft.mjs';
const gh=(args,binary=false)=>execFileSync('gh',args,{stdio:['ignore','pipe','pipe'],encoding:binary?undefined:'utf8',maxBuffer:binary?134217728:20000000,timeout:180000});
const git=args=>execFileSync('git',args,{encoding:'utf8'});
const state={stage:'plan'};
try {
 const {values}=parseArgs({options:{sha:{type:'string'},run:{type:'string'},repo:{type:'string',default:REPOSITORY},tag:{type:'string',default:'v0.2.0'},output:{type:'string'},'dry-run':{type:'boolean',default:false},key:{type:'string'},certificate:{type:'string'}}});
 const dryRun=values['dry-run'];
 if(!process.getuid||process.getuid()===0||(!dryRun&&(!process.stdin.isTTY||!process.stderr.isTTY)))throw new Error('owner_tty_required');
 // No personal default: the owner names the files or sets the two documented variables.
 const key=values.key??process.env.TG_MCP_SIGNING_KEY,certificate=values.certificate??process.env.TG_MCP_SIGNING_CERTIFICATE;
 if(!dryRun&&(!key||!certificate))throw new Error('signing_paths_required');
 const sign=dryRun?undefined:(candidates,sourceSha)=>signCandidates(candidates,{sourceSha,certificatePath:resolve(certificate),keyPath:resolve(key),prompt:terminalIo.prompt,signerPin:OWNER_PIN});
 const result=await prepareDraft({sha:values.sha,run:values.run,repo:values.repo,tag:values.tag,output:values.output,dryRun},{gh,git,sign,notice:terminalIo.err},state);
 terminalIo.out(JSON.stringify(result));
}catch(error){process.stderr.write(JSON.stringify(failureRecord(error,state))+'\n');process.exitCode=1;}
