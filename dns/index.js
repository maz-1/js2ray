'use strict';
const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');
const tls = require('node:tls');
const { domainToASCII } = require('node:url');
const { domainMatcher, ipMatcher } = require('../geodata');
const { DomainSet } = require('../geodata/domains');
const { failure, Js2rayError } = require('../runtime/errors');
const { StreamReader } = require('../runtime/reader');
const { write } = require('../runtime/streams');
const { connect, tlsOptions } = require('../transports');
const wire = require('./wire');
const { endpoint } = require('../config/dns');

class Resolver {
  constructor(
    config = {},
    { data, dial, openDatagram, signal, lookup = dns.lookup, profile = 'native' } = {},
  ) {
    this.config = config;
    this.profile = profile;
    this.dial = dial;
    this.openDatagram = openDatagram;
    this.signal = signal;
    this.system = lookup;
    this.cache = new Map();
    this.pending = 0;
    this.counts = {
      queries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hostsHits: 0,
      serverQueries: 0,
      serverFailures: 0,
    };
    this.hosts = Object.entries(config.hosts ?? {}).map(([pattern, addresses]) => ({
      match: domainMatcher(pattern, data, 'full'),
      addresses: Array.isArray(addresses) ? addresses : [addresses],
    }));
    this.servers = (config.servers ?? ['localhost']).map((server, index) => {
      server = typeof server === 'string' ? { address: server } : server;
      return {
        ...server,
        index,
        endpoint: endpoint(server),
        domains: new DomainSet(
          (server.domains ?? []).map((pattern) => domainMatcher(pattern, data)),
          config.domainMatcher !== 'linear',
        ),
        expect: (server.expectIPs ?? []).map((pattern) => ipMatcher(pattern, data)),
      };
    });
    this.lookup = this.lookup.bind(this);
    this.bootstrapLookup = this.bootstrapLookup.bind(this);
  }
  hostValue(host) {
    const matches = this.hosts
      .filter((entry) => entry.match(host))
      .sort((a, b) => a.match.priority(host) - b.match.priority(host));
    if (this.profile === 'native') return matches[0]?.addresses;
    if (!matches.length) return;
    const values = matches.flatMap((entry) => {
      const alias = entry.addresses.find((a) => !net.isIP(a));
      return alias ? [alias] : entry.addresses;
    });
    return values.length === 1 ? values : values.filter((a) => net.isIP(a));
  }
  get stats() {
    return { ...this.counts, pending: this.pending, cacheEntries: this.cache.size };
  }
  async systemLookup(host, family, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, addresses) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(addresses);
      };
      const abort = () =>
        finish(failure('ERR_CANCELLED', 'DNS lookup cancelled.', 'dns', signal.reason));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try {
        this.system(host, { all: true, family }, (cause, addresses) => {
          if (cause || !Array.isArray(addresses) || !addresses.length)
            return finish(failure('ERR_DNS', 'System DNS lookup failed.', 'dns', cause));
          finish(
            undefined,
            addresses.map((entry) => ({ address: entry.address, family: entry.family, ttl: 60 })),
          );
        });
      } catch (cause) {
        finish(failure('ERR_DNS', 'System DNS lookup failed.', 'dns', cause));
      }
    });
  }
  async bootstrap(host, family = 0, signal, seen = new Set()) {
    if (net.isIP(host))
      return !family || family === net.isIP(host)
        ? [{ address: host, family: net.isIP(host), ttl: 60 }]
        : [];
    if (seen.has(host) || seen.size >= 16)
      throw failure('ERR_DNS', 'Cyclic DNS hosts alias.', 'dns');
    seen.add(host);
    const hosts = this.hostValue(host);
    if (hosts) {
      const alias = hosts.find((value) => !net.isIP(value));
      if (alias) return this.bootstrap(alias, family, signal, seen);
      return hosts
        .filter((value) => !family || net.isIP(value) === family)
        .map((address) => ({ address, family: net.isIP(address), ttl: 60 }));
    }
    return this.systemLookup(host, family, signal);
  }
  bootstrapLookup(host, options, callback) {
    this.callbackLookup(this.bootstrap(host, options.family ?? 0, this.signal), options, callback);
  }
  lookup(host, options, callback) {
    this.callbackLookup(
      this.resolve(host, { family: options.family ?? 0, signal: this.signal }),
      options,
      callback,
    );
  }
  callbackLookup(promise, options, callback) {
    promise.then((addresses) => {
      if (!addresses.length)
        return callback(failure('ERR_DNS', 'No DNS address in the requested family.', 'dns'));
      options.all
        ? callback(
            null,
            addresses.map(({ address, family }) => ({ address, family })),
          )
        : callback(null, addresses[0].address, addresses[0].family);
    }, callback);
  }
  async resolve(host, { family = 0, signal, seen = new Set() } = {}) {
    this.counts.queries++;
    host = net.isIP(host) ? host : domainToASCII(host).toLowerCase().replace(/\.$/, '');
    if (!host || ![0, 4, 6].includes(family)) throw failure('ERR_DNS', 'Invalid DNS query.', 'dns');
    if (net.isIP(host)) return this.bootstrap(host, family, signal);
    const controller = new AbortController();
    const signals = [
      controller.signal,
      ...(signal ? [signal] : []),
      ...(this.signal ? [this.signal] : []),
    ];
    const active = AbortSignal.any(signals);
    if (active.aborted)
      throw failure('ERR_CANCELLED', 'DNS query cancelled.', 'dns', active.reason);
    const timer = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'DNS query timed out.', 'dns')),
      Math.min(
        2147483647,
        this.servers.reduce(
          (sum, s) => sum + (s.timeoutMs ?? this.config.timeoutMs ?? 3000),
          this.config.timeoutMs ?? 3000,
        ),
      ),
    );
    try {
      if (seen.has(host) || seen.size >= 16)
        throw failure('ERR_DNS', 'Cyclic DNS hosts alias.', 'dns');
      seen.add(host);
      if (this.profile === 'xray-25.3.6' && !this.families({}, family).length) throw this.empty();
      const hosts = this.hostValue(host);
      if (hosts) {
        this.counts.hostsHits++;
        const alias = hosts.find((value) => !net.isIP(value));
        if (alias) return await this.resolve(alias, { family, signal: active, seen });
        const result = hosts
          .filter(
            (value) =>
              (!family || net.isIP(value) === family) &&
              (this.profile !== 'xray-25.3.6' ||
                this.families({}, family).includes(net.isIP(value))),
          )
          .map((address) => ({ address, family: net.isIP(address), ttl: 60 }));
        if (!result.length)
          throw failure('ERR_DNS', 'Hosts has no address in the requested family.', 'dns');
        return result;
      }
      let last;
      for (const server of this.serverOrder(host)) {
        try {
          const families = this.families(server, family);
          const result = await Promise.allSettled(
            families.map((f) => this.cachedQuery(server, host, f, active)),
          );
          if (active.aborted)
            throw failure('ERR_CANCELLED', 'DNS query cancelled.', 'dns', active.reason);
          if (!families.length) throw this.empty();
          if (result.every((item) => item.status === 'rejected')) throw result[0].reason;
          let records = result.flatMap((item) => (item.status === 'fulfilled' ? item.value : []));
          if (!records.length) throw this.empty();
          if (server.expect.length) {
            records = records.filter((record) =>
              server.expect.some((match) => match(record.address)),
            );
            if (!records.length)
              throw new Js2rayError('ERR_DNS', 'DNS server returned no expected address.', {
                phase: 'dns',
                context: { kind: 'expected' },
              });
          }
          return records.map((record) => ({ ...record }));
        } catch (error) {
          if (active.aborted) throw error;
          last = error;
          if (
            this.profile !== 'native' &&
            !['ERR_TIMEOUT', 'ERR_CANCELLED'].includes(error.code) &&
            error.context?.kind !== 'expected' &&
            !(
              this.profile === 'xray-25.3.6' &&
              (error.context?.kind === 'empty' || error.context?.rcode === 5)
            )
          )
            throw error;
        }
      }
      throw last ?? failure('ERR_DNS', 'No DNS server available.', 'dns');
    } catch (cause) {
      if (controller.signal.reason?.code === 'ERR_TIMEOUT') throw controller.signal.reason;
      if (active.aborted)
        throw failure('ERR_CANCELLED', 'DNS query cancelled.', 'dns', active.reason);
      throw cause instanceof Js2rayError
        ? cause
        : failure('ERR_DNS', 'DNS query failed.', 'dns', cause);
    } finally {
      clearTimeout(timer);
    }
  }
  empty() {
    return new Js2rayError('ERR_DNS', 'DNS server returned no address.', {
      phase: 'dns',
      context: { kind: 'empty' },
    });
  }
  families(server, family) {
    const global = this.config.queryStrategy ?? 'UseIP',
      own = server.queryStrategy ?? global;
    const allows = (strategy, f) =>
      strategy === 'UseIP' || strategy === (f === 4 ? 'UseIPv4' : 'UseIPv6');
    return [4, 6].filter(
      (f) =>
        (!family || family === f) &&
        allows(own, f) &&
        (this.profile === 'v2ray-5.14.1' || allows(global, f)),
    );
  }
  serverOrder(host) {
    const priority = (server) => server.domains.priority(host);
    const preferred = this.servers
      .filter((s) => priority(s) < Infinity)
      .sort((a, b) => priority(a) - priority(b));
    const fallback = this.servers.filter((s) => {
      if (preferred.includes(s)) return false;
      const strategy =
        s.fallbackStrategy ??
        (s.skipFallback
          ? 'disabled'
          : (this.config.fallbackStrategy ??
            (this.config.disableFallback
              ? 'disabled'
              : this.config.disableFallbackIfMatch
                ? 'disabledIfAnyMatch'
                : 'enabled')));
      return strategy === 'enabled' || (strategy === 'disabledIfAnyMatch' && !preferred.length);
    });
    const servers = [...preferred, ...fallback];
    return !servers.length && this.profile === 'xray-25.3.6' ? [this.servers[0]] : servers;
  }
  async cachedQuery(server, host, family, signal) {
    const disabled =
      server.cacheStrategy !== undefined
        ? server.cacheStrategy === 'disabled'
        : (server.disableCache ??
          (this.config.cacheStrategy !== undefined
            ? this.config.cacheStrategy === 'disabled'
            : (this.config.disableCache ?? false)));
    const key = JSON.stringify([
      server.index,
      host,
      family,
      server.clientIp ?? this.config.clientIp ?? '',
    ]);
    const cached = !disabled && this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      this.counts.cacheHits++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.records.map((r) => ({ ...r }));
    }
    this.cache.delete(key);
    this.counts.cacheMisses++;
    if (this.pending >= (this.config.maxConcurrent ?? 64))
      throw failure('ERR_LIMIT', 'DNS concurrency limit reached.', 'dns');
    this.pending++;
    try {
      const records = await this.query(server, host, family, signal);
      if (!disabled && records.length && records.every((r) => r.ttl > 0)) {
        this.cache.set(key, {
          records,
          expires: Date.now() + Math.min(...records.map((r) => r.ttl), 3600) * 1000,
        });
        while (this.cache.size > (this.config.cacheSize ?? 1024))
          this.cache.delete(this.cache.keys().next().value);
      }
      return records.map((r) => ({ ...r }));
    } finally {
      this.pending--;
    }
  }
  async query(server, host, family, signal) {
    this.counts.serverQueries++;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'DNS server timed out.', 'dns')),
      server.timeoutMs ?? this.config.timeoutMs ?? 3000,
    );
    try {
      return await this.queryServer(
        server,
        host,
        family,
        AbortSignal.any([controller.signal, signal]),
      );
    } catch (error) {
      this.counts.serverFailures++;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async tcp(server, request, signal) {
    const endpoint = server.endpoint;
    const target = {
      host: endpoint.host,
      port: endpoint.port,
      signal,
      inboundTag: server.tag ?? this.config.tag,
      outboundTag: server.outboundTag,
      dnsInternal: true,
    };
    const stream = endpoint.local
      ? await connect(
          { address: target.host, port: target.port },
          {
            signal,
            lookup: this.bootstrapLookup,
            connectTimeoutMs: server.timeoutMs ?? this.config.timeoutMs ?? 3000,
          },
        )
      : await this.dial(target);
    try {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(request.length);
      await write(stream, Buffer.concat([prefix, request]));
      const reader = new StreamReader(stream, {
        signal,
        timeoutMs: server.timeoutMs ?? this.config.timeoutMs ?? 3000,
        maxBytes: 65537,
      });
      return await reader.read((await reader.read(2)).readUInt16BE());
    } finally {
      stream.destroy();
    }
  }
  async queryServer(server, host, family, signal) {
    const parsed = server.endpoint;
    if (parsed.type === 'system') return this.systemLookup(host, family, signal);
    const request = wire.query(
      host,
      family === 4 ? 1 : 28,
      undefined,
      server.clientIp ?? this.config.clientIp,
    );
    let bytes;
    if (parsed.type === 'https') bytes = await this.doh(server, request, signal);
    else if (parsed.type === 'tcp') bytes = await this.tcp(server, request, signal);
    else {
      const target = {
        host: parsed.host,
        port: parsed.port,
        signal,
        inboundTag: server.tag ?? this.config.tag,
        outboundTag: server.outboundTag,
        dnsInternal: true,
      };
      const session = await this.openDatagram(target);
      try {
        await session.send(request);
        bytes = (await session.next()).value?.data;
      } finally {
        session.destroy();
      }
      if (!bytes) throw failure('ERR_DNS', 'DNS session closed without a response.', 'dns');
      if (wire.response(bytes, request).truncated) bytes = await this.tcp(server, request, signal);
    }
    return wire
      .response(bytes, request)
      .records.map((record) => ({ address: record.address, family, ttl: record.ttl }));
  }
  async doh(server, payload, signal) {
    const local = server.address.startsWith('https+local:');
    const url = new URL(server.address.replace(/^https\+local:/, 'https:'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (options, callback) => {
      const attempt = local
        ? connect(
            { address: host, port: Number(url.port || 443) },
            {
              signal,
              lookup: this.bootstrapLookup,
              connectTimeoutMs: server.timeoutMs ?? this.config.timeoutMs ?? 3000,
            },
          )
        : this.dial({
            host,
            port: Number(url.port || 443),
            signal,
            inboundTag: server.tag ?? this.config.tag,
            outboundTag: server.outboundTag,
            dnsInternal: true,
          });
      attempt.then((socket) => {
        const name = server.tls?.serverName ?? host;
        const secure = tls.connect({
          ...tlsOptions(server.tls),
          socket,
          servername: net.isIP(name) ? '' : name,
          checkServerIdentity: (_name, cert) => tls.checkServerIdentity(name, cert),
        });
        const error = (cause) => callback(cause);
        secure.once('error', error);
        const cancelled = () =>
          secure.destroy(failure('ERR_CANCELLED', 'DoH TLS handshake cancelled.', 'dns'));
        signal.addEventListener('abort', cancelled, { once: true });
        secure.once('close', () => signal.removeEventListener('abort', cancelled));
        if (signal.aborted) cancelled();
        secure.once('secureConnect', () => {
          secure.removeListener('error', error);
          callback(null, secure);
        });
      }, callback);
    };
    try {
      return await new Promise((resolve, reject) => {
        const request = https.request(
          url,
          {
            method: 'POST',
            agent,
            signal,
            headers: {
              'content-type': 'application/dns-message',
              accept: 'application/dns-message',
              'content-length': payload.length,
            },
          },
          (response) => {
            if (
              response.statusCode !== 200 ||
              !String(response.headers['content-type'])
                .toLowerCase()
                .startsWith('application/dns-message')
            ) {
              response.resume();
              return reject(failure('ERR_DNS', 'DoH HTTP response rejected.', 'dns'));
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > 65535)
                response.destroy(failure('ERR_LIMIT', 'DoH response too large.', 'dns'));
              else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => resolve(Buffer.concat(chunks)));
          },
        );
        request.once('error', reject);
        request.end(payload);
      });
    } finally {
      agent.destroy();
    }
  }
  close() {
    this.cache.clear();
  }
}
module.exports = { Resolver };
