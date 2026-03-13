/**
 * NodePalette — Left sidebar node picker.
 *
 * Design: floating card panel with 12px left margin and 8px vertical margin,
 * so it never bleeds into the viewport edge, navbar, or footer.
 * No search bar — all categories always visible, drag-to-canvas.
 */

import { type DragEvent, useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { PALETTE_ITEMS } from '@/config/nodeTypes';
import type { PaletteCategory, PaletteItem } from '@/types/canvas';

/* ── Category display order ── */
const CATEGORY_ORDER: PaletteCategory[] = [
  'Entities',
  'Federated Learning',
  'Generators',
  'Utilities',
];

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* Group ALL items by category, preserving order */
function groupedItems() {
  const map = new Map<PaletteCategory, PaletteItem[]>();
  for (const item of PALETTE_ITEMS) {
    const list = map.get(item.category) ?? [];
    list.push(item);
    map.set(item.category, list);
  }
  return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
    category: cat,
    items: map.get(cat)!,
  }));
}

const GROUPED = groupedItems();

export default function NodePalette() {
  return (
    <aside
      className="flex flex-col w-[248px] ml-3 my-2 shrink-0 overflow-hidden rounded-xl"
      style={{
        background: 'var(--n8n-sidebar-bg)',
        border: '1px solid var(--n8n-card-border)',
      }}
    >
      {/* ── Panel header ── */}
      <div
        className="flex items-center flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--n8n-card-border)',
          height: '40px',
          paddingLeft: '16px',
          paddingRight: '12px',
        }}
      >
        <span
          style={{
            color: 'var(--n8n-text-muted)',
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
          }}
        >
          Nodes
        </span>
      </div>

      {/* ── Categorized node list (scrollable) ── */}
      <div className="n8n-palette-list flex-1 overflow-y-auto pb-3">
        {GROUPED.map(({ category, items }, index) => (
          <div key={category}>
            {/* Category label */}
            <div
              style={{
                paddingLeft: '16px',
                paddingRight: '12px',
                paddingTop: index === 0 ? '16px' : '20px',
                paddingBottom: '8px',
              }}
            >
              <span
                style={{
                  color: 'var(--n8n-text-muted)',
                  fontSize: '11px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.8px',
                }}
              >
                {category}
              </span>
            </div>

            {/* Node items */}
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
      <div
        className="icon-badge icon-badge-md"
        style={{ background: hexToRgba(accent, 0.1) }}
      >
        {Icon && <Icon size={17} style={{ color: accent }} />}
      </div>
      <span
        className="n8n-palette-label text-[13px] font-medium truncate"
        style={{ color: 'var(--n8n-text-primary)', transition: 'color 0.15s ease' }}
      >
        {label}
      </span>
    </div>
  );
}
