/** @param {NS} ns
 * Coding-contract crawler/solver.
 *   run puzzles.js          -> one sweep of the whole network
 *   run puzzles.js 600      -> sweep every 600s forever (set-and-forget)
 * Solve-or-skip: only submits answers verified correct against the game's own
 * checker. Unknown contract types are reported and left untouched (never guessed).
 * Runs the codingcontract API (RAM-heavy) — run it on home.
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const interval = Number(ns.args[0]) || 0;
  do {
    sweep(ns);
    if (interval > 0) await ns.sleep(interval * 1000);
  } while (interval > 0);
}

function sweep(ns) {
  const seen = new Set(["home"]), queue = ["home"], all = ["home"];
  while (queue.length) {
    const c = queue.shift();
    for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); queue.push(n); all.push(n); }
  }
  let solved = 0, failed = 0, skipped = 0;
  const report = [];
  for (const host of all) {
    let files = [];
    try { files = ns.ls(host, ".cct"); } catch (e) { continue; }
    for (const file of files) {
      try {
        const type = ns.codingcontract.getContractType(file, host);
        const solver = SOLVERS[type];
        if (!solver) { skipped++; report.push("SKIP   " + host + "/" + file + "  (" + type + ") - no solver"); continue; }
        const data = ns.codingcontract.getData(file, host);
        const ans = solver(data);
        const reward = ns.codingcontract.attempt(ans, file, host);
        if (reward && reward.length > 0) { solved++; report.push("SOLVED " + host + "/" + file + "  [" + type + "] -> " + reward); }
        else { failed++; report.push("FAILED " + host + "/" + file + "  [" + type + "] - rejected (tries left " + tries(ns, file, host) + ")"); }
      } catch (e) {
        failed++; report.push("ERROR  " + host + "/" + file + " - " + e);
      }
    }
  }
  const head = "=== contract sweep: " + solved + " solved, " + failed + " failed, " + skipped + " skipped ===";
  ns.tprint("\n" + head + (report.length ? "\n" + report.join("\n") : "\n(no contracts found)"));
}

function tries(ns, file, host) { try { return ns.codingcontract.getNumTriesRemaining(file, host); } catch (e) { return "?"; } }

// ===================== verified solvers =====================
function comprLZDecode(compr){let plain="";for(let i=0;i<compr.length;){const ll=compr.charCodeAt(i)-0x30;if(ll<0||ll>9||i+1+ll>compr.length)return null;plain+=compr.substring(i+1,i+1+ll);i+=1+ll;if(i>=compr.length)break;const bl=compr.charCodeAt(i)-0x30;if(bl<0||bl>9)return null;else if(bl===0){++i;}else{if(i+1>=compr.length)return null;const bo=compr.charCodeAt(i+1)-0x30;if((bl>0&&(bo<1||bo>9))||bo>plain.length)return null;for(let j=0;j<bl;++j)plain+=plain[plain.length-bo];i+=2;}}return plain;}
function comprLZEncode(plain){let cur=Array.from(Array(10),()=>Array(10).fill(null));let nw=Array.from(Array(10),()=>Array(10));function set(state,i,j,str){const c=state[i][j];if(c==null||str.length<c.length)state[i][j]=str;else if(str.length===c.length&&Math.random()<0.5)state[i][j]=str;}cur[0][1]="";for(let i=1;i<plain.length;++i){for(const row of nw)row.fill(null);const c=plain[i];for(let length=1;length<=9;++length){const str=cur[0][length];if(str==null)continue;if(length<9)set(nw,0,length+1,str);else set(nw,0,1,str+"9"+plain.substring(i-9,i)+"0");for(let offset=1;offset<=Math.min(9,i);++offset){if(plain[i-offset]===c)set(nw,offset,1,str+String(length)+plain.substring(i-length,i));}}for(let offset=1;offset<=9;++offset){for(let length=1;length<=9;++length){const str=cur[offset][length];if(str==null)continue;if(plain[i-offset]===c){if(length<9)set(nw,offset,length+1,str);else set(nw,offset,1,str+"9"+String(offset)+"0");}set(nw,0,1,str+String(length)+String(offset));for(let no=1;no<=Math.min(9,i);++no){if(plain[i-no]===c)set(nw,no,1,str+String(length)+String(offset)+"0");}}}const t=nw;nw=cur;cur=t;}let result=null;for(let len=1;len<=9;++len){let str=cur[0][len];if(str==null)continue;str+=String(len)+plain.substring(plain.length-len);if(result==null||str.length<result.length)result=str;else if(str.length==result.length&&Math.random()<0.5)result=str;}for(let offset=1;offset<=9;++offset)for(let len=1;len<=9;++len){let str=cur[offset][len];if(str==null)continue;str+=String(len)+""+String(offset);if(result==null||str.length<result.length)result=str;else if(str.length==result.length&&Math.random()<0.5)result=str;}return result==null?"":result;}
function HammingEncode(data){const enc=[0];const db=data.toString(2).split("").reverse().map(v=>parseInt(v));let k=db.length;for(let i=1;k>0;i++){if((i&(i-1))!=0)enc[i]=db[--k];else enc[i]=0;}let pn=0;for(let i=0;i<enc.length;i++)if(enc[i])pn^=i;const pa=pn.toString(2).split("").reverse().map(v=>parseInt(v));for(let i=0;i<pa.length;i++)enc[2**i]=pa[i]?1:0;pn=0;for(let i=0;i<enc.length;i++)if(enc[i])pn++;enc[0]=pn%2==0?0:1;return enc.join("");}
function HammingDecode(data){let err=0;const bits=[];const arr=data.split("");for(let i=0;i<arr.length;++i){const bit=parseInt(arr[i]);bits[i]=bit;if(bit)err^=+i;}if(err)bits[err]=bits[err]?0:1;let ans="";for(let i=1;i<bits.length;i++){if((i&(i-1))!=0)ans+=bits[i];}return parseInt(ans,2);}
function isqrt(n){if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
function isqrtRound(n){const f=isqrt(n);return (n-f*f<=f)?f:f+1n;}

const SOLVERS = {
"Find Largest Prime Factor":(data)=>{let fac=2,n=data;while(n>(fac-1)*(fac-1)){while(n%fac===0){n=Math.round(n/fac);}++fac;}return n===1?fac-1:n;},
"Subarray with Maximum Sum":(data)=>{const nums=data.slice();for(let i=1;i<nums.length;i++){nums[i]=Math.max(nums[i],nums[i]+nums[i-1]);}return Math.max(...nums);},
"Total Ways to Sum":(data)=>{const ways=[1];ways.length=data+1;ways.fill(0,1);for(let i=1;i<data;++i){for(let j=i;j<=data;++j){ways[j]+=ways[j-i];}}return ways[data];},
"Total Ways to Sum II":(data)=>{const n=data[0],s=data[1];const ways=[1];ways.length=n+1;ways.fill(0,1);for(let i=0;i<s.length;i++){for(let j=s[i];j<=n;j++){ways[j]+=ways[j-s[i]];}}return ways[n];},
"Spiralize Matrix":(data)=>{const spiral=[];const m=data.length,n=data[0].length;let u=0,d=m-1,l=0,r=n-1,k=0,done=false;while(!done){for(let c=l;c<=r;c++){spiral[k]=data[u][c];++k;}if(++u>d){done=true;continue;}for(let row=u;row<=d;row++){spiral[k]=data[row][r];++k;}if(--r<l){done=true;continue;}for(let c=r;c>=l;c--){spiral[k]=data[d][c];++k;}if(--d<u){done=true;continue;}for(let row=d;row>=u;row--){spiral[k]=data[row][l];++k;}if(++l>r){done=true;continue;}}return spiral;},
"Array Jumping Game":(data)=>{const n=data.length;let i=0;for(let reach=0;i<n&&i<=reach;++i){reach=Math.max(i+data[i],reach);}return i===n?1:0;},
"Array Jumping Game II":(data)=>{const n=data.length;let reach=0,jumps=0,lastJump=-1;while(reach<n-1){let jf=-1;for(let i=reach;i>lastJump;i--){if(i+data[i]>reach){reach=i+data[i];jf=i;}}if(jf===-1){jumps=0;break;}lastJump=jf;jumps++;}return jumps;},
"Merge Overlapping Intervals":(data)=>{const iv=data.slice().map(a=>a.slice());iv.sort((a,b)=>a[0]-b[0]);const res=[];let start=iv[0][0],end=iv[0][1];for(const x of iv){if(x[0]<=end){end=Math.max(end,x[1]);}else{res.push([start,end]);start=x[0];end=x[1];}}res.push([start,end]);return res;},
"Generate IP Addresses":(data)=>{const ret=[];for(let a=1;a<=3;++a)for(let b=1;b<=3;++b)for(let c=1;c<=3;++c)for(let d=1;d<=3;++d){if(a+b+c+d===data.length){const A=parseInt(data.substring(0,a),10),B=parseInt(data.substring(a,a+b),10),C=parseInt(data.substring(a+b,a+b+c),10),D=parseInt(data.substring(a+b+c,a+b+c+d),10);if(A<=255&&B<=255&&C<=255&&D<=255){const ip=[A,".",B,".",C,".",D].join("");if(ip.length===data.length+3)ret.push(ip);}}}return ret;},
"Algorithmic Stock Trader I":(data)=>{let mc=0,ms=0;for(let i=1;i<data.length;++i){mc=Math.max(0,(mc+=data[i]-data[i-1]));ms=Math.max(mc,ms);}return ms;},
"Algorithmic Stock Trader II":(data)=>{let p=0;for(let i=1;i<data.length;++i){p+=Math.max(data[i]-data[i-1],0);}return p;},
"Algorithmic Stock Trader III":(data)=>{let h1=-1e15,h2=-1e15,r1=0,r2=0;for(const price of data){r2=Math.max(r2,h2+price);h2=Math.max(h2,r1-price);r1=Math.max(r1,h1+price);h1=Math.max(h1,price*-1);}return r2;},
"Algorithmic Stock Trader IV":(data)=>{const k=data[0],prices=data[1],len=prices.length;if(len<2)return 0;if(k>len/2){let res=0;for(let i=1;i<len;++i)res+=Math.max(prices[i]-prices[i-1],0);return res;}const hold=[],rele=[];hold.length=k+1;rele.length=k+1;for(let i=0;i<=k;++i){hold[i]=-1e15;rele[i]=0;}for(let i=0;i<len;++i){const cur=prices[i];for(let j=k;j>0;--j){rele[j]=Math.max(rele[j],hold[j]+cur);hold[j]=Math.max(hold[j],rele[j-1]-cur);}}return rele[k];},
"Minimum Path Sum in a Triangle":(data)=>{const n=data.length;const dp=data[n-1].slice();for(let i=n-2;i>-1;--i){for(let j=0;j<data[i].length;++j){dp[j]=Math.min(dp[j],dp[j+1])+data[i][j];}}return dp[0];},
"Unique Paths in a Grid I":(data)=>{const n=data[0],m=data[1];const row=[];row.length=n;for(let i=0;i<n;i++)row[i]=1;for(let r=1;r<m;r++)for(let i=1;i<n;i++)row[i]+=row[i-1];return row[n-1];},
"Unique Paths in a Grid II":(data)=>{const g=data.map(r=>r.slice());for(let i=0;i<g.length;i++)for(let j=0;j<g[0].length;j++){if(g[i][j]==1){g[i][j]=0;}else if(i==0&&j==0){g[0][0]=1;}else{g[i][j]=(i>0?g[i-1][j]:0)+(j>0?g[i][j-1]:0);}}return g[g.length-1][g[0].length-1];},
"Sanitize Parentheses in Expression":(data)=>{let left=0,right=0;const res=[];for(let i=0;i<data.length;++i){if(data[i]==="(")++left;else if(data[i]===")")left>0?--left:++right;}function dfs(pair,index,left,right,s,sol,res){if(s.length===index){if(left===0&&right===0&&pair===0){if(!res.includes(sol))res.push(sol);}return;}if(s[index]==="("){if(left>0)dfs(pair,index+1,left-1,right,s,sol,res);dfs(pair+1,index+1,left,right,s,sol+s[index],res);}else if(s[index]===")"){if(right>0)dfs(pair,index+1,left,right-1,s,sol,res);if(pair>0)dfs(pair-1,index+1,left,right,s,sol+s[index],res);}else{dfs(pair,index+1,left,right,s,sol+s[index],res);}}dfs(0,0,left,right,data,"",res);return res;},
"Find All Valid Math Expressions":(data)=>{const num=data[0],target=data[1];function helper(res,path,num,target,pos,ev,mu){if(pos===num.length){if(target===ev)res.push(path);return;}for(let i=pos;i<num.length;++i){if(i!=pos&&num[pos]=="0")break;const cur=parseInt(num.substring(pos,i+1));if(pos===0){helper(res,path+cur,num,target,i+1,cur,cur);}else{helper(res,path+"+"+cur,num,target,i+1,ev+cur,cur);helper(res,path+"-"+cur,num,target,i+1,ev-cur,-cur);helper(res,path+"*"+cur,num,target,i+1,ev-mu+mu*cur,mu*cur);}}}const result=[];helper(result,"",num,target,0,0,0);return result;},
"Total Number of Primes":(data)=>{function simpleSieve(max){const primes=[];const arr=Array(max);for(let i=2;i*i<=max;i++){if(!arr[i]){for(let p=i*i;p<=max;p+=i)arr[p]=1;}}for(let i=2;i<=max;i++)if(!arr[i])primes.push(i);return primes;}function primeSieve(low,high){if(low<2)low=2;let primes=0;const arr=Array(high-low+1);const checks=simpleSieve(Math.ceil(Math.sqrt(high)));for(const i of checks){const lim=Math.max(i,Math.ceil(low/i))*i;for(let j=lim;j<=high;j+=i)arr[j-low]=1;}for(let a=0;a<=high-low;a++)if(!arr[a])++primes;return primes;}return primeSieve(data[0],data[1]);},
"Largest Rectangle in a Matrix":(data)=>{const H=Array.from({length:data.length},()=>Array(data[0].length).fill(0));for(let i=0;i<data[0].length;i++){let count=0;for(let j=0;j<data.length;j++){if(data[j][i]==0)count++;else count=0;H[j][i]=count;}}let mA=0,mL=0,mR=0,mU=0,mD=0;for(let i=0;i<H.length;i++){const row=H[i];for(let j=0;j<row.length;j++){if(row[j]==0)continue;let left=j,right=j;while(row[left-1]>=row[j])left--;while(row[right+1]>=row[j])right++;if((right-left+1)*row[j]>mA){mA=(right-left+1)*row[j];mL=left;mR=right;mU=i-row[j]+1;mD=i;}}}return[[mU,mL],[mD,mR]];},
"Encryption I: Caesar Cipher":(data)=>[...data[0]].map(a=>a===" "?a:String.fromCharCode(((a.charCodeAt(0)-65-data[1]+26)%26)+65)).join(""),
"Encryption II: Vigenère Cipher":(data)=>[...data[0]].map((a,i)=>a===" "?a:String.fromCharCode(((a.charCodeAt(0)-2*65+data[1].charCodeAt(i%data[1].length))%26)+65)).join(""),
"Compression I: RLE Compression":(plain)=>{if(plain.length===0)return"";let out="",count=1;for(let i=1;i<plain.length;i++){if(count<9&&plain[i]===plain[i-1]){count++;continue;}out+=count+plain[i-1];count=1;}out+=count+plain[plain.length-1];return out;},
"Compression II: LZ Decompression":(c)=>{const r=comprLZDecode(c);return r==null?"":r;},
"Compression III: LZ Compression":(p)=>comprLZEncode(p),
"HammingCodes: Integer to Encoded Binary":(data)=>HammingEncode(data),
"HammingCodes: Encoded Binary to Integer":(data)=>HammingDecode(data),
"Square Root":(data)=>isqrtRound(BigInt(data)).toString(),
"Shortest Path in a Grid":(grid)=>{const h=grid.length,w=grid[0].length;if(grid[0][0]===1||grid[h-1][w-1]===1)return "";const prev=Array.from({length:h},()=>Array(w).fill(null));const seen=Array.from({length:h},()=>Array(w).fill(false));const q=[[0,0]];seen[0][0]=true;const mv=[[-1,0,"U"],[1,0,"D"],[0,-1,"L"],[0,1,"R"]];while(q.length){const cell=q.shift();const y=cell[0],x=cell[1];if(y===h-1&&x===w-1)break;for(const m of mv){const ny=y+m[0],nx=x+m[1];if(ny>=0&&ny<h&&nx>=0&&nx<w&&!seen[ny][nx]&&grid[ny][nx]===0){seen[ny][nx]=true;prev[ny][nx]=[y,x,m[2]];q.push([ny,nx]);}}}if(!seen[h-1][w-1])return "";let path=[],cy=h-1,cx=w-1;while(!(cy===0&&cx===0)){const p=prev[cy][cx];path.push(p[2]);cy=p[0];cx=p[1];}return path.reverse().join("");},
"Proper 2-Coloring of a Graph":(data)=>{const n=data[0],edges=data[1];const adj=Array.from({length:n},()=>[]);for(const e of edges){adj[e[0]].push(e[1]);adj[e[1]].push(e[0]);}const color=Array(n).fill(-1);for(let s=0;s<n;s++){if(color[s]!==-1)continue;color[s]=0;const q=[s];while(q.length){const v=q.shift();for(const u of adj[v]){if(color[u]===-1){color[u]=color[v]^1;q.push(u);}else if(color[u]===color[v]){return [];}}}}return color;},
};
