// Inlined into the client factory by pack.mjs. Directory refreshes belong to a
// session, not to an individual keystroke's AbortSignal.
var CTX = null;
var REMOTE = null;
var FRESH_TTL_MS = 500;
var FRESH_TIMEOUT_MS = 10000;
var FRESH = new Map();
var QUERY_GENERATIONS = new Map();
var LIFETIME = 0;

function serviceOf(ctx, name) {
  try { if (ctx && typeof ctx.get === 'function') { var v = ctx.get(name); if (v) return v; } } catch (e) {}
  try { return ctx && ctx[name] || null; } catch (e) { return null; }
}

function noteFresh(ok, n, err) {
  try { window.localStorage.setItem('dsh.skillcat.fresh', JSON.stringify({ at: Date.now(), ok: !!ok, n: n || 0, err: String(err || '').slice(0, 160) })); } catch (e) {}
}

/**
 * 现场取证：把「这次渲染真正用的账」写进 localStorage。
 *
 * 为什么必须记名字而不只记数字：用户看到 24/9/8/9/… 与我本地 23/9/8/7/… 打架时，
 * 光比数字只能证明"不一样"，证明不了"哪一条不一样"。把不在 MAP 里的名字列出来，
 * 就能直接判：是目录多出了新技能（unknown 非空），还是 MAP 与索引不同源（unknown 为空却仍不等）。
 */
function noteDiag(all) {
  try {
    var unknown = [];
    var names = [];
    var i;
    for (i = 0; i < all.length; i++) {
      var nm = all[i] && all[i].name;
      if (!nm) continue;
      names.push(nm);
      if (!MAP[nm]) unknown.push(nm);
    }
    window.localStorage.setItem(
      'dsh.skillcat.diag',
      JSON.stringify({
        at: Date.now(),
        version: (typeof diag !== 'undefined' && diag.version) || '',
        mapN: Object.keys(MAP).length,
        catN: all.length,
        unknownN: unknown.length,
        unknown: unknown.slice(0, 60),
        // 全量名单：宿主报的条数与磁盘对不上时，靠它逐条 diff 出多/少的那几个
        names: names.slice(0, 400),
        counts: JSON.parse(JSON.stringify(CATCOUNT)),
        total: TOTAL,
        pinned: (typeof PINS !== 'undefined' && PINS) ? Object.keys(PINS).length : 0,
        sem: (typeof SEM !== 'undefined' && SEM && SEM.status) || '',
      })
    );
  } catch (e) {}
}

function bounded(p, ms, fallback) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { finish(fallback); }, ms);
    function finish(value) { if (done) return; done = true; clearTimeout(timer); resolve(value); }
    Promise.resolve(p).then(finish, function () { finish(fallback); });
  });
}

function cachedCatalog(session) {
  var entry = FRESH.get(sid(session));
  return entry && entry.list;
}

function freshCatalog(ctx, session) {
  var sidv = session && (session.sessionId || session.id);
  var remote = REMOTE || serviceOf(ctx, 'remote');
  var sessions = serviceOf(ctx, 'sessions');
  var api;
  try { api = remote && remote.skills; } catch (e) { return Promise.resolve(null); }
  if (!sidv || !api || typeof api.list !== 'function') return Promise.resolve(null);
  var key = sid(session);
  var entry = FRESH.get(key);
  if (!entry) {
    entry = { at: 0, list: null, task: null };
    FRESH.set(key, entry);
  }
  if (entry.list !== null && Date.now() - entry.at < FRESH_TTL_MS) return Promise.resolve(entry.list);
  if (entry.task) return entry.task.promise;
  var task = { abort: new AbortController(), promise: null, cancel: null };
  entry.task = task;
  task.promise = new Promise(function (resolve) {
    var finished = false;
    var timer = setTimeout(function () { finish(null, 'timeout'); }, FRESH_TIMEOUT_MS);
    function finish(list, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (entry.task === task) {
        entry.task = null;
        if (Array.isArray(list)) {
          entry.list = list;
          entry.at = Date.now();
          diag.freshFetches = (diag.freshFetches || 0) + 1;
          noteFresh(true, list.length, '');
        } else if (error !== 'disposed') {
          noteFresh(false, 0, error);
        }
      }
      if (error) task.abort.abort();
      resolve(list);
    }
    task.cancel = function () { finish(null, 'disposed'); };
    function take(result) {
      if (!result || result.ok !== true || !result.value || !Array.isArray(result.value.skills)) throw new Error('bad-result');
      return result.value.skills;
    }
    Promise.resolve().then(function () {
      return api.list({ sessionId: sidv }, task.abort.signal);
    }).then(take).catch(function (error) {
      if (finished || task.abort.signal.aborted || error && error.name === 'AbortError') throw error;
      if (!sessions || typeof sessions.using !== 'function') throw error;
      if (typeof sessions.binding === 'function' && sessions.binding(sidv) === undefined) throw error;
      return sessions.using(sidv, { source: 'skill-categories', signal: task.abort.signal }, function (ref) {
        if (ref.binding.session.getSnapshot().openState !== 'open') throw new Error('not-open');
        return Promise.resolve(api.list({ sessionId: sidv }, task.abort.signal)).then(take);
      });
    }).then(function (list) { finish(list); }, function (error) { finish(null, String(error && error.message || error)); });
  });
  return task.promise;
}

function clearCatalogs() {
  LIFETIME++;
  FRESH.forEach(function (entry) { if (entry.task) entry.task.cancel(); });
  FRESH.clear();
  QUERY_GENERATIONS.clear();
  REMOTE = null;
}
