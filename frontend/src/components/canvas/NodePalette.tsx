/**
 * NodePalette — Left sidebar node picker (drag-to-canvas).
 *
 * Every spacing value is an inline style — no Tailwind for layout.
 */

import { type DragEvent, useCallback, useMemo } from 'react';
import * as LucideIcons from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { PALETTE_ITEMS } from '@/config/nodeTypes';
import type { PaletteCategory, PaletteItem } from '@/types/canvas';

const CATEGORY_ORDER: PaletteCategory[] = [
  'Entities',
  'Federated Learning',
  'Generators',
  'Utilities',
];

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace('#', '');
  if (c.length !== 6) return hex;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ── Styles as plain objects (no CSS classes for layout) ── */

const sidebarStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 248,
  marginLeft: 12,
  marginTop: 8,
  marginBottom: 8,
  flexShrink: 0,
  overflow: 'hidden',
  borderRadius: 12,
  background: 'var(--n8n-sidebar-bg)',
  border: '1px solid var(--n8n-card-border)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  height: 40,
  paddingLeft: 16,
  paddingRight: 12,
  borderBottom: '1px solid var(--n8n-card-border)',
};

const headerTextStyle: React.CSSProperties = {
  color: 'var(--n8n-text-muted)',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
};

const scrollAreaStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  paddingBottom: 12,
};

const categoryLabelStyle: React.CSSProperties = {
  color: 'var(--n8n-text-muted)',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 16,
  paddingRight: 12,
  cursor: 'grab',
  borderRadius: 6,
  userSelect: 'none',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--n8n-text-primary)',
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/* ── Component ── */

export default function NodePalette() {
  const grouped = useMemo(() => {
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
  }, []);

  return (
    <aside style={sidebarStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={headerTextStyle}>Nodes</span>
      </div>

      {/* Scrollable category list */}
      <div className="n8n-palette-list" style={scrollAreaStyle}>
        {grouped.map(({ category, items }, idx) => (
          <div key={category}>
            {/* Category label */}
            <div
              style={{
                paddingLeft: 16,
                paddingRight: 12,
                paddingTop: idx === 0 ? 16 : 20,
                paddingBottom: 8,
              }}
            >
              <span style={categoryLabelStyle}>{category}</span>
            </div>

            {/* Node rows */}
            {items.map((item) => (
              <PaletteNodeItem key={item.type} item={item} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

/* ── Single draggable node row ── */

function PaletteNodeItem({ item }: { item: PaletteItem }) {
  const { type, label, icon, accent, description } = item;
  const Icon = LucideIcons[icon as keyof typeof LucideIcons] as LucideIcon | undefined;

  const onDragStart = useCallback(
    (e: DragEvent) => {
      e.dataTransfer.setData('application/reactflow-node-type', type as string);
      e.dataTransfer.effectAllowed = 'move';
    },
    [type],
  );

  return (
    <div draggable onDragStart={onDragStart} title={description} style={itemStyle}>
      {/* Icon badge */}
      <div
        className="icon-badge icon-badge-md"
        style={{ background: hexToRgba(accent, 0.1), flexShrink: 0 }}
      >
        {Icon && <Icon size={17} style={{ color: accent }} />}
      </div>
      {/* Label */}
      <span style={labelStyle}>{label}</span>
    </div>
  );
}
