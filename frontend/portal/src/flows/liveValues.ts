/**
 * Portal v3 M5 · Part C - live values on the canvas (pure, unit-tested).
 *
 * Two INDEPENDENT sources, deliberately kept apart:
 *
 *  1. CHANNEL VALUES (work today, no edge change): the plant's entity telemetry
 *     the editor already polls. A data node that reads an entity channel gets a
 *     chip on every wire leaving it ("2,9 kW", "76 %").
 *  2. PER-NODE STATES (need the additive, feature-flagged edge heartbeat block
 *     `flow_node_status`): "erfüllt", "EIN seit 14:02". THE FALLBACK IS THE
 *     POINT - with the edge flag off the editor shows channel values only and
 *     NO node state anywhere. A guessed state would be worse than none: the
 *     customer would read it as proof their rule fired.
 */
import { channelUnitHint } from '../channels';
import { fmtNum } from '../format';
import type { FlowDocument } from './model';

/** One measured channel of one entity (null = known channel, no reading). */
export interface ChannelValue {
  entityId: string;
  channel: string;
  value: number | null;
}

/**
 * One node's live state as REPORTED by the device (never derived here).
 * `state` is the edge vocabulary: active | idle | error.
 */
export interface NodeStatusReport {
  nodeId: string;
  state: 'active' | 'idle' | 'error' | string;
  text?: string | null;
  since?: string | null;
}

export interface NodeStateView {
  label: string;
  tone: 'ok' | 'off' | 'error';
}

export interface LiveValuesInput {
  doc: FlowDocument;
  channels?: ChannelValue[] | null;
  /** Absent/null = the edge does not report node states (flag off, old edge). */
  statuses?: NodeStatusReport[] | null;
  now?: Date;
}

export interface LiveValuesView {
  /** edge id -> the chip rendered on that wire. Only where a value exists. */
  chips: Record<string, string>;
  /** node id -> its reported state. EMPTY without the edge block. */
  nodeStates: Record<string, NodeStateView>;
  /** True when the device reports per-node states at all. */
  hasNodeStates: boolean;
}

/** The channel a data node reads, or null for a node that reads none. */
export function readChannelOf(
  node: { type: string; parameters?: Record<string, unknown> },
): { entityId: string; channel: string } | null {
  if (node.type !== 'vp.entity.read' && node.type !== 'vp.modbus.read') return null;
  const entityId = String(node.parameters?.entity_id ?? '');
  const channel = String(node.parameters?.channel ?? '');
  if (!entityId || !channel) return null;
  return { entityId, channel };
}

/** "2,9 kW" / "76 %" - the customer-facing chip text, "—" when unreadable. */
export function chipText(channel: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const unit = channelUnitHint(channel);
  return fmtNum(value, unit ?? '', unit === '%' ? 0 : 1);
}

function toneFor(state: string): NodeStateView['tone'] {
  if (state === 'error') return 'error';
  if (state === 'active') return 'ok';
  return 'off';
}

function sinceLabel(since: string | null | undefined, now: Date): string | null {
  if (!since) return null;
  const t = new Date(since);
  if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime() + 60_000) return null;
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `seit ${hh}:${mm}`;
}

/** The device's own words when it sent them, else the plain German state. */
export function nodeStateView(
  status: NodeStatusReport,
  now: Date = new Date(),
): NodeStateView {
  const base = status.text && status.text.trim()
    ? status.text.trim()
    : status.state === 'active' ? 'erfüllt'
      : status.state === 'error' ? 'Fehler'
        : 'wartet';
  const since = sinceLabel(status.since, now);
  return { label: since ? `${base} · ${since}` : base, tone: toneFor(status.state) };
}

export function liveValues(input: LiveValuesInput): LiveValuesView {
  const { doc } = input;
  const now = input.now ?? new Date();
  const byKey = new Map<string, number | null>();
  for (const cv of input.channels ?? []) {
    byKey.set(`${cv.entityId}#${cv.channel}`, cv.value);
  }

  const chips: Record<string, string> = {};
  for (const node of doc.nodes) {
    const read = readChannelOf(node);
    if (!read) continue;
    const key = `${read.entityId}#${read.channel}`;
    if (!byKey.has(key)) continue; // no source at all -> no chip, never a "—"
    const text = chipText(read.channel, byKey.get(key) ?? null);
    for (const edge of doc.edges) {
      if (edge.from.node === node.id) chips[edge.id] = text;
    }
  }

  const nodeStates: Record<string, NodeStateView> = {};
  const known = new Set(doc.nodes.map((n) => n.id));
  const reports = input.statuses ?? null;
  for (const status of reports ?? []) {
    if (!known.has(status.nodeId)) continue;
    nodeStates[status.nodeId] = nodeStateView(status, now);
  }
  return { chips, nodeStates, hasNodeStates: reports != null && reports.length > 0 };
}
