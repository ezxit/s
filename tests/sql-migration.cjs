const fs = require('node:fs');
const assert = require('node:assert/strict');
const qaRequire = require('node:module').createRequire(require('node:path').resolve(__dirname, '../output/data-qa/package.json'));
const {PGlite} = qaRequire('@electric-sql/pglite');
const {pg_trgm} = qaRequire('@electric-sql/pglite/contrib/pg_trgm');

(async () => {
  const db = new PGlite({extensions: {pg_trgm}});
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT);
    CREATE TABLE storage.objects(id UUID DEFAULT gen_random_uuid(),bucket_id TEXT,name TEXT);
    CREATE EXTENSION pg_trgm WITH SCHEMA public;
    CREATE TABLE public.shortlinks(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),text TEXT DEFAULT '',images JSONB DEFAULT '[]',description TEXT DEFAULT '',namespace TEXT DEFAULT 'default',created_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO public.shortlinks(id,text,images,namespace) VALUES('11111111-1111-4111-8111-111111111111','迁移以前的正文','["data:image/png;base64,LEGACY"]','legacy');`);
  const sql = fs.readFileSync('migration.sql','utf8');
  await db.exec(sql);
  await db.exec(sql);
  let checks = 2;
  const rpc = async (name,args,casts) => (await db.query(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}${casts?.[i] || ''}`).join(',')}) AS result`,args)).rows[0].result;
  const insert = async (row) => (await db.query('INSERT INTO public.shortlinks(text,description,namespace,images,files,retired_assets) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [row.text || '',row.description || '',row.namespace || 'alice',JSON.stringify(row.images || []),JSON.stringify(row.files || []),JSON.stringify(row.retired_assets || [])])).rows[0].id;
  const legacy = await rpc('search_shortlinks',['legacy','以前的正文',false,20,0]);
  assert.equal(legacy.total,1); assert.equal(legacy.items[0].id,'11111111-1111-4111-8111-111111111111'); checks++;
  assert.equal((await db.query("SELECT images->>0 AS image FROM public.shortlinks WHERE namespace='legacy'")).rows[0].image,'data:image/png;base64,LEGACY'); checks++;
  const one = await insert({text:'Only正文深处测试词',description:'摘要',images:['data:image/png;base64,OLD',{name:'长截图.png',key:'img',thumbnailKey:'thumb'}],files:[{name:'合同中文.pdf',key:'pdf'}],retired_assets:[{name:'旧文件.pdf',key:'retired'}]});
  const two = await insert({text:'100%_ literal',namespace:'alice2'});
  for(let i=0;i<25;i++) await insert({text:`other ${i}`});
  for (const term of ['正文深处','长截图','合同中文']) {
    const found = await rpc('search_shortlinks',['alice',term,false,20,0]);
    assert.equal(found.total,1); assert.equal(found.items[0].id,one);
    assert.equal('images' in found.items[0],false); checks++;
  }
  assert.equal((await rpc('search_shortlinks',['alice','',false,20,0])).total,26); checks++;
  assert.equal((await rpc('search_shortlinks',['alice','',false,20,20])).items.length,6); checks++;
  assert.equal((await rpc('search_shortlinks',['alice2','%_',false,20,0])).total,1); checks++;
  assert.equal((await rpc('search_shortlinks',['alice','%_',false,20,0])).total,0); checks++;
  await assert.rejects(rpc('soft_delete_shortlinks',[[one,two],'alice']),/missing|namespace/i); checks++;
  assert.equal((await rpc('search_shortlinks',['alice','正文深处',false,20,0])).total,1); checks++;
  await db.exec('SET ROLE anon');
  await rpc('soft_delete_shortlinks',[[one],'alice']);
  assert.equal((await rpc('search_shortlinks',['alice','正文深处',false,20,0])).total,0); checks++;
  assert.equal((await rpc('search_shortlinks',['alice','正文深处',true,20,0])).total,1); checks++;
  await rpc('restore_shortlinks',[[one],'alice']);
  assert.equal((await rpc('search_shortlinks',['alice','正文深处',false,20,0])).total,1); checks++;
  await assert.rejects(db.query('DELETE FROM public.shortlinks WHERE id=$1',[one]),/recycle bin/i); checks++;
  await rpc('soft_delete_shortlinks',[[one],'alice']);
  const plan = await rpc('begin_purge',[one,'alice']);
  assert.deepEqual(plan.keys.map(x=>x.key).sort(),['img','pdf','retired','thumb']); checks++;
  assert.deepEqual(await rpc('begin_purge',[one,'alice']),plan); checks++;
  await assert.rejects(rpc('restore_shortlinks',[[one],'alice']),/cleanup/i); checks++;
  await assert.rejects(db.query('UPDATE public.shortlinks SET text=$1 WHERE id=$2',['edit',one]),/cleaned/i); checks++;
  await assert.rejects(insert({files:[{key:'pdf'}]}),/attachment.*removed/i); checks++;
  await assert.rejects(rpc('finish_purge',[one,'alice','[]'],['','','::jsonb']),/complete.*plan/i); checks++;
  await rpc('finish_purge',[one,'alice',JSON.stringify(plan.keys)],['','','::jsonb']);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.shortlinks WHERE id=$1',[one])).rows[0].n,0); checks++;
  assert.equal((await rpc('finish_purge',[one,'alice',JSON.stringify(plan.keys)],['','','::jsonb'])).completed,true); checks++;
  assert.equal((await rpc('begin_purge',[one,'alice'])).completed,true); checks++;
  await assert.rejects(rpc('begin_purge',[one,'wrong namespace']),/namespace/i); checks++;
  await assert.rejects(insert({files:[{key:'pdf'}]}),/attachment.*removed/i); checks++;
  // Shared active records remain intact. Only the last non-restorable holder
  // reserves the object, even with interleaved cleanup starts from two clients.
  const a = await insert({files:[{key:'shared',name:'shared.bin'}]});
  const b = await insert({files:[{key:'shared',name:'shared.bin'}]});
  await rpc('soft_delete_shortlinks',[[a],'alice']);
  const aPlan = await rpc('begin_purge',[a,'alice']);
  assert.deepEqual(aPlan.keys,[]); checks++;
  await rpc('soft_delete_shortlinks',[[b],'alice']);
  const bPlan = await rpc('begin_purge',[b,'alice']);
  assert.deepEqual(bPlan.keys,[{bucket:'files',key:'shared'}]); checks++;
  await rpc('finish_purge',[b,'alice',JSON.stringify(bPlan.keys)],['','','::jsonb']);
  await rpc('finish_purge',[a,'alice','[]'],['','','::jsonb']); checks++;
  const c = await insert({files:[{key:'double-cleanup',name:'same.bin'}]});
  await rpc('soft_delete_shortlinks',[[c],'alice']);
  const cPlan = await rpc('begin_purge',[c,'alice']);
  assert.deepEqual(await rpc('begin_purge',[c,'alice']),cPlan); checks++;
  await rpc('finish_purge',[c,'alice',JSON.stringify(cPlan.keys)],['','','::jsonb']);
  assert.equal((await rpc('finish_purge',[c,'alice',JSON.stringify(cPlan.keys)],['','','::jsonb'])).completed,true); checks++;
  // Segmented uploads store only physical part objects. Base keys are logical;
  // original and thumbnail keys remain independently owned Storage objects.
  const segmented = (base,keys,extra={}) => ({key:base,url:'',name:'200MB中文文件.zip',size:209715200,segmented:true,parts:keys.map(key=>({key,url:`https://storage.test/${key}`,size:33554432,sha256:'hash'})),...extra});
  const extractor = (await db.query('SELECT * FROM public.shortlink_asset_keys($1::jsonb,$2::jsonb,$3::jsonb) ORDER BY bucket,key',[
    JSON.stringify([segmented('logical-image',['image-1','image-2'],{originalKey:'original-img',thumbnail:{key:'thumbnail-img',bucket:'previews'}}),'data:image/png;base64,OLD']),
    JSON.stringify([segmented('logical-file',['file-1','file-1'],{bucket:'archive',parts:[{key:'file-1'},{key:'file-2',bucket:'files'}]})]),
    JSON.stringify([segmented('logical-retired',['retired-1']),{key:'ordinary',originalKey:'ordinary-original'},null])
  ])).rows;
  assert.deepEqual(extractor,[{bucket:'archive',key:'file-1'},{bucket:'files',key:'file-2'},
    {bucket:'files',key:'image-1'},{bucket:'files',key:'image-2'},{bucket:'files',key:'ordinary'},
    {bucket:'files',key:'ordinary-original'},{bucket:'files',key:'original-img'},
    {bucket:'files',key:'retired-1'},{bucket:'previews',key:'thumbnail-img'}]); checks++;
  const fullParts = ['whole/part-1','whole/part-2','whole/part-3','whole/part-4','whole/part-5','whole/part-6','whole/part-7'];
  const whole = await insert({files:[segmented('whole-logical',fullParts)],images:[segmented('whole-image-logical',['whole-image/part-1'],{thumbnailKey:'whole-image/thumb'})],retired_assets:[segmented('whole-retired-logical',['whole-retired/part-1'])]});
  await rpc('soft_delete_shortlinks',[[whole],'alice']);
  const wholePlan = await rpc('begin_purge',[whole,'alice']);
  assert.deepEqual(wholePlan.keys.map(x=>x.key).sort(),[...fullParts,'whole-image/part-1','whole-image/thumb','whole-retired/part-1'].sort()); checks++;
  assert.deepEqual(await rpc('begin_purge',[whole,'alice']),wholePlan); checks++;
  await assert.rejects(rpc('finish_purge',[whole,'alice',JSON.stringify(wholePlan.keys.slice(0,-1))],['','','::jsonb']),/complete.*plan/i); checks++;
  assert.equal((await db.query('SELECT count(*)::int n FROM public.shortlinks WHERE id=$1',[whole])).rows[0].n,1); checks++;
  await assert.rejects(insert({files:[segmented('another-base',[fullParts[0]])]}),/attachment.*removed/i); checks++;
  await rpc('finish_purge',[whole,'alice',JSON.stringify(wholePlan.keys)],['','','::jsonb']);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.shortlinks WHERE id=$1',[whole])).rows[0].n,0); checks++;
  await assert.rejects(insert({files:[segmented('another-base-after',[fullParts[0]])]}),/attachment.*removed/i); checks++;
  const partA = await insert({files:[segmented('logical-A',['shared-part','unique-part-A'])]});
  const partB = await insert({retired_assets:[segmented('logical-B',['shared-part','unique-part-B'])]});
  await rpc('soft_delete_shortlinks',[[partA,partB],'alice']);
  const partAPlan = await rpc('begin_purge',[partA,'alice']);
  assert.deepEqual(partAPlan.keys,[{bucket:'files',key:'unique-part-A'}]); checks++;
  await rpc('restore_shortlinks',[[partB],'alice']);
  assert.equal((await db.query('SELECT deleted_at FROM public.shortlinks WHERE id=$1',[partB])).rows[0].deleted_at,null); checks++;
  await rpc('soft_delete_shortlinks',[[partB],'alice']);
  const partBPlan = await rpc('begin_purge',[partB,'alice']);
  assert.deepEqual(partBPlan.keys,[{bucket:'files',key:'shared-part'},{bucket:'files',key:'unique-part-B'}]); checks++;
  await rpc('finish_purge',[partB,'alice',JSON.stringify(partBPlan.keys)],['','','::jsonb']);
  await rpc('finish_purge',[partA,'alice',JSON.stringify(partAPlan.keys)],['','','::jsonb']); checks++;
  console.log(JSON.stringify({passed:checks,migration:'executed twice',engine:'PGlite / PostgreSQL',coverage:'search, Chinese, names, pagination, anon RPCs, atomic delete, undo, cleanup retry, retired assets, shared references, concurrent-plan interleaving, segmented originals/images/retired assets, shared part protection, physical-key-only plans'}));
  await db.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
