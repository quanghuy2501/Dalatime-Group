#!/usr/bin/env node
import { runDirectNvIngestion } from '../src/ingestion/directNvRunner.mjs';

try {
  await runDirectNvIngestion();
} catch(error) {
  if(!error.nvFinalLogged) console.error(JSON.stringify({timestamp:new Date().toISOString(),job:'direct_nv_ingestion',event:'final',status:'blocked',error:error.message,lastKnownGoodPreserved:true}));
  process.exitCode=1;
}
