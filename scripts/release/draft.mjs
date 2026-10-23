// Owner draft preparation core. GitHub, Git and signing access are injected: the owner
// command passes the real tools, tests pass fakes and disposable keys. Never publishes.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseManifest } from '../../dist/install/manifest.js';
import { encodeReleaseTar, encodeReleaseZip } from '../../dist/install/releasePackage.js';
import { runtimeEntry } from '../install/runtime-entry.mjs';
import { OWNER_PIN, readRegular, sha256, inspectCandidate } from './batch-sign.mjs';
import { TARGETS, requireRun, requireRunId, manifestEvidence, assetNames, releaseNotes, draftArguments } from './plan.mjs';
const CODE=/^[a-z][a-z0-9_]{2,63}$/,CAUSE=/^[A-Z][A-Z0-9_]{1,63}$/;
/** Safe failure record: own error code, optional system cause code, stage and the output directory to inspect or remove. */
export function failureRecord(error,state){
 const message=String(error?.message??''),cause=typeof error?.code==='string'&&CAUSE.test(error.code)?error.code:undefined;
 return {format_version:1,error_code:CODE.test(message)?message:'draft_release_failed',...(cause?{cause}:{}),stage:state.stage,...(state.output?{output:state.output}:{}),published:false};
}
const notFound=error=>/\b404\b/.test(String(error?.stderr??''));
/**
 * gh(args, binary) returns stdout; git(args) returns stdout; sign(candidates, sourceSha) writes signatures.
 * Dry run verifies CI evidence, downloads and inspects all five candidates and writes the notes,
 * without a key, signatures, packages or a GitHub release.
 */
export async function prepareDraft({sha,run,repo,tag,output,dryRun=false,checkout='.',signerSha256=OWNER_PIN},{gh,git,sign,notice=()=>{}},state={stage:'plan'}){
 state.stage='plan';
 if(!/^[0-9a-f]{40}$/.test(sha??'')||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repo??''))throw new Error('invalid_release_plan');
 requireRunId(run);const names=assetNames(tag);
 if(!dryRun&&typeof sign!=='function')throw new Error('signing_paths_required');
 const source=git(['rev-parse','HEAD']).trim();if(source!==sha||git(['status','--porcelain']).trim())throw new Error('frozen_clean_checkout_required');
 const api=endpoint=>JSON.parse(gh(['api',endpoint]));
 state.stage='ci';
 const base=`repos/${repo}`,ci=api(`${base}/actions/runs/${run}`);
 requireRun(ci,source);
 const jobs=api(`${base}/actions/runs/${run}/jobs?per_page=100`);if(jobs.total_count!==jobs.jobs.length||jobs.jobs.some(j=>j.conclusion!=='success'))throw new Error('ci_jobs_incomplete');
 const artifacts=api(`${base}/actions/runs/${run}/artifacts?per_page=100`);if(artifacts.total_count!==artifacts.artifacts.length)throw new Error('artifact_listing_incomplete');
 // releases/tags/{tag} never returns drafts: list every release, drafts included, and reject the tag name.
 const tags=gh(['api','--paginate',`${base}/releases?per_page=100`,'--jq','.[].tag_name']).split(/\r?\n/).filter(Boolean);
 if(tags.includes(tag))throw new Error('release_already_exists');
 // An existing tag must already point at the frozen commit. Resolve annotated tags too.
 let ref=null;try{ref=api(`${base}/git/ref/tags/${tag}`)}catch(e){if(!notFound(e))throw e}
 if(ref){let object=ref.object;for(let i=0;object.type==='tag'&&i<4;i++)object=api(`${base}/git/tags/${object.sha}`).object;if(object.type!=='commit'||object.sha!==source)throw new Error('tag_source_mismatch')}
 const root=output?resolve(output):mkdtempSync(join(tmpdir(),'tg-mcp-draft-'));if(output)mkdirSync(root,{mode:0o700});state.output=root;
 state.stage='download';
 const candidates=[];
 for(const [runner,platform,architecture,label] of TARGETS){
  const found=artifacts.artifacts.filter(a=>a.name===`unsigned-${runner}-${source}`&&!a.expired);if(found.length!==1||!/^sha256:[0-9a-f]{64}$/.test(found[0].digest??''))throw new Error('candidate_artifact_missing');
  const job=jobs.jobs.find(j=>j.name===`unsigned-candidates (${runner})`);if(!job)throw new Error('candidate_job_missing');
  const manifestSha256=manifestEvidence(gh(['api',`${base}/actions/jobs/${job.id}/logs`]),source);
  const zip=gh(['api',`${base}/actions/artifacts/${found[0].id}/zip`],true);if(sha256(zip)!==found[0].digest.slice(7))throw new Error('ci_artifact_digest_mismatch');
  const archive=join(root,runner+'.zip');writeFileSync(archive,zip,{flag:'wx',mode:0o600});
  const directory=join(root,label);mkdirSync(directory,{mode:0o700});
  for(const [name,max] of [['manifest.tsv',8192],['node'+(platform==='win32'?'.exe':''),134217728],['installer.mjs',1048576],['manifest.mjs',1048576],['archive.mjs',1048576],['application.tar.gz',134217728],['NODE_LICENSE',1048576]])writeFileSync(join(directory,name),runtimeEntry(archive,name,max,true),{flag:'wx',mode:0o600});
  const candidate={directory,platform,architecture,label,manifestSha256};inspectCandidate(candidate,source);candidates.push(candidate);
 }
 // Bootstrap bytes come from the verified frozen checkout; README pins the same SHA-256 values.
 const bootstraps=[[names.posixBootstrap,readFileSync(join(checkout,'scripts/install/bootstrap-posix.sh'))],[names.windowsBootstrap,readFileSync(join(checkout,'scripts/install/bootstrap-windows.ps1'))]];
 const notesText=releaseNotes({repo,tag,sourceSha:source,run,signerSha256,bootstrapSha256:{posix:sha256(bootstraps[0][1]),windows:sha256(bootstraps[1][1])}});
 const notes=join(root,'RELEASE-NOTES.md'),publicNames=[...TARGETS.map(t=>names.archive(t[3])),names.posixBootstrap,names.windowsBootstrap,names.checksums];
 if(dryRun){writeFileSync(notes,notesText,{flag:'wx',mode:0o600});return {format_version:1,phase:'draft_release_dry_run',source_sha:source,tag,output:root,notes,assets:publicNames,signed:false,created:false,published:false}}
 notice('All five CI manifests and payloads verified. Stop agents/capture before entering your signing passphrase.');
 state.stage='sign';
 await sign(candidates,source);
 state.stage='package';
 const assets=[];
 for(const candidate of candidates){const manifest=parseManifest(readRegular(join(candidate.directory,'manifest.tsv'),8192));const files=new Map(['manifest.tsv','manifest.sig','signer.der',...manifest.artifacts.map(a=>a.name)].map(name=>[name,readRegular(join(candidate.directory,name),134217728)]));
  const file=join(root,names.archive(candidate.label));writeFileSync(file,candidate.platform==='win32'?encodeReleaseZip(files):encodeReleaseTar(files),{flag:'wx',mode:0o600});assets.push(file);
 }
 for(const [name,bytes] of bootstraps){const path=join(root,name);writeFileSync(path,bytes,{flag:'wx',mode:0o600});assets.push(path)}
 const checksums=join(root,names.checksums);writeFileSync(checksums,assets.map(path=>`${sha256(readRegular(path,134217728))}  ${path.split('/').at(-1)}\n`).join(''),{flag:'wx',mode:0o600});assets.push(checksums);
 writeFileSync(notes,notesText,{flag:'wx',mode:0o600});
 state.stage='draft';
 const releaseUrl=gh(draftArguments({tag,repo,sha:source,notes,assets})).trim();
 return {format_version:1,phase:'draft_release_created',source_sha:source,tag,output:root,release_url:releaseUrl,published:false};
}
