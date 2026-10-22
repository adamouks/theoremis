import { useState } from "react";
import { initials } from "../lib/text";
import type { DocumentSummary, Project } from "../lib/types";
import { ChevronDown, ChevronRight, Gear, Plus, Search, StatusGlyph, Trash } from "./Icons";
import { STATUS_INFO } from "../lib/doc";

interface Props {
  projects: Project[];
  documents: DocumentSummary[];
  activeId: string | null;
  displayName: string;
  showWindowControlsSpace: boolean;
  shortcut: (keys: string) => string;
  onOpen: (id: string) => void;
  onNewDocument: (projectId?: string) => void;
  onNewProject: () => Promise<Project>;
  onToggleProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
  onDeleteProject: (project: Project) => void;
  onSearch: () => void;
  onSettings: () => void;
}

export function Sidebar({
  projects,
  documents,
  activeId,
  displayName,
  showWindowControlsSpace,
  shortcut,
  onOpen,
  onNewDocument,
  onNewProject,
  onToggleProject,
  onRenameProject,
  onDeleteProject,
  onSearch,
  onSettings,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <aside className="sidebar">
      <div className={`sidebar__chrome${showWindowControlsSpace ? "" : " sidebar__chrome--compact"}`} data-tauri-drag-region />
      <div className="sidebar__brand" data-tauri-drag-region>
        <span className="wordmark">Theoremis</span>
        <span className="tombstone" title="∎" />
      </div>

      <button type="button" className="sidebar__search" onClick={onSearch}>
        <Search />
        <span>Search or jump to</span>
        <kbd>{shortcut("K")}</kbd>
      </button>

      <div className="sidebar__section">
        <span>Projects</span>
        <button
          type="button"
          className="icon-button icon-button--tiny"
          title="New project"
          aria-label="New project"
          onClick={async () => setRenaming((await onNewProject()).id)}
        >
          <Plus />
        </button>
      </div>

      <nav className="tree" aria-label="Projects">
        {projects.length === 0 && <p className="tree__empty">No projects yet.</p>}
        {projects.map((project) => {
          const docs = documents.filter((d) => d.projectId === project.id);
          const expanded = !project.collapsed;
          return (
            <div key={project.id}>
              <div
                className={`tree__project${expanded ? " is-expanded" : ""}`}
                onClick={() => renaming !== project.id && onToggleProject(project)}
                onMouseLeave={() => confirmDelete === project.id && setConfirmDelete(null)}
              >
                <span className="tree__chevron">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
                {renaming === project.id ? (
                  <input
                    className="tree__rename"
                    autoFocus
                    defaultValue={project.name}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      onRenameProject(project, e.currentTarget.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = project.name;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <span
                    className="tree__name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenaming(project.id);
                    }}
                    title="Double-click to rename"
                  >
                    {project.name}
                  </span>
                )}
                {confirmDelete === project.id ? (
                  <button
                    type="button"
                    className="tree__confirm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(null);
                      onDeleteProject(project);
                    }}
                  >
                    Delete{docs.length ? ` ${docs.length}` : ""}
                  </button>
                ) : (
                  <span className="tree__actions">
                    <button
                      type="button"
                      className="icon-button icon-button--tiny"
                      title="New document"
                      aria-label={`New document in ${project.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewDocument(project.id);
                      }}
                    >
                      <Plus />
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--tiny"
                      title="Delete project"
                      aria-label={`Delete ${project.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(project.id);
                      }}
                    >
                      <Trash />
                    </button>
                  </span>
                )}
                <span className="tree__count">{docs.length}</span>
              </div>

              {expanded && (
                <div className="tree__docs">
                  {docs.length === 0 && (
                    <button type="button" className="tree__doc tree__doc--empty" onClick={() => onNewDocument(project.id)}>
                      New document
                    </button>
                  )}
                  {docs.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`tree__doc${d.id === activeId ? " is-active" : ""}`}
                      title={STATUS_INFO[d.status ?? "open"].meaning}
                      onClick={() => onOpen(d.id)}
                    >
                      <StatusGlyph status={d.status ?? "open"} size={8} />
                      <span className="tree__doc-title">{d.title || "Untitled"}</span>
                      {d.pending > 0 && (
                        <span className="pending-count" title="Collaborator suggestions awaiting your review">
                          {d.pending}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <button type="button" className="sidebar__row" onClick={() => onNewDocument()}>
          <span className="dashed-plus">
            <Plus size={10} />
          </span>
          <span>New document</span>
          <kbd>{shortcut("N")}</kbd>
        </button>
        <button type="button" className="sidebar__row sidebar__row--user" onClick={onSettings}>
          {displayName ? <span className="avatar">{initials(displayName)}</span> : <Gear />}
          <span>{displayName || "Settings"}</span>
          <kbd>{shortcut(",")}</kbd>
        </button>
      </div>
    </aside>
  );
}
