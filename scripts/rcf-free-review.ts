import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {LocalStorage} from '../electron/storage';
import {OpenCodeSupervisor} from '../electron/supervisor';
import {SessionCoordinator} from '../electron/coordinator';
import {WorktreeService} from '../electron/worktrees';
import {AgentControlService} from '../electron/agent-control';
import {MediaService} from '../electron/media';
import {Redactor} from '../electron/security';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rcf-free-review-'));
const repo=path.join(directory,'fixture');await fs.mkdir(repo);
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,windowsHide:true,stdio:'ignore'});
git('init');await fs.writeFile(path.join(repo,'calc.ts'),'export const divide = (a: number, b: number) => a / b;\n');git('add','.');git('-c','user.name=RCF QA','-c','user.email=qa@example.invalid','commit','-m','fixture');await fs.writeFile(path.join(repo,'calc.ts'),'export const divide = (a: number, b: number) => a * b;\n');
const storage=new LocalStorage(path.join(directory,'profile'));
const engine=new OpenCodeSupervisor(path.join(directory,'profile/engine'),path.resolve('node_modules/@opencode/cli/bin/opencode.exe'),new Redactor(),()=>{});
const coordinator=new SessionCoordinator(storage,engine,new MediaService(path.join(directory,'attachments')),()=>{});
const control=new AgentControlService(coordinator,storage,()=>engine.ensure(),new WorktreeService(storage,()=>engine.ensure()));
const result:Record<string,unknown>={passed:false,paidRequests:0,isolatedProfile:true,directory};
try{
  await coordinator.start();const project=storage.addProject(repo);
  const available=await coordinator.models(project.id);
  const free=available.find(m=>m.enabled&&m.providerID==='opencode'&&m.id.endsWith('-free'));
  if(!free)throw Error('No enabled built-in explicitly free model in the isolated engine.');
  const model={id:free.id,providerID:free.providerID};result.model=model;
  const source=await coordinator.create(project.id,model,'cautious','work');
  await (await engine.ensure()).session.update({sessionID:source.id,title:'divide(a, b) must return a divided by b; identify the regression. No tests have been run.'});
  const before=await fs.readFile(path.join(repo,'calc.ts'),'utf8');
  const review=await control.startReview(source.id,model);
  const end=Date.now()+60000;
  while((await (await engine.ensure()).session.active())[review.id]&&Date.now()<end)await new Promise(r=>setTimeout(r,300));
  const report=await control.report(review.id);
  const unchanged=before===await fs.readFile(path.join(repo,'calc.ts'),'utf8');
  Object.assign(result,{report,unchanged,passed:report.status==='Completed'&&unchanged&&!!report.issues?.some(i=>i.file==='calc.ts'&&/multipl|divid|division|умнож|делени/i.test(JSON.stringify(i)))});
  console.log(result.passed?'PASS actual built-in free model independently detected seeded regression through RCF Reviewer':'Live free-model check incomplete; see test-results/rcf-free-review.json');
}catch(e){result.error=engine.redactor.error(e);console.log('Live free-model check did not complete:',engine.redactor.error(e));}
finally{await coordinator.close();storage.close();await fs.mkdir('test-results',{recursive:true});await fs.writeFile('test-results/rcf-free-review.json',JSON.stringify(result,null,2));}
