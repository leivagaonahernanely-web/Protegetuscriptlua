// Ofuscador 4: motor en JavaScript portado de Kingmor (KM-VM v7).
// No depende de Python ni de CLIs externas. Se usa en proceso desde obfuscateUncached().
"use strict";

import crypto from "crypto";

function obfuscateLua(plainSource, seedBuf) {
  const src = String(plainSource || "");
  if (!src.trim()) return src;

  // Deterministic byte stream when seedBuf is given (needed so multi-part
  // pack delivery can regenerate IDENTICAL obfuscated bytes across separate
  // HTTP requests / Railway replicas, with zero shared state). Falls back to
  // real crypto.randomBytes for one-shot calls (standalone OBF tool, preview).
  let __seedCounter = 0;
  let __seedBuf = Buffer.alloc(0);
  let __seedPos = 0;
  function nextBytes(n) {
    if (!seedBuf) return crypto.randomBytes(n);
    const out = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) {
      if (__seedPos >= __seedBuf.length) {
        const ctr = Buffer.alloc(4);
        ctr.writeUInt32BE(__seedCounter++, 0);
        __seedBuf = crypto.createHash("sha256").update(seedBuf).update(ctr).digest();
        __seedPos = 0;
      }
      out[i] = __seedBuf[__seedPos++];
    }
    return out;
  }

  const rndU32 = () => nextBytes(4).readUInt32BE(0) >>> 0;
  const id = () => {
    const A = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
    let s = A[rndU32() % A.length];
    for (let i = 1; i < 9 + (rndU32() % 5); i++) s += A[rndU32() % A.length];
    return s;
  };

  function umul32(a, b) {
    a >>>= 0; b >>>= 0;
    const a1 = a & 0xffff, a2 = a >>> 16, b1 = b & 0xffff, b2 = b >>> 16;
    return (((a1 * b1) + (((a1 * b2 + a2 * b1) & 0xffff) << 16)) >>> 0);
  }
  function scrambleLayer(input, key, seed, mul, add) {
    const out = Buffer.allocUnsafe(input.length);
    let s = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      s = (umul32(mul, s) + add) >>> 0;
      const k = key[i & 31];
      const drift = ((s >>> 8) ^ (i * 67 + 13)) & 255;
      const hi = (s >>> 16) & 255;
      out[i] = input[i] ^ k ^ drift ^ hi;
    }
    return out;
  }

  // --- ANTI-STATIC: randomize multipliers/adders from a pool of valid LCG constants ---
  // All are known good LCG params (Hull-Dobell theorem satisfied)
  const MUL_POOL = [1103515245, 214013, 1664525, 22695477, 1140671485, 134775813, 6364136223846793005n];
  const ADD_POOL = [12345, 2531011, 1013904223, 1, 12211, 2891336453, 1442695040888963407n];
  // Pick 3 distinct indices
  const pickedIdx = [];
  while (pickedIdx.length < 3) {
    const i = rndU32() % 6; // keep to non-BigInt entries (0-5)
    if (!pickedIdx.includes(i)) pickedIdx.push(i);
  }
  const muls = pickedIdx.map(i => MUL_POOL[i]);
  const adds = pickedIdx.map(i => ADD_POOL[i]);

  // 3-layer encrypt with independent random keys
  const keys = [nextBytes(32), nextBytes(32), nextBytes(32)];
  const seeds = [
    (rndU32() & 0x7fffffff) | 1,
    (rndU32() & 0x7fffffff) | 1,
    (rndU32() & 0x7fffffff) | 1,
  ];

  let buf = Buffer.from(src, "utf8");
  for (let L = 0; L < 3; L++) {
    buf = scrambleLayer(buf, keys[L], seeds[L], muls[L], adds[L]);
  }

  // final XOR with rolling position key
  const roll = nextBytes(16);
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= roll[i & 15] ^ ((i * 31) & 255);
  }
  const b64 = buf.toString("base64");

  const pieceSize = 1800 + (rndU32() % 700);
  const pieces = [];
  for (let i = 0; i < b64.length; i += pieceSize) pieces.push(b64.slice(i, i + pieceSize));
  const order = pieces.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rndU32() % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const shuffled = order.map((oi) => pieces[oi]);

  // opcodes
  const used = new Set();
  const op = () => {
    let n; do { n = 20 + (rndU32() % 200); } while (used.has(n));
    used.add(n); return n;
  };
  const OP = {
    ENV: op(), CHK: op(), LOADK: op(), UNSHUF: op(), CONCAT: op(),
    B64: op(), ROLL: op(), DEC2: op(), DEC1: op(), DEC0: op(),
    LOAD: op(), CALL: op(), RET: op(), NOP: op(),
  };

  const program = [OP.ENV, OP.CHK, OP.NOP];
  for (let i = 1; i <= shuffled.length; i++) program.push(OP.LOADK, i);
  program.push(OP.UNSHUF, OP.CONCAT, OP.B64, OP.ROLL, OP.DEC2, OP.DEC1, OP.DEC0, OP.LOAD, OP.CALL, OP.RET);

  function rndStr(n) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/!@#";
    let s = "";
    for (let i = 0; i < n; i++) s += A[rndU32() % A.length];
    return s;
  }
  const decoyN = Math.min(50, 10 + Math.floor(src.length / 1000));
  const decoys = Array.from({ length: decoyN }, () => `[=[${rndStr(100 + rndU32() % 180)}]=]`);
  const poolA = Array.from({ length: 48 }, () => rndU32() % 256).join(",");
  const poolB = Array.from({ length: 48 }, () => rndU32() % 1e6).join(",");

  const v = {};
  for (const k of ["ls","k0","k1","k2","km0","km1","km2","s0","s1","s2","m0","m1","m2","a0","a1","a2",
    "roll","rA","rB","chunks","ord","code","xor","b64","layer","umul","st","pc","n","decoy","pa","pb","tmp"]) {
    v[k] = id();
  }

  // --- ANTI-STATIC: mask each 32-byte key by XOR with a random 32-byte mask ---
  // Output: two arrays of 32 ints each, neither matches the tool's regex for "the real key"
  // Lua runtime recovers original key = masked[i] XOR kmask[i]
  const kMasked = keys.map(k => {
    const mask = nextBytes(32);
    const masked = Buffer.allocUnsafe(32);
    for (let i = 0; i < 32; i++) masked[i] = (k[i] + mask[i]) % 256;
    return { masked: Array.from(masked).join(","), mask: Array.from(mask).join(",") };
  });

  // --- ANTI-STATIC: split roll key into two 8-byte halves stored in separate vars ---
  const rollA = Array.from(roll.slice(0, 8)).join(",");
  const rollB = Array.from(roll.slice(8, 16)).join(",");

  // --- ANTI-STATIC: encode seeds as arithmetic expression, not raw int literal ---
  // seed = (base + offset) where base and offset are random but sum to original seed
  const seedExprs = seeds.map(s => {
    const offset = rndU32() & 0xffffff;
    const base = (s - offset + 0x100000000) >>> 0;
    return `(${base}+${offset})%4294967296`;
  });

  // --- ANTI-STATIC: encode mul/add constants via XOR expression ---
  const mulExprs = muls.map(m => {
    const x = rndU32() & 0xffff;
    return `(${m ^ x})~${x}`; // Lua: bit32 not available in all contexts; use math trick instead
  });
  // Fallback: encode as sum of two random halves (simpler, works without bit32)
  const mulEncoded = muls.map(m => {
    const half = rndU32() & 0x3fffffff;
    return `(${half}+(${(m - half + 0x100000000) >>> 0}))`;
  });
  const addEncoded = adds.map(a => {
    const half = rndU32() & 0x3fffffff;
    return `(${half}+(${(a - half + 0x100000000) >>> 0}))`;
  });

  // --- ANTI-STATIC: randomize comment header (blank, fake, or random string) ---
  const headerVariants = [
    ``,
    `-- ${rndStr(8 + rndU32() % 12)}`,
    `-- v${1 + rndU32() % 9}.${rndU32() % 10}`,
    `-- ${["runtime","loader","module","core","init","main"][rndU32() % 6]}`,
  ];
  const header = headerVariants[rndU32() % headerVariants.length];

  const chunksLua = shuffled.map((p, i) => `[${i + 1}]=[=[${p}]=]`).join(",");
  const ordLua = order.map((o, i) => `[${i + 1}]=${o + 1}`).join(",");
  const codeLua = program.join(",");
  const decoyLua = decoys.join(",");

  return `${header}
return(function()
local ${v.ls}=loadstring or load
if type(${v.ls})~="function" then
  local e=(_ENV or _G)
  if type(e)=="table" then ${v.ls}=e.loadstring or e.load end
end
if type(${v.ls})~="function" then return end
local ${v.km0}={${kMasked[0].mask}}
local ${v.k0}=(function() local t={${kMasked[0].masked}} local r={} for i=1,32 do r[i]=t[i]~=nil and (t[i]-${v.km0}[i])%256 or 0 end return r end)()
local ${v.km1}={${kMasked[1].mask}}
local ${v.k1}=(function() local t={${kMasked[1].masked}} local r={} for i=1,32 do r[i]=t[i]~=nil and (t[i]-${v.km1}[i])%256 or 0 end return r end)()
local ${v.km2}={${kMasked[2].mask}}
local ${v.k2}=(function() local t={${kMasked[2].masked}} local r={} for i=1,32 do r[i]=t[i]~=nil and (t[i]-${v.km2}[i])%256 or 0 end return r end)()
local ${v.s0}=${seedExprs[0]}
local ${v.s1}=${seedExprs[1]}
local ${v.s2}=${seedExprs[2]}
local ${v.m0}=${mulEncoded[0]}
local ${v.m1}=${mulEncoded[1]}
local ${v.m2}=${mulEncoded[2]}
local ${v.a0}=${addEncoded[0]}
local ${v.a1}=${addEncoded[1]}
local ${v.a2}=${addEncoded[2]}
local ${v.rA}={${rollA}}
local ${v.rB}={${rollB}}
local ${v.roll}=(function() local t={} for i=1,8 do t[i]=${v.rA}[i] end for i=1,8 do t[8+i]=${v.rB}[i] end return t end)()
local ${v.chunks}={${chunksLua}}
local ${v.ord}={${ordLua}}
local ${v.code}={${codeLua}}
local ${v.decoy}={${decoyLua}}
local ${v.pa}={${poolA}}
local ${v.pb}={${poolB}}
local function ${v.xor}(a,c)
  a=math.floor(a)%256
  c=math.floor(c)%256
  local r,p=0,1
  for _=1,8 do
    local x,y=a%2,c%2
    if x~=y then r=r+p end
    a=(a-x)/2
    c=(c-y)/2
    p=p*2
  end
  return r
end
local function ${v.umul}(a,b)
  a=a%4294967296
  b=b%4294967296
  local a1=a%65536
  local a2=math.floor(a/65536)%65536
  local b1=b%65536
  local b2=math.floor(b/65536)%65536
  local low=a1*b1
  local mid=a1*b2+a2*b1
  return (low+(mid%65536)*65536)%4294967296
end
local function ${v.b64}(data)
  local A="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  local L={}
  for i=1,#A do L[string.sub(A,i,i)]=i-1 end
  data=string.gsub(tostring(data or ""),"[^A-Za-z0-9%+/=]","")
  local out,val,bits={},0,0
  for i=1,#data do
    local ch=string.sub(data,i,i)
    if ch=="=" then break end
    local f=L[ch]
    if f then
      val=val*64+f
      bits=bits+6
      if bits>=8 then
        bits=bits-8
        local d=2^bits
        out[#out+1]=string.char(math.floor(val/d)%256)
        val=val%d
      end
    end
  end
  return table.concat(out)
end
local function ${v.layer}(raw,key,st,mul,add)
  local chunks,buf,bi={},{},0
  st=st%4294967296
  for i=1,#raw do
    st=(${v.umul}(mul,st)+add)%4294967296
    local k=key[((i-1)%32)+1]
    local drift=${v.xor}(math.floor(st/256),(i-1)*67+13)
    local hi=${v.xor}(math.floor(st/65536),0)
    bi=bi+1
    buf[bi]=string.char(${v.xor}(${v.xor}(${v.xor}(string.byte(raw,i),k),drift),hi))
    if bi>=4096 then
      chunks[#chunks+1]=table.concat(buf)
      buf={}
      bi=0
    end
  end
  if bi>0 then chunks[#chunks+1]=table.concat(buf) end
  return table.concat(chunks)
end
pcall(function() if #${v.pa}==99999 then print(${v.decoy}[1]) end end)
local ${v.st}={}
local ${v.pc}=1
local ${v.n}=#${v.code}
local ${v.tmp}=nil
while ${v.pc}<=${v.n} do
  local op=${v.code}[${v.pc}]
  ${v.pc}=${v.pc}+1
  if op==${OP.NOP} then
    ${v.tmp}=(${v.tmp} or 0)+1
  elseif op==${OP.ENV} then
    if type(${v.ls})~="function" then ${v.ls}=loadstring or load end
  elseif op==${OP.CHK} then
    if type(${v.chunks})~="table" or type(${v.code})~="table" then return end
  elseif op==${OP.LOADK} then
    local idx=${v.code}[${v.pc}]
    ${v.pc}=${v.pc}+1
    ${v.st}[#${v.st}+1]=${v.chunks}[idx]
  elseif op==${OP.UNSHUF} then
    local slots={}
    for i=1,#${v.st} do
      slots[${v.ord}[i]]=${v.st}[i]
    end
    ${v.st}=slots
  elseif op==${OP.CONCAT} then
    local parts={}
    for i=1,#${v.st} do parts[i]=${v.st}[i] end
    ${v.st}={table.concat(parts)}
  elseif op==${OP.B64} then
    ${v.st}[1]=${v.b64}(${v.st}[1])
  elseif op==${OP.ROLL} then
    local raw=${v.st}[1]
    local out,buf,bi={},{},0
    for i=1,#raw do
      local b=string.byte(raw,i)
      b=${v.xor}(${v.xor}(b,${v.roll}[((i-1)%16)+1]),((i-1)*31)%256)
      bi=bi+1
      buf[bi]=string.char(b)
      if bi>=4096 then out[#out+1]=table.concat(buf) buf={} bi=0 end
    end
    if bi>0 then out[#out+1]=table.concat(buf) end
    ${v.st}[1]=table.concat(out)
  elseif op==${OP.DEC2} then
    ${v.st}[1]=${v.layer}(${v.st}[1],${v.k2},${v.s2},${v.m2},${v.a2})
  elseif op==${OP.DEC1} then
    ${v.st}[1]=${v.layer}(${v.st}[1],${v.k1},${v.s1},${v.m1},${v.a1})
  elseif op==${OP.DEC0} then
    ${v.st}[1]=${v.layer}(${v.st}[1],${v.k0},${v.s0},${v.m0},${v.a0})
  elseif op==${OP.LOAD} then
    if type(${v.ls})~="function" then return end
    local fn,err=${v.ls}(${v.st}[1])
    if not fn then return end
    ${v.st}[1]=fn
  elseif op==${OP.CALL} then
    local fn=${v.st}[1]
    ${v.st}[1]=nil
    if type(fn)=="function" then
      local ok,err=pcall(fn)
      if not ok then error(tostring(err),0) end
    end
  elseif op==${OP.RET} then
    break
  end
end
end)()
`;
}

export { obfuscateLua };
