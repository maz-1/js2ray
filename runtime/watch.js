'use strict';
// Many independently owned clients may share a runtime. Keep one EventEmitter
// listener per event and remove it when the last client releases its watch.
const watches = new WeakMap();
function watch(runtime, event, callback) {
  let events = watches.get(runtime);
  if (!events) {
    events = new Map();
    watches.set(runtime, events);
  }
  let group = events.get(event);
  if (!group) {
    group = {
      callbacks: new Set(),
      listener: (...args) => {
        for (const listener of [...group.callbacks]) listener(...args);
      },
    };
    events.set(event, group);
    runtime.on(event, group.listener);
  }
  group.callbacks.add(callback);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    group.callbacks.delete(callback);
    if (!group.callbacks.size) {
      runtime.removeListener(event, group.listener);
      events.delete(event);
    }
  };
}
module.exports = { watch };
