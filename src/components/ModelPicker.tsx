import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, type ModelRef, type ProviderStatus } from "../lib/types";
import { CheckIcon, ChevronDownIcon, RefreshIcon } from "./Icons";

interface Props {
  providers: ProviderStatus[];
  loading: boolean;
  selected: ModelRef | null;
  onSelect: (model: ModelRef) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

export function ModelPicker({
  providers,
  loading,
  selected,
  onSelect,
  onRefresh,
  onOpenSettings,
}: Props) {
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
        className="model-picker__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <span className={`provider-dot provider-dot--${selected.provider}`} />
            <span className="model-picker__name">{selected.model}</span>
          </>
        ) : (
          <span className="model-picker__name">{loading ? "Loading models…" : "Choose a model"}</span>
        )}
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="model-picker__menu" role="listbox">
          <div className="model-picker__menu-head">
            <span>Models</span>
            <button
              type="button"
              className="icon-button icon-button--small"
              onClick={onRefresh}
              title="Refresh models"
              aria-label="Refresh models"
              disabled={loading}
            >
              <RefreshIcon className={loading ? "spin" : undefined} />
            </button>
          </div>
          {providers.map((status) => (
            <section key={status.provider} className="model-picker__group">
              <h3>
                <span className={`provider-dot provider-dot--${status.provider}`} />
                {PROVIDER_LABELS[status.provider]}
                {!status.available && <span className="model-picker__badge">Not connected</span>}
              </h3>
              {status.models.map((model) => {
                const active =
                  selected?.provider === model.provider && selected.model === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`model-picker__item${active ? " is-active" : ""}`}
                    onClick={() => {
                      onSelect({ provider: model.provider, model: model.id });
                      setOpen(false);
                    }}
                  >
                    <span className="model-picker__item-name">{model.id}</span>
                    {model.detail && <span className="model-picker__detail">{model.detail}</span>}
                    {active && <CheckIcon />}
                  </button>
                );
              })}
              {status.message && (
                <div className="model-picker__note">
                  <p>{status.message}</p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setOpen(false);
                      if (status.provider === "openai") onOpenSettings();
                      else onRefresh();
                    }}
                  >
                    {status.provider === "openai" ? "Open settings" : "Try again"}
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
