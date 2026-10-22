import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, type ModelRef, type Provider, type ProviderStatus } from "../lib/types";
import { Check, ChevronDown, OllamaMark, OpenAILogo } from "./Icons";

export function ProviderMark({ provider, size = 13 }: { provider: Provider; size?: number }) {
  return provider === "openai" ? <OpenAILogo size={size} /> : <OllamaMark size={size} />;
}

interface Props {
  providers: ProviderStatus[];
  loading: boolean;
  selected: ModelRef | null;
  onSelect: (model: ModelRef) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

export function ModelPicker({ providers, loading, selected, onSelect, onRefresh, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="model-pill"
        title="Collaborator model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <>
            <ProviderMark provider={selected.provider} />
            <span className="model-pill__model" title={`${PROVIDER_LABELS[selected.provider]} · ${selected.model}`}>
              {selected.model}
            </span>
          </>
        ) : (
          <span className="model-pill__model">{loading ? "Connecting…" : "Choose a model"}</span>
        )}
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="menu menu--right model-menu" role="listbox">
          {providers.map((status) => (
            <section key={status.provider} className="model-menu__group">
              <div className="model-menu__head">
                <ProviderMark provider={status.provider} size={12} />
                <span>{PROVIDER_LABELS[status.provider]}</span>
                <span className={`model-menu__state${status.available ? " is-on" : ""}`}>
                  {status.available ? "CONNECTED" : "NOT CONNECTED"}
                </span>
              </div>
              {status.models.map((model) => {
                const active = selected?.provider === model.provider && selected.model === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`menu__item${active ? " is-active" : ""}`}
                    onClick={() => {
                      onSelect({ provider: model.provider, model: model.id });
                      setOpen(false);
                    }}
                  >
                    <span className="menu__check">{active && <Check />}</span>
                    <span className="model-menu__id">{model.id}</span>
                    {model.detail && <span className="menu__hint">{model.detail}</span>}
                  </button>
                );
              })}
              {status.message && <p className="model-menu__note">{status.message}</p>}
            </section>
          ))}
          <div className="menu__divider" />
          <div className="model-menu__foot">
            <button type="button" className="text-button" onClick={onRefresh} disabled={loading}>
              {loading ? "Checking…" : "Refresh"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
