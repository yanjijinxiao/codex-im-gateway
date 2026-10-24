/** Safe, structured host receipts; never carry arbitrary extension/SSH output. */
export type IDEProfileStatus = {
  phase: "checking" | "installing" | "ready" | "error";
  requested: string[];
  installed: { id: string; version: string }[];
  missing: string[];
  activeExtension?: string;
  warning?: string;
};

// Runtime defaults are deliberately outside the saved Profile identity: adding
// a missing default must not abandon user data or invalidate browser grants.
// Portable editor appearance, not a copy of desktop caches or machine paths.
// Fonts are resolved by the browser's device, never installed on the SSH host.
export const IDE_APPEARANCE_DEFAULTS = {
  "workbench.colorTheme": "Dark 2026",
  "workbench.iconTheme": "vs-seti",
  "workbench.productIconTheme": "Default",
  "editor.fontFamily": "Menlo, Monaco, 'Courier New', monospace",
  "editor.fontSize": 12,
  "editor.lineHeight": 18,
  "editor.fontWeight": "normal",
  "editor.fontLigatures": false,
  "workbench.editor.wrapTabs": true
};
export const IDE_SETTING_DEFAULTS = { ...IDE_APPEARANCE_DEFAULTS, "workbench.secondarySideBar.defaultVisibility": "hidden" };

/** Runs on either host without Gateway dependencies. JSONC is normalized only
 * for validation; edits insert missing defaults into the ORIGINAL text. */
export const IDE_PROFILE_HELPER = String.raw`
function seedSettings(text,defaults){
 const chars=text.split('');let quoted=false,escaped=false;
 for(let i=0;i<chars.length;i++){
  const c=text[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}
  if(c==='/'&&text[i+1]==='/'){for(;i<chars.length&&text[i]!=='\n'&&text[i]!=='\r';i++)chars[i]=' ';i--;}
  else if(c==='/'&&text[i+1]==='*'){
   chars[i++]=' ';chars[i]=' ';let closed=false;
   for(i++;i<chars.length;i++){if(text[i]==='*'&&text[i+1]==='/'){chars[i++]=chars[i]=' ';closed=true;break;}if(!/[\r\n]/.test(text[i]))chars[i]=' ';}
   if(!closed)throw Error('Invalid settings comment');
  }
 }
 const clean=chars.join('');quoted=false;escaped=false;
 for(let i=0;i<chars.length;i++){
  const c=clean[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;
  else if(c===','){let j=i+1;while(/\s/.test(clean[j]||'')&&j<clean.length)j++;if(clean[j]==='}'||clean[j]===']')chars[i]=' ';}
 }
 if(chars[0]==='\uFEFF')chars[0]=' ';
 const normalized=chars.join(''),eol=text.includes('\r\n')?'\r\n':'\n';
 if(!normalized.trim())return text+eol+JSON.stringify(defaults,null,2).replace(/\n/g,eol)+eol;
 const value=JSON.parse(normalized);
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Settings must be an object');
 const missing=Object.fromEntries(Object.entries(defaults).filter(([key])=>!Object.hasOwn(value,key)));
 if(!Object.keys(missing).length)return text;
 const at=chars.indexOf('{')+1;
 return text.slice(0,at)+eol+Object.entries(missing).map(([k,v])=>'  '+JSON.stringify(k)+': '+JSON.stringify(v)).join(','+eol)+(Object.keys(value).length?',':'')+eol+text.slice(at);
}
`;
