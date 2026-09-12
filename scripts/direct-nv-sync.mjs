#!/usr/bin/env node
import { runDirectNvIngestion } from '../src/ingestion/directNvRunner.mjs';

try {
  const result=await runDirectNvIngestion();
  console.log(JSON.stringify({status:'published',...result},null,2));
} catch(error) {
  console.error(JSON.stringify({status:'blocked',error:error.message,lastKnownGoodPreserved:true},null,2));
  process.exitCode=1;
}
