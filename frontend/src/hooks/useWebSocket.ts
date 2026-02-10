/**
 * useWebSocket — React hook for the backend WebSocket.
 *
 * Features:
 *  • Auto-reconnect with exponential backoff (1s → 2s → 4s … capped at 30s)
 *  • Subscribes to typed message channels via subscribe(type, handler)
 *  • Exposes `isConnected` and `lastMessage`
 *  • Responds to server pings with pong
 *  • Uses token from authStore for authentication
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

export interface WSMessage {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type MessageHandler = (msg: WSMessage) => void;

// ── Build the WebSocket URL relative to current host ──
function getWsUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host; // works with Vite proxy
  return `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;
}

// ── Backoff config ──
const INITIAL_DELAY = 1_000;
const MAX_DELAY = 30_000;
const BACKOFF_FACTOR = 2;

export function useWebSocket() {
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayRef = useRef(INITIAL_DELAY);
  const mountedRef = useRef(true);

  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  // ── Subscribe to a specific message type ──
  const subscribe = useCallback((type: string, handler: MessageHandler) => {
    if (!subscribersRef.current.has(type)) {
      subscribersRef.current.set(type, new Set());
    }
    subscribersRef.current.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      subscribersRef.current.get(type)?.delete(handler);
    };
  }, []);

  // ── Dispatch incoming message to subscribers ──
  const dispatch = useCallback((msg: WSMessage) => {
    setLastMessage(msg);

    // Dispatch to type-specific subscribers
    const handlers = subscribersRef.current.get(msg.type);
    if (handlers) {
      handlers.forEach((h) => {
        try { h(msg); } catch (e) { console.error('[WS] handler error:', e); }
      });
    }

    // Also dispatch to wildcard subscribers
    const wildcardHandlers = subscribersRef.current.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((h) => {
        try { h(msg); } catch (e) { console.error('[WS] wildcard handler error:', e); }
      });
    }
  }, []);

  // ── Connect (via ref to allow self-scheduling) ──
  const connectRef = useRef<() => void>(() => {});

  // Keep connectRef up to date with latest closure values
  useEffect(() => {
    connectRef.current = () => {
      if (!token || !mountedRef.current) return;

      // Clean up any existing connection
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        if (wsRef.current.readyState < WebSocket.CLOSING) {
          wsRef.current.close();
        }
      }

      const url = getWsUrl(token);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setIsConnected(true);
        delayRef.current = INITIAL_DELAY; // reset backoff
        console.log('[WS] Connected');
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg: WSMessage = JSON.parse(event.data);

          // Respond to server pings
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          dispatch(msg);
        } catch {
          // Not JSON — ignore
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        setIsConnected(false);
        console.log(`[WS] Disconnected (code=${event.code})`);

        // Don't reconnect if closed intentionally (4001 = auth failure)
        if (event.code === 4001) {
          console.warn('[WS] Auth failed — not reconnecting');
          return;
        }

        // Schedule reconnect with exponential backoff
        const delay = delayRef.current;
        delayRef.current = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY);
        console.log(`[WS] Reconnecting in ${delay}ms...`);
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connectRef.current();
        }, delay);
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    };
  }, [token, dispatch]);

  const connect = useCallback(() => connectRef.current(), []);

  // ── Lifecycle ──
  useEffect(() => {
    mountedRef.current = true;

    if (isAuthenticated && token) {
      connect();
    }

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [isAuthenticated, token, connect]);

  return { isConnected, lastMessage, subscribe };
}
