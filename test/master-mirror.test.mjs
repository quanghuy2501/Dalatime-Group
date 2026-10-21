import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogSheets,buildFactSheets,googleSerial,RAW_HEADER,NORMALIZED_HEADER,UNTAGGED_BRAND } from '../src/masterMirror/snapshot.mjs';

test('Master mirror maps canonical typed fields to the exact 26-column contract',()=>{
  const post={posted_date:'2026-10-21',brand_text_raw:'Brand A, Brand B',brand_names:['Brand A','Brand B'],channel_name:'Kênh',post_url:'https://tiktok.test/p',owner_name:'NV',is_exclusive:true,viral_label:'🔥 Viral',realtime_view:10,realtime_like:2,realtime_comment:1,realtime_save:1,realtime_share:1,snapshot_view:9,snapshot_like:2,snapshot_comment:1,snapshot_save:1,snapshot_share:1,engagement_rate:.5,status:'Đã cập nhật',bonus_amount:15000,show_channel:'Có',updated_at:'2026-10-21T07:00:00Z',source_file_id:'abc',viral_confirm_date:'2026-10-20',raw_values:Array(22).fill('')};
  const legacy=new Map([[post.post_url,{lastMilestone:'M1',notifiedAt:'N1'}]]);
  const out=buildFactSheets([post],{legacyState:legacy});
  assert.equal(RAW_HEADER.length,26);assert.equal(NORMALIZED_HEADER.length,26);
  assert.equal(out.rawRows.length,5);assert.equal(out.normalizedRows.length,6);
  assert.equal(out.rawRows[4].length,26);assert.equal(out.rawRows[4][21],googleSerial(post.updated_at,{withTime:true}));
  assert.equal(out.rawRows[4][22],'https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing');
  assert.equal(out.rawRows[4][23],'M1');assert.equal(out.rawRows[4][24],'N1');assert.equal(out.rawRows[4][25],googleSerial('2026-10-20'));
  assert.deepEqual(out.normalizedRows.slice(4).map(row=>row[1]),['Brand A','Brand B']);
});

test('Master mirror preserves employee serial dates and legacy unparsed dates without UTC drift',()=>{
  const directRaw=Array(22).fill('');directRaw[0]=46315;directRaw[1]='B';directRaw[2]='K';directRaw[3]='u';directRaw[21]=46314;
  const legacyRaw=Array(26).fill('');legacyRaw[0]='06/17/2026';legacyRaw[1]='B';legacyRaw[2]='K';legacyRaw[3]='u2';legacyRaw[18]='Chưa cập nhật';legacyRaw[21]=46100;legacyRaw[22]='legacy-link';legacyRaw[25]=46101;
  const direct={posted_date:new Date('2026-10-19T17:00:00.000Z'),brand_names:['B'],raw_values:directRaw,updated_at:'2026-10-21T08:00:00Z',source_file_id:'file'};
  const legacy={posted_date:null,brand_names:['B'],raw_values:legacyRaw,updated_at:'2026-09-12T00:00:00Z',source_file_id:'https://docs.google.com/spreadsheets/d/legacy/edit'};
  const facts=buildFactSheets([direct,legacy]);
  assert.equal(facts.rawRows[4][0],46315);
  assert.equal(facts.rawRows[4][25],46314);
  assert.equal(facts.rawRows[5][0],'06/17/2026');
  assert.equal(facts.rawRows[5][21],46100);
  assert.equal(facts.rawRows[5][22],'https://docs.google.com/spreadsheets/d/legacy/edit');
  assert.equal(facts.rawRows[5][25],46101);
  assert.equal(facts.rawRows[4][18],'Chưa cập nhật');
});

test('Master mirror retains untagged posts and creates row-relative catalog formulas',()=>{
  const post={posted_date:'2026-10-21',brand_names:[],raw_values:Array(22).fill('')};
  const facts=buildFactSheets([post]);assert.equal(facts.normalizedRows[4][1],UNTAGGED_BRAND);
  const c=buildCatalogSheets({clients:[{client_code:'KH1',name:'Khách',raw_row:[]}],brands:[],staff:[{nv_id:'NV1',name:'Nhân sự',raw_row:[]}],channels:[],bonus:[]});
  assert.equal(c.clientRows[0][7].formula,"=COUNTIF('4. LIST BRAND'!$D$5:$D;B5)");
  assert.match(c.staffRows[0][8].formula,/REGEXMATCH\(C5/);
});
