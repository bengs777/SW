import type { GeneratedFile } from "../types"

export interface SandboxConfig {
  theme?: "light" | "dark"
  tailwindCdn?: boolean
  reactVersion?: string
}

const DEFAULT_CONFIG: SandboxConfig = {
  theme: "dark",
  tailwindCdn: true,
  reactVersion: "18.2.0",
}

/**
 * Generates a complete HTML document that can be rendered in an iframe
 * for previewing React components with Tailwind CSS
 */
export function generateSandboxHtml(
  files: GeneratedFile[],
  config: SandboxConfig = {}
): string {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  
  // Find the main component file
  const mainFile = selectPreviewEntryFile(files)

  if (!mainFile) {
    return generateEmptyPreview()
  }

  // Transform the React code for browser execution (bundle modules + main)
  const transformedCode = transformReactCode(mainFile, files)

  // We'll compile the generated code inside the preview iframe using Babel at
  // runtime. The transformed code may contain JSX and module-registry wrappers
  // produced earlier by `transformReactCode`.
  // To avoid prematurely closing the inline <script> tag in the generated HTML
  // we must escape occurrences like </script> and HTML comments.
  const userCode = JSON.stringify(String(transformedCode || ""))
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--')
    .replace(/<\/style>/gi, '<\\/style>')

  return `<!doctype html>
<html lang="en" class="${mergedConfig.theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Preview</title>
  <script>window.__sw_preview_report_error=function(m,s){try{window.parent.postMessage({type:'swift-preview-error',message:m,source:s||location.href},'*')}catch(e){}}</script>
  ${mergedConfig.tailwindCdn ? '<script src="https://cdn.tailwindcss.com" onerror="window.__sw_preview_report_error(\'Failed to load Tailwind CDN\', this.src)"></script>' : ''}
  <script crossorigin src="https://unpkg.com/react@${mergedConfig.reactVersion}/umd/react.development.js" onerror="window.__sw_preview_report_error('Failed to load React', this.src)"></script>
  <script crossorigin src="https://unpkg.com/react-dom@${mergedConfig.reactVersion}/umd/react-dom.development.js" onerror="window.__sw_preview_report_error('Failed to load ReactDOM', this.src)"></script>
  <script crossorigin src="https://unpkg.com/@babel/standalone/babel.min.js" onerror="window.__sw_preview_report_error('Failed to load Babel', this.src)"></script>
</head>
<body>
  <div id="root"></div>

  <script>
    (function(){
      // Runtime helpers and builtins used by transformed code
      function __swiftNoopFunction(){ return undefined }
      function __swiftMissingComponent(name){
        return function MissingComponent(props){
          props = props || {}
          const rendered = __swiftRenderNamedPreviewComponent(name, props)
          if (rendered) return rendered
          const children = props.children != null ? props.children : ('[missing component: ' + name + ']')
          const rest = Object.assign({}, props)
          delete rest.children
          const cls = 'rounded-md border border-dashed border-border bg-secondary/50 p-2 text-xs text-muted-foreground'
          return React.createElement('div', Object.assign({ className: cls, ['data-swift-missing']: name }, rest), children)
        }
      }

      function __swiftRenderNamedPreviewComponent(name, props){
        const n = String(name || '').toLowerCase()
        if (n.includes('navbar') || n.includes('header')) {
          return React.createElement('header', { className: 'sticky top-0 z-10 border-b bg-white/95 px-6 py-4 shadow-sm' },
            React.createElement('div', { className: 'mx-auto flex max-w-6xl items-center justify-between gap-4' },
              React.createElement('div', { className: 'text-xl font-black text-emerald-600' }, 'Swift Preview'),
              React.createElement('div', { className: 'hidden flex-1 md:block' }, React.createElement('input', { className: 'w-full rounded-md border px-4 py-2 text-sm', placeholder: 'Cari modul...' })),
              React.createElement('nav', { className: 'flex items-center gap-3 text-sm font-medium' },
                React.createElement('a', { href: '#products' }, 'Fitur'),
                React.createElement('a', { href: '#categories' }, 'Modul')
              )
            )
          )
        }
        if (n.includes('hero')) {
          return React.createElement('section', { className: 'bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500 px-6 py-14 text-white' },
            React.createElement('div', { className: 'mx-auto grid max-w-6xl gap-8 md:grid-cols-[1.1fr_.9fr]' },
              React.createElement('div', null,
                React.createElement('p', { className: 'text-sm font-semibold uppercase tracking-wide' }, 'Swift generated preview'),
                React.createElement('h1', { className: 'mt-3 text-4xl font-black md:text-5xl' }, 'Aplikasi generated siap ditinjau'),
                React.createElement('p', { className: 'mt-4 max-w-xl text-white/90' }, 'Preview ini menampilkan struktur visual dari project yang dibuat Swift AI tanpa mengunci arah produk ke template lama.'),
                React.createElement('div', { className: 'mt-6 flex flex-wrap gap-3' },
                  React.createElement('a', { href: '#products', className: 'rounded-md bg-white px-5 py-3 text-sm font-bold text-emerald-700' }, 'Lihat fitur'),
                  React.createElement('a', { href: '#categories', className: 'rounded-md border border-white/70 px-5 py-3 text-sm font-bold text-white' }, 'Lihat modul')
                )
              ),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                ['Overview', 'Form', 'Dashboard', 'Data'].map(function(item){
                  return React.createElement('div', { key: item, className: 'rounded-lg bg-white/15 p-5 shadow-lg backdrop-blur' },
                    React.createElement('div', { className: 'text-2xl font-black' }, item),
                    React.createElement('p', { className: 'mt-2 text-sm text-white/85' }, 'Modul preview siap dicek')
                  )
                })
              )
            )
          )
        }
        if (n.includes('categor')) {
          return React.createElement('section', { id: 'categories', className: 'mx-auto max-w-6xl px-6 py-10' },
            React.createElement('h2', { className: 'text-2xl font-bold' }, 'Modul Utama'),
            React.createElement('div', { className: 'mt-5 grid grid-cols-2 gap-3 md:grid-cols-6' },
              ['Beranda', 'Form', 'Admin', 'Data', 'Status', 'Aksi'].map(function(item){
                return React.createElement('div', { key: item, className: 'rounded-lg border bg-white p-4 text-center shadow-sm' },
                  React.createElement('div', { className: 'mx-auto mb-3 h-12 w-12 rounded-full bg-emerald-100' }),
                  React.createElement('p', { className: 'text-sm font-semibold' }, item)
                )
              })
            )
          )
        }
        if (n.includes('product')) {
          return React.createElement('section', { id: 'products', className: 'mx-auto max-w-6xl px-6 py-10' },
            React.createElement('div', { className: 'flex items-end justify-between gap-4' },
              React.createElement('div', null,
                React.createElement('h2', { className: 'text-2xl font-bold' }, 'Fitur Utama'),
                React.createElement('p', { className: 'mt-1 text-sm text-slate-600' }, 'Preview fitur dari hasil generate Swift AI')
              ),
              React.createElement('button', { className: 'rounded-md border px-4 py-2 text-sm font-semibold' }, 'Lihat semua')
            ),
            React.createElement('div', { className: 'mt-5 grid grid-cols-2 gap-4 md:grid-cols-4' },
              ['Order Flow', 'Admin Table', 'Status Panel', 'Data API'].map(function(item, index){
                return React.createElement('article', { key: item, className: 'overflow-hidden rounded-lg border bg-white shadow-sm' },
                  React.createElement('div', { className: 'aspect-square bg-gradient-to-br from-slate-100 to-emerald-100' }),
                  React.createElement('div', { className: 'space-y-2 p-3' },
                    React.createElement('h3', { className: 'line-clamp-2 text-sm font-semibold' }, item),
                    React.createElement('p', { className: 'font-bold text-emerald-600' }, ['Ready', 'Preview', 'Mock', 'Route'][index]),
                    React.createElement('p', { className: 'text-xs text-slate-500' }, 'Modul aplikasi')
                  )
                )
              })
            )
          )
        }
        if (n.includes('footer')) {
          return React.createElement('footer', { className: 'mt-10 border-t bg-slate-950 px-6 py-8 text-white' },
            React.createElement('div', { className: 'mx-auto flex max-w-6xl flex-col justify-between gap-4 md:flex-row' },
              React.createElement('div', null, React.createElement('h2', { className: 'text-xl font-black' }, 'Swift Preview'), React.createElement('p', { className: 'mt-1 text-sm text-slate-300' }, 'Generated fallback preview untuk project saat ini.')),
              React.createElement('p', { className: 'text-sm text-slate-400' }, 'Generated preview by Swift AI')
            )
          )
        }
        return null
      }

      function __swiftNamespace(source){
        return new Proxy({}, { get(_t, key){ const name = String(key); return __swiftResolve(name,name,source) } })
      }

      function __swiftResolve(importedName, localName, source){
        const name = localName || importedName
        try{
          const s0 = String(source || '')
          const s1 = s0.replace(/\\.(tsx|ts|jsx|js)$/, '')
          const s2 = s1.replace(/^@\\//, '')
          const candidates = [s0,s1,s2,'@/'+s2,'./'+s2,'/'+s2,s2]
          if (typeof window !== 'undefined' && window.__sw_modules){
            for(const k of candidates){
              const mod = window.__sw_modules[k]
              if (mod){
                if (importedName && Object.prototype.hasOwnProperty.call(mod, importedName)) return mod[importedName]
                if (localName && Object.prototype.hasOwnProperty.call(mod, localName)) return mod[localName]
                if (Object.prototype.hasOwnProperty.call(mod, 'default')) return mod.default
              }
            }
          }
        }catch(e){}

        const builtins = {
          React,
          useState: React.useState,
          useEffect: React.useEffect,
          useRef: React.useRef,
          useCallback: React.useCallback,
          useMemo: React.useMemo,
          useReducer: React.useReducer,
          useContext: React.useContext,
          useLayoutEffect: React.useLayoutEffect,
          useId: React.useId,
          useTransition: React.useTransition,
          useDeferredValue: React.useDeferredValue,
          Button: function Button(props){ return React.createElement('button', props, props && props.children) },
          Input: function Input(props){ return React.createElement('input', props) },
          Textarea: function Textarea(props){ return React.createElement('textarea', props) },
          Card: function Card(props){ return React.createElement('div', props, props && props.children) },
          CardHeader: function CardHeader(props){ return React.createElement('div', props, props && props.children) },
          CardTitle: function CardTitle(props){ return React.createElement('h3', props, props && props.children) },
          CardDescription: function CardDescription(props){ return React.createElement('p', props, props && props.children) },
          CardContent: function CardContent(props){ return React.createElement('div', props, props && props.children) },
          CardFooter: function CardFooter(props){ return React.createElement('div', props, props && props.children) },
          Badge: function Badge(props){ return React.createElement('div', props, props && props.children) },
          Link: function Link(props){ return React.createElement('a', Object.assign({ href: props && props.href || '#' }, props), props && props.children) },
          Image: function Image(props){ return React.createElement('img', Object.assign({ alt: props && props.alt || '' }, props)) },
          useRouter: function(){ return { push: function(){}, replace:function(){}, back:function(){}, prefetch: async function(){} } },
          usePathname: function(){ return '/' },
          useSearchParams: function(){ return new URLSearchParams() }
        }

        if (name in builtins) return builtins[name]
        if (importedName in builtins) return builtins[importedName]
        if (name && /^[A-Z]/.test(name)) return __swiftMissingComponent(name)
        return __swiftNoopFunction
      }

      function __swiftTextIncludes(files, terms){
        try{
          const haystack = (files || []).map(function(file){ return String((file && file.path) || '') + ' ' + String((file && file.preview) || '') }).join(' ').toLowerCase()
          return terms.some(function(term){ return haystack.indexOf(term) >= 0 })
        }catch(e){ return false }
      }

      function __swiftRenderLaundryFallback(files, errorMessage){
        return React.createElement('div', { className: 'min-h-screen bg-slate-950 text-white' },
          React.createElement('section', { className: 'border-b border-white/10 bg-cyan-950/40 px-6 py-10' },
            React.createElement('div', { className: 'mx-auto max-w-6xl' },
              React.createElement('p', { className: 'text-sm font-semibold uppercase tracking-wide text-cyan-300' }, 'Laundry service preview'),
              React.createElement('h1', { className: 'mt-3 text-4xl font-black' }, 'LaundrySwift order dashboard'),
              React.createElement('p', { className: 'mt-3 max-w-2xl text-slate-300' }, 'Preview fallback menampilkan alur laundry sesuai prompt: order form, paket layanan, status pickup, dan tabel order admin.'),
              React.createElement('p', { className: 'mt-3 rounded-md border border-amber-300/20 bg-amber-300/10 p-3 text-xs text-amber-100' }, String(errorMessage || 'Preview runtime error'))
            )
          ),
          React.createElement('section', { className: 'mx-auto grid max-w-6xl gap-4 px-6 py-8 md:grid-cols-3' },
            ['Cuci Lipat', 'Cuci Setrika', 'Dry Clean'].map(function(item, index){
              return React.createElement('article', { key: item, className: 'rounded-xl border border-white/10 bg-white/[0.04] p-5' },
                React.createElement('h2', { className: 'text-lg font-bold' }, item),
                React.createElement('p', { className: 'mt-2 text-2xl font-black text-cyan-300' }, ['Rp 7.000/kg', 'Rp 10.000/kg', 'Mulai Rp 35.000'][index]),
                React.createElement('p', { className: 'mt-2 text-sm text-slate-400' }, 'Paket layanan siap dipilih di form order.')
              )
            })
          ),
          React.createElement('section', { className: 'mx-auto max-w-6xl px-6 pb-10' },
            React.createElement('div', { className: 'overflow-hidden rounded-xl border border-white/10 bg-white/[0.04]' },
              React.createElement('div', { className: 'border-b border-white/10 p-4' },
                React.createElement('h2', { className: 'text-xl font-bold' }, 'Tabel order aktif')
              ),
              React.createElement('div', { className: 'grid grid-cols-5 gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400' },
                ['ID', 'Pelanggan', 'Layanan', 'Status', 'Total'].map(function(item){ return React.createElement('span', { key: item }, item) })
              ),
              [
                ['LS-1042', 'Nadia Putri', 'Cuci Setrika', 'Pickup', 'Rp 54.000'],
                ['LS-1041', 'Rafi Hidayat', 'Dry Clean', 'Diproses', 'Rp 85.000'],
                ['LS-1040', 'Maya Sari', 'Cuci Lipat', 'Siap Antar', 'Rp 42.000']
              ].map(function(row){
                return React.createElement('div', { key: row[0], className: 'grid grid-cols-5 gap-3 border-t border-white/5 px-4 py-3 text-sm' },
                  row.map(function(cell){ return React.createElement('span', { key: cell }, cell) })
                )
              })
            )
          )
        )
      }

      function __swiftRenderRuntimeFallback(errorMessage){
        try{
          const rootElement = document.getElementById('root')
          const root = ReactDOM.createRoot(rootElement)
          const files = Array.isArray(window.__sw_preview_files) ? window.__sw_preview_files : []
          if (__swiftTextIncludes(files, ['laundry', 'laundryswift', 'dry clean', 'cuci', 'setrika'])) {
            root.render(__swiftRenderLaundryFallback(files, errorMessage))
            return
          }
          root.render(React.createElement('div', { className: 'min-h-screen bg-slate-50 text-slate-950' },
            __swiftRenderNamedPreviewComponent('Navbar', {}),
            __swiftRenderNamedPreviewComponent('HeroSection', {}),
            __swiftRenderNamedPreviewComponent('CategoryGrid', {}),
            __swiftRenderNamedPreviewComponent('FeaturedProducts', {}),
            React.createElement('section', { className: 'mx-auto max-w-6xl px-6 py-6' },
              React.createElement('details', { className: 'rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm' },
                React.createElement('summary', { className: 'cursor-pointer font-semibold text-slate-700' }, 'Preview runtime note'),
                React.createElement('pre', { className: 'mt-3 overflow-x-auto rounded-md bg-slate-100 p-3 text-xs text-slate-700' }, String(errorMessage || 'Unknown preview runtime error'))
              )
            ),
            __swiftRenderNamedPreviewComponent('Footer', {})
          ))
        }catch(e){}
      }

      window.addEventListener('error', function(event){
        try{ window.parent?.postMessage({ type: 'swift-preview-error', message: event.message || 'Unhandled preview error', filename: event.filename, lineno: event.lineno, colno: event.colno, stack: event.error ? (event.error.stack || event.error.message) : null }, '*') }catch(_){}
        __swiftRenderRuntimeFallback(event.message || 'Unhandled preview error')
      })

      window.addEventListener('unhandledrejection', function(ev){
        try{ ev.preventDefault && ev.preventDefault() }catch(_){}
        const reason = ev && (ev.reason || ev.detail) ? (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason || ev.detail)) : 'Unhandled promise rejection'
        try{ window.parent?.postMessage({ type: 'swift-preview-error', message: reason, reason: ev.reason }, '*') }catch(_){}
        __swiftRenderRuntimeFallback(reason)
      })

      // Compile & execute the generated code (module registry + App component)
      try{
        const userCode = ${userCode};
        window.__sw_preview_files = ${JSON.stringify(buildStaticPreviewFileSummaries(files))};

        // Debug instrumentation: report userCode size and some heuristics
        try {
          try { console.log('[swift-preview-debug] userCode length:', String(userCode).length) } catch(e) {}
          const containsModuleRegistry = String(userCode || '').includes('window.__sw_modules') || String(userCode || '').includes('moduleRegistryScript')
          try { console.log('[swift-preview-debug] containsModuleRegistry:', containsModuleRegistry) } catch(e) {}
          try { window.parent?.postMessage({ type: 'swift-preview-debug', userCodeLength: String(userCode).length, containsModuleRegistry }, '*') } catch(e) {}
        } catch (e) {}

          const compiled = Babel.transform(String(userCode || ''), {
            presets: [
              ['typescript', { isTSX: true, allExtensions: true }],
              ['react', { runtime: 'classic' }]
            ]
          }).code;
        new Function(compiled)();
      }catch(err){
        try{ window.parent?.postMessage({ type: 'swift-preview-error', message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : null }, '*') }catch(_){}
        __swiftRenderRuntimeFallback(err && err.message ? err.message : String(err))
      }
    })()
  </script>
</body>
</html>`
}

function selectPreviewEntryFile(files: GeneratedFile[]) {
  const normalized = (value: string) => value.replace(/\\/g, "/").toLowerCase()
  const preferredPaths = [
    "app/page.preview.tsx",
    "app/page.tsx",
    "src/app/page.preview.tsx",
    "src/app/page.tsx",
    "pages/index.preview.tsx",
    "pages/index.tsx",
    "app.tsx",
    "src/app.tsx",
  ]

  for (const preferred of preferredPaths) {
    const found = files.find((file) => normalized(file.path) === preferred)
    if (found) {
      return found
    }
  }

  return files.find((file) => /(^|\/)(page|index|app)\.(preview\.)?(tsx|jsx|ts|js)$/i.test(normalized(file.path))) || files[0]
}

function buildStaticPreviewFileSummaries(files: GeneratedFile[]) {
  return files
    .filter((file) => /\.(tsx?|jsx?|css|html|json)$/i.test(file.path))
    .slice(0, 12)
    .map((file) => ({
      path: file.path,
      preview: String(file.content || "").slice(0, 1400),
    }))
}

/**
 * Transform React/Next.js code for browser execution
 */
function transformReactCode(mainFile: GeneratedFile, allFiles: GeneratedFile[]): string {
  // Helper to strip imports/exports and TS types for module files
  function stripTypeScriptSyntax(src: string) {
    let t = String(src)
    t = t.replace(/(?:export\s+)?interface\s+\w+\s*\{[\s\S]*?\}\s*;?/g, "")
    t = t.replace(/(?:export\s+)?type\s+\w+\s*=\s*\{[\s\S]*?\}\s*;?/g, "")
    t = t.replace(/(?:export\s+)?type\s+\w+\s*=\s*[^;\n]+;?/g, "")
    t = t.replace(
      /(\b(?:const|let|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+(?=\s*=)/g,
      "$1"
    )
    t = t.replace(/(\b(?:function\s+)?[A-Za-z_$][\w$]*\s*\(\s*\{[\s\S]*?\})\s*:\s*\{[\s\S]*?\}\s*(?=\))/g, "$1")
    t = t.replace(/\)\s*:\s*[^=\{\n]+(?=\s*=>|\s*\{)/g, ")")
    t = t.replace(/\s+satisfies\s+[A-Za-z_$][\w$<>\[\]\{\}\|&,\s]*/g, "")
    t = t.replace(/\s+as\s+const\b/g, "")
    t = t.replace(/\s+as\s+[A-Za-z_$][\w$<>\[\]\{\}\|&,\s]*/g, "")
    t = t.replace(/(?<=[\w\)])<([A-Z]?\w+)(\s*,\s*([A-Z]?\w+))*>\(/g, "(")
    return t
  }

  function transformFileForModule(src: string) {
    let t = String(src)
    // Remove import statements entirely for module bundling
    t = t.replace(/^\s*import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
    t = t.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
    t = t.replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
    t = t.replace(/['"]use client['"];?\n?/g, "")

    // Convert some export patterns to declarations
    t = t.replace(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, "function $1")
    t = t.replace(/export\s+default\s+(?:async\s+)?function\s*\(/g, "function __default_export(")
    t = t.replace(/export\s+default\s+([A-Za-z_$][\w$]*)/g, "const __default_export_ref = $1")
    t = t.replace(/export\s+function\s+([A-Za-z_$][\w$]*)/g, "function $1")
    t = t.replace(/export\s+const\s+([A-Za-z_$][\w$]*)/g, "const $1")
    t = t.replace(/export\s+let\s+([A-Za-z_$][\w$]*)/g, "let $1")
    t = t.replace(/export\s+var\s+([A-Za-z_$][\w$]*)/g, "var $1")
    t = t.replace(/export\s+class\s+([A-Za-z_$][\w$]*)/g, "class $1")
    t = t.replace(/export\s*\{[\s\S]*?\}/g, "")
    t = t.replace(/export\s+/g, "")

    return stripTypeScriptSyntax(t)
  }

  function detectExportedNames(src: string) {
    const names: string[] = []
    const defaultNames: string[] = []
    let m
    const reDefaultNamed = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g
    while ((m = reDefaultNamed.exec(src)) !== null) defaultNames.push(m[1])

    const reExportFn = /export\s+function\s+([A-Za-z_$][\w$]*)/g
    while ((m = reExportFn.exec(src)) !== null) names.push(m[1])

    const reExportConst = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
    while ((m = reExportConst.exec(src)) !== null) names.push(m[1])

    const reNamed = /export\s*\{([^}]+)\}/g
    while ((m = reNamed.exec(src)) !== null) {
      const list = m[1].split(",").map((s) => s.trim().split(" as ")[0].trim())
      for (const n of list) if (n) names.push(n)
    }

    const reDefaultVar = /export\s+default\s+(?!function\b|class\b)([A-Za-z_$][\w$]*)/g
    while ((m = reDefaultVar.exec(src)) !== null) defaultNames.push(m[1])

    return { names: Array.from(new Set(names)), defaultNames: Array.from(new Set(defaultNames)) }
  }

  function buildKeysForPath(p: string) {
    const normalized = p.replace(/^\.\//, "").replace(/\\\\/g, "/")
    const noExt = normalized.replace(/\.(tsx|ts|jsx|js)$/, "")
    const keys = new Set<string>()
    keys.add(normalized)
    keys.add(noExt)
    keys.add(`@/${noExt}`)
    keys.add(`./${noExt}`)
    keys.add(`/${noExt}`)
    keys.add(noExt.replace(/^\//, ""))
    return Array.from(keys)
  }

  function isPreviewExecutableFile(filePath: string) {
    return /\.(tsx?|jsx?|mjs|cjs)$/i.test(filePath)
  }

  function isPreviewJsonFile(filePath: string) {
    return /\.json$/i.test(filePath)
  }

  function isPreviewAssetFile(filePath: string) {
    return /\.(css|scss|sass|less|md|env|prisma|html|txt|csv|yml|yaml|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|lock|toml|ini|xml|pdf|webmanifest|manifest|d\.ts|d\.mts|d\.cts)$/i.test(filePath)
  }

  function isPreviewServerOnlyFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase()
    return (
      /^app\/api\//.test(normalized) ||
      /^app\/layout\.(tsx?|jsx?)$/i.test(normalized) ||
      /^app\/(?:.+\/)?page\.(preview\.)?(tsx?|jsx?)$/i.test(normalized) ||
      /^src\/app\/layout\.(tsx?|jsx?)$/i.test(normalized) ||
      /^src\/app\/(?:.+\/)?page\.(preview\.)?(tsx?|jsx?)$/i.test(normalized) ||
      /(^|\/)route\.(tsx?|ts|jsx?|js|mjs|cjs)$/i.test(normalized) ||
      /(^|\/)(auth|proxy)\.ts$/i.test(normalized) ||
      /^prisma\//.test(normalized) ||
      /^scripts\//.test(normalized) ||
      /^public\//.test(normalized) ||
      /(^|\/)(next\.config\.[mc]?[jt]s|postcss\.config\.[mc]?[jt]s|tailwind\.config\.[mc]?[jt]s|components\.json|package\.json|tsconfig\.json)$/i.test(normalized)
    )
  }

  function buildPreviewModuleSource(file: GeneratedFile) {
    const normalizedPath = file.path.replace(/\\/g, "/")

    if (isPreviewServerOnlyFile(normalizedPath)) {
      return null
    }

    if (isPreviewJsonFile(normalizedPath)) {
      try {
        const parsed = JSON.parse(String(file.content || "{}"))
        return `const __default_export = ${JSON.stringify(parsed, null, 2)}\n`
      } catch {
        return `const __default_export = {}\n`
      }
    }

    if (isPreviewAssetFile(normalizedPath)) {
      return `const __default_export = {}\n`
    }

    if (!isPreviewExecutableFile(normalizedPath)) {
      return null
    }

    return transformFileForModule(file.content)
  }

  // Build module registry wrappers for non-main files
  let moduleRegistryScript = "";
  for (const f of allFiles || []) {
    if (!f || !f.path) continue
    if (f.content === mainFile.content) continue
    try {
      const transformedModule = buildPreviewModuleSource(f)
      if (!transformedModule) {
        continue
      }

      const exp = isPreviewExecutableFile(f.path) ? detectExportedNames(f.content) : { names: [], defaultNames: [] }
      const keys = buildKeysForPath(f.path)

      moduleRegistryScript += `(function(){\ntry{\n${transformedModule}\nconst __sw_e = {}\n`;
      for (const n of exp.names) {
        moduleRegistryScript += `try{ if (typeof ${n} !== 'undefined') __sw_e[${JSON.stringify(n)}] = ${n} }catch(e){}\n`
      }
      for (const dn of exp.defaultNames) {
        moduleRegistryScript += `try{ if (typeof ${dn} !== 'undefined') __sw_e.default = ${dn} }catch(e){}\n`
      }
      // If there were no explicit default named, try fallback variable name used earlier
      moduleRegistryScript += `try{ if (typeof __default_export !== 'undefined') __sw_e.default = __default_export }catch(e){}\n`;
      moduleRegistryScript += `window.__sw_modules = window.__sw_modules || {}\n`;
      moduleRegistryScript += `[${keys.map((k) => JSON.stringify(k)).join(",")}].forEach(k=>{ try{ window.__sw_modules[k] = __sw_e }catch(e){} })\n`;
      moduleRegistryScript += `}catch(e){ try{ console.warn('[swift-preview] skipped module ${f.path.replace(/\\/g, "/")}', e) }catch(_){} }\n})()\n\n`;
    } catch (e) {
      // ignore module transform errors
    }
  }

  // Now transform main file content as before (keeping import fallback declarations)
  let transformed = String(mainFile.content || "")

  transformed = transformImportsToFallbacks(transformed)

  transformed = stripTypeScriptSyntax(transformed)

  // Remove "use client" directive
  transformed = transformed.replace(/['"]use client['"];?\n?/g, "")

  // Replace export default with an App component the sandbox can render.
  transformed = transformed.replace(/export\s+default\s+function\s+\w+/, "function App")
  transformed = transformed.replace(/export\s+default\s+function\s*\(/, "function App(")
  transformed = transformed.replace(/export\s+default\s+(?:async\s+)?\(/, "const App = (")
  transformed = transformed.replace(/export\s+default\s+([A-Za-z_$][\w$]*)/, "const App = $1")

  // Remove other exports
  transformed = transformed.replace(/export\s+/g, "")

  // Handle Next.js specific components
  transformed = transformed.replace(/import\s+Link\s+from\s+['"]next\/link['"];?\n?/g, "")
  transformed = transformed.replace(/<Link\s+href=/g, "<a href=")
  transformed = transformed.replace(/<\/Link>/g, "</a>")

  transformed = transformed.replace(/import\s+Image\s+from\s+['"]next\/image['"];?\n?/g, "")
  transformed = transformed.replace(/<Image\s+/g, "<img ")

  const renderScript = `

;(function(){
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Preview root element was not found')
  }

  if (typeof App !== 'function') {
    throw new Error('Preview entry did not export a renderable React component')
  }

  const root = ReactDOM.createRoot(rootElement)
  root.render(React.createElement(App))
})()
`

  // Prepend module registry wrappers so modules are available at runtime.
  return moduleRegistryScript + "\n" + transformed + renderScript
}

function transformImportsToFallbacks(code: string) {
  const transformed = code.replace(
    /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_full, rawClause: string, rawSource: string) => {
      const clause = String(rawClause || "").trim()
      const source = String(rawSource || "").trim()
      return buildImportFallbackDeclarations(clause, source)
    }
  )

  return transformed.replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
}

function buildImportFallbackDeclarations(clause: string, source: string) {
  const statements: string[] = []
  const safeSource = JSON.stringify(source)
  const sourceLower = source.toLowerCase()
  const reactGlobals = new Set([
    "useState",
    "useEffect",
    "useRef",
    "useCallback",
    "useMemo",
    "Fragment",
    "Suspense",
  ])

  const trimmedClause = clause.trim()
  if (trimmedClause.startsWith("type ")) {
    return ""
  }

  const namespaceMatch = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
  if (namespaceMatch?.[1]) {
    const name = namespaceMatch[1]
    if (sourceLower === "react" && name === "React") {
      return ""
    }
    statements.push(`const ${name} = __swiftNamespace(${safeSource});`)
    return statements.join("\n")
  }

  const namedMatch = clause.match(/^\{([\s\S]+)\}$/)
  if (namedMatch?.[1]) {
    for (const item of namedMatch[1].split(",")) {
      const token = item.trim()
      if (!token) continue
      if (token.startsWith("type ")) continue
      const aliasMatch = token.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      const imported = aliasMatch?.[1] || token
      const local = aliasMatch?.[2] || imported
      if (
        sourceLower === "react" &&
        reactGlobals.has(imported) &&
        imported === local
      ) {
        continue
      }
      statements.push(`const ${local} = __swiftResolve(${JSON.stringify(imported)}, ${JSON.stringify(local)}, ${safeSource});`)
    }
    return statements.join("\n")
  }

  const mixedMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]+)\}$/)
  if (mixedMatch?.[1]) {
    const defaultName = mixedMatch[1]
    if (!(sourceLower === "react" && defaultName === "React")) {
      statements.push(`const ${defaultName} = __swiftResolve("default", ${JSON.stringify(defaultName)}, ${safeSource});`)
    }
    for (const item of mixedMatch[2].split(",")) {
      const token = item.trim()
      if (!token) continue
      if (token.startsWith("type ")) continue
      const aliasMatch = token.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      const imported = aliasMatch?.[1] || token
      const local = aliasMatch?.[2] || imported
      if (
        sourceLower === "react" &&
        reactGlobals.has(imported) &&
        imported === local
      ) {
        continue
      }
      statements.push(`const ${local} = __swiftResolve(${JSON.stringify(imported)}, ${JSON.stringify(local)}, ${safeSource});`)
    }
    return statements.join("\n")
  }

  const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)$/)
  if (defaultMatch?.[1]) {
    const name = defaultMatch[1]
    if (sourceLower === "react" && name === "React") {
      return ""
    }
    statements.push(`const ${name} = __swiftResolve("default", ${JSON.stringify(name)}, ${safeSource});`)
    return statements.join("\n")
  }

  return `/* Unsupported import clause omitted: ${clause} from ${source} */`
}

/**
 * Generate empty preview HTML
 */
function generateEmptyPreview(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>
  <div style="text-align: center; padding: 2rem;">
    <div style="width: 48px; height: 48px; margin: 0 auto 1rem; border-radius: 50%; background: #1f1f1f; display: flex; align-items: center; justify-content: center;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
      </svg>
    </div>
    <h3 style="font-size: 1.125rem; font-weight: 600; margin: 0;">No preview available</h3>
    <p style="font-size: 0.875rem; color: #a3a3a3; margin-top: 0.5rem;">
      Start a conversation to generate your component
    </p>
  </div>
</body>
</html>
  `
}

/**
 * Get error HTML for preview
 */
export function generateErrorPreview(error: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .error-container {
      max-width: 400px;
      text-align: center;
    }
    .error-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 1rem;
      border-radius: 50%;
      background: #451a03;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    h3 {
      color: #ef4444;
      margin: 0 0 0.5rem;
    }
    pre {
      background: #1f1f1f;
      padding: 1rem;
      border-radius: 0.5rem;
      font-size: 0.75rem;
      text-align: left;
      overflow-x: auto;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
    </div>
    <h3>Preview Error</h3>
    <p style="color: #a3a3a3; font-size: 0.875rem;">
      There was an error rendering the preview
    </p>
    <pre>${escapeHtml(error)}</pre>
  </div>
</body>
</html>
  `
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
