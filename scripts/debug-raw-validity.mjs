import { loadLiveMasterSnapshot, mapPostRaw } from '../src/importers/liveMaster.mjs';
const snap=await loadLiveMasterSnapshot();
const mapped=snap.rawRows.map(mapPostRaw);
const cats={total:mapped.length, hasDate:0, hasUrl:0, hasDateUrl:0, hasMetrics:0, valid:0};
const samples={noUrl:[], noDate:[], valid:[]};
for(const p of mapped){
 if(p.posted_date) cats.hasDate++;
 if(p.post_url) cats.hasUrl++;
 if(p.posted_date && p.post_url) cats.hasDateUrl++;
 if(p.realtime_view || p.realtime_like || p.realtime_comment || p.realtime_save || p.realtime_share) cats.hasMetrics++;
 const valid=!!(p.posted_date && p.post_url && (p.brand_text_raw || p.channel_name || p.owner_name));
 if(valid) {cats.valid++; if(samples.valid.length<3) samples.valid.push(p)}
 else if(!p.post_url && samples.noUrl.length<5) samples.noUrl.push(p)
 else if(!p.posted_date && samples.noDate.length<5) samples.noDate.push(p)
}
console.log(JSON.stringify({cats,samples},null,2));
