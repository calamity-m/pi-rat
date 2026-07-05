import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";

import { NestedPickerPanel, type NestedPickerRow } from "./lib/nested-picker-panel.ts";

interface DemoValue {
  kind: string;
}

const demoRows: readonly NestedPickerRow<DemoValue>[] = [
  {
    id: "start",
    label: "start",
    description: "Open the first branch",
    value: { kind: "branch" },
    children: [
      {
        id: "middle",
        label: "middle",
        description: "Continue toward nested leaf content",
        value: { kind: "branch" },
        children: [
          {
            id: "end",
            label: "end",
            description: "Interactive leaf content",
            value: { kind: "leaf" },
          },
          {
            id: "alternate-end",
            label: "alternate end",
            description: "Static leaf content",
            value: { kind: "leaf" },
          },
        ],
      },
      {
        id: "side-quest",
        label: "side quest",
        description: "Leaf beside the middle branch",
        value: { kind: "leaf" },
      },
    ],
  },
  {
    id: "tools",
    label: "tools",
    description: "A second top-level branch for search",
    value: { kind: "branch" },
    children: [
      {
        id: "hammer",
        label: "hammer",
        description: "Static text content",
        value: { kind: "leaf" },
      },
      { id: "saw", label: "saw", description: "Static text content", value: { kind: "leaf" } },
    ],
  },
];

/** Manual smoke-test command for the reusable nested picker panel. */
export default function nestedPickerDemo(pi: ExtensionAPI): void {
  pi.registerCommand("nested-picker-demo", {
    description: "Show a nested picker demo with searchable levels and interactive leaf content",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("nested picker demo requires TUI mode", "warning");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        let lastLeaf = "none";
        return new NestedPickerPanel<DemoValue>({
          title: "nested picker demo",
          rows: demoRows,
          enableSearch: true,
          visibleRows: 8,
          theme,
          keybindings,
          requestRender: () => tui.requestRender(),
          onCancel: () => done(),
          onLeafEnter: (_row, path) => {
            lastLeaf = path.map((row) => row.label).join(" -> ");
          },
          renderContent: ({ row, path }) => {
            const trail = path.map((segment) => segment.label).join(" -> ");
            if (row.id === "end") return new ToggleLeafContent(trail);
            return [
              `Selected: ${trail}`,
              `Last leaf opened: ${lastLeaf}`,
              "Use ←/backspace to return to the picker, or Esc to jump to root/cancel.",
            ];
          },
        });
      });
    },
  });
}

class ToggleLeafContent implements Component {
  private selected = false;

  constructor(private readonly trail: string) {}

  render(width: number): string[] {
    const state = this.selected ? "selected" : "not selected";
    return [
      `Leaf content for ${this.trail}`,
      `State: ${state}`,
      "Press Space or x to toggle this leaf-local state.",
      "Use ←/backspace to go back, or Esc to return to root/cancel.",
    ].map((line) => line.slice(0, Math.max(0, width)));
  }

  handleInput(data: string): void {
    if (data === "x" || matchesKey(data, Key.space)) this.selected = !this.selected;
  }

  invalidate(): void {}
}
