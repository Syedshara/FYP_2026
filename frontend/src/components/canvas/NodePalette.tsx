/**
 * NodePalette — n8n-style left sidebar node picker.
 *
 * Design goals (matching n8n's node creator panel):
 *  - Search bar at top (no header label — search IS the entry point)
 *  - Subtle separator below search
 *  - Category section headers (muted uppercase labels with generous spacing)
 *  - Clean rows: colored-bg rounded-square icon + label (no inline descriptions)
 *  - CSS-only hover states (all styles in index.css, zero embedded <style>)
 *  - Generous horizontal padding throughout — nothing touches the edges
 *  - Drag to add nodes onto the canvas
 */

import { type DragEvent, useCallback, useMemo, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { Search, X, type LucideIcon } from 'lucide-react';
import { PALETTE_ITEMS } from '@/config/nodeTypes';
import type { PaletteCategory, PaletteItem } from '@/types/canvas';

/* ── Category display order ── */
const CATEGORY_ORDER: PaletteCategory[] = [
  'Entities',
  'Federated Learning',
  'Generators',
  'Utilities',
];

/**
 * Convert a hex color like "#ff6d5a" to an rgba() with the given alpha.
 * Falls back gracefully if the input isn't a valid 6-char hex.
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function NodePalette() {
  const [search, setSearch] = useState('');

  /* Filter items by search query (match label, description, or category) */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PALETTE_ITEMS;
    return PALETTE_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q),
    );
  }, [search]);

  /* Group filtered items by category, preserving order */
  const grouped = useMemo(() => {
    const map = new Map<PaletteCategory, PaletteItem[]>();
    for (const item of filteredItems) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
      category: cat,
      items: map.get(cat)!,
    }));
  }, [filteredItems]);

  return (
    <aside
      className="flex flex-col w-[260px] border-r shrink-0 overflow-hidden"
      style={{
        background: 'var(--n8n-sidebar-bg)',
        borderColor: 'var(--n8n-card-border)',
      }}
    >
      {/* ── Search area ── */}
      <div
        className="px-4 pt-5 pb-4"
        style={{ borderBottom: '1px solid var(--n8n-card-border)' }}
      >
        <div className="relative">
          <Search
            size={15}
            className="absolute left-[10px] top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--n8n-text-muted)' }}
          />
          <input
            type="text"
            className="n8n-palette-search"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="n8n-palette-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ── Categorized node list ── */}
      <div className="n8n-palette-list flex-1 overflow-y-auto px-3 pb-5">
        {grouped.length === 0 && (
          <p
            className="text-[12px] text-center py-8"
            style={{ color: 'var(--n8n-text-muted)' }}
          >
            No matching nodes
          </p>
        )}

        {grouped.map(({ category, items }, index) => (
          <div key={category}>
            {/* Category header */}
            <div className={`px-3 pb-2 ${index === 0 ? 'pt-4' : 'pt-5'}`}>
              <span
                className="text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: 'var(--n8n-text-muted)', opacity: 0.8 }}
              >
                {category}
              </span>
            </div>

            {/* Items */}
            <div className="flex flex-col gap-0.5">
              {items.map((item) => (
                <PaletteNodeItem key={item.type} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Palette Node Item ──

function PaletteNodeItem({ item }: { item: PaletteItem }) {
  const { type, label, icon, accent, description } = item;

  const Icon = LucideIcons[icon as keyof typeof LucideIcons] as LucideIcon | undefined;

  const onDragStart = useCallback(
    (event: DragEvent) => {
      event.dataTransfer.setData('application/reactflow-node-type', type as string);
      event.dataTransfer.effectAllowed = 'move';
    },
    [type],
  );

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="n8n-palette-item"
      title={description}
    >
      {/* Icon — rounded square, colored background via rgba() */}
      <div
        className="icon-badge icon-badge-md"
        style={{ background: hexToRgba(accent, 0.1) }}
      >
        {Icon && <Icon size={17} style={{ color: accent }} />}
      </div>

      {/* Label */}
      <span
        className="n8n-palette-label text-[13px] font-medium truncate"
        style={{ color: 'var(--n8n-text-primary)', transition: 'color 0.15s ease' }}
      >
        {label}
      </span>
    </div>
  );
}
