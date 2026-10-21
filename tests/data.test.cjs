const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/data.js'), 'utf8');

function setup(handle) {
  const requests = [];
  const window = {};
  const context = vm.createContext({window, fetch: async (url, options) => {
    const request = {url: new URL(url), ...options, json: options.body ? JSON.parse(options.body) : null};
    requests.push(request);
    const result = await handle(request);
    return {ok: !result.status || result.status < 400, status: result.status || 200,
      text: async () => JSON.stringify(result.body ?? result)};
  }});
  vm.runInContext(source, context);
  const api = window.ShortlinkData;
  api.configure({url: 'https://test.supabase.co', key: 'sb_publishable_test'});
  return {api, requests};
}
const missing = {status:404, body:{code:'PGRST202',message:'RPC missing'}};
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy search visits every server-capped page and never selects base64 images', async () => {
  const rows = Array.from({length: 145}, (_,i)=>({id:`row-${i}`,namespace:'中文空间',text:i===144?'深处的搜索词':'普通正文',description:'摘要',files:i===125?[{name:'合同中文.pdf'}]:[]}));
  const {api,requests} = setup(request => {
    if(request.url.pathname.endsWith('/shortlink_capabilities')) return missing;
    assert.equal(request.url.searchParams.get('namespace'),'eq.中文空间');
    assert.equal(request.url.searchParams.get('select').includes('images'),false);
    const offset = Number(request.url.searchParams.get('offset'));
    return rows.slice(offset,offset+37);
  });
  const body = await api.search('中文空间',{query:'搜索词'});
  assert.equal(body.needsUpgrade,true); assert.equal(body.total,1); assert.equal(body.items[0].id,'row-144');
  const files = await api.search('中文空间',{query:'合同中文'});
  assert.equal(files.total,1); assert.equal(files.items[0].id,'row-125');
  assert.equal(requests.filter(x=>x.url.pathname.endsWith('/shortlink_capabilities')).length,1);
});

test('upgraded search passes query, scope and page to server without loading content', async () => {
  const {api,requests} = setup(request => request.url.pathname.endsWith('/shortlink_capabilities')?{schema:2}:{items:[{id:'found'}],total:88});
  const result = await api.search('a,b',{query:' 合同_% ',trash:true,limit:20,offset:40});
  assert.deepEqual(plain(result),{items:[{id:'found'}],total:88,needsUpgrade:false});
  assert.deepEqual(requests[1].json,{p_namespace:'a,b',p_query:'合同_%',p_trash:true,p_limit:20,p_offset:40});
  assert.equal('Authorization' in requests[0].headers,false);
});

test('missing upgrade gates all deletion and authorization failures are surfaced', async () => {
  const {api,requests} = setup(()=>missing);
  await assert.rejects(api.softDelete(['one'],'alice'),error=>error.needsUpgrade===true);
  await assert.rejects(api.restore(['one'],'alice'),error=>error.needsUpgrade===true);
  await assert.rejects(api.purge(['one'],'alice',()=>{}),error=>error.needsUpgrade===true);
  assert.equal(requests.length,1);
  const bad = setup(()=>({status:401,body:{message:'Invalid key'}}));
  await assert.rejects(bad.api.search('alice'),/Invalid key/);
  assert.equal(bad.requests.length,1);
});

test('partial server mutation result is not reported as complete', async () => {
  const {api} = setup(request=>request.url.pathname.endsWith('/shortlink_capabilities')?{schema:2}:{ids:['one'],count:1});
  await assert.rejects(api.softDelete(['one','two'],'alice'),/部分短链接/);
});

test('failed Storage cleanup preserves metadata and retries the same plan before finish', async () => {
  const {api,requests} = setup(request => {
    if(request.url.pathname.endsWith('/shortlink_capabilities')) return {schema:2};
    if(request.url.pathname.endsWith('/begin_purge')) return {id:request.json.p_id,keys:[{bucket:'files',key:'original'},{bucket:'files',key:'thumb'}]};
    return {id:request.json.p_id};
  });
  const deleted = [];
  let fail = true;
  const remove = async object => { deleted.push(object.key); if(object.key==='thumb' && fail) throw new Error('Storage offline'); };
  const first = await api.purge(['one'],'alice',remove);
  assert.equal(first.count,0); assert.equal(first.failed[0].id,'one');
  assert.equal(requests.some(x=>x.url.pathname.endsWith('/finish_purge')),false);
  fail=false;
  const second = await api.purge(['one'],'alice',remove);
  assert.equal(second.count,1); assert.equal(second.failed.length,0);
  assert.deepEqual(deleted,['original','thumb','original','thumb']);
  assert.deepEqual(requests.at(-1).json.p_completed_keys,[{bucket:'files',key:'original'},{bucket:'files',key:'thumb'}]);
});

test('switching project during cleanup never finalizes against the new backend', async () => {
  const {api,requests} = setup(request=>request.url.pathname.endsWith('/shortlink_capabilities')?{schema:2}:{id:'one',keys:[{bucket:'files',key:'original'}]});
  const result = await api.purge(['one'],'alice',async()=>api.configure({url:'https://new.supabase.co',key:'sb_publishable_new'}));
  assert.equal(result.count,0); assert.match(result.failed[0].error.message,/连接已切换/);
  assert.equal(requests.every(x=>x.url.hostname==='test.supabase.co'),true);
  assert.equal(requests.some(x=>x.url.pathname.endsWith('/finish_purge')),false);
});

test('a segmented object is finalized only after every physical part was removed, including retries', async () => {
  const parts = Array.from({length:7},(_,i)=>({bucket:'files',key:`large-file/part-${i+1}`}));
  const {api,requests} = setup(request => {
    if(request.url.pathname.endsWith('/shortlink_capabilities')) return {schema:2};
    if(request.url.pathname.endsWith('/begin_purge')) return {id:request.json.p_id,keys:parts};
    return {id:request.json.p_id};
  });
  const remaining = new Set(parts.map(part=>part.key));
  let fail=true;
  const remove = async object => {
    if(object.key===parts[3].key && fail) throw new Error('part unavailable');
    remaining.delete(object.key); // Missing objects are successful on a retry.
  };
  assert.equal((await api.purge(['segmented'],'alice',remove)).count,0);
  assert.equal(remaining.size,4);
  assert.equal(requests.some(request=>request.url.pathname.endsWith('/finish_purge')),false);
  fail=false;
  assert.equal((await api.purge(['segmented'],'alice',remove)).count,1);
  assert.equal(remaining.size,0);
  assert.deepEqual(requests.at(-1).json.p_completed_keys,parts);
});
