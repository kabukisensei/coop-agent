(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoopUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parse(text) {
    if (typeof text !== 'string' || !/^Usage:\s*/i.test(text)) return null;
    const windows = [];
    for (const part of text.replace(/^Usage:\s*/i, '').split('|')) {
      const match = /^\s*(\d+(?:\.\d+)?[dhms]|Primary|Secondary):\s*(--|\d+(?:\.\d+)?%)\s*$/i.exec(part);
      if (!match) continue;
      const remaining = match[2] === '--' ? null : Math.min(100, Math.max(0, parseFloat(match[2])));
      windows.push({ label: match[1], remaining });
    }
    return windows.length ? { windows: windows.slice(0, 2), title: text + ' (percent remaining)' } : null;
  }
  return { parse };
});
