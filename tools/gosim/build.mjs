import * as esbuild from 'esbuild';
const EMPTY = '/home/claude/gosim/stubs/empty.cjs';
const alias = {
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^@player$/ }, () => ({ path: '/home/claude/gosim/stubs/player.ts' }));
    b.onResolve({ filter: /^@enums$/ }, () => ({ path: '/tmp/bb/src/Enums.ts' }));
    b.onResolve({ filter: /helpers\/exceptionAlert$/ }, () => ({ path: '/home/claude/gosim/stubs/misc.ts' }));
    b.onResolve({ filter: /(^|\/)utils\/Utility$/ }, () => ({ path: '/home/claude/gosim/stubs/utility.ts' }));
    // any bare (non-relative, non-absolute) package -> inert proxy; UI code bundles but never runs
    b.onResolve({ filter: /^[^./]/ }, (a) => (a.path.startsWith('@player') || a.path.startsWith('@enums') ? undefined : { path: EMPTY }));
    b.onResolve({ filter: /\?raw$/ }, () => ({ path: EMPTY }));
    // All UI is .tsx; the Go engine is entirely .ts. Cutting .tsx removes React/MUI from the graph.
    b.onResolve({ filter: /\.tsx$/ }, () => ({ path: EMPTY }));
    b.onResolve({ filter: /^\.{1,2}\// }, async (a) => {
      const path = await import('node:path'); const fs = await import('node:fs');
      const p0 = path.resolve(a.resolveDir, a.path);
      for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (fs.existsSync(p0 + ext) && fs.statSync(p0 + ext).isFile()) return (p0 + ext).endsWith('.tsx') ? { path: EMPTY } : { path: p0 + ext };
      }
      return undefined;
    });
    b.onResolve({ filter: /\.(png|jpg|svg|md|txt|wip\.jsx)$/ }, () => ({ path: EMPTY }));
  },
};
await esbuild.build({
  entryPoints: ['entry.ts'], bundle: true, format: 'esm', outfile: 'bbgo.mjs',
  platform: 'node', target: 'node20', plugins: [alias], logLevel: 'error',
  banner: { js: `
const __stub = () => { const h = new Proxy(function(){}, { get:(t,k)=> k==='then'?undefined:h, set:()=>true, has:()=>true, apply:()=>h, construct:()=>({}) }); return h; };
for (const g of ['CSSStyleSheet','document','window','navigator','localStorage','sessionStorage','HTMLElement','Element','Node','MutationObserver','ResizeObserver','requestAnimationFrame','getComputedStyle','Audio','Image','matchMedia','IntersectionObserver','Worker','indexedDB','FileReader','Blob','URL']) {
  if (typeof globalThis[g] === 'undefined') globalThis[g] = __stub();
}
` },
  loader: { '.png': 'empty', '.jpg': 'empty', '.svg': 'empty' },
});
console.log('built');
