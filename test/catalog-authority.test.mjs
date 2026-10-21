import test from 'node:test';
import assert from 'node:assert/strict';
import { isDatabaseCatalogAuthority } from '../src/catalog/authority.mjs';

test('explicit authority overrides production cutover detection', async () => {
  const db={query:async()=>{throw new Error('should not query')}};
  assert.equal(await isDatabaseCatalogAuthority(db,{NODE_ENV:'production',CATALOG_AUTHORITY:'database'}),true);
  assert.equal(await isDatabaseCatalogAuthority(db,{NODE_ENV:'production',CATALOG_AUTHORITY:'master'}),false);
});

test('production auto-detects only a successful catalog cutover marker', async () => {
  const enabled={query:async()=>({rows:[{enabled:true}]})};
  const disabled={query:async()=>({rows:[{enabled:false}]})};
  assert.equal(await isDatabaseCatalogAuthority(enabled,{NODE_ENV:'production'}),true);
  assert.equal(await isDatabaseCatalogAuthority(disabled,{NODE_ENV:'production'}),false);
  assert.equal(await isDatabaseCatalogAuthority(enabled,{NODE_ENV:'development'}),false);
});
