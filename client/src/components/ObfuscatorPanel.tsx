import { useState } from "react";
import { Code2, FileCode2, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { readLuaFile, validateLuaFile } from "@/lib/lua-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

const MODES = [
  { value: "fast", label: "Fast", description: "Protección rápida para iterar." },
  { value: "balanced", label: "Balanced", description: "Equilibrio recomendado." },
  { value: "fortified", label: "Fortified", description: "Protección más estricta." },
] as const;

export function ObfuscatorPanel() {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("balanced");
  const [obfuscateStrings, setObfuscateStrings] = useState(true);
  const [addLoaderGuard, setAddLoaderGuard] = useState(true);
  const [result, setResult] = useState<{ code: string; checksum: string; status: string } | null>(null);
  const createProtection = trpc.protections.create.useMutation({
    onSuccess: (record) => { setResult(record); toast.success("Source protegida correctamente"); },
    onError: (error) => toast.error(error.message || "No se pudo proteger la source"),
  });
  const loadFile = async (file?: File) => {
    if (!file) return;
    const error = validateLuaFile(file);
    if (error) { toast.error(error); return; }
    try { setSource(await readLuaFile(file)); toast.success(`Archivo cargado: ${file.name}`); }
    catch { toast.error("No se pudo leer el archivo Lua"); }
  };
  const protect = () => {
    if (!name.trim()) return toast.error("Escribe un nombre para la protección");
    if (!source.trim()) return toast.error("Pega o carga un archivo Lua");
    createProtection.mutate({ name: name.trim(), source, mode, obfuscateStrings, addLoaderGuard });
  };
  return <section className="obfuscator-page">
    <section className="panel obfuscator-hero"><div className="panel-header"><div><span className="overline">PROTECTION ENGINE</span><h2><ShieldCheck size={17} /> Obfuscator</h2><p>Protege una source Lua y descarga el resultado. Este módulo no aloja scripts ni administra keys.</p></div><span className="panel-index">01</span></div></section>
    <section className="content-grid"><div className="panel create-panel"><div className="panel-header"><div><h2><Code2 size={17} /> Nueva protección</h2><p>La source se procesa aquí y permanece dentro del flujo privado.</p></div></div><label>Nombre de la protección<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Combat module" /></label><label className="code-label">Archivo o source Lua<div className="file-upload-row"><input type="file" accept=".lua,text/plain" onChange={(event) => void loadFile(event.target.files?.[0])} aria-label="Cargar archivo Lua para proteger" /><span>Compatible con móvil y escritorio.</span></div><Textarea value={source} onChange={(event) => setSource(event.target.value)} placeholder="-- pega aquí tu source Lua..." spellCheck={false} /></label><div className="form-grid"><label>Modo<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>{MODES.map((item) => <option value={item.value} key={item.value}>{item.label} — {item.description}</option>)}</select></label><label className="switch-label"><Switch checked={obfuscateStrings} onCheckedChange={setObfuscateStrings} /><span><strong>Ofuscar strings</strong><small>Transforma textos literales del artefacto.</small></span></label><label className="switch-label"><Switch checked={addLoaderGuard} onCheckedChange={setAddLoaderGuard} /><span><strong>Loader guard</strong><small>Añade protección de ejecución.</small></span></label></div><div className="form-actions"><Button className="primary-button" onClick={protect} disabled={createProtection.isPending}><ShieldCheck size={16} /> {createProtection.isPending ? "Protegiendo..." : "Proteger source"}</Button><Button variant="outline" className="secondary-button" onClick={() => { setName(""); setSource(""); setResult(null); }}><FileCode2 size={16} /> Limpiar</Button></div></div><div className="panel result-panel"><div className="panel-header"><div><h2><Code2 size={17} /> Resultado</h2><p>{result ? "Artefacto protegido listo para descargar." : "El resultado aparecerá aquí."}</p></div><span className="panel-index">02</span></div>{result ? <div className="output-state"><span className="success-label">{result.status.toUpperCase()}</span><h3>{name}</h3><p className="private-note">Checksum: {result.checksum}. La source original no se muestra en este resultado.</p><pre className="source-preview">{result.code}</pre></div> : <div className="empty-output"><div className="empty-icon"><Code2 size={19} /></div><strong>Aún no hay resultado.</strong><span>Configura la protección y pulsa Proteger source.</span></div>}</div></section>
  </section>;
}
