/**
 * StateDetailPanel — right-side detail inspector for the Step Function graph.
 *
 * Renders three tabs (Input / Output / Details). Each tab contains named
 * card sections with key-value rows.  A per-tab Copy button serialises that
 * tab's data to JSON.
 *
 * Also exports LayerValuesPreview — an inline component that shows the first
 * ~8 values of a large number array and a "[Show all]" button that opens
 * LayerValuesModal.
 */

import { useState, useCallback } from 'react';
import { Copy, Check, ClipboardList } from 'lucide-react';
import type { NodeStatus } from './StateNode';
import LayerValuesModal from './LayerValuesModal';

// ── Shared types ───────────────────────────────────────────────────────────

export interface KVRow {
  key: string;
  value: string | number | null | undefined;
  /** Optional CSS colour override for the value cell. */
  valueColor?: string;
}

export interface DetailSection {
  title: string;
  rows: KVRow[];
}

export interface TabData {
  sections: DetailSection[];
}

export interface DetailTabs {
  input: TabData;
  output: TabData;
  details: TabData;
}

// ── LayerValuesPreview ──────────────────────────────────────────────────────

const PREVIEW_COUNT = 8;

export interface LayerValuesPreviewProps {
  layerName: string;
  values: number[];
  sizeKB?: number;
}

export function LayerValuesPreview({ layerName, values, sizeKB }: LayerValuesPreviewProps) {
  const [modalOpen, setModalOpen] = useState(false);

  if (values.length === 0) return null;

  const preview = values.slice(0, PREVIEW_COUNT);
  const hasMore = values.length > PREVIEW_COUNT;
  const previewText = preview.map((v) => v.toFixed(5)).join(', ');

  return (
    <div className="sfn-layer-preview">
      <span className="sfn-layer-preview__values">
        {previewText}
        {hasMore && <span className="sfn-layer-preview__ellipsis"> …</span>}
        {!hasMore && (
          <span className="sfn-layer-preview__complete"> (complete)</span>
        )}
      </span>
      {hasMore && (
        <button
          type="button"
          className="sfn-layer-preview__btn"
          onClick={() => setModalOpen(true)}
        >
          Show all ({values.length})
        </button>
      )}
      <LayerValuesModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        layerName={layerName}
        values={values}
        sizeKB={sizeKB}
      />
    </div>
  );
}

// ── StateDetailPanel ──────────────────────────────────────────────────────

export interface StateDetailPanelProps {
  /** Node label shown in the panel header. Null means nothing selected. */
  nodeLabel: string | null;
  nodeStatus?: NodeStatus;
  nodeDuration?: string;
  /** New tab-based structure.  Takes priority over legacy `sections`. */
  tabs?: DetailTabs;
  /** Legacy flat sections — used when `tabs` is not provided. */
  sections?: DetailSection[];
}

type ActiveTab = 'input' | 'output' | 'details';

const STATUS_BADGE_CLASS: Record<NodeStatus, string> = {
  succeeded: 'sfn-node__badge sfn-node__badge--succeeded',
  running:   'sfn-node__badge sfn-node__badge--running',
  failed:    'sfn-node__badge sfn-node__badge--failed',
  warning:   'sfn-node__badge sfn-node__badge--warning',
  pending:   'sfn-node__badge sfn-node__badge--pending',
};

const STATUS_LABELS: Record<NodeStatus, string> = {
  succeeded: 'Succeeded',
  running:   'Running',
  failed:    'Failed',
  warning:   'Warning',
  pending:   'Pending',
};

/** Serialise a set of sections to a JSON-friendly object. */
function sectionsToPayload(sections: DetailSection[]): Record<string, Record<string, string>> {
  const payload: Record<string, Record<string, string>> = {};
  for (const sec of sections) {
    payload[sec.title] = {};
    for (const row of sec.rows) {
      if (row.value !== null && row.value !== undefined) {
        payload[sec.title][row.key] = String(row.value);
      }
    }
  }
  return payload;
}

/** Render a list of DetailSections as card rows. */
function SectionList({ sections }: { sections: DetailSection[] }) {
  return (
    <>
      {sections.map((sec) => (
        <div key={sec.title} className="sfn-detail__section">
          <div className="sfn-detail__section-title">{sec.title}</div>
          <div className="sfn-detail__kv">
            {sec.rows.map((row, i) =>
              row.value !== null && row.value !== undefined ? (
                <div key={i} className="sfn-detail__kv-row">
                  <span className="sfn-detail__key">{row.key}</span>
                  <span
                    className="sfn-detail__val"
                    style={row.valueColor ? { color: row.valueColor } : undefined}
                  >
                    {String(row.value)}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export default function StateDetailPanel({
  nodeLabel,
  nodeStatus,
  nodeDuration,
  tabs,
  sections = [],
}: StateDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('input');
  const [copied, setCopied] = useState(false);

  // Active sections: use tab-based when available, otherwise legacy flat sections
  const activeSections: DetailSection[] = tabs
    ? (tabs[activeTab]?.sections ?? [])
    : sections;

  const handleCopy = useCallback(() => {
    const payload = sectionsToPayload(activeSections);
    navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {/* clipboard denied — silently ignore */});
  }, [activeSections]);

  // Reset active tab when node changes
  const handleTabChange = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setCopied(false);
  }, []);

  if (nodeLabel === null) {
    return (
      <div className="sfn-detail">
        <div className="sfn-detail__panel-title">State Details</div>
        <div className="sfn-detail__empty">
          <div className="sfn-detail__empty-icon">
            <ClipboardList size={24} />
          </div>
          <p className="sfn-detail__empty-heading">No state selected</p>
          <p className="sfn-detail__empty-sub">
            Click any step in the execution graph to inspect its input, output,
            and runtime metrics.
          </p>
        </div>
      </div>
    );
  }

  const tabLabels: { id: ActiveTab; label: string }[] = [
    { id: 'input',   label: 'Input' },
    { id: 'output',  label: 'Output' },
    { id: 'details', label: 'Details' },
  ];

  return (
    <div className="sfn-detail">
      {/* Panel label */}
      <div className="sfn-detail__panel-title">State Details</div>

      {/* Header: node title + status badge + duration */}
      <div className="sfn-detail__header">
        <div className="sfn-detail__header-row">
          <span className="sfn-detail__title">{nodeLabel}</span>
        </div>
        <div className="sfn-detail__meta">
          {nodeStatus && (
            <span className={STATUS_BADGE_CLASS[nodeStatus]}>
              {STATUS_LABELS[nodeStatus]}
            </span>
          )}
          {nodeDuration && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--n8n-text-muted)',
                fontFamily: 'var(--n8n-font-mono)',
              }}
            >
              {nodeDuration}
            </span>
          )}
        </div>
      </div>

      {/* Tab bar — only shown when tabs prop is provided */}
      {tabs && (
        <div className="sfn-detail__tabs" role="tablist" aria-label="State data tabs">
          {tabLabels.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={activeTab === id}
              className={`sfn-detail__tab${activeTab === id ? ' sfn-detail__tab--active' : ''}`}
              onClick={() => handleTabChange(id)}
            >
              {label}
            </button>
          ))}
          <div className="sfn-detail__tabs-copy">
            <button
              type="button"
              className={`sfn-detail__copy-btn${copied ? ' sfn-detail__copy-btn--copied' : ''}`}
              onClick={handleCopy}
              title={`Copy ${activeTab} data as JSON`}
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Copy button for legacy (no-tabs) mode */}
      {!tabs && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className={`sfn-detail__copy-btn${copied ? ' sfn-detail__copy-btn--copied' : ''}`}
            onClick={handleCopy}
            title="Copy state data as JSON"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {/* Tab content */}
      <SectionList sections={activeSections} />
    </div>
  );
}
