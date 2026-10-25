// How hard the collaborator's model thinks. Providers name efforts (OpenAI's `none` … `xhigh`,
// Ollama's `none` / `think`); these are the names and notes people see.

import type { Effort, ModelInfo, ModelRef } from "./types";

const LABELS: Record<string, string> = {
  none: "Instant",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  think: "Thinking",
  xhigh: "Max",
};

const NOTES: Record<string, string> = {
  none: "Answers at once, without reasoning first.",
  minimal: "Barely reasons. The fastest that still thinks.",
  low: "Reasons briefly. Quick.",
  medium: "Balances reasoning and speed.",
  high: "Reasons at length. For hard problems.",
  think: "Reasons before it answers.",
  xhigh: "The most reasoning the model offers. The slowest.",
};

export function effortLabel(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function effortNote(effort: Effort): string {
  return effort.description ?? NOTES[effort.id] ?? "";
}

/** Where a model's chosen effort is kept in settings. */
export function effortKey(model: ModelRef): string {
  return `${model.provider}:${model.model}`;
}

/** The effort to ask for: the one chosen for the model while it still offers it, else its
 *  default, else the middle of its range. Nothing for a model that offers no choice. */
export function resolveEffort(info: ModelInfo | null | undefined, chosen: string | undefined): string | undefined {
  const efforts = info?.efforts ?? [];
  if (!efforts.length) return undefined;
  const offered = (id: string | null | undefined) => (id && efforts.some((e) => e.id === id) ? id : undefined);
  return offered(chosen) ?? offered(info?.defaultEffort) ?? efforts[Math.floor((efforts.length - 1) / 2)].id;
}
