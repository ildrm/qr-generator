import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { serializePayload, type PayloadInput } from './lib/payload'
import { encodeQr, renderSvg, safeFilename, svgToPng, moduleSizeMm, type Matrix } from './lib/qr'
import { verifyPng, verifySvg, type ScanState } from './lib/verify'
import { DEFAULT_STYLE, clearLocalData, deleteSavedDesign, exportDesignConfig, listSavedDesigns, loadBrandKit, parseDesignConfig, saveBrandKit, saveDesign, type DesignStyle, type SavedDesign } from './lib/storage'
import { CSV_TEMPLATE, generateBatchZip, mapCsvRows, parseCsv, type BatchItem, type ParsedCsv } from './lib/batch'

type Type = PayloadInput['type']
type Editor = { input: PayloadInput; style: DesignStyle; printMm: number; filename: string }
type Panel = 'editor'|'saved'|'batch'|'help'
const initial: Editor = { input:{type:'url',url:''}, style: DEFAULT_STYLE, printMm:25, filename:'my-qr-code' }
const typeNames: Record<Type,string> = {url:'Website URL',text:'Plain text',wifi:'Wi-Fi',email:'Email',phone:'Phone call',sms:'SMS',contact:'Contact card',calendar:'Calendar event'}
const types = Object.keys(typeNames) as Type[]
const presets: {name:string; style:Partial<DesignStyle>}[] = [
  {name:'Classic',style:{foreground:'#172421',background:'#FFFFFF',moduleStyle:'square',finderStyle:'square',gradient:undefined,transparent:false}},
  {name:'Ink',style:{foreground:'#183C72',background:'#FFFFFF',moduleStyle:'rounded',finderStyle:'square',gradient:undefined,transparent:false}},
  {name:'Forest',style:{foreground:'#14583D',background:'#FFFFFF',moduleStyle:'rounded',finderStyle:'rounded',gradient:undefined,transparent:false}},
  {name:'Slate',style:{foreground:'#303945',background:'#F4F7FA',moduleStyle:'dots',finderStyle:'square',gradient:undefined,transparent:false}},
]
const freshInput = (type:Type): PayloadInput => {
  switch(type){
    case 'url': return {type,url:''}; case 'text': return {type,text:''}; case 'wifi': return {type,ssid:'',security:'WPA',password:'',hidden:false}
    case 'email': return {type,to:'',subject:'',body:''}; case 'phone': return {type,number:''}; case 'sms': return {type,number:'',message:''}
    case 'contact': return {type,fullName:'',organization:'',phone:'',email:'',url:''}
    case 'calendar': return {type,title:'',start:'',end:'',description:'',location:''}
  }
}
const field = (input: PayloadInput, key: string) => String((input as unknown as Record<string,unknown>)[key] ?? '')
function download(blob: Blob, filename: string) { const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=filename; link.click(); window.setTimeout(()=>URL.revokeObjectURL(url),1000) }
function downloadText(text:string, filename:string, mime:string){download(new Blob([text],{type:mime}),filename)}
function localIso(value:string){ if(!value) return ''; const d=new Date(value); return Number.isNaN(d.getTime()) ? value : d.toISOString() }
function toLocalInput(value:string){ if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return value.slice(0,16);const local=new Date(d.getTime()-d.getTimezoneOffset()*60_000);return local.toISOString().slice(0,16) }

function FormField({label,id,value,onChange,type='text',help,error,placeholder}: {label:string;id:string;value:string;onChange:(v:string)=>void;type?:string;help?:string;error?:string;placeholder?:string}) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} type={type} value={value} placeholder={placeholder} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined} onChange={e=>onChange(e.target.value)}/>{error?<small className="field-error" id={`${id}-error`}>{error}</small>:help?<small id={`${id}-help`}>{help}</small>:null}</div>
}

function ContentForm({input,onChange,errors}: {input:PayloadInput;onChange:(v:PayloadInput)=>void;errors:Record<string,string>}) {
  const set=(key:string,value:string|boolean)=>onChange({...input,[key]:value} as PayloadInput)
  const f=(label:string,key:string,other:Partial<Parameters<typeof FormField>[0]>={})=><FormField label={label} id={`content-${key}`} value={field(input,key)} onChange={v=>set(key,v)} error={errors[key]} {...other}/>
  switch(input.type){
    case 'url':return f('Website URL','url',{placeholder:'https://example.com',help:'A bare address uses HTTPS. Check the final destination below.'})
    case 'text':return <div className="field"><label htmlFor="content-text">Text to encode</label><textarea id="content-text" value={input.text} onChange={e=>set('text',e.target.value)} rows={6} aria-invalid={!!errors.text}/>{errors.text&&<small className="field-error">{errors.text}</small>}</div>
    case 'wifi':return <>{f('Network name (SSID)','ssid')}{<div className="field"><label htmlFor="wifi-security">Security</label><select id="wifi-security" value={input.security} onChange={e=>set('security',e.target.value)}><option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP</option><option value="nopass">Open network</option></select></div>}{input.security!=='nopass'&&f('Password','password',{type:'text',help:'Never saved to local designs.'})}<label className="check"><input type="checkbox" checked={!!input.hidden} onChange={e=>set('hidden',e.target.checked)}/>Hidden network</label></>
    case 'email':return <>{f('To','to',{type:'email',placeholder:'hello@example.com'})}{f('Subject','subject')}{f('Message','body')}</>
    case 'phone':return f('Phone number','number',{type:'tel',placeholder:'+1 555 123 4567'})
    case 'sms':return <>{f('Recipient','number',{type:'tel'})}{f('Message','message')}</>
    case 'contact':return <>{f('Full name','fullName')}{f('Given name','givenName')}{f('Family name','familyName')}{f('Organization','organization')}{f('Title','title')}{f('Phone','phone',{type:'tel'})}{f('Email','email',{type:'email'})}{f('Website','url')}{f('Address','address')}{f('Note','note')}</>
    case 'calendar':return <>{f('Event title','title')}<FormField label="Starts" id="content-start" type="datetime-local" value={toLocalInput(input.start)} onChange={v=>set('start',localIso(v))} error={errors.start} help="Saved as an exact UTC time."/><FormField label="Ends" id="content-end" type="datetime-local" value={toLocalInput(input.end)} onChange={v=>set('end',localIso(v))} error={errors.end}/>{f('Location','location')}{f('Description','description')}</>
  }
}

async function processLogo(file:File):Promise<string>{
  if(file.size>1024*1024) throw new Error('Logo must be under 1 MB.')
  const header=new Uint8Array(await file.slice(0,12).arrayBuffer())
  const png=[137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v)
  const jpeg=header[0]===255&&header[1]===216&&header[2]===255
  const webp=String.fromCharCode(...header.slice(0,4))==='RIFF'&&String.fromCharCode(...header.slice(8,12))==='WEBP'
  if(!png&&!jpeg&&!webp) throw new Error('Use a PNG, JPEG, or WebP logo.')
  const bitmap=await createImageBitmap(file)
  try {
    if(bitmap.width>2048||bitmap.height>2048||bitmap.width<16||bitmap.height<16) throw new Error('Logo dimensions must be 16–2048 pixels.')
    const canvas=document.createElement('canvas'); canvas.width=Math.min(bitmap.width,512); canvas.height=Math.min(bitmap.height,512)
    const ctx=canvas.getContext('2d'); if(!ctx) throw new Error('Cannot process this logo.')
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height)
    return canvas.toDataURL('image/png')
  } finally {bitmap.close()}
}

function batchInput(item:BatchItem):PayloadInput {
  if(item.type==='url') return {type:'url',url:item.content}
  if(item.type==='text') return {type:'text',text:item.content}
  // Structured rows use JSON so punctuation, Unicode and optional fields remain unambiguous.
  const parsed:unknown=JSON.parse(item.content)
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error(`Row ${item.rowNumber}: expected a JSON object for ${item.type}.`)
  return {...parsed,type:item.type} as PayloadInput
}

function App(){
  const [editor,setEditor]=useState<Editor>(initial)
  const undo=useRef<Editor[]>([]), redo=useRef<Editor[]>([])
  const [panel,setPanel]=useState<Panel>('editor')
  const [theme,setTheme]=useState<'light'|'dark'>('light')
  const [status,setStatus]=useState<ScanState>({kind:'pending',message:'Enter content to preview'})
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const [surface,setSurface]=useState<'light'|'dark'>('light')
  const [saved,setSaved]=useState<SavedDesign[]>([])
  const [csv,setCsv]=useState<ParsedCsv|null>(null)
  const [mapping,setMapping]=useState({content:'content',type:'type',filename:'filename'})
  const [batchProgress,setBatchProgress]=useState('')
  const batchController=useRef<AbortController|null>(null)
  const importRef=useRef<HTMLInputElement>(null)
  const logoRef=useRef<HTMLInputElement>(null)
  const [copied,setCopied]=useState('')
  const [advanced,setAdvanced]=useState(false)
  const [inspect,setInspect]=useState(false)
  const [touched,setTouched]=useState(false)
  const [saveContent,setSaveContent]=useState(false)
  const result=useMemo(()=>serializePayload(editor.input),[editor.input])
  const matrix=useMemo<Matrix|null>(()=>{if(!result.valid||!result.value)return null;try{return encodeQr(result.value,editor.style.ecl)}catch{return null}},[result,editor.style.ecl])
  const capacityError=result.valid&&!!result.value&&!matrix
  const svg=useMemo(()=>matrix?renderSvg(matrix,editor.style,editor.style.size):'', [matrix,editor.style])
  const previewUrl=svg?`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`:''
  const issues=Object.fromEntries(result.errors.map(x=>[x.field,x.message]))
  const byteCount=new TextEncoder().encode(result.value).length
  const mapped=csv?mapCsvRows(csv,mapping):null

  function edit(change:Partial<Editor>|((prev:Editor)=>Editor)){ undo.current.push(editor); if(undo.current.length>50)undo.current.shift();redo.current=[];setEditor(prev=>typeof change==='function'?change(prev):{...prev,...change});setNotice('') }
  function style(change:Partial<DesignStyle>){edit(prev=>({...prev,style:{...prev.style,...change}}))}
  function moveHistory(direction:'undo'|'redo'){const from=direction==='undo'?undo.current:redo.current,to=direction==='undo'?redo.current:undo.current;const previous=from.pop();if(previous){to.push(editor);setEditor(previous)}}
  useEffect(()=>{const fn=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();moveHistory(e.shiftKey?'redo':'undo')}};window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn)})
  useEffect(()=>{let cancelled=false;if(!matrix||!svg){setStatus(capacityError?{kind:'capacity',message:'Content exceeds QR capacity'}:{kind:'pending',message:touched&&result.errors.length?result.errors[0].message:'Enter content to preview'});return}setStatus({kind:'pending',message:'Checking scan readability…'});const timer=setTimeout(()=>verifySvg(svg,result.value,editor.style,matrix,editor.printMm).then(v=>{if(!cancelled)setStatus(v)}),350);return()=>{cancelled=true;clearTimeout(timer)}},[svg,result.value,editor.style,matrix,editor.printMm,capacityError,result.errors,touched])
  useEffect(()=>{const r=listSavedDesigns();if(r.ok)setSaved(r.value)},[])
  function refreshSaved(){const r=listSavedDesigns();if(r.ok)setSaved(r.value);else setNotice(r.error)}
  function flash(message:string){setNotice(message);window.setTimeout(()=>setNotice(''),5000)}
  function ensureReady(){if(!matrix||!svg||!result.valid){flash('Finish a valid QR code first.');return false}return true}
  async function exportFile(kind:'png'|'svg'|'pdf'){
    if(!ensureReady()||!matrix)return;setBusy(true)
    try{
      const verified=await verifySvg(svg,result.value,editor.style,matrix,editor.printMm);setStatus(verified)
      if(verified.kind==='failed'){flash('Export stopped: this design could not be decoded. Use “Make safer” and try again.');return}
      const base=safeFilename(editor.filename)
      if(kind==='svg') {downloadText(svg,`${base}.svg`,'image/svg+xml');flash('SVG downloaded and verified.');return}
      const png=await svgToPng(svg,editor.style.size,editor.style.transparent?undefined:editor.style.background)
      const exported=await verifyPng(png,result.value,editor.style,matrix,editor.printMm)
      if(exported.kind==='failed'){flash('PNG export did not pass verification.');return}
      if(kind==='png'){download(png,`${base}.png`);flash('PNG downloaded and verified.');return}
      const {PDFDocument,StandardFonts}=await import('pdf-lib')
      const pdf=await PDFDocument.create();const mm=editor.printMm
      const embedded=await pdf.embedPng(await png.arrayBuffer());const width=mm*72/25.4;const height=width*embedded.height/embedded.width
      const pageWidth=Math.max(595.28,width+56.69);const pageHeight=Math.max(841.89,height+170.08)
      const page=pdf.addPage([pageWidth,pageHeight])
      page.drawImage(embedded,{x:(pageWidth-width)/2,y:pageHeight-72-height,width,height})
      const font=await pdf.embedFont(StandardFonts.Helvetica)
      const label=`${mm} mm - ${moduleSizeMm(matrix,mm).toFixed(2)} mm per module`
      page.drawText(label,{x:(pageWidth-font.widthOfTextAtSize(label,9))/2,y:pageHeight-72-height-24,size:9,font})
      const bytes=await pdf.save();download(new Blob([new Uint8Array(bytes).buffer],{type:'application/pdf'}),`${base}.pdf`);flash('PDF downloaded. Print at actual size.')
    }catch(e){flash(e instanceof Error?e.message:'Export failed.')}finally{setBusy(false)}
  }
  async function copyImage(){if(!ensureReady())return;try{if(!navigator.clipboard?.write||!window.ClipboardItem)throw new Error('Image clipboard is unavailable. Download PNG instead.');const blob=await svgToPng(svg,editor.style.size,editor.style.background);await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);setCopied('Image copied')}catch(e){flash(e instanceof Error?e.message:'Copy failed. Download PNG instead.')}}
  async function copyPayload(){if(!result.valid)return;try{await navigator.clipboard.writeText(result.value);setCopied('Content copied')}catch{flash('Clipboard unavailable. Select the encoded content in Inspect to copy it.')}}
  function safer(){style({foreground:'#111111',background:'#FFFFFF',moduleStyle:'square',finderStyle:'square',gradient:undefined,logo:undefined,transparent:false,ecl:'H'})}
  async function addLogo(e:ChangeEvent<HTMLInputElement>){const file=e.target.files?.[0];e.target.value='';if(!file)return;try{const logo=await processLogo(file);style({logo,ecl:'H'});flash('Logo added. Checking the final design.')}catch(err){flash(err instanceof Error?err.message:'Could not process the logo.')}}
  function saveCurrent(){const name=window.prompt('Name this local design',editor.filename);if(name===null)return;const content=saveContent&&result.valid&&(editor.input.type==='url'||editor.input.type==='text')?{type:editor.input.type,value:result.value}:undefined;const r=saveDesign({name,style:editor.style,content,includeContent:!!content});if(r.ok){refreshSaved();flash(content?'Design and content saved locally.':'Design saved locally without content.')}else flash(r.error)}
  async function importDesign(e:ChangeEvent<HTMLInputElement>){
    const file=e.target.files?.[0];e.target.value='';if(!file)return
    if(file.size>1_600_000){flash('Design file is too large.');return}
    try{
      const config=parseDesignConfig(await file.text())
      if(config.style.logo){
        const encoded=config.style.logo.slice(config.style.logo.indexOf(',')+1)
        const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))
        config.style.logo=await processLogo(new File([bytes],'imported-logo'))
      }
      edit(prev=>({...prev,style:config.style,input:config.content?config.content.type==='url'?{type:'url',url:config.content.value}:{type:'text',text:config.content.value}:prev.input}))
      flash('Design imported.')
    }catch(err){flash(err instanceof Error?err.message:'Invalid design file.')}
  }
  function reset(){if(window.confirm('Reset content and design? This cannot be undone.')){undo.current=[];redo.current=[];setEditor(initial);setTouched(false)}}
  function readCsv(e:ChangeEvent<HTMLInputElement>){const file=e.target.files?.[0];e.target.value='';if(!file)return;if(file.size>1024*1024){flash('CSV exceeds the 1 MB limit.');return}file.text().then(text=>{const parsed=parseCsv(text);setCsv(parsed);setPanel('batch')})}
  async function runBatch(){if(!mapped||mapped.items.length===0||mapped.errors.length){flash('Fix the CSV row errors before exporting.');return}const controller=new AbortController();batchController.current=controller;setBusy(true);setBatchProgress('Starting…');try{const blob=await generateBatchZip(mapped.items,async item=>{const payload=serializePayload(batchInput(item));if(!payload.valid)throw new Error(`Row ${item.rowNumber}: ${payload.errors[0]?.message}`);const m=encodeQr(payload.value,editor.style.ecl);const s=renderSvg(m,editor.style,512);const png=await svgToPng(s,512,editor.style.background);const checked=await verifyPng(png,payload.value,editor.style,m,editor.printMm);if(checked.kind==='failed')throw new Error(`Row ${item.rowNumber}: QR could not be verified.`);return {data:png,extension:'png'}},{signal:controller.signal,onProgress:p=>setBatchProgress(`${p.completed} / ${p.total} complete`)});download(blob,'qr-batch.zip');flash('Batch ZIP downloaded.')}catch(e){flash(e instanceof Error?e.message:'Batch failed.')}finally{setBusy(false);batchController.current=null}}
  const info=(content:ReactNode)=><div className="callout">{content}</div>

  return <div className={`app ${theme}`}>
    <header className="site-header"><a className="brand" href="#main" aria-label="QRlab home"><span>qr</span>lab<span className="brand-dot">.</span></a><nav aria-label="Main"><button className={panel==='editor'?'nav-active':''} onClick={()=>setPanel('editor')}>Editor</button><button className={panel==='saved'?'nav-active':''} onClick={()=>setPanel('saved')}>Saved</button><button className={panel==='batch'?'nav-active':''} onClick={()=>setPanel('batch')}>Batch</button><button className={panel==='help'?'nav-active':''} onClick={()=>setPanel('help')}>Guide</button></nav><div className="header-right"><span>Your data stays in your browser</span><button className="theme-button" aria-label={`Switch to ${theme==='light'?'dark':'light'} theme`} onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?'◐':'☼'}</button></div></header>
    <main id="main"><div className="intro"><div><h1>Create your QR code</h1><p>Make a clear, scan-ready code in seconds. Private by design.</p></div><div className="edit-actions"><button onClick={()=>moveHistory('undo')} disabled={!undo.current.length} aria-label="Undo">↶ <span>Undo</span></button><button onClick={()=>moveHistory('redo')} disabled={!redo.current.length} aria-label="Redo">↷ <span>Redo</span></button><button onClick={reset}>Reset</button></div></div>
    {panel==='editor'&&<div className="workspace"><section className="panel content-panel" aria-labelledby="content-title"><h2 id="content-title">Content</h2><div className="field"><label htmlFor="content-type">What should this QR do?</label><select id="content-type" value={editor.input.type} onChange={e=>{setTouched(false);edit({input:freshInput(e.target.value as Type)})}}>{types.map(type=><option value={type} key={type}>{typeNames[type]}</option>)}</select></div><ContentForm input={editor.input} onChange={input=>{setTouched(true);edit({input})}} errors={touched?issues:{}}/>{result.warnings.map((warning,i)=><p className="warning" key={i}>{warning.message}</p>)}{capacityError&&<p className="field-error">Content exceeds QR capacity. Shorten it or lower error correction.</p>}{result.valid&&result.value&&<div className="destination"><span>Encoded destination</span><bdi dir="auto">{editor.input.type==='url'?result.value:typeNames[editor.input.type]}</bdi></div>}<details className="inspect" open={inspect} onToggle={e=>setInspect(e.currentTarget.open)}><summary>Inspect exact encoded content</summary><textarea readOnly value={result.value} rows={6} aria-label="Exact encoded content" dir="auto"/><button className="text-button" onClick={copyPayload} disabled={!result.value}>Copy encoded content</button></details></section>
    <section className="panel preview-panel" aria-labelledby="preview-title"><div className="panel-head"><h2 id="preview-title">Preview</h2><span className={`scan-state ${status.kind}`} role="status" aria-live="polite"><i/>{status.message}</span></div><div className={`preview-stage surface-${surface}`}>{previewUrl?<img src={previewUrl} alt={`QR code for ${editor.input.type==='url'?result.value:typeNames[editor.input.type]}`}/>:<div className="empty-preview"><div className="empty-grid" aria-hidden="true"/><p>Your QR code appears here</p><small>Enter content to begin</small></div>}</div>{status.reason&&<p className={`status-reason ${status.kind}`}>{status.reason}</p>}{status.kind==='failed'&&<button className="safer" onClick={safer}>Make safer</button>}<div className="surface-controls"><span>Preview on</span><button className={surface==='light'?'selected':''} onClick={()=>setSurface('light')}>Light</button><button className={surface==='dark'?'selected':''} onClick={()=>setSurface('dark')}>Dark</button></div><div className="download-row"><button className="primary" onClick={()=>exportFile('png')} disabled={!matrix||busy}>↓ Download PNG</button><button className="secondary" onClick={()=>exportFile('svg')} disabled={!matrix||busy}>↓ Download SVG</button></div><div className="more-export"><button onClick={()=>exportFile('pdf')} disabled={!matrix||busy}>Print PDF</button><button onClick={copyImage} disabled={!matrix||busy}>Copy image</button></div><p className="preview-meta">{matrix?`${matrix.size} × ${matrix.size} modules · ${byteCount} bytes · ${editor.style.ecl} correction`:'Static QR · created locally'}{copied&&` · ${copied}`}</p></section>
    <section className="panel design-panel" aria-labelledby="design-title"><h2 id="design-title">Design</h2><div className="control-group"><h3>Preset style</h3><div className="presets">{presets.map(p=><button key={p.name} className={editor.style.foreground===p.style.foreground&&editor.style.moduleStyle===p.style.moduleStyle?'active':''} onClick={()=>style(p.style)} aria-label={`${p.name} preset`}><span className="preset-art" style={{color:p.style.foreground,background:p.style.background}}>▣<small>▪▫▪</small></span><span>{p.name}</span></button>)}</div></div><div className="style-fields"><div className="color-row"><label htmlFor="foreground">Foreground</label><div><input id="foreground" type="color" value={editor.style.foreground} onChange={e=>style({foreground:e.target.value})}/><span>{editor.style.foreground.toUpperCase()}</span></div></div><div className="color-row"><label htmlFor="background">Background</label><div><input id="background" type="color" value={editor.style.background} onChange={e=>style({background:e.target.value})}/><span>{editor.style.background.toUpperCase()}</span></div></div><div className="field"><label htmlFor="module-style">Module shape</label><select id="module-style" value={editor.style.moduleStyle} onChange={e=>style({moduleStyle:e.target.value as DesignStyle['moduleStyle']})}><option value="square">Square</option><option value="rounded">Gently rounded</option><option value="dots">Dots</option></select></div><div className="field"><label htmlFor="filename">Filename</label><input id="filename" value={editor.filename} onChange={e=>edit({filename:e.target.value})}/></div></div><details className="advanced" open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>Advanced design and print</summary><div className="advanced-content"><div className="field"><label htmlFor="finder-style">Finder style</label><select id="finder-style" value={editor.style.finderStyle} onChange={e=>style({finderStyle:e.target.value as DesignStyle['finderStyle']})}><option value="square">Square</option><option value="rounded">Rounded corners</option></select></div><div className="field"><label htmlFor="ecl">Error correction</label><select id="ecl" value={editor.style.ecl} onChange={e=>style({ecl:e.target.value as DesignStyle['ecl']})}>{['L','M','Q','H'].map(x=><option key={x}>{x}</option>)}</select></div><div className="field"><label htmlFor="size">Output pixels</label><input id="size" type="number" min="256" max="4096" step="1" value={editor.style.size} onChange={e=>style({size:Math.max(256,Math.min(4096,Number(e.target.value)||256))})}/></div><div className="field"><label htmlFor="print-size">Print width (mm)</label><input id="print-size" type="number" min="10" max="300" value={editor.printMm} onChange={e=>edit({printMm:Math.max(10,Math.min(300,Number(e.target.value)||25))})}/>{matrix&&<small>{moduleSizeMm(matrix,editor.printMm).toFixed(2)} mm per module. Aim for at least 0.35 mm.</small>}</div>{previewUrl&&<div className="print-preview"><span>Print preview · {editor.printMm} mm wide</span><img src={previewUrl} alt="QR code at intended print width" style={{width:`${editor.printMm}mm`}}/></div>}<label className="check"><input type="checkbox" checked={!!editor.style.gradient} onChange={e=>style({gradient:e.target.checked?{from:editor.style.foreground,to:'#477A67'}:undefined})}/>Foreground gradient</label>{editor.style.gradient&&<div className="two-col"><input aria-label="Gradient start" type="color" value={editor.style.gradient.from} onChange={e=>style({gradient:{...editor.style.gradient!,from:e.target.value}})}/><input aria-label="Gradient end" type="color" value={editor.style.gradient.to} onChange={e=>style({gradient:{...editor.style.gradient!,to:e.target.value}})}/></div>}<label className="check"><input type="checkbox" checked={editor.style.transparent} onChange={e=>style({transparent:e.target.checked})}/>Transparent background</label>{editor.style.transparent&&<small>Check contrast on the final surface before printing.</small>}<div className="field"><label htmlFor="frame-label">Short label below code</label><input id="frame-label" maxLength={32} value={editor.style.frame?.label||''} onChange={e=>style({frame:{label:e.target.value}})} placeholder="Scan me"/></div><div className="field"><label htmlFor="logo">Center logo · PNG, JPEG or WebP</label><input id="logo" ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={addLogo}/>{editor.style.logo&&<button className="text-button" onClick={()=>style({logo:undefined})}>Remove logo</button>}</div></div></details>{(editor.input.type==='url'||editor.input.type==='text')&&<label className="check"><input type="checkbox" checked={saveContent} onChange={e=>setSaveContent(e.target.checked)}/>Include this URL or text when saving</label>}<div className="save-actions"><button onClick={saveCurrent}>Save design</button><button onClick={()=>downloadText(exportDesignConfig(editor.style),`${safeFilename(editor.filename)}.qrdesign.json`,'application/json')}>Export setup</button></div></section></div>}
    {panel==='saved'&&<section className="single-panel"><div className="section-heading"><div><h2>Saved designs</h2><p>Saving is optional. Content is excluded unless you explicitly choose to save a URL or plain text.</p></div><button className="secondary" onClick={()=>importRef.current?.click()}>Import setup</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importDesign}/></div><div className="saved-list">{saved.length?saved.map(design=><div className="saved-row" key={design.id}><div className="saved-swatch" style={{background:design.style.background,color:design.style.foreground}}>▣</div><div><strong>{design.name}</strong><small>{new Date(design.createdAt).toLocaleDateString()}{design.content?' · includes content':''}</small></div><button onClick={()=>{edit(prev=>({...prev,style:design.style,input:design.content?design.content.type==='url'?{type:'url',url:design.content.value}:{type:'text',text:design.content.value}:prev.input}));setPanel('editor')}}>Open</button><button className="danger-text" onClick={()=>{deleteSavedDesign(design.id);refreshSaved()}}>Delete</button></div>):info('No saved designs yet. Save a style from the editor to reopen it later.')}</div><div className="brand-kit"><h3>Small brand kit</h3><p>Store two colors and the current logo on this device.</p><button onClick={()=>{const kit=loadBrandKit();if(kit.ok&&kit.value){style({foreground:kit.value.primary,background:kit.value.secondary,logo:kit.value.logo});setPanel('editor')}else flash('No brand kit saved yet.')}}>Apply brand kit</button><button onClick={()=>{const r=saveBrandKit({primary:editor.style.foreground,secondary:editor.style.background,logo:editor.style.logo});flash(r.ok?'Brand kit saved locally.':r.error)}}>Save current colors and logo</button></div><button className="danger-text clear-all" onClick={()=>{if(window.confirm('Delete all locally saved designs and brand kit?')){const r=clearLocalData();if(r.ok){refreshSaved();flash('Local data deleted.')}else flash(r.error)}}}>Delete all local data</button></section>}
    {panel==='batch'&&<section className="single-panel"><div className="section-heading"><div><h2>Batch creation</h2><p>Upload a CSV, review each row, then download a ZIP of verified PNG codes. Up to 500 rows.</p></div><button className="secondary" onClick={()=>downloadText(CSV_TEMPLATE,'qr-batch-template.csv','text/csv')}>Download template</button></div><div className="batch-upload"><label htmlFor="csv-file">Choose CSV file · 1 MB maximum</label><input id="csv-file" type="file" accept=".csv,text/csv" onChange={readCsv}/><p>For Wi-Fi, contact and other structured types, put a JSON object in the content cell with CSV quotes escaped. Each row stays on this device.</p></div>{csv&&<><div className="batch-summary"><strong>{csv.rows.length} rows found</strong><span>{mapped?.items.length||0} ready · {mapped?.errors.length||0} errors</span></div><div className="mapping"><label>Content column<select value={mapping.content} onChange={e=>setMapping({...mapping,content:e.target.value})}>{csv.headers.map(h=><option key={h}>{h}</option>)}</select></label><label>Type column<select value={mapping.type} onChange={e=>setMapping({...mapping,type:e.target.value})}>{csv.headers.map(h=><option key={h}>{h}</option>)}</select></label><label>Filename column<select value={mapping.filename} onChange={e=>setMapping({...mapping,filename:e.target.value})}><option value="">None</option>{csv.headers.map(h=><option key={h}>{h}</option>)}</select></label></div>{mapped?.errors.length? <div className="row-errors"><h3>Row errors</h3>{mapped.errors.slice(0,30).map((x,i)=><p key={i}>Row {x.row}: {x.message}</p>)}</div>:<p className="success-note">Columns mapped. Each QR will be verified before it enters the ZIP.</p>}<div className="batch-actions"><button className="primary" disabled={busy||!mapped?.items.length||!!mapped.errors.length} onClick={runBatch}>Create ZIP</button>{busy&&<button onClick={()=>batchController.current?.abort()}>Cancel</button>}<span role="status">{batchProgress}</span></div></>}</section>}
    {panel==='help'&&<section className="single-panel guide"><h2>Make a code that scans well</h2><div className="guide-grid"><div><h3>Before printing</h3><p>Keep the full four-module margin. Start at 25 mm wide and check that each module is at least 0.35 mm. Use dark ink on a light background.</p><p>Software verification checks this rendered code, but cannot predict every phone, paper, screen, or lighting condition. Test a physical proof on two devices before a large print run.</p></div><div><h3>Privacy and static codes</h3><p>Your content and logo are processed in this browser. No account, tracker, upload, or redirect service is used. A static QR contains its destination directly; printing it makes that destination permanent.</p><p>Design saving is explicit. Saved entries contain style only by default. Remove them anytime on the Saved screen.</p></div><div><h3>Compatibility</h3><p>Wi-Fi, vCard 3.0 contact cards, and iCalendar events use common formats. Scanner and app support varies. Calendar times are encoded in UTC. Phone and SMS actions depend on the scanning device.</p></div><div><h3>Working offline</h3><p>After a production build is loaded once, the service worker caches the app for later offline use on supported browsers. Clipboard image copying needs browser permission; downloads remain available.</p></div></div></section>}
    <footer><div><strong>qrlab.</strong><span>Static codes. Made locally.</span></div><p>QR codes carry data, but are not a substitute for a readable link or description. <button onClick={()=>setPanel('help')}>Printing & privacy guide</button></p></footer></main>{notice&&<div className="toast" role="status">{notice}</div>}</div>
}
export default App
