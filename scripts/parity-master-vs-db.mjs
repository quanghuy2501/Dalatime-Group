import fs from 'fs';
import { loadLiveMasterSnapshot, mapPostRaw } from '../src/importers/liveMaster.mjs';
import { connectDb } from '../src/db/postgres.mjs';
function inRange(p, from, to){return (!from || p.posted_date>=from) && (!to || p.posted_date<=to)}
function agg(rows){const o={posts:0,view:0,like:0,comment:0,save:0,share:0,viral:0,exclusive:0}; for(const p of rows){o.posts++; o.view+=p.realtime_view||0; o.like+=p.realtime_like||0; o.comment+=p.realtime_comment||0; o.save+=p.realtime_save||0; o.share+=p.realtime_share||0; if(p.viral_label)o.viral++; if(p.is_exclusive)o.exclusive++;} o.interactions=o.like+o.comment+o.save+o.share; o.er=o.view?o.interactions/o.view*100:0; return o}
const ranges=[{name:'all',from:'',to:''},{name:'sep_1_8',from:'2026-09-01',to:'2026-09-08'},{name:'august',from:'2026-08-01',to:'2026-08-31'}];
const snap=await loadLiveMasterSnapshot();
const raw=snap.rawRows.map(mapPostRaw).filter(p=>p.posted_date || p.post_url);
const db=await connectDb();
const report={generatedAt:new Date().toISOString(), ranges:[]};
for(const r of ranges){
 const master=agg(raw.filter(p=>inRange(p,r.from,r.to)));
 const qs=[]; const vals=[]; if(r.from){vals.push(r.from); qs.push(`posted_date >= $${vals.length}`)} if(r.to){vals.push(r.to); qs.push(`posted_date <= $${vals.length}`)}
 const where=qs.length?'where '+qs.join(' and '):'';
 const q=await db.query(`select count(*)::int posts, coalesce(sum(realtime_view),0)::bigint view, coalesce(sum(realtime_like),0)::bigint like, coalesce(sum(realtime_comment),0)::bigint comment, coalesce(sum(realtime_save),0)::bigint save, coalesce(sum(realtime_share),0)::bigint share, count(*) filter (where coalesce(viral_label,'')<>'')::int viral, count(*) filter (where is_exclusive)::int exclusive from posts_raw ${where}`, vals);
 const dbAgg=q.rows[0]; for(const k of Object.keys(dbAgg)) dbAgg[k]=Number(dbAgg[k]); dbAgg.interactions=dbAgg.like+dbAgg.comment+dbAgg.save+dbAgg.share; dbAgg.er=dbAgg.view?dbAgg.interactions/dbAgg.view*100:0;
 const diff={}; for(const k of ['posts','view','like','comment','save','share','viral','exclusive','interactions']) diff[k]=dbAgg[k]-master[k]; diff.er=dbAgg.er-master.er;
 report.ranges.push({range:r, masterRawNoDedupe:master, dbDedupe:dbAgg, diff});
}
await db.end();
fs.mkdirSync('reports/phase2',{recursive:true});
fs.writeFileSync('reports/phase2/parity-master-vs-db.json', JSON.stringify(report,null,2));
const md=['# Parity Master RAW vs DB Dedupe','',`Generated: ${report.generatedAt}`,'','Note: Master live RAW is non-deduped; DB is deduped by normalized URL/source/date/channel, so differences are expected where duplicates exist.'];
for(const x of report.ranges){md.push('',`## ${x.range.name}`,`- Master posts: ${x.masterRawNoDedupe.posts}, DB posts: ${x.dbDedupe.posts}, diff: ${x.diff.posts}`,`- Master view: ${x.masterRawNoDedupe.view.toLocaleString('vi-VN')}, DB view: ${x.dbDedupe.view.toLocaleString('vi-VN')}, diff: ${x.diff.view.toLocaleString('vi-VN')}`,`- Master viral: ${x.masterRawNoDedupe.viral}, DB viral: ${x.dbDedupe.viral}, diff: ${x.diff.viral}`,`- Master ER: ${x.masterRawNoDedupe.er.toFixed(4)}%, DB ER: ${x.dbDedupe.er.toFixed(4)}%, diff: ${x.diff.er.toFixed(4)}%`)}
fs.writeFileSync('reports/phase2/parity-master-vs-db.md', md.join('\n'));
console.log(JSON.stringify(report.ranges.map(r=>({name:r.range.name,diff:r.diff})),null,2));
