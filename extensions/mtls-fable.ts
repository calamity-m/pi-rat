import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

/**
 * mtls-fable — presents a client certificate (mutual TLS) on all HTTPS
 * requests pi makes, including LLM provider traffic.
 *
 * Configuration (environment variables):
 *   PI_MTLS_CERT        path to the client certificate (PEM)   [required]
 *   PI_MTLS_KEY         path to the client private key (PEM)   [required]
 *   PI_MTLS_CA          path to a private CA bundle (PEM)      [optional]
 *   PI_MTLS_PASSPHRASE  passphrase for the private key         [optional]
 *
 * Toggle in ~/.pi/agent/settings.json (defaults to enabled; run /reload
 * after changing it — pi reinstates its own dispatcher on reload, so
 * turning the toggle off also takes effect then):
 *   { "mtlsFable": { "enabled": false } }
 */

// Stashed on globalThis so /reload reuses the agent instead of leaking sockets.
const AGENT_KEY = Symbol.for("mtls-fable.dispatcher");

function isEnabledInSettings(): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as { mtlsFable?: { enabled?: boolean } };
    return settings.mtlsFable?.enabled !== false;
  } catch {
    return true; // missing or malformed settings.json: default to enabled
  }
}

export default function (pi: ExtensionAPI) {
  if (!isEnabledInSettings()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("mtls-fable: disabled via settings.json (mtlsFable.enabled)", "info");
    });
    return;
  }

  const certPath = process.env.PI_MTLS_CERT;
  const keyPath = process.env.PI_MTLS_KEY;
  if (!certPath || !keyPath) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("mtls-fable disabled: set PI_MTLS_CERT and PI_MTLS_KEY", "warning");
    });
    return;
  }

  let dispatcher = (globalThis as Record<symbol, unknown>)[AGENT_KEY] as
    | EnvHttpProxyAgent
    | undefined;
  if (!dispatcher) {
    const tls = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      ca: process.env.PI_MTLS_CA ? readFileSync(process.env.PI_MTLS_CA) : undefined,
      passphrase: process.env.PI_MTLS_PASSPHRASE,
    };
    // Mirrors pi's own dispatcher (core/http-dispatcher.js): EnvHttpProxyAgent
    // keeps HTTP(S)_PROXY/NO_PROXY support, which pi populates from its
    // httpProxy setting. The fixed timeouts replace pi's idle-timeout setting.
    dispatcher = new EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: 300_000,
      headersTimeout: 300_000,
      connect: tls, // direct HTTPS
      requestTls: tls, // HTTPS through a proxy CONNECT tunnel
      // proxyTls: tls, // Enable if required mtls on proxy
    });
    // Pi swallows undici's internal mid-stream-abort "error" events; without a
    // listener they are unhandled EventEmitter errors that crash the process.
    (dispatcher as unknown as NodeJS.EventEmitter).on?.("error", () => {});
    (globalThis as Record<symbol, unknown>)[AGENT_KEY] = dispatcher;
  }

  const assertDispatcher = () => {
    if (getGlobalDispatcher() !== dispatcher) {
      setGlobalDispatcher(dispatcher);
    }
  };

  assertDispatcher();

  // Pi re-installs its own global dispatcher after extensions load (main.js),
  // when the HTTP idle timeout setting changes, and after /reload. Re-assert
  // at the last moment before every LLM request rather than polling.
  pi.on("before_provider_request", assertDispatcher);

  pi.on("session_start", (_event, ctx) => {
    assertDispatcher();
    ctx.ui.setStatus("mtls-fable", "mTLS: active");
  });
}
