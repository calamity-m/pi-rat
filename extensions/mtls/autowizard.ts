import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";

import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type Focusable,
  type SelectItem,
  SelectList,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { resolveUserPath } from "./config.ts";
import type { CredentialSource, MtlsConfig, PreparedCredential, SecretFormat } from "./types.ts";
import {
  discoverPassEntries,
  formatKeyringAttributes,
  parseKeyringAttributes,
} from "./wizard-data.ts";

type SourceType = CredentialSource["type"];
type ReviewDecision = "save" | "back" | "cancel";

interface SourceCapability {
  type: SourceType;
  available: boolean;
  item: SelectItem;
}

interface EditorPromptOptions {
  title: string;
  description: string;
  initial?: string;
  required?: boolean;
  autocomplete?: AutocompleteProvider;
  openSuggestions?: boolean;
  validate?: (value: string) => Promise<string | undefined>;
}

class PathAutocompleteProvider implements AutocompleteProvider {
  private readonly base = new CombinedAutocompleteProvider([], homedir());

  constructor(private readonly expectedExtensions: ReadonlySet<string>) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) {
    const result = await this.base.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!result) return null;

    const items = result.items
      .map((item) => {
        const directory = item.label.endsWith("/");
        const relevant =
          directory || this.expectedExtensions.has(extname(item.label).toLowerCase());
        return {
          ...item,
          description: directory ? "directory" : relevant ? "matching file type" : "other file",
          relevant,
        };
      })
      .sort((left, right) => Number(right.relevant) - Number(left.relevant));
    return {
      prefix: result.prefix,
      items: items.map(({ relevant: _relevant, ...item }) => item),
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

class ValueAutocompleteProvider implements AutocompleteProvider {
  constructor(private readonly items: AutocompleteItem[]) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ) {
    const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const query = prefix.toLowerCase();
    const matches = this.items.filter((item) => {
      const searchable = `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase();
      return searchable.includes(query);
    });
    return matches.length > 0 ? { items: matches, prefix } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    const next = [...lines];
    const current = next[cursorLine] ?? "";
    next[cursorLine] =
      `${current.slice(0, cursorCol - prefix.length)}${item.value}${current.slice(cursorCol)}`;
    return {
      lines: next,
      cursorLine,
      cursorCol: cursorCol - prefix.length + item.value.length,
    };
  }
}

async function executableAvailable(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

async function sourceCapabilities(): Promise<SourceCapability[]> {
  const [hasPass, hasSecretTool] = await Promise.all([
    executableAvailable("pass"),
    executableAvailable("secret-tool"),
  ]);
  const keyringSession = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
  return [
    {
      type: "pem",
      available: true,
      item: {
        value: "pem",
        label: "PEM certificate and key files",
        description: "Separate certificate and private-key files; encrypted keys are supported",
      },
    },
    {
      type: "p12",
      available: true,
      item: {
        value: "p12",
        label: "PKCS#12/PFX file",
        description: "One .p12 or .pfx file; passphrase requested securely",
      },
    },
    {
      type: "pass",
      available: hasPass,
      item: {
        value: "pass",
        label: `pass password-store${hasPass ? "" : " (unavailable)"}`,
        description: hasPass
          ? "Browse password-store entries without decrypting them"
          : "The pass executable was not found in PATH",
      },
    },
    {
      type: "gnome-keyring",
      available: hasSecretTool,
      item: {
        value: "gnome-keyring",
        label: `GNOME Keyring${hasSecretTool ? "" : " (unavailable)"}`,
        description: hasSecretTool
          ? keyringSession
            ? "Look up a secret by service and account attributes"
            : "secret-tool found; no D-Bus session was detected"
          : "The secret-tool executable was not found in PATH",
      },
    },
  ];
}

function selectTheme(theme: ExtensionContext["ui"]["theme"]) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

async function selectRich(
  ctx: ExtensionContext,
  title: string,
  description: string,
  items: SelectItem[],
  initialValue?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("muted", description), 1, 0));
    const list = new SelectList(items, Math.min(10, items.length), selectTheme(theme));
    const initialIndex = items.findIndex((item) => item.value === initialValue);
    if (initialIndex >= 0) list.setSelectedIndex(initialIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function promptEditor(
  ctx: ExtensionContext,
  options: EditorPromptOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: selectTheme(theme),
    };
    const editor = new Editor(tui, editorTheme, { autocompleteMaxVisible: 8 });
    editor.setText(options.initial ?? "");
    if (options.autocomplete) editor.setAutocompleteProvider(options.autocomplete);

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
    container.addChild(new Text(theme.fg("muted", options.description), 1, 0));
    container.addChild(editor);
    const feedback = new Text("", 1, 0);
    container.addChild(feedback);
    container.addChild(
      new Text(
        theme.fg("dim", "Tab browse/complete • Enter continue • Esc cancel • Ctrl+U clear"),
        1,
        0,
      ),
    );
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    let submitting = false;
    editor.onSubmit = (rawValue) => {
      if (submitting) return;
      submitting = true;
      void (async () => {
        const value = rawValue.trim();
        let error: string | undefined;
        if (options.required && value === "") error = "A value is required.";
        if (!error && options.validate) error = await options.validate(value);
        if (error) {
          feedback.setText(theme.fg("warning", error));
          submitting = false;
          tui.requestRender();
          return;
        }
        done(value);
      })();
    };

    if (options.openSuggestions && options.autocomplete) {
      queueMicrotask(() => editor.handleInput("\t"));
    }

    return {
      get focused() {
        return editor.focused;
      },
      set focused(value: boolean) {
        editor.focused = value;
      },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        editor.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function validateFile(value: string, optional = false): Promise<string | undefined> {
  if (optional && value === "") return undefined;
  try {
    const info = await stat(resolveUserPath(value));
    return info.isFile() ? undefined : "The selected path is not a file.";
  } catch (error) {
    return `Cannot read this file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function selectSecretFormat(
  ctx: ExtensionContext,
  initial?: SecretFormat,
): Promise<SecretFormat | undefined> {
  const value = await selectRich(
    ctx,
    "Secret payload format",
    "The secret itself is never displayed by the wizard.",
    [
      {
        value: "pem",
        label: "Combined PEM bundle",
        description: "Certificate chain and private key in one multiline secret",
      },
      {
        value: "p12-base64",
        label: "Base64 PKCS#12/PFX",
        description: "A binary .p12/.pfx payload encoded as base64",
      },
    ],
    initial,
  );
  return value as SecretFormat | undefined;
}

export async function runSetupWizard(
  ctx: ExtensionContext,
  draft?: MtlsConfig,
): Promise<MtlsConfig | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The mTLS setup wizard requires interactive TUI mode", "warning");
    return undefined;
  }

  const capabilities = await sourceCapabilities();
  let selectedType: SourceType | undefined;
  while (!selectedType) {
    const selection = await selectRich(
      ctx,
      "mTLS certificate source",
      "Choose where Pi should load its client identity. Availability is checked locally.",
      capabilities.map((capability) => capability.item),
      draft?.source?.type,
    );
    if (!selection) return undefined;
    const capability = capabilities.find((candidate) => candidate.type === selection);
    if (!capability?.available) {
      ctx.ui.notify(capability?.item.description ?? "This source is unavailable", "warning");
      continue;
    }
    selectedType = selection as SourceType;
  }

  const previous = draft?.source?.type === selectedType ? draft.source : undefined;
  let source: CredentialSource;
  if (selectedType === "pem") {
    const certPath = await promptEditor(ctx, {
      title: "Client certificate",
      description: "Type a path or press Tab to browse. PEM, CRT, and CER files are prioritized.",
      initial: previous?.type === "pem" ? previous.certPath : "~/",
      required: true,
      autocomplete: new PathAutocompleteProvider(new Set([".pem", ".crt", ".cer"])),
      validate: validateFile,
    });
    if (certPath === undefined) return undefined;
    const keyPath = await promptEditor(ctx, {
      title: "Client private key",
      description: "Encrypted PEM keys are supported and will trigger a masked passphrase prompt.",
      initial: previous?.type === "pem" ? previous.keyPath : "~/",
      required: true,
      autocomplete: new PathAutocompleteProvider(new Set([".pem", ".key"])),
      validate: validateFile,
    });
    if (keyPath === undefined) return undefined;
    source = { type: "pem", certPath, keyPath };
  } else if (selectedType === "p12") {
    const path = await promptEditor(ctx, {
      title: "PKCS#12/PFX client identity",
      description: "Type a path or press Tab to browse. P12 and PFX files are prioritized.",
      initial: previous?.type === "p12" ? previous.path : "~/",
      required: true,
      autocomplete: new PathAutocompleteProvider(new Set([".p12", ".pfx", ".pkcs12"])),
      validate: validateFile,
    });
    if (path === undefined) return undefined;
    source = { type: "p12", path };
  } else if (selectedType === "pass") {
    const entries = await discoverPassEntries();
    const entry = await promptEditor(ctx, {
      title: "pass password-store entry",
      description:
        entries.length > 0
          ? `${entries.length} entries discovered without decrypting them. Type to filter or press Tab.`
          : "No entries were discovered; enter the pass entry name directly.",
      initial: previous?.type === "pass" ? previous.entry : "",
      required: true,
      autocomplete: new ValueAutocompleteProvider(
        entries.map((value) => ({ value, label: value, description: "password-store entry" })),
      ),
      openSuggestions: entries.length > 0 && previous?.type !== "pass",
    });
    if (entry === undefined) return undefined;
    const format = await selectSecretFormat(
      ctx,
      previous?.type === "pass" ? previous.format : undefined,
    );
    if (!format) return undefined;
    source = { type: "pass", entry, format };
  } else {
    const attributesInput = await promptEditor(ctx, {
      title: "GNOME Keyring lookup attributes",
      description:
        "Enter comma-separated key=value pairs. secret-tool cannot safely enumerate arbitrary secrets.",
      initial:
        previous?.type === "gnome-keyring"
          ? formatKeyringAttributes(previous.attributes)
          : "service=pi-mtls, account=",
      required: true,
      autocomplete: new ValueAutocompleteProvider([
        {
          value: "service=pi-mtls, account=",
          label: "service=pi-mtls, account=…",
          description: "recommended service/account lookup",
        },
      ]),
      validate: async (value) => {
        try {
          parseKeyringAttributes(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (attributesInput === undefined) return undefined;
    const format = await selectSecretFormat(
      ctx,
      previous?.type === "gnome-keyring" ? previous.format : undefined,
    );
    if (!format) return undefined;
    source = {
      type: "gnome-keyring",
      attributes: parseKeyringAttributes(attributesInput),
      format,
    };
  }

  const caPath = await promptEditor(ctx, {
    title: "Custom CA bundle (optional)",
    description: "Leave blank to use system CAs, or type a path/press Tab to browse CA files.",
    initial: draft?.caPath ?? "",
    autocomplete: new PathAutocompleteProvider(new Set([".pem", ".crt", ".cer"])),
    validate: (value) => validateFile(value, true),
  });
  if (caPath === undefined) return undefined;
  return { enabled: true, source, ...(caPath ? { caPath } : {}) };
}

function sourceSummary(source: CredentialSource | undefined): string[] {
  if (!source) return ["Source: none"];
  switch (source.type) {
    case "pem":
      return [
        `Source: PEM files`,
        `Certificate: ${source.certPath}`,
        `Private key: ${source.keyPath}`,
      ];
    case "p12":
      return ["Source: PKCS#12/PFX file", `Identity: ${source.path}`];
    case "pass":
      return ["Source: pass password-store", `Entry: ${source.entry}`, `Format: ${source.format}`];
    case "gnome-keyring":
      return [
        "Source: GNOME Keyring",
        `Lookup: ${Object.entries(source.attributes)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
        `Format: ${source.format}`,
      ];
  }
}

export async function reviewPreparedCredential(
  ctx: ExtensionContext,
  config: MtlsConfig,
  prepared: PreparedCredential,
): Promise<ReviewDecision> {
  const lines = [
    ...sourceSummary(config.source),
    `CA trust: ${config.caPath ? `custom (${config.caPath})` : "system CAs"}`,
  ];
  if (prepared.certificate) {
    lines.push(
      `Subject: ${prepared.certificate.subject}`,
      `Issuer: ${prepared.certificate.issuer}`,
      `Valid until: ${prepared.certificate.validTo}`,
      `SHA-256: ${prepared.certificate.fingerprint256}`,
    );
  } else {
    lines.push("Certificate metadata is contained in PKCS#12/PFX and is not exposed by Node.js.");
  }

  const decision = await selectRich(
    ctx,
    "Review validated mTLS identity",
    lines.join("\n"),
    [
      {
        value: "save",
        label: "Save and activate",
        description: "Write non-secret settings and enable mTLS",
      },
      {
        value: "back",
        label: "Back to setup",
        description: "Keep these values and edit the wizard again",
      },
      {
        value: "cancel",
        label: "Cancel",
        description: "Keep the currently active configuration unchanged",
      },
    ],
    "save",
  );
  return (decision ?? "cancel") as ReviewDecision;
}

class MaskedPassphraseComponent implements Component, Focusable {
  focused = false;
  private value = "";
  private pasteBuffer = "";
  private isPasting = false;

  constructor(
    private readonly title: string,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: string | undefined) => void,
    private readonly requestRender: () => void,
    private readonly fg: (color: "accent" | "text" | "dim", text: string) => string,
    private readonly bold: (text: string) => string,
  ) {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit") || data === "\n") {
      this.done(this.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.value = Array.from(this.value).slice(0, -1).join("");
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
      this.value = "";
      this.requestRender();
      return;
    }

    if (data.includes("\x1b[200~")) {
      this.isPasting = true;
      this.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }
    if (this.isPasting) {
      this.pasteBuffer += data;
      const end = this.pasteBuffer.indexOf("\x1b[201~");
      if (end === -1) return;
      this.value += this.pasteBuffer.slice(0, end).replace(/[\r\n]/g, "");
      const remaining = this.pasteBuffer.slice(end + 6);
      this.pasteBuffer = "";
      this.isPasting = false;
      if (remaining) this.handleInput(remaining);
      this.requestRender();
      return;
    }

    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.value += kittyPrintable;
      this.requestRender();
      return;
    }
    const hasControlCharacters = Array.from(data).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    if (!hasControlCharacters) {
      this.value += data;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines = [this.fg("accent", "─".repeat(renderWidth))];
    lines.push(...wrapTextWithAnsi(` ${this.fg("accent", this.bold(this.title))}`, renderWidth));
    lines.push(
      ...wrapTextWithAnsi(
        ` ${this.fg("dim", "Input is obscured and is not added to the session.")}`,
        renderWidth,
      ),
    );
    lines.push("");

    const prefix = renderWidth >= 2 ? "> " : ">";
    const available = Math.max(0, renderWidth - visibleWidth(prefix));
    const count = Array.from(this.value).length;
    let mask = "•".repeat(Math.min(count, Math.max(0, available - 1)));
    if (count > mask.length && mask.length > 0) mask = `…${mask.slice(1)}`;
    const marker = this.focused ? CURSOR_MARKER : "";
    const cursor = available > 0 ? `${marker}\x1b[7m \x1b[27m` : "";
    lines.push(`${prefix}${this.fg("text", mask)}${cursor}`);
    lines.push("");
    lines.push(
      ...wrapTextWithAnsi(
        ` ${this.fg("dim", "Enter submit • Esc cancel • Ctrl+U clear")}`,
        renderWidth,
      ),
    );
    lines.push(this.fg("accent", "─".repeat(renderWidth)));
    return lines;
  }

  invalidate(): void {}
}

export async function promptForPassphrase(
  ctx: ExtensionContext,
  title: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    return new MaskedPassphraseComponent(
      title,
      keybindings,
      done,
      () => tui.requestRender(),
      (color, text) => theme.fg(color, text),
      (text) => theme.bold(text),
    );
  });
}
