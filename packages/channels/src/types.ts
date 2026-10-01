import type { InboundMessage, OutboundMessage } from '@execugate/core';

export type { InboundMessage, OutboundMessage };

/**
 * Channel abstraction (ADR-7).
 *
 * PRD §9 scopes Prototype Alpha to one messaging platform, but the interface is
 * kept vendor-neutral so Slack/WhatsApp/Teams are additive later. Telegram is the
 * only adapter shipped in Alpha.
 */
export interface ChannelAdapter {
  readonly kind: 'telegram' | 'web';
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Register the handler for normalised inbound traffic. */
  onInbound(handler: (msg: InboundMessage) => Promise<void>): void;
  send(target: string, msg: OutboundMessage): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Registry of where each division listens. The orchestrator dispatches tickets by
 * looking up a division's chat id here rather than hardcoding chat ids.
 */
export class ChannelRouter {
  private routes = new Map<string, string>();

  constructor(private readonly adapter: ChannelAdapter) {}

  /** Bind a logical name (e.g. `technical`) to a channel-native target. */
  route(name: string, target: string): void {
    this.routes.set(name, target);
  }

  target(name: string): string | undefined {
    return this.routes.get(name);
  }

  routes_(): Record<string, string> {
    return Object.fromEntries(this.routes);
  }

  get known(): string[] {
    return [...this.routes.keys()];
  }
}