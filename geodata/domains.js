'use strict';

// Exact/suffix hash indexes and an Aho-Corasick keyword automaton. The public
// linear/mph/hybrid choices select equivalent matching semantics; indexed
// choices use this JS backend rather than claiming Go's internal hash layout.
class DomainSet {
  constructor(matchers, indexed = true) {
    this.matchers = matchers;
    this.indexed = indexed;
    this.exact = new Set();
    this.suffix = new Set();
    this.other = [];
    this.nodes = [{ next: new Map(), fail: 0, longest: 0 }];
    const expanded = matchers.flatMap((m) => m.patterns ?? [m]);
    if (!indexed) return;
    for (const match of expanded) {
      if (match.kind === 'full') this.exact.add(match.value);
      else if (match.kind === 'domain') this.suffix.add(match.value);
      else if (match.kind === 'keyword') {
        let state = 0;
        for (const char of match.value) {
          let next = this.nodes[state].next.get(char);
          if (next === undefined) {
            next = this.nodes.length;
            this.nodes[state].next.set(char, next);
            this.nodes.push({ next: new Map(), fail: 0, longest: 0 });
          }
          state = next;
        }
        this.nodes[state].longest = Math.max(this.nodes[state].longest, match.value.length);
      } else this.other.push(match);
    }
    const queue = [...this.nodes[0].next.values()];
    for (let i = 0; i < queue.length; i++) {
      const state = queue[i];
      for (const [char, next] of this.nodes[state].next) {
        let fail = this.nodes[state].fail;
        while (fail && !this.nodes[fail].next.has(char)) fail = this.nodes[fail].fail;
        this.nodes[next].fail = this.nodes[fail].next.get(char) ?? 0;
        this.nodes[next].longest = Math.max(
          this.nodes[next].longest,
          this.nodes[this.nodes[next].fail].longest,
        );
        queue.push(next);
      }
    }
  }
  priority(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    if (!this.indexed)
      return this.matchers.reduce((best, m) => Math.min(best, m.priority(host)), Infinity);
    if (this.exact.has(host)) return 0;
    let best = Infinity;
    for (let offset = 0; offset < host.length; ) {
      const suffix = host.slice(offset);
      if (this.suffix.has(suffix)) best = Math.min(best, 1000000 + 253 - suffix.length);
      const dot = host.indexOf('.', offset);
      if (dot < 0) break;
      offset = dot + 1;
    }
    if (best < Infinity) return best;
    let state = 0,
      position = 0;
    for (const char of host) {
      while (state && !this.nodes[state].next.has(char)) state = this.nodes[state].fail;
      state = this.nodes[state].next.get(char) ?? 0;
      if (this.nodes[state].longest)
        best = Math.min(best, 2000000 + position + 1 - this.nodes[state].longest);
      position++;
    }
    if (best < Infinity) return best;
    for (const match of this.other) best = Math.min(best, match.priority(host));
    return best;
  }
  test(host) {
    return this.priority(host) < Infinity;
  }
}
module.exports = { DomainSet };
