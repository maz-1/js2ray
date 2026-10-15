import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { LookupFunction, AddressInfo } from 'node:net';

export type RuntimeState = 'created' | 'starting' | 'running' | 'closing' | 'closed';
export interface Diagnostic {
  code: string;
  path: string;
  reason: string;
  suggestion: string;
}
export interface ErrorRecord {
  name: string;
  code: string;
  message: string;
  phase: string;
  context: Record<string, unknown>;
}
export class Js2rayError extends Error {
  code: string;
  phase: string;
  context: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    options?: { phase?: string; cause?: unknown; context?: Record<string, unknown> },
  );
  toJSON(): ErrorRecord;
}
export interface TlsOptions {
  serverName?: string;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}
export interface Network {
  type?: 'tcp' | 'ws';
  address?: string;
  port: number;
  option?: { path?: string; headers?: Record<string, string>; tls?: TlsOptions };
}
export interface VmessUser {
  id: string;
  security?: 'auto' | 'aes-128-gcm' | 'chacha20-poly1305' | 'none';
  alterId?: number;
  email?: string;
  traffic?: number;
  ipCount?: number;
  ipCountDuration?: number;
  expire?: number;
  deactive?: boolean | number;
}
export interface VlessUser {
  id: string;
  encryption?: 'none';
  flow?: '';
  email?: string;
}
export interface SocksUser {
  user: string;
  pass: string;
}
export type Bound =
  | { tag?: string; protocol: 'vmess'; networks: Network[]; users: VmessUser[] }
  | { tag?: string; protocol: 'vless'; networks: Network[]; users: VlessUser[] }
  | { tag?: string; protocol: 'socks'; networks: Network[]; users?: SocksUser[] };
export type Outbound = Bound | { tag?: string; protocol?: 'freedom' };
export interface Limits {
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  maxPendingDials?: number;
  maxBufferBytes?: number;
}
export interface NativeConfig {
  inbounds?: Bound[];
  outbounds?: Outbound[];
  routing?: (
    host: string,
    port: number,
    command: 1 | 2,
    inboundTag?: string,
  ) => string | boolean | null;
  storage?: string;
  debug?: (event: ErrorRecord) => void;
  limits?: Limits;
}
/** Traditional JSON is validated at runtime; only the documented subset is accepted. */
export interface TraditionalConfig {
  inbounds?: Record<string, unknown>[];
  outbounds?: Record<string, unknown>[];
  log?: { loglevel: 'debug' | 'info' | 'warning' | 'error' | 'none' };
  limits?: Limits;
}
export interface RuntimeOptions {
  baseDir?: string;
  logger?: ((event: ErrorRecord) => void) | { error(event: ErrorRecord): void };
  lookup?: LookupFunction;
}
export interface DialTarget {
  host: string;
  port: number;
  network?: 'tcp';
  outboundTag?: string;
  inboundTag?: string;
  signal?: AbortSignal;
}
export interface DatagramTarget extends Omit<DialTarget, 'network'> {
  network?: 'udp';
}
export interface ConnectionStream extends Duplex {
  setTimeout(milliseconds: number, callback?: () => void): this;
  setNoDelay(noDelay?: boolean): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  ref(): this;
  unref(): this;
}
export interface DatagramMessage {
  data: Buffer;
  host: string;
  port: number;
}
export interface DatagramSession extends EventEmitter, AsyncIterableIterator<DatagramMessage> {
  readonly target: Readonly<{ host: string; port: number }>;
  readonly destroyed: boolean;
  readonly closed: boolean;
  send(data: Buffer, target?: { host: string; port: number }): Promise<void>;
  close(): void;
  destroy(error?: Error): void;
  setTimeout(milliseconds: number, callback?: () => void): this;
}
export class Runtime extends EventEmitter {
  constructor(config?: NativeConfig | TraditionalConfig, options?: RuntimeOptions);
  readonly state: RuntimeState;
  readonly stats: {
    state: RuntimeState;
    connections: number;
    pendingDials: number;
    listeners: number;
  };
  readonly listenersInfo: Array<{ tag: string; address: AddressInfo | string | null }>;
  start(): Promise<this>;
  dial(target: DialTarget): Promise<ConnectionStream>;
  openDatagram(target: DatagramTarget): Promise<DatagramSession>;
  close(options?: { drainTimeoutMs?: number }): Promise<void>;
}
export function createRuntime(
  config?: NativeConfig | TraditionalConfig,
  options?: RuntimeOptions,
): Runtime;
export function config(
  config: NativeConfig | TraditionalConfig,
  options?: RuntimeOptions,
): Runtime & { stop(options?: { drainTimeoutMs?: number }): Promise<void> };
export interface ConfigReport {
  ok: boolean;
  diagnostics: Diagnostic[];
  metadata?: Array<{ path: string; reason: string }>;
  config?: NativeConfig;
  capabilities?: {
    protocols: { inbound: string[]; outbound: string[] };
    transports: string[];
    udp: string[];
    reverse: boolean;
    mux: boolean;
  };
}
export function checkConfig(config?: unknown, options?: { baseDir?: string }): ConfigReport;
export function normalizeConfig(config?: unknown, options?: { baseDir?: string }): NativeConfig;
export function redact(value: unknown): unknown;
declare const api: {
  createRuntime: typeof createRuntime;
  Runtime: typeof Runtime;
  config: typeof config;
  checkConfig: typeof checkConfig;
  normalizeConfig: typeof normalizeConfig;
  redact: typeof redact;
  Js2rayError: typeof Js2rayError;
};
export default api;
