import { useMemo, useState } from "react";
import { IconSearch } from "@tabler/icons-react";
import type { CatalogIcon } from "../types";
import { searchIcons } from "../icon-search";
import { Action, Button, TaskIcon } from "./shared";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const PAGE_SIZE = 60;

export function IconPicker({ catalog, selected, onSelect, onClose }: {
  catalog: CatalogIcon[];
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const matches = useMemo(() => searchIcons(catalog, query), [catalog, query]);
  return <Dialog open onOpenChange={onClose}>
    <DialogContent className="icon-picker">
      <DialogHeader>
        <DialogTitle>Choose an icon</DialogTitle>
        <DialogDescription>Tabler icons, available offline. Search names, brands, or keywords—even with a typo.</DialogDescription>
      </DialogHeader>
      <div className="search-field">
        <IconSearch size={16} aria-hidden="true" />
        <Input placeholder="Try Slack, Gmail, or calendar…" aria-label="Search icon catalog" value={query} maxLength={80} onChange={e => { setQuery(e.target.value); setPage(0); }} />
      </div>
      <p className="icon-results" role="status">{matches.length ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, matches.length)} of ${matches.length} icons` : "No matching icons. Try a different name or keyword."}</p>
      <div className="icon-grid" key={`${query}-${page}`}>
        {matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(icon => <Action key={icon.id} aria-pressed={icon.id === selected} title={`${icon.name} · ${icon.category}`} onClick={() => onSelect(icon.id)} className={icon.id === selected ? "active" : ""}>
          <TaskIcon id={icon.id} catalog={catalog} size={24} />
          <span>{icon.name}</span>
        </Action>)}
      </div>
      {matches.length > PAGE_SIZE && <nav className="icon-pagination" aria-label="Icon result pages">
        <Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous icons</Button>
        <Button variant="outline" disabled={(page + 1) * PAGE_SIZE >= matches.length} onClick={() => setPage(page + 1)}>Next icons</Button>
      </nav>}
      <small className="icon-disclaimer">Brand icons identify a service, not an integration or endorsement. No custom uploads.</small>
    </DialogContent>
  </Dialog>;
}
