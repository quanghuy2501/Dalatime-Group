#!/usr/bin/env node
import { runMasterMirror } from '../src/masterMirror/runner.mjs';

const apply=process.argv.includes('--apply');
try{
  const result=await runMasterMirror({spreadsheetId:process.env.MASTER_MIRROR_SPREADSHEET_ID,apply,log:event=>console.log(JSON.stringify({job:'master_report_mirror',...event}))});
  console.log(JSON.stringify({job:'master_report_mirror',status:'ok',...result},null,2));
}catch(error){console.error(JSON.stringify({job:'master_report_mirror',status:'failed',error:String(error.message||error)},null,2));process.exitCode=1;}

