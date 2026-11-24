// Transport unchanged public Linear assets when full-file CDN requests reset.
// This helper is for reference capture only; it is never loaded by the product.
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gunzipSync,brotliDecompressSync} from 'node:zlib'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

const run = promisify(execFile)
const cache = process.env.LINEAR_REFERENCE_CACHE || join(tmpdir(),'linear-demo-public-assets')
mkdirSync(cache,{recursive:true})
const pending = new Map()
let active = 0
const waiters = []
export const assets = []
export const cleanURL = url => {const u=new URL(url);return u.origin+u.pathname}
const sha = body => createHash('sha256').update(body).digest('hex')

async function limited(fn) {
  if (active >= 4) await new Promise(resolve => waiters.push(resolve))
  else active++
  try {return await fn()}
  finally {const next=waiters.shift();if(next)next();else active--}
}

async function chunk(url,start,end,key) {
  return limited(async () => {
    const file=join(cache,`${key}-${start}`),headers=file+'.headers'
    await run('curl',['--http1.1','--fail','--silent','--show-error','--location','--range',`${start}-${end}`,'--header','Accept-Encoding: identity','--max-time','20','--max-filesize','20000000','--dump-header',headers,'--output',file,url])
    const all=readFileSync(headers,'utf8')
    const header=all.split(/\r?\n\r?\n/).filter(s => s.startsWith('HTTP/')).at(-1)||all
    const match=header.match(/^content-range:\s*bytes (\d+)-(\d+)\/(\d+)/im)
    return {body:readFileSync(file),range:match?match.slice(1).map(Number):null,type:header.match(/^content-type:\s*([^\r\n]+)/im)?.[1]||'application/octet-stream',encoding:header.match(/^content-encoding:\s*([^\r\n]+)/im)?.[1]||''}
  })
}

export async function getPublicAsset(url) {
  if(new URL(url).origin !== 'https://static.linear.app') throw Error('Expected a public static.linear.app asset')
  if(pending.has(url)) return pending.get(url)
  const job=(async () => {
    const key=sha(url),file=join(cache,key+'.complete'),meta=file+'.json'
    if(existsSync(file)&&existsSync(meta)) {
      const body=readFileSync(file),info=JSON.parse(readFileSync(meta,'utf8'))
      if(info.bytes!==body.length||info.sha256!==sha(body)) throw Error('Cached public asset failed integrity check')
      assets.push(info)
      return {body,...info}
    }
    const first=await chunk(url,0,65535,key)
    let body=first.body,count=1
    if(first.range) {
      const [start,end,total]=first.range
      if(start!==0||body.length!==end+1||total>20000000) throw Error('Invalid initial byte range')
      const starts=[]
      for(let pos=end+1;pos<total;pos+=65536) starts.push(pos)
      const rest=await Promise.all(starts.map(async pos => {
        const last=Math.min(pos+65535,total-1),item=await chunk(url,pos,last,key)
        if(!item.range||item.range[0]!==pos||item.range[1]!==last||item.range[2]!==total||item.body.length!==last-pos+1) throw Error('Invalid continuation byte range')
        return item.body
      }))
      count+=rest.length
      body=Buffer.concat([body,...rest])
      if(body.length!==total) throw Error('Incomplete public asset')
    }
    if(first.encoding==='gzip') body=gunzipSync(body)
    else if(first.encoding==='br') body=brotliDecompressSync(body)
    const info={type:first.type,url:cleanURL(url),bytes:body.length,ranges:count,sha256:sha(body)}
    writeFileSync(file,body)
    writeFileSync(meta,JSON.stringify(info))
    assets.push(info)
    return {body,...info}
  })()
  pending.set(url,job)
  return job
}
