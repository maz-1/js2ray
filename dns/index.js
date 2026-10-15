'use strict';
const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');
const tls = require('node:tls');
const { domainToASCII } = require('node:url');
const { domainMatcher, ipMatcher } = require('../geodata');
const { failure, Js2rayError } = require('../runtime/errors');
const { StreamReader } = require('../runtime/reader');
const { write } = require('../runtime/streams');
const { connect, tlsOptions } = require('../transports');
const wire = require('./wire');

class Resolver {
  constructor(config = {}, { data, dial, openDatagram, signal, lookup = dns.lookup } = {}) {
    this.config = config;
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
    this.servers = (config.servers ?? ['localhost']).map((server) => {
      server = typeof server === 'string' ? { address: server } : server;
      return {
        ...server,
        domains: (server.domains ?? []).map((pattern) => domainMatcher(pattern, data)),
        expect: (server.expectIPs ?? []).map((pattern) => ipMatcher(pattern, data)),
      };
    });
    this.lookup = this.lookup.bind(this);
    this.bootstrapLookup = this.bootstrapLookup.bind(this);
  }
  hostValue(host) {
    return this.hosts
      .filter((entry) => entry.match(host))
      .sort((a, b) => a.match.priority(host) - b.match.priority(host))[0]?.addresses;
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
      (this.config.timeoutMs ?? 3000) * (this.servers.length + 1),
    );
    try {
      if (seen.has(host) || seen.size >= 16)
        throw failure('ERR_DNS', 'Cyclic DNS hosts alias.', 'dns');
      seen.add(host);
      const hosts = this.hostValue(host);
      if (hosts) {
        this.counts.hostsHits++;
        const alias = hosts.find((value) => !net.isIP(value));
        if (alias) return await this.resolve(alias, { family, signal: active, seen });
        const result = hosts
          .filter((value) => !family || net.isIP(value) === family)
          .map((address) => ({ address, family: net.isIP(address), ttl: 60 }));
        if (!result.length)
          throw failure('ERR_DNS', 'Hosts has no address in the requested family.', 'dns');
        return result;
      }
      const key = `${host}|${family}`,
        cached = this.cache.get(key);
      if (cached && cached.expires > Date.now()) {
        this.counts.cacheHits++;
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.records.map((entry) => ({ ...entry }));
      }
      this.cache.delete(key);
      this.counts.cacheMisses++;
      if (this.pending >= (this.config.maxConcurrent ?? 64))
        throw failure('ERR_LIMIT', 'DNS concurrency limit reached.', 'dns');
      this.pending++;
      try {
        const priority = (server) =>
          Math.min(...server.domains.map((match) => match.priority(host)));
        const preferred = this.servers
          .filter((server) => priority(server) < Infinity)
          .sort((a, b) => priority(a) - priority(b));
        let servers = preferred.length
          ? [
              ...preferred,
              ...(this.config.disableFallback
                ? []
                : this.servers.filter(
                    (server) => !preferred.includes(server) && !server.skipFallback,
                  )),
            ]
          : this.servers.filter((server) => !server.skipFallback);
        if (!preferred.length && this.config.disableFallback) servers = [];
        let last;
        for (const server of servers) {
          try {
            const strategy = this.config.queryStrategy ?? 'UseIP';
            const families = [4, 6].filter(
              (candidate) =>
                (!family || candidate === family) &&
                (strategy === 'UseIP' || strategy === (candidate === 4 ? 'UseIPv4' : 'UseIPv6')),
            );
            const result = await Promise.allSettled(
              families.map((candidate) => this.query(server, host, candidate, active)),
            );
            if (result.length && result.every((item) => item.status === 'rejected'))
              throw result[0].reason;
            let records = result.flatMap((item) => (item.status === 'fulfilled' ? item.value : []));
            if (server.expect.length)
              records = records.filter((record) =>
                server.expect.some((match) => match(record.address)),
              );
            if (!records.length)
              throw failure('ERR_DNS', 'DNS server returned no expected address.', 'dns');
            if (!this.config.disableCache && records.every((record) => record.ttl > 0)) {
              this.cache.set(key, {
                records,
                expires: Date.now() + Math.min(...records.map((record) => record.ttl), 3600) * 1000,
              });
              while (this.cache.size > (this.config.cacheSize ?? 1024))
                this.cache.delete(this.cache.keys().next().value);
            }
            return records.map((entry) => ({ ...entry }));
          } catch (error) {
            if (active.aborted) throw error;
            last = error;
          }
        }
        throw last ?? failure('ERR_DNS', 'No DNS server available.', 'dns');
      } finally {
        this.pending--;
      }
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
  async query(server, host, family, signal) {
    this.counts.serverQueries++;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'DNS server timed out.', 'dns')),
      this.config.timeoutMs ?? 3000,
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
  async queryServer(server, host, family, signal) {
    if (server.address === 'localhost') return this.systemLookup(host, family, signal);
    const request = wire.query(host, family === 4 ? 1 : 28);
    let bytes;
    if (server.address.startsWith('https')) bytes = await this.doh(server, request, signal);
    else {
      const target = {
        host: server.address,
        port: server.port ?? 53,
        signal,
        inboundTag: this.config.tag,
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
      if (wire.response(bytes, request).truncated) {
        const stream = await this.dial(target);
        try {
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(request.length);
          await write(stream, Buffer.concat([prefix, request]));
          const reader = new StreamReader(stream, {
            signal,
            timeoutMs: this.config.timeoutMs ?? 3000,
            maxBytes: 65537,
          });
          bytes = await reader.read((await reader.read(2)).readUInt16BE());
        } finally {
          stream.destroy();
        }
      }
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
              connectTimeoutMs: this.config.timeoutMs ?? 3000,
            },
          )
        : this.dial({
            host,
            port: Number(url.port || 443),
            signal,
            inboundTag: this.config.tag,
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
