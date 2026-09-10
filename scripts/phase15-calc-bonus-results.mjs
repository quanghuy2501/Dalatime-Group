import fs from 'fs';
import { connectDb } from '../src/db/postgres.mjs';
const db=await connectDb();
const started=Date.now();
await db.query('begin');
try {
  const run=(await db.query(`insert into sync_runs (run_type,status,started_at,meta) values ('phase1_5_bonus_calc','running',now(),$1) returning id`, [JSON.stringify({source:'scripts/phase15-calc-bonus-results.mjs'})])).rows[0];
  await db.query('delete from bonus_results');
  await db.query(`insert into bonus_results (post_raw_id, eligible, reason, amount, rule_id)
    select p.id,
      case when p.viral_label <> '' and p.posted_date is not null and p.posted_date <= current_date - interval '14 days' and coalesce(p.snapshot_view,0) > 0 and br.id is not null then true else false end as eligible,
      case
        when coalesce(p.viral_label,'') = '' then 'not_viral'
        when p.posted_date is null then 'bad_or_missing_posted_date'
        when p.posted_date > current_date - interval '14 days' then 'waiting_14_days'
        when coalesce(p.snapshot_view,0) = 0 then 'missing_snapshot'
        when br.id is null then 'no_matching_bonus_rule'
        else 'eligible'
      end as reason,
      case
        when p.viral_label <> '' and p.posted_date is not null and p.posted_date <= current_date - interval '14 days' and coalesce(p.snapshot_view,0) > 0 and br.id is not null
        then case when lower(coalesce(s.role,'')) like '%part%' then br.amount_parttime else br.amount_fulltime end
        else 0
      end as amount,
      br.id as rule_id
    from posts_raw p
    left join lateral (
      select role from staff st where lower(trim(st.name)) = lower(trim(p.owner_name)) order by st.updated_at desc limit 1
    ) s on true
    left join lateral (
      select * from bonus_rules b
      where b.min_snapshot_view <= coalesce(p.snapshot_view,0)
      order by b.min_snapshot_view desc
      limit 1
    ) br on true`);
  const count=(await db.query('select count(*)::int count from bonus_results')).rows[0].count;
  await db.query(`update sync_runs set status='ok',finished_at=now(),duration_ms=$2,rows_written=$3,meta=$4 where id=$1`, [run.id, Date.now()-started, count, JSON.stringify({bonus_results:count})]);
  await db.query('commit');
} catch(e) { await db.query('rollback'); throw e; }
const summary={generatedAt:new Date().toISOString()};
summary.byReason=(await db.query(`select reason, count(*)::int count, sum(amount)::bigint amount from bonus_results group by reason order by count desc`)).rows;
summary.total=(await db.query(`select count(*)::int count, sum(amount)::bigint amount from bonus_results`)).rows[0];
summary.topEligible=(await db.query(`select p.posted_date,p.owner_name,p.channel_name,p.post_url,p.snapshot_view,b.amount from bonus_results b join posts_raw p on p.id=b.post_raw_id where b.eligible order by b.amount desc, p.snapshot_view desc limit 20`)).rows;
fs.mkdirSync('reports/phase15',{recursive:true});
fs.writeFileSync('reports/phase15/bonus-results-summary.json', JSON.stringify(summary,null,2));
const md=['# Phase 1.5 Bonus Results Summary','',`Generated: ${summary.generatedAt}`,'',`Total rows: ${summary.total.count}`,`Total calculated amount: ${Number(summary.total.amount||0).toLocaleString('vi-VN')}đ`,'','## By reason',...summary.byReason.map(r=>`- ${r.reason}: ${r.count} rows, ${Number(r.amount||0).toLocaleString('vi-VN')}đ`),'','## Top eligible',...summary.topEligible.map(r=>`- ${r.posted_date || ''} / ${r.owner_name || '(chưa gán)'} / ${Number(r.snapshot_view||0).toLocaleString('vi-VN')} views / ${Number(r.amount||0).toLocaleString('vi-VN')}đ / ${r.channel_name || ''}`)];
fs.writeFileSync('reports/phase15/bonus-results-summary.md', md.join('\n'));
console.log(JSON.stringify(summary,null,2));
await db.end();
