import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { LookupFunction, AddressInfo } from 'node:net';
import { Agent as HttpAgent, AgentOptions as HttpAgentOptions } from 'node:http';
import { Agent as HttpsAgent, AgentOptions as HttpsAgentOptions } from 'node:https';

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
  type?: 'tcp' | 'ws' | 'xhttp';
  address?: string;
  port: number;
  option?: {
    path?: string;
    headers?: Record<string, string>;
    tls?: TlsOptions;
    reality?: RealityClientOptions | RealityServerOptions;
    host?: string;
    mode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
    httpVersion?: 'auto' | '1.1' | '2';
    xPaddingBytes?: number | string;
    noGRPCHeader?: boolean;
    noSSEHeader?: boolean;
    scMaxEachPostBytes?: number;
    scMaxBufferedPosts?: number;
    scStreamUpServerSecs?: number;
  };
}
export interface RealityClientOptions {
  publicKey: string;
  serverName: string;
  shortId: string;
  fingerprint?: 'chrome' | 'chrome120';
  clientVersion?: string;
  show?: false;
}
export interface RealityServerOptions {
  dest: string;
  privateKey: string;
  serverNames: string[];
  shortIds: string[];
  maxTimeDiff?: number;
  minClientVer?: string;
  maxClientVer?: string;
  xver?: 0;
  show?: false;
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
  flow?: '' | 'xtls-rprx-vision' | 'xtls-rprx-vision-udp443';
  email?: string;
}
export interface SocksUser {
  user: string;
  pass: string;
}
export interface Sniffing {
  enabled?: boolean;
  routeOnly?: boolean;
  destOverride?: Array<'http' | 'tls'>;
  timeoutMs?: number;
  maxBytes?: number;
}
export type Bound = (
  | { tag?: string; protocol: 'vmess'; networks: Network[]; users: VmessUser[] }
  | {
      tag?: string;
      protocol: 'vless';
      networks: Network[];
      users: VlessUser[];
      packetEncoding?: 'none' | 'xudp';
    }
  | { tag?: string; protocol: 'socks'; networks: Network[]; users?: SocksUser[]; udp?: boolean }
  | { tag?: string; protocol: 'tcp'; networks: Network[]; target: { host: string; port: number } }
) & { sniffing?: Sniffing };
export type Outbound =
  | (Bound & { mux?: { enabled: boolean; concurrency?: number } })
  | {
      tag?: string;
      protocol?: 'freedom';
      redirect?: string;
      domainStrategy?: 'AsIs' | 'UseIP' | 'UseIPv4' | 'UseIPv6';
    }
  | { tag?: string; protocol: 'blackhole' }
  | { tag?: string; protocol: 'service'; service: string; allow: { host: string; port: number } };
export interface RoutingRule {
  type?: 'field';
  inboundTag?: string[];
  domain?: string[];
  ip?: string[];
  port?: string | number;
  network?: string;
  outboundTag: string;
}
export interface Routing {
  domainStrategy?: 'AsIs' | 'IPIfNonMatch' | 'IPOnDemand';
  rules?: RoutingRule[];
}
export interface GeoResource {
  path: string;
  version: string;
  sha256: string;
  maxBytes?: number;
}
export interface DnsConfig {
  hosts?: Record<string, string | string[]>;
  servers?: Array<
    | string
    | {
        address: string;
        port?: number;
        domains?: string[];
        expectIPs?: string[];
        skipFallback?: boolean;
        outboundTag?: string;
        tls?: Pick<TlsOptions, 'ca' | 'caFile' | 'serverName'>;
      }
  >;
  queryStrategy?: 'UseIP' | 'UseIPv4' | 'UseIPv6';
  disableCache?: boolean;
  disableFallback?: boolean;
  tag?: string;
  timeoutMs?: number;
  cacheSize?: number;
  maxConcurrent?: number;
}
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
  routing?:
    | Routing
    | ((
        host: string,
        port: number,
        command: 1 | 2,
        inboundTag?: string,
      ) => string | boolean | null);
  dns?: DnsConfig;
  geodata?: { geoip?: GeoResource; geosite?: GeoResource };
  reverse?: { bridges?: ReverseEndpoint[]; portals?: ReverseEndpoint[] };
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
  services?: Record<string, (target: DialTarget) => Duplex | Promise<Duplex>>;
}
export interface ReverseEndpoint {
  tag: string;
  domain: string;
  maxWorkers?: number;
  maxSessions?: number;
  reconnectMs?: number;
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
  readonly metrics: RuntimeMetrics;
  readonly stats: {
    state: RuntimeState;
    connections: number;
    pendingDials: number;
    listeners: number;
    reverse: Array<{
      tag: string;
      role: string;
      transports: number;
      active: number;
      sessions: number;
      connecting?: boolean;
    }>;
  };
  readonly listenersInfo: Array<{ tag: string; address: AddressInfo | string | null }>;
  start(): Promise<this>;
  dial(target: DialTarget): Promise<ConnectionStream>;
  resolve(
    host: string,
    options?: { family?: 0 | 4 | 6; signal?: AbortSignal },
  ): Promise<Array<{ address: string; family: number; ttl: number }>>;
  openDatagram(target: DatagramTarget): Promise<DatagramSession>;
  close(options?: { drainTimeoutMs?: number }): Promise<void>;
}
export interface RuntimeMetrics {
  dials: number;
  succeeded: number;
  failed: number;
  bytesRead: number;
  bytesWritten: number;
  datagramsRead: number;
  datagramsWritten: number;
  visionSessions: number;
  visionReadSwitches: number;
  visionWriteSwitches: number;
  errors: Record<string, number>;
  timings: Record<string, { count: number; totalMs: number; minMs: number; maxMs: number }>;
  reverseEvents: Record<string, number>;
  dns: {
    queries: number;
    cacheHits: number;
    cacheMisses: number;
    hostsHits: number;
    serverQueries: number;
    serverFailures: number;
    pending: number;
    cacheEntries: number;
  };
  mux: { transports: number; sessions: number; businessSessions: number; queuedBytes: number };
}
export interface ManagerOptions extends RuntimeOptions {
  maxRetiringGenerations?: number;
}
export interface RotationOptions {
  runtimeOptions?: RuntimeOptions;
  drainTimeoutMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  ready?: (candidate: Runtime, signal: AbortSignal) => void | Promise<void>;
}
export interface RotationResult {
  generation: number;
  drained: Promise<void>;
}
export class RuntimeManager extends EventEmitter {
  constructor(config?: NativeConfig | TraditionalConfig, options?: ManagerOptions);
  readonly state: RuntimeState;
  readonly generation: number;
  readonly listenersInfo: Runtime['listenersInfo'];
  readonly stats: {
    state: RuntimeState;
    generation: number;
    generations: number;
    connections: number;
    pendingDials: number;
    listeners: number;
    reverse: Runtime['stats']['reverse'];
  };
  readonly metrics: Array<{ generation: number; retiring: boolean; metrics: RuntimeMetrics }>;
  start(): Promise<this>;
  dial(target: DialTarget): Promise<ConnectionStream>;
  openDatagram(target: DatagramTarget): Promise<DatagramSession>;
  resolve(
    host: string,
    options?: { family?: 0 | 4 | 6; signal?: AbortSignal },
  ): ReturnType<Runtime['resolve']>;
  rotate(
    config: NativeConfig | TraditionalConfig,
    options?: RotationOptions,
  ): Promise<RotationResult>;
  close(): Promise<void>;
}
export function createRuntimeManager(
  config?: NativeConfig | TraditionalConfig,
  options?: ManagerOptions,
): RuntimeManager;
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
export interface AdapterOptions {
  outboundTag?: string;
  inboundTag?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  targetTls?: TlsOptions;
}
export function createHttpAgent(
  runtime: Runtime | RuntimeManager,
  options?: AdapterOptions & HttpAgentOptions,
): HttpAgent;
export function createHttpsAgent(
  runtime: Runtime | RuntimeManager,
  options?: AdapterOptions & HttpsAgentOptions,
): HttpsAgent;
export interface UndiciConnectOptions {
  hostname: string;
  port: string;
  protocol: string;
  host?: string;
  servername?: string;
  localAddress?: string | null;
  httpSocket?: Duplex;
  signal?: AbortSignal;
}
export interface ApplicationWebSocket extends EventEmitter {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  send(
    data: string | Buffer | ArrayBuffer | ArrayBufferView,
    callback?: (error?: Error) => void,
  ): void;
  send(
    data: string | Buffer | ArrayBuffer | ArrayBufferView,
    options: { binary?: boolean; fin?: boolean; compress?: boolean },
    callback?: (error?: Error) => void,
  ): void;
  ping(data?: string | Buffer, callback?: (error?: Error) => void): void;
  pong(data?: string | Buffer, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string | Buffer): void;
  terminate(): void;
  pause(): void;
  resume(): void;
}
export interface WebSocketOptions extends AdapterOptions {
  protocols?: string | string[];
  headers?: Record<string, string>;
  origin?: string;
  maxPayload?: number;
  maxBufferBytes?: number;
  closeTimeoutMs?: number;
}
export function createWebSocket(
  runtime: Runtime | RuntimeManager,
  address: string | URL,
  options?: WebSocketOptions,
): ApplicationWebSocket;
export interface UndiciConnector {
  (options: UndiciConnectOptions, callback: (...args: [null, any] | [Error, null]) => void): void;
  destroy(): void;
}
/** The optional module supplies the concrete dispatcher type without a core dependency. */
export function createUndiciConnector(runtime: Runtime, options?: AdapterOptions): UndiciConnector;
export function createUndiciDispatcher<T>(
  runtime: Runtime | RuntimeManager,
  options: AdapterOptions & { undici: { Agent: new (options?: any) => T }; [key: string]: unknown },
): T;
declare const api: {
  createWebSocket: typeof createWebSocket;
  RuntimeManager: typeof RuntimeManager;
  createRuntimeManager: typeof createRuntimeManager;
  createRuntime: typeof createRuntime;
  Runtime: typeof Runtime;
  config: typeof config;
  checkConfig: typeof checkConfig;
  normalizeConfig: typeof normalizeConfig;
  redact: typeof redact;
  Js2rayError: typeof Js2rayError;
  createHttpAgent: typeof createHttpAgent;
  createHttpsAgent: typeof createHttpsAgent;
  createUndiciConnector: typeof createUndiciConnector;
  createUndiciDispatcher: typeof createUndiciDispatcher;
};
export default api;
