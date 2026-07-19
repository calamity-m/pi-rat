import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

import { promptForPassphrase, reviewPreparedCredential, runSetupWizard } from "./autowizard.ts";
import { errorMessage, readConfig, writeConfig } from "./config.ts";
import { prepareCredential } from "./credentials.ts";
import type { CredentialSource, MtlsConfig, PreparedCredential, RuntimeStatus } from "./types.ts";

/**
 * Present an mTLS client certificate on every HTTPS request made by Pi.
 *
 * Configuration is stored under `mtls` in ~/.pi/agent/settings.json. Secrets
 * are never written there. `pass` and GNOME Keyring entries contain either a
 * combined PEM certificate/private-key bundle or a base64 PKCS#12 payload.
 * Run /mtls to inspect status, configure a source, or disable mTLS.
 */

const STATUS_KEY = "mtls";
const GLOBAL_DISPATCHER_KEY = Symbol.for("pi-rat.mtls.dispatcher");

interface GlobalDispatcherState {
  dispatcher: EnvHttpProxyAgent;
  fingerprint: string;
  previousDispatcher: Dispatcher;
}

function sourceLabel(source: CredentialSource | undefined): string {
  if (!source) return "none";
  switch (source.type) {
    case "pem":
      return "PEM files";
    case "p12":
      return "PKCS#12/PFX file";
    case "pass":
      return `pass (${source.format})`;
    case "gnome-keyring":
      return `GNOME Keyring (${source.format})`;
  }
}

function statusLines(status: RuntimeStatus): string[] {
  switch (status.state) {
    case "not-configured":
      return ["mTLS is not configured.", "Run /mtls setup to configure a certificate source."];
    case "disabled":
      return ["mTLS is disabled in ~/.pi/agent/settings.json."];
    case "error":
      return [
        "mTLS is not active.",
        ...(status.source ? [`Source: ${status.source}`] : []),
        `Error: ${status.message}`,
      ];
    case "active": {
      const lines = [
        "mTLS is active.",
        `Source: ${status.source}`,
        `CA trust: ${status.customCa ? "custom CA bundle" : "system CAs"}`,
        `Loaded: ${status.loadedAt.toLocaleString()}`,
      ];
      if (status.certificate) {
        lines.push(
          `Subject: ${status.certificate.subject}`,
          `Issuer: ${status.certificate.issuer}`,
          `Valid until: ${status.certificate.validTo}`,
          `SHA-256: ${status.certificate.fingerprint256}`,
        );
      } else {
        lines.push("Certificate metadata: contained in PKCS#12/PFX (not exposed by Node.js)");
      }
      return lines;
    }
  }
}

export default function mtlsExtension(pi: ExtensionAPI) {
  let runtimeStatus: RuntimeStatus = { state: "not-configured" };
  let activeDispatcher: EnvHttpProxyAgent | undefined;

  function updateUi(ctx: ExtensionContext): void {
    if (runtimeStatus.state === "active") {
      ctx.ui.setStatus(STATUS_KEY, `mTLS: active (${runtimeStatus.source})`);
    } else if (runtimeStatus.state === "error") {
      ctx.ui.setStatus(STATUS_KEY, "mTLS: error");
    } else if (runtimeStatus.state === "disabled") {
      ctx.ui.setStatus(STATUS_KEY, "mTLS: off");
    } else {
      ctx.ui.setStatus(STATUS_KEY, "mTLS: not configured");
    }
  }

  function installDispatcher(prepared: PreparedCredential, config: MtlsConfig): void {
    const globalRecord = globalThis as Record<symbol, unknown>;
    let state = globalRecord[GLOBAL_DISPATCHER_KEY] as GlobalDispatcherState | undefined;
    const current = getGlobalDispatcher();

    if (state?.fingerprint === prepared.fingerprint) {
      if (current !== state.dispatcher) state.previousDispatcher = current;
    } else {
      const previousDispatcher =
        state && current === state.dispatcher ? state.previousDispatcher : current;
      const oldDispatcher = state?.dispatcher;
      const tls = { secureContext: prepared.secureContext };
      const dispatcher = new EnvHttpProxyAgent({
        allowH2: false,
        bodyTimeout: 300_000,
        headersTimeout: 300_000,
        connect: tls,
        requestTls: tls,
      });
      (dispatcher as unknown as NodeJS.EventEmitter).on?.("error", () => {});
      state = { dispatcher, fingerprint: prepared.fingerprint, previousDispatcher };
      globalRecord[GLOBAL_DISPATCHER_KEY] = state;
      if (oldDispatcher && oldDispatcher !== dispatcher) void oldDispatcher.close().catch(() => {});
    }

    activeDispatcher = state.dispatcher;
    setGlobalDispatcher(state.dispatcher);
    runtimeStatus = {
      state: "active",
      source: sourceLabel(config.source),
      customCa: config.caPath !== undefined,
      loadedAt: new Date(),
      ...(prepared.certificate ? { certificate: prepared.certificate } : {}),
    };
  }

  function uninstallDispatcher(): void {
    const globalRecord = globalThis as Record<symbol, unknown>;
    const state = globalRecord[GLOBAL_DISPATCHER_KEY] as GlobalDispatcherState | undefined;
    if (state) {
      if (getGlobalDispatcher() === state.dispatcher) setGlobalDispatcher(state.previousDispatcher);
      delete globalRecord[GLOBAL_DISPATCHER_KEY];
      void state.dispatcher.close().catch(() => {});
    }
    activeDispatcher = undefined;
  }

  function assertDispatcher(): void {
    if (activeDispatcher && getGlobalDispatcher() !== activeDispatcher) {
      setGlobalDispatcher(activeDispatcher);
    }
  }

  async function activate(config: MtlsConfig, ctx: ExtensionContext): Promise<void> {
    if (!config.enabled) {
      uninstallDispatcher();
      runtimeStatus = { state: "disabled" };
      updateUi(ctx);
      return;
    }
    const prepared = await prepareCredential(config, pi, ctx, promptForPassphrase);
    installDispatcher(prepared, config);
    updateUi(ctx);
  }

  async function configure(ctx: ExtensionContext): Promise<boolean> {
    const current = await readConfig();
    let draft = current.config;

    while (true) {
      const config = await runSetupWizard(ctx, draft);
      if (!config) return false;

      let prepared: PreparedCredential;
      try {
        prepared = await prepareCredential(config, pi, ctx, promptForPassphrase);
      } catch (error) {
        ctx.ui.notify(`mTLS validation failed: ${errorMessage(error)}`, "error");
        if (ctx.mode !== "tui") return false;
        const retry = await ctx.ui.confirm(
          "Return to mTLS setup?",
          "Keep the entered values and correct the source configuration?",
        );
        if (!retry) return false;
        draft = config;
        continue;
      }

      const decision = await reviewPreparedCredential(ctx, config, prepared);
      if (decision === "cancel") return false;
      if (decision === "back") {
        draft = config;
        continue;
      }

      try {
        await writeConfig(config);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return false;
      }

      installDispatcher(prepared, config);
      updateUi(ctx);
      ctx.ui.notify("mTLS configured and active", "info");
      return true;
    }
  }

  async function disable(ctx: ExtensionContext): Promise<void> {
    const result = await readConfig();
    const config: MtlsConfig = { ...(result.config ?? { enabled: false }), enabled: false };
    try {
      await writeConfig(config);
      uninstallDispatcher();
      runtimeStatus = { state: "disabled" };
      updateUi(ctx);
      ctx.ui.notify("mTLS disabled", "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }

  function showStatus(ctx: ExtensionContext): void {
    ctx.ui.notify(
      statusLines(runtimeStatus).join("\n"),
      runtimeStatus.state === "error" ? "error" : "info",
    );
  }

  pi.registerCommand("mtls", {
    description: "Show mTLS status or configure the client certificate",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        showStatus(ctx);
        return;
      }
      if (action === "setup" || action === "configure") {
        await ctx.waitForIdle();
        await configure(ctx);
        return;
      }
      if (action === "disable") {
        await ctx.waitForIdle();
        await disable(ctx);
        return;
      }
      if (action !== "") {
        ctx.ui.notify("Usage: /mtls [status|setup|disable]", "warning");
        return;
      }

      const choice = await ctx.ui.select("mTLS", [
        "Show status",
        "Run setup wizard",
        "Disable mTLS",
      ]);
      if (choice === "Show status") {
        showStatus(ctx);
      } else if (choice === "Run setup wizard") {
        await ctx.waitForIdle();
        await configure(ctx);
      } else if (choice === "Disable mTLS") {
        await ctx.waitForIdle();
        await disable(ctx);
      }
    },
  });

  pi.on("before_provider_request", () => {
    assertDispatcher();
  });

  pi.on("session_start", async (_event, ctx) => {
    const result = await readConfig();
    if (result.error) {
      uninstallDispatcher();
      runtimeStatus = { state: "error", message: result.error };
      updateUi(ctx);
      ctx.ui.notify(result.error, "error");
      return;
    }

    if (!result.config) {
      uninstallDispatcher();
      runtimeStatus = { state: "not-configured" };
      updateUi(ctx);
      if (ctx.mode === "tui") {
        ctx.ui.notify("mTLS is not configured; starting setup", "info");
        await configure(ctx);
      }
      return;
    }

    try {
      await activate(result.config, ctx);
      assertDispatcher();
    } catch (error) {
      uninstallDispatcher();
      runtimeStatus = {
        state: "error",
        message: errorMessage(error),
        source: sourceLabel(result.config.source),
      };
      updateUi(ctx);
      ctx.ui.notify(`mTLS could not be activated: ${errorMessage(error)}`, "error");
    }
  });
}
