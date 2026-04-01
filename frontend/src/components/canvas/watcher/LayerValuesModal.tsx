/**
 * LayerValuesModal — fullscreen overlay for inspecting large per-layer value
 * arrays (ciphertext previews, decrypted gradients, etc.).
 *
 * Opens on demand from a LayerValuesPreview "[Show all]" button. Virtualises
 * the row list when the array exceeds 500 entries so scrolling stays smooth.
 */

import { useEffect, useCallback, useMemo } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { useState } from 'react';

export interface LayerValuesModalProps {
  isOpen: boolean;
  onClose: () => void;
  layerName: string;
  values: number[];
  sizeKB?: number;
}

/** Compute summary statistics for a numeric array. */
function computeStats(values: number[]): {
  min: number;
  max: number;
  mean: number;
  std: number;
  norm: number;
} {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, std: 0, norm: 0 };
  }
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const norm = Math.sqrt(values.reduce((a, b) => a + b * b, 0));
  return { min, max, mean, std, norm };
}

/** Format a number for display in a compact fixed-precision way. */
function fmt(v: number): string {
  return v.toFixed(6);
}

const VIRTUAL_THRESHOLD = 500;
const VIRTUAL_CHUNK = 80;

export default function LayerValuesModal({
  isOpen,
  onClose,
  layerName,
  values,
  sizeKB,
}: LayerValuesModalProps) {
  const [copied, setCopied] = useState(false);
  const [visibleCount, setVisibleCount] = useState(VIRTUAL_CHUNK);

  const stats = useMemo(() => computeStats(values), [values]);

  // Reset visible count when the modal reopens / values change
  useEffect(() => {
    if (isOpen) setVisibleCount(VIRTUAL_CHUNK);
  }, [isOpen, values]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleCopy = useCallback(() => {
    const text = values.map((v, i) => `[${i}]\t${fmt(v)}`).join('\n');
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {/* clipboard denied — silently ignore */});
  }, [values]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleLoadMore = useCallback(() => {
    setVisibleCount((c) => Math.min(c + VIRTUAL_CHUNK, values.length));
  }, [values.length]);

  if (!isOpen) return null;

  const isVirtualised = values.length > VIRTUAL_THRESHOLD;
  const visibleValues = isVirtualised ? values.slice(0, visibleCount) : values;
  const hasMore = visibleCount < values.length;

  return (
    <div
      className="sfn-modal-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Layer values: ${layerName}`}
    >
      <div className="sfn-modal-card">
        {/* ── Header ── */}
        <div className="sfn-modal__header">
          <div className="sfn-modal__header-left">
            <span className="sfn-modal__layer-name">{layerName}</span>
            <span className="sfn-modal__meta">
              {values.length.toLocaleString()} values
              {sizeKB != null && ` · ${sizeKB.toFixed(2)} KB`}
            </span>
          </div>
          <div className="sfn-modal__header-right">
            <button
              type="button"
              className={`sfn-detail__copy-btn${copied ? ' sfn-detail__copy-btn--copied' : ''}`}
              onClick={handleCopy}
              title="Copy all values as TSV"
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              type="button"
              className="sfn-modal__close-btn"
              onClick={onClose}
              aria-label="Close modal"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Value list ── */}
        <div className="sfn-modal__body">
          {visibleValues.map((v, i) => (
            <div key={i} className="sfn-modal__value-row">
              <span className="sfn-modal__value-idx">[{i}]</span>
              <span className="sfn-modal__value-num">{fmt(v)}</span>
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              className="sfn-modal__load-more"
              onClick={handleLoadMore}
            >
              Load more ({values.length - visibleCount} remaining)
            </button>
          )}
        </div>

        {/* ── Footer stats ── */}
        <div className="sfn-modal__footer">
          <span className="sfn-modal__stat">min <b>{fmt(stats.min)}</b></span>
          <span className="sfn-modal__stat">max <b>{fmt(stats.max)}</b></span>
          <span className="sfn-modal__stat">mean <b>{fmt(stats.mean)}</b></span>
          <span className="sfn-modal__stat">std <b>{fmt(stats.std)}</b></span>
          <span className="sfn-modal__stat">‖v‖ <b>{fmt(stats.norm)}</b></span>
        </div>
      </div>
    </div>
  );
}
