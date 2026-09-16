#!/usr/bin/env node
import { executeConfigPush } from '../src/configPush/runner.mjs';

const production=process.argv.includes('--production');
try {
  const result=await executeConfigPush({production});
  const {results,...summary}=result;
  console.log(JSON.stringify({job:'config_push',final:true,...summary,files:results.map(({fileId:_fileId,...item})=>item)},null,2));
  if(result.counts.failed)process.exitCode=2;
} catch(error) {
  console.error(JSON.stringify({job:'config_push',final:true,status:'blocked',mode:production?'production':'dry-run',error:String(error.message||error)},null,2));
  process.exitCode=1;
}
