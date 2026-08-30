// Attested Harness — browser auth + attestation shell.
//
// This is the Privasys fork layer over the stock dsh web UI. It runs as a
// SEPARATE bundle from dsh (its own DOM roots, no shared framework) and owns
// three things the stock UI cannot do on the confidential platform:
//
//   1. Sign-in gate. The enclave gateway enforces sealed transport
//      (X-Privasys-Edge: terminate -> manager requireSealed), so a plain
//      browser load is 403'd "sealed-transport-required". We gate the whole
//      app behind a Privasys wallet/passkey/social ceremony (@privasys/auth
//      AuthFrame) that also establishes a sealed CBOR-AES-GCM session against
//      the harness enclave — the same transport chat.privasys.org uses.
//
//   2. Sealed transport hand-off. On a live sealed session we publish it to
//      dsh via `window.__PRIVASYS_SEALED__` and boot dsh through
//      `window.__PRIVASYS_BOOT__` (installed by the patched apps/web/main.ts).
//      dsh's connection plugin then routes its whole API — unary RPC + the
//      SSE event downlinks — through the sealed session instead of plain
//      fetch + WebSockets (which cannot traverse the sealed relay).
//
//   3. Attestation panel. A shield in the top-right opens a drawer that shows
//      the live evidence: the enclave your wallet attested at sign-in, the
//      harness measurement, and the attested dependency set (Confidential AI +
//      each tool) the agent loop is pinned to. "Trust you can verify."
//
// The SDK's frame-client is loaded first as a classic <script>
// (vendor/privasys-auth-client.iife.js -> window.Privasys); this module uses
// window.Privasys.AuthFrame. No bundler, no npm install in the enclave image.

/** @typedef {import('@privasys/auth').SealedSession} SealedSession */

// --- configuration ---------------------------------------------------------
// Deploy-time overridable via a `window.__PRIVASYS_CFG__ = {...}` <script>
// injected into index.html (see the Dockerfile / entrypoint). Defaults target
// the dev control plane + the apps-test enclave gateway the harness runs on.
const CFG = Object.assign(
    {
        // Management-service API base (session-relay metadata, attribute billing).
        apiBase: 'https://api-test.privasys.org',
        // Hosted auth iframe origin (privasys.id OIDC PKCE + wallet broker).
        authOrigin: 'https://privasys.id',
        // OIDC relying-party id (the IdP), NOT the app.
        rpId: 'privasys.id',
        // Shared platform OIDC client.
        clientId: 'privasys-platform',
        // The app as registered on the platform (UUID is unambiguous).
        appName: '590ebdc3-1b63-401f-bbb8-22d5f3886c5e',
        // The enclave host the sealed session is attested against.
        appHost: 'attested-harness.apps-test.privasys.org',
        // Broker relay for the wallet QR / push channel.
        brokerUrl: 'wss://relay.privasys.org/relay'
    },
    /** @type {any} */ (window).__PRIVASYS_CFG__ || {}
);

const AuthFrame = /** @type {any} */ (window).Privasys?.AuthFrame;

// --- DOM scaffolding -------------------------------------------------------
const shellRoot = document.getElementById('privasys-shell');
if (!shellRoot) throw new Error('privasys-shell: missing #privasys-shell mount');

function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') node.className = v;
            else if (k === 'style') node.setAttribute('style', v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v != null) node.setAttribute(k, String(v));
        }
    }
    for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

// Full-viewport gate container the SDK renders its ceremony into.
const gate = el('div', { id: 'privasys-gate', class: 'pv-gate' });
// Persistent top-right chrome (attestation shield) shown once signed in.
const chrome = el('div', { id: 'privasys-chrome', class: 'pv-chrome pv-hidden' });
shellRoot.appendChild(gate);
shellRoot.appendChild(chrome);

function setGate(...children) {
    gate.replaceChildren(...children);
    gate.classList.remove('pv-hidden');
}
function hideGate() {
    gate.classList.add('pv-hidden');
    gate.replaceChildren();
}

// --- sign-in flow ----------------------------------------------------------
let sealed = /** @type {SealedSession | null} */ (null);
// The live AuthFrame instance, hoisted so sign-out can clear its session.
let frame = /** @type {any} */ (null);

// Pitch strings for the SDK gate's left panel (page presentation). The SDK
// styles them; we supply copy only — the header, the "Secured by Privasys ID"
// seal, the ceremony states, and the terms footer are all the SDK's global,
// branded UI. We render NO chrome of our own around it (mirrors
// chat.privasys.org's SignInGate).
const HARNESS_PITCH = {
    title: 'A coding agent you can verify.',
    description:
        'The Attested Harness runs its agent and model inside hardware-protected ' +
        'enclaves. The operator can never read your prompts or the agent’s work, ' +
        'and you can verify it yourself by remote attestation.',
    bullets: [
        'Sealed browser-to-enclave transport. The gateway only sees ciphertext.',
        'Every model call is attested Confidential AI. No bearer keys.',
        'Each tool the agent uses is a separately verified enclave.',
        'No passwords. Sign in with the Privasys Wallet on your phone.'
    ]
};

async function run() {
    if (!AuthFrame) {
        showAuthFallback(
            'The Privasys authentication script did not load. Reload the page.',
            false
        );
        return;
    }

    // One container; the SDK's `page` presentation fills it with the ENTIRE
    // branded surface when a ceremony is needed. During connect()'s SILENT
    // restore the SDK paints nothing (the session iframe is invisible), which
    // used to leave a blank white page for several seconds — so show a
    // connecting card (chat does the same) and drop it the moment the SDK
    // mounts its ceremony iframe or connect() settles.
    gate.replaceChildren();
    gate.classList.remove('pv-hidden');
    const connecting = el('div', { class: 'pv-connecting' },
        spinnerCard('Connecting…', 'Restoring your secure session.'));
    gate.appendChild(connecting);
    const gateObserver = new MutationObserver(() => {
        if (gate.querySelector('iframe')) {
            connecting.remove();
            gateObserver.disconnect();
        }
    });
    gateObserver.observe(gate, { childList: true, subtree: true });
    const clearConnecting = () => { gateObserver.disconnect(); connecting.remove(); };

    frame = new AuthFrame({
        apiBase: CFG.apiBase,
        authOrigin: CFG.authOrigin,
        rpId: CFG.rpId,
        clientId: CFG.clientId,
        appName: CFG.appName,
        brokerUrl: CFG.brokerUrl,
        // Minimal identity — the harness needs a subject, not attributes.
        scope: ['openid', 'offline_access'],
        container: gate,
        presentation: 'page',
        // Sealed instance: the end-to-end encrypted session is established only
        // over the wallet-attested channel (same constraint as chat).
        methods: ['wallet'],
        pitch: HARNESS_PITCH,
        // App identity for the gate header + the "Secured by Privasys ID" seal.
        app: {
            displayName: 'Attested Harness',
            logoUrl: location.origin + '/privasys/privasys-logo.mini.svg'
        },
        // Establish the sealed transport against the harness enclave.
        sessionRelay: { appHost: CFG.appHost }
    });

    try {
        // connect(): silent restore -> one-tap re-approval -> full ceremony,
        // all rendered by the SDK. Resolves with the sealed session once the
        // enclave is attested and the transport is live.
        const res = await frame.connect();
        clearConnecting();
        if (!res.session) {
            showAuthFallback(
                'Signed in, but the enclave returned no sealed session. The harness ' +
                'requires end-to-end encryption. Please try again.',
                false
            );
            return;
        }
        sealed = res.session;
        onAuthenticated();
    } catch (err) {
        clearConnecting();
        const code = /** @type {any} */ (err)?.code;
        if (code === 'cancelled') {
            showAuthFallback('Sign-in was closed.', true);
            return;
        }
        showAuthFallback(
            String(/** @type {any} */ (err)?.message || err || 'Sign-in failed') + '.',
            false
        );
    }
}

// Minimal fallback shown ONLY on error/cancel (never during the normal SDK
// flow) — a single button that re-enters the SDK gate. Mirrors chat's
// closed/error panel.
function showAuthFallback(message, closed) {
    setGate(el('div', { class: 'pv-card pv-center' },
        el('div', { class: 'pv-card-title' }, closed ? 'Sign-in closed' : 'Sign-in problem'),
        el('div', { class: 'pv-card-sub' }, message),
        el('button', { class: 'pv-btn pv-btn-primary', onclick: () => void run() }, 'Sign in')));
}

function onAuthenticated() {
    // Hand the sealed transport to dsh and boot it. The patched apps/web
    // main.ts reads __PRIVASYS_SEALED__ when its connection plugin applies.
    /** @type {any} */ (window).__PRIVASYS_SEALED__ = sealed;
    // Install the sealed transport BEFORE boot: dsh's connection plugin reads
    // window.__DSH_TRANSPORT__ when it applies, and its event client opens the
    // mux WebSocket during boot — both must already be sealed-routed.
    installSealedTransport(sealed);
    const boot = /** @type {any} */ (window).__PRIVASYS_BOOT__;
    if (typeof boot === 'function') {
        try {
            boot();
        } catch (err) {
            console.error('[privasys-shell] dsh boot threw:', err);
        }
    } else {
        console.warn('[privasys-shell] __PRIVASYS_BOOT__ not installed; dsh entry missing?');
    }
    hideGate();
    mountChrome();
}

// --- sealed transport injection (dsh alpha @Remote gateway) ----------------
// The alpha removed the legacy APIProxy (AbstractApiClient) that our old
// overlay subclassed. dsh now reads a single global seam,
// `window.__DSH_TRANSPORT__ = { fetch }`, for all unary /api RPC, and — when no
// in-process stream carrier is provided — opens ONE multiplexed WebSocket at
// `/api/remote.mux` for events + every @Remote stream. We inject both here
// from our vanilla shell, so NO dsh transport source is patched:
//   * unary /api  -> sealed.request() over sealed HTTP (FIFO-ordered: the relay
//     enforces a strict monotonic c2s HTTP counter, so concurrent frames must
//     arrive in order — same fix as before, now here instead of in a TS carrier)
//   * /api/remote.mux -> sealed.openWebSocket(); we intercept ONLY that URL and
//     adapt the SDK's SealedWebSocket (ready/onMessage/onClose callbacks, binary
//     sealed frames) to the native WebSocket API dsh's mux client expects
//     (addEventListener + string message data). dsh's mux code is untouched.
const SEALED_WS_SUBPROTOCOL = 'privasys.sealed.v1';
const MUX_PATH = '/api/remote.mux';

function installSealedTransport(session) {
    // Unary RPC: FIFO chain so sealed HTTP frames reach the relay in counter
    // order (out-of-order = 401 replay -> "connection lost" storm).
    let chain = Promise.resolve();
    const enqueue = (task) => {
        const run = chain.then(task, task);
        chain = run.then(noop, noop);
        return run;
    };
    async function sealedFetch(input, init) {
        const url = typeof input === 'string' ? new URL(input, location.origin) : input;
        const path = url.pathname + url.search;
        const method = (init && init.method ? init.method : 'GET').toUpperCase();
        const body = init && init.body != null ? init.body : undefined;
        const opts = init && init.signal ? { signal: init.signal } : undefined;
        const r = await enqueue(() => session.request(method, path, body, opts));
        return new Response(/** @type {any} */ (r.body), { status: r.status });
    }
    /** @type {any} */ (window).__DSH_TRANSPORT__ = { fetch: sealedFetch };

    // Event downlink: route ONLY the mux socket through the sealed session.
    // Everything else (incl. the SDK's own sealed socket, which carries the
    // sealed subprotocol) falls through to the native WebSocket, so we never
    // recurse into our own interception.
    const NativeWebSocket = window.WebSocket;
    function isMux(u) {
        try { return new URL(u, location.origin).pathname === MUX_PATH; } catch { return false; }
    }
    function carriesSealedProto(protocols) {
        if (!protocols) return false;
        const arr = Array.isArray(protocols) ? protocols : [protocols];
        return arr.indexOf(SEALED_WS_SUBPROTOCOL) !== -1;
    }
    function InterceptingWebSocket(url, protocols) {
        if (isMux(url) && !carriesSealedProto(protocols)) {
            return new SealedWebSocketAdapter(session, MUX_PATH);
        }
        return new NativeWebSocket(url, protocols);
    }
    InterceptingWebSocket.prototype = NativeWebSocket.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        InterceptingWebSocket[k] = NativeWebSocket[k];
    }
    /** @type {any} */ (window).WebSocket = InterceptingWebSocket;
}

// Adapts an SDK SealedWebSocket to the browser WebSocket surface dsh's mux
// client uses: addEventListener('open'|'message'|'close'|'error'), readyState
// vs WebSocket.OPEN, send(string), close(code,reason). dsh requires text
// message data, so inbound sealed bytes are UTF-8 decoded to a string.
class SealedWebSocketAdapter extends EventTarget {
    constructor(session, path) {
        super();
        this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
        this.readyState = 0;
        this.binaryType = 'blob';
        this._decoder = new TextDecoder();
        try {
            this._sws = session.openWebSocket(path);
        } catch (err) {
            this.readyState = 3;
            queueMicrotask(() => {
                this.dispatchEvent(new Event('error'));
                this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: msg(err), wasClean: false }));
            });
            return;
        }
        this._sws.ready.then(
            () => { this.readyState = 1; this.dispatchEvent(new Event('open')); },
            (err) => {
                this.readyState = 3;
                this.dispatchEvent(new Event('error'));
                this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: msg(err), wasClean: false }));
            }
        );
        this._unsub = this._sws.onMessage((bytes) => {
            this.dispatchEvent(new MessageEvent('message', { data: this._decoder.decode(bytes) }));
        });
        this._sws.onClose((info) => {
            this.readyState = 3;
            this.dispatchEvent(new CloseEvent('close', {
                code: info.code, reason: info.reason, wasClean: info.wasClean
            }));
        });
        this._sws.onError(() => { this.dispatchEvent(new Event('error')); });
    }
    send(data) {
        // dsh sends JSON text; the SDK seals it into a binary frame.
        this._sws.send(data);
    }
    close(code, reason) {
        this.readyState = 2;
        try { if (this._unsub) this._unsub(); } catch { /* ignore */ }
        try { this._sws.close(code, reason); } catch { /* ignore */ }
    }
}
function msg(err) { return String((err && err.message) || err || 'error'); }
function noop() { /* keep the FIFO chain alive regardless of task outcome */ }

// --- attestation drawer ----------------------------------------------------
// The Attestation ("Verified") and User (Sign out) CONTROLS live in dsh's left
// sidebar foot, next to Settings — React rows registered into the
// sidebar.footer.action slot (overlay/brand/PrivasysRows.tsx) that call the
// window.__PRIVASYS_SHELL__ hooks below. The chrome element here only hosts
// the attestation drawer + backdrop when opened; it renders no buttons.
function mountChrome() {
    chrome.replaceChildren();
    chrome.classList.remove('pv-hidden');
}

// Clear the sealed session and re-gate. clearSession() tells the SDK's session
// iframe to forget stored credentials so the reload shows the ceremony again
// instead of silently restoring. Best-effort: even if clearSession is missing
// or throws, we still reload into the gate.
let loggingOut = false;
async function logout() {
    if (loggingOut) return;
    loggingOut = true;
    try {
        if (frame && typeof frame.clearSession === 'function') await frame.clearSession();
    } catch (err) {
        console.warn('[privasys-shell] clearSession failed; reloading anyway:', err);
    }
    try {
        delete (/** @type {any} */ (window)).__PRIVASYS_SEALED__;
    } catch { /* ignore */ }
    sealed = null;
    location.reload();
}

let drawerOpen = false;
async function openAttestation() {
    if (drawerOpen) return;
    drawerOpen = true;

    const body = el('div', { class: 'pv-drawer-body' },
        spinnerCard('Reading attestation…', 'Fetching the live evidence over the sealed session.'));
    const drawer = el('aside', { class: 'pv-drawer', role: 'dialog', 'aria-label': 'Attestation' },
        el('header', { class: 'pv-drawer-head' },
            el('h2', null, 'Attestation'),
            el('button', {
                class: 'pv-drawer-close', 'aria-label': 'Close', onclick: () => closeDrawer()
            }, '×')
        ),
        body
    );
    const backdrop = el('div', { class: 'pv-backdrop', onclick: () => closeDrawer() });
    chrome.appendChild(backdrop);
    chrome.appendChild(drawer);
    // Let the button interactions co-exist with the full dsh surface.
    chrome.classList.add('pv-chrome-open');

    function closeDrawer() {
        drawerOpen = false;
        drawer.remove();
        backdrop.remove();
        chrome.classList.remove('pv-chrome-open');
    }

    try {
        const data = await fetchAttestation();
        body.replaceChildren(attestationView(data));
    } catch (err) {
        body.replaceChildren(errorCard(
            'Could not read attestation',
            String(/** @type {any} */ (err)?.message || err) +
            '. Your session is still sealed and encrypted; this only affects the evidence panel.'
        ));
    }
}

// Pull the harness's own attestation summary over the sealed session (served
// by the Go ingress at /privasys/attestation — the egress proxy's dependency
// fold + the harness measurement + the pinned model/tool peers).
async function fetchAttestation() {
    if (!sealed) throw new Error('no sealed session');
    const r = await sealed.request('GET', '/privasys/attestation');
    if (r.status >= 400) throw new Error('attestation endpoint returned ' + r.status);
    const text = new TextDecoder().decode(r.body);
    return JSON.parse(text);
}

function attestationView(data) {
    const app = data.app || {};
    const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
    const frag = document.createDocumentFragment();

    frag.appendChild(el('p', { class: 'pv-lead' },
        'Your wallet attested this enclave end-to-end before your session opened. ' +
        'Everything below is checkable evidence, not a claim.'));

    // The enclave you are talking to.
    frag.appendChild(section('The enclave', [
        kv('Host', app.public_host || CFG.appHost),
        kv('TEE', app.tee || 'Intel TDX'),
        app.mrtd ? kv('Measurement (MRTD)', mono(app.mrtd)) : null,
        app.code_hash ? kv('App code (OID 3.2)', mono(app.code_hash)) : null,
        app.app_id ? kv('App id (OID 3.6)', mono(app.app_id)) : null
    ]));

    // The attested dependency set the agent loop is fenced to.
    const depChildren = deps.length
        ? deps.map((d) => depCard(d))
        : [el('p', { class: 'pv-muted' },
            'No dependency set reported. The egress proxy enforces the pinned ' +
            'peers regardless; this panel could not read the live fold.')];
    frag.appendChild(section(
        'Attested dependency set',
        [el('p', { class: 'pv-muted' },
            'Every model and tool call the agent makes is dialled over mutual ' +
            'RA-TLS and refused unless the peer matches one of these measurements ' +
            '(fail-closed). Model auth is the attested client certificate — no key.'),
        ...depChildren]
    ));

    // The human-readable routes those measurements gate.
    const routeRows = [];
    if (data.model_host) routeRows.push(kv('Model (Confidential AI)', data.model_host));
    if (data.tool_hosts && typeof data.tool_hosts === 'object') {
        for (const [name, host] of Object.entries(data.tool_hosts)) {
            routeRows.push(kv('Tool · ' + name, String(host)));
        }
    }
    if (routeRows.length) {
        frag.appendChild(section('Routes', [
            el('p', { class: 'pv-muted' },
                'The hosts the agent reaches — each dialled only if it matches a ' +
                'pinned measurement above.'),
            el('div', { class: 'pv-kv-list' }, ...routeRows)
        ]));
    }

    if (data.dependency_fold) {
        frag.appendChild(section('Dependency fold', [
            el('p', { class: 'pv-muted' },
                'A digest of the pinned set; it changes if any pinned peer changes.'),
            mono(data.dependency_fold)
        ]));
    }

    return frag;
}

function depCard(d) {
    const rows = [];
    if (d.host) rows.push(kv('Host', d.host));
    if (d.role) rows.push(kv('Role', d.role));
    if (d.code_hash) rows.push(kv('Code (OID 3.2)', mono(d.code_hash)));
    if (d.app_id) rows.push(kv('App id (OID 3.6)', mono(d.app_id)));
    if (Array.isArray(d.measurements)) {
        for (const m of d.measurements) {
            if (m.mrtd) rows.push(kv('MRTD', mono(m.mrtd)));
            if (m.mrenclave) rows.push(kv('MRENCLAVE', mono(m.mrenclave)));
        }
    }
    return el('div', { class: 'pv-dep' },
        el('div', { class: 'pv-dep-name' }, d.name || d.role || d.host || 'peer'),
        el('div', { class: 'pv-kv-list' }, ...rows));
}

// --- small view helpers ----------------------------------------------------
function section(title, children) {
    return el('section', { class: 'pv-section' },
        el('h3', null, title),
        ...children.filter(Boolean));
}
function kv(k, v) {
    return el('div', { class: 'pv-kv' },
        el('span', { class: 'pv-kv-k' }, k),
        typeof v === 'string' ? el('span', { class: 'pv-kv-v' }, v) : v);
}
function mono(s) {
    return el('code', { class: 'pv-mono' }, String(s));
}
function spinnerCard(title, sub) {
    return el('div', { class: 'pv-card pv-center' },
        el('div', { class: 'pv-spinner' }),
        el('div', { class: 'pv-card-title' }, title),
        sub ? el('div', { class: 'pv-card-sub' }, sub) : null);
}
function errorCard(title, sub, retry) {
    return el('div', { class: 'pv-card pv-center' },
        el('div', { class: 'pv-card-title' }, title),
        sub ? el('div', { class: 'pv-card-sub' }, sub) : null,
        retry ? el('button', { class: 'pv-btn', onclick: retry }, 'Try again') : null);
}
// Publish shell actions for the React sidebar rows (overlay/brand/
// PrivasysRows.tsx) to call.
/** @type {any} */ (window).__PRIVASYS_SHELL__ = {
    openAttestation: () => void openAttestation(),
    logout: () => void logout()
};

// --- go --------------------------------------------------------------------
run();
