import fs from 'fs';
import path from 'path';
import { parseRawRows, normalizePostBrands, parseDimensions } from '../src/importers/masterCsv.mjs';

const outDir = path.join(process.cwd(), 'reports', 'local-import');
fs.mkdirSync(outDir, { recursive: true });
const posts = parseRawRows();
const postBrands = normalizePostBrands(posts);
const dims = parseDimensions();
const brandSet = new Set(dims.brands.map(b => String(b['TÊN THƯƠNG HIỆU'] ?? '').trim()).filter(Boolean));
const issues = [];
for (const pb of postBrands) {
  if (pb.brand_name !== '(Chưa tag brand)' && !brandSet.has(pb.brand_name)) {
    issues.push({ severity:'warn', issue_type:'brand_not_in_master', brand_name: pb.brand_name, post_url: pb.post_url });
  }
}
const summary = {
  generatedAt: new Date().toISOString(),
  posts_raw_count: posts.length,
  post_brands_count: postBrands.length,
  dimensions: Object.fromEntries(Object.entries(dims).map(([k,v]) => [k, v.length])),
  issues_count: issues.length,
  issues_sample: issues.slice(0, 50)
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, 'posts_raw.sample.json'), JSON.stringify(posts.slice(0, 20), null, 2));
fs.writeFileSync(path.join(outDir, 'post_brands.sample.json'), JSON.stringify(postBrands.slice(0, 50), null, 2));
console.log(JSON.stringify(summary, null, 2));
