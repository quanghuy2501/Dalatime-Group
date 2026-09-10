// Intentional manual approval gate. This script exits unless the exact approval phrase is supplied.
const phrase = process.env.PRODUCTION_SHEET_WRITE_APPROVAL || '';
const required = 'I_APPROVE_OVERWRITE_RAW_DATA_AND_NORMALIZED';
if (phrase !== required) {
  console.error('Blocked: production sheet overwrite requires explicit approval.');
  console.error(`Set PRODUCTION_SHEET_WRITE_APPROVAL=${required} only after staging-vs-production diff is reviewed.`);
  process.exit(2);
}
console.log('Approval phrase accepted. Implement production overwrite in a separate, reviewed script only.');
