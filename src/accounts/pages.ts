/** Small, same-origin account UI. Untrusted values are rendered with textContent. */
export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Federal Register MCP · Account</title><link rel="stylesheet" href="/account.css"><script src="/account.js" defer></script></head>
<body><header><a href="/account">Federal Register MCP</a><span>by BLEN</span></header>
<main><p class="eyebrow">YOUR REGULATORY RESEARCH CONNECTION</p><h1 id="title">Your account</h1>
<p id="intro">Connect your account to read Federal Register, eCFR, and regulations.gov data.</p>
<p id="message" role="status" aria-live="polite"></p>
<section id="signin" hidden><h2>Sign in to continue</h2><p>Manage your regulations.gov key and connect your AI assistant.</p><button id="google">Continue with Google</button></section>
<section id="account" hidden><p id="identity"></p><h2>Regulations.gov API key</h2><p id="key-status"></p>
<form id="key-form"><label for="api-key">API key</label><input id="api-key" name="apiKey" type="password" autocomplete="off" spellcheck="false" required minlength="40" maxlength="40" pattern="[A-Za-z0-9]{40}" aria-describedby="key-help">
<p id="key-help">Your key is encrypted and used only for requests to regulations.gov. It is never shown to your AI assistant.</p>
<div class="actions"><button type="submit" id="save">Save key</button><button type="button" id="remove" class="secondary" hidden>Remove saved key</button></div></form>
<p><a href="https://open.gsa.gov/api/regulationsgov/" target="_blank" rel="noreferrer">Get a free regulations.gov API key ↗</a></p>
<p class="note">Federal Register and eCFR work without an API key.</p>
<div id="connection" hidden><h2>Connect your AI assistant</h2><p>Add this MCP URL in your assistant’s connector settings:</p><code id="mcp-url"></code><p>Your assistant will open a page asking you to authorize access.</p></div>
<div id="consent" hidden><h2 id="client"></h2><p id="destination"></p><p id="local-warning" hidden>Only approve a local connection you started on this computer.</p><p>This application can read regulatory data using your account. It cannot view or change your saved key.</p><div class="actions"><button id="allow">Authorize connection</button><button id="deny" class="secondary">Cancel</button></div></div>
<button id="signout" class="secondary">Sign out</button></section>
<noscript>JavaScript is required to sign in and manage your API key.</noscript></main><footer>Federal Register · eCFR · Regulations.gov</footer></body></html>`;

export const styles = `:root{font-family:system-ui,-apple-system,sans-serif;color:#14283b;background:#f4f6f8;color-scheme:light}*{box-sizing:border-box}body{margin:0}header,footer{max-width:1000px;margin:auto;padding:24px;display:flex;justify-content:space-between}header a{font-weight:700;text-decoration:none;color:inherit}header span,footer{color:#536577;font-size:14px}main{max-width:660px;margin:40px auto;padding:0 24px}h1{font-size:36px;letter-spacing:-1px;line-height:1.15}h2{font-size:21px;margin-top:0}p{line-height:1.6}.eyebrow{color:#496b7b;font-size:11px;letter-spacing:1.5px;font-weight:700}section{background:white;border:1px solid #d5dfe6;border-radius:12px;padding:28px;margin-top:24px}label{display:block;font-weight:600;margin:18px 0 8px}input{width:100%;padding:12px;border:1px solid #889eae;border-radius:6px;font-size:16px}button{padding:12px 17px;border:1px solid #145d72;border-radius:6px;background:#145d72;color:white;font:600 14px system-ui;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.secondary{background:white;color:#284658;border-color:#b8c8d3}.actions{display:flex;gap:10px;flex-wrap:wrap}a{color:#145d72}#key-help,.note{font-size:14px;color:#536577}#message:empty{display:none}#message{padding:12px;border-left:3px solid #145d72;background:#e6f0f4}#message.error{border-color:#a82c35;color:#891c24;background:#fff0ef}#identity{font-size:14px;color:#536577;overflow-wrap:anywhere}#signout{margin-top:26px}#consent,#connection{border-top:1px solid #d5dfe6;margin-top:26px;padding-top:26px}code{display:block;overflow-wrap:anywhere;padding:12px;background:#f4f6f8}#local-warning{color:#891c24}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #bf831b;outline-offset:3px}[hidden]{display:none!important}@media(max-width:520px){main{margin:18px auto}section{padding:20px}h1{font-size:30px}header{padding:20px}}`;

export const script = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const names = new Set(params.getAll('ba_param'));
const signed = new URLSearchParams();
if (params.has('sig') && names.size) for (const [k,v] of params) {
  if (k === 'sig' || k === 'ba_param' || names.has(k)) signed.append(k,v);
}
const oauthQuery = signed.toString();
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
async function api(path, body) {
  const response = await fetch(path, { credentials:'same-origin', headers:{'Content-Type':'application/json'},
    ...(body === undefined ? {} : {method:'POST', body:JSON.stringify(body)}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The request failed. Please try again.');
  return result;
}
async function busy(fn) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (error) { message(error.message, true); }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
function go(value) {
  const url = new URL(value, location.origin);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid redirect.');
  location.assign(url.href);
}
async function load() {
  const session = await api('/api/auth/get-session');
  if (!session?.user?.emailVerified) { $('signin').hidden = false; return; }
  $('signin').hidden = true;
  $('account').hidden = false;
  const data = await api('/api/portal/account');
  $('identity').textContent = 'Signed in as ' + data.email;
  $('key-status').textContent = data.key.connected ? 'Your key is saved. Enter a new key to replace it.' : 'No key saved yet. Add one to query regulations.gov.';
  $('save').textContent = data.key.connected ? 'Replace key' : 'Save key';
  $('remove').hidden = !data.key.connected;
  $('mcp-url').textContent = data.mcpUrl;
  $('connection').hidden = !!oauthQuery;
  if (oauthQuery) {
    const consent = await api('/api/portal/consent?oauth_query=' + encodeURIComponent(oauthQuery));
    $('title').textContent = 'Authorize your connection';
    $('client').textContent = 'Connect ' + consent.client;
    $('destination').textContent = 'You will return to ' + consent.destination;
    $('local-warning').hidden = !consent.local;
    $('consent').hidden = false;
  }
}
$('google').onclick = () => busy(async () => {
  const result = await api('/api/auth/sign-in/social', { provider:'google',
    errorCallbackURL:'/sign-in' + (oauthQuery ? '?' + oauthQuery : ''),
    ...(oauthQuery ? {oauth_query:oauthQuery} : {callbackURL:'/account'}) });
  go(result.url);
});
$('key-form').onsubmit = event => { event.preventDefault(); busy(async () => {
  await api('/api/portal/keys', {apiKey:$('api-key').value.trim()});
  $('api-key').value = ''; await load(); message('Your regulations.gov key is saved.');
}); };
$('remove').onclick = () => busy(async () => {
  await api('/api/portal/keys/delete', {}); $('api-key').value = ''; await load(); message('Your saved key was removed.');
});
for (const id of ['allow','deny']) $(id).onclick = () => busy(async () => {
  const result = await api('/api/portal/consent', {oauth_query:oauthQuery, accept:id === 'allow'}); go(result.url);
});
$('signout').onclick = () => busy(async () => { await api('/api/auth/sign-out', {}); location.assign('/sign-in'); });
load().catch(error => message(error.message, true));
`;
