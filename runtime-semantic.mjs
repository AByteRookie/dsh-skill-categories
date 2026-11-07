// Pipeline initialization and per-skill vectors survive catalog refreshes.
var PIPE_TASK = null;
var VECTOR_CACHE = new Map();
var VECTOR_CACHE_LOADED = false;

function vectorKey(item) {
  return JSON.stringify([SEM.model, SEM.libUrl, 'mean', true, String(item.name || ''), String(item.description || '')]);
}

function dropPipeline() {
  var pipe = SEM.pipe;
  SEM.pipe = null;
  PIPE_TASK = null;
  if (pipe && typeof pipe.dispose === 'function') Promise.resolve().then(function () { return pipe.dispose(); }).catch(function () {});
}

function semanticPipeline() {
  if (SEM.pipe) return Promise.resolve(SEM.pipe);
  if (PIPE_TASK) return PIPE_TASK.promise;
  var hooks = SEM_HOOKS;
  var task = { promise: null };
  PIPE_TASK = task;
  task.promise = Promise.resolve().then(function () {
    return hooks && typeof hooks.importLib === 'function' ? hooks.importLib() : import(SEM.libUrl);
  }).then(function (mod) {
    if (PIPE_TASK !== task) throw new Error('superseded');
    if (hooks && typeof hooks.makePipe === 'function') return hooks.makePipe(mod);
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    // 关键：把 ONNX 放到 Web Worker 里跑。
    // 默认实现把权重解析和推理都放在渲染主线程，初始化那一刻界面会直接停住几秒——
    // 这才是「按 / 卡住」的真正原因；把开工时间推迟只是把卡顿挪到别处。
    try {
      if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
        mod.env.backends.onnx.wasm.proxy = true;
        SEM.proxy = true;
      }
    } catch (e) {}
    return mod.pipeline('feature-extraction', SEM.model, { quantized: true }).catch(function (error) {
      // 某些环境不允许建 Worker（CSP / 文件协议）：退回主线程，宁可慢也不能没有语义
      if (!SEM.proxy) throw error;
      SEM.proxy = false;
      try {
        mod.env.backends.onnx.wasm.proxy = false;
      } catch (e) {}
      return mod.pipeline('feature-extraction', SEM.model, { quantized: true });
    });
  }).then(function (pipe) {
    if (PIPE_TASK !== task) {
      if (pipe && typeof pipe.dispose === 'function') Promise.resolve().then(function () { return pipe.dispose(); }).catch(function () {});
      throw new Error('superseded');
    }
    SEM.pipe = pipe;
    return pipe;
  }).catch(function (error) {
    if (PIPE_TASK === task) PIPE_TASK = null;
    throw error;
  });
  return task.promise;
}

function noteSem(state) {
  try {
    var ms = SEM.warmStartedAt ? Date.now() - SEM.warmStartedAt : 0;
    window.localStorage.setItem(
      'dsh.skillcat.sem',
      JSON.stringify({ at: Date.now(), status: state, ms: ms, indexed: (SEM.vectors || []).length, err: String(SEM.error || '').slice(0, 160) })
    );
  } catch (e) {}
}
function semLoad(items) {
  if (SEM.status !== 'idle') return;
  SEM.status = 'loading';
  var myGen = ++SEM.gen;
  var myFp = SEM.fp;
  function stale() { return myGen !== SEM.gen || myFp !== SEM.fp; }
  semanticPipeline().then(function (pipe) {
    if (stale()) return;
    if (!VECTOR_CACHE_LOADED) {
      VECTOR_CACHE_LOADED = true;
      try {
        var cached = JSON.parse(window.localStorage.getItem(SEM.cacheKey) || 'null');
        if (cached && cached.version === 2 && Array.isArray(cached.v)) {
          cached.v.forEach(function (v) {
            if (Array.isArray(v) && typeof v[2] === 'string') {
              var vec = b64dec(v[1]);
              if (vec.length && Array.prototype.every.call(vec, Number.isFinite)) VECTOR_CACHE.set(v[2], vec);
            }
          });
        } else if (cached && cached.fp === myFp && Array.isArray(cached.v) && cached.v.length === items.length) {
          // Upgrade an unchanged v1 catalog without recomputing every vector.
          var byName = new Map(items.map(function (item) { return [item.name, item]; }));
          cached.v.forEach(function (v) {
            var item = byName.get(v[0]);
            if (!item) return;
            var vec = b64dec(v[1]);
            if (vec.length && Array.prototype.every.call(vec, Number.isFinite)) VECTOR_CACHE.set(vectorKey(item), vec);
          });
        }
      } catch (e) { VECTOR_CACHE.clear(); }
    }
    var out = [];
    var nextCache = new Map();
    var index = 0;
    var computed = 0;
    function fail(error) {
      if (stale()) return;
      SEM.status = 'unavailable';
      noteSem('unavailable');
      SEM.error = 'index:' + String(error && error.message || error);
    }
    function step() {
      if (stale()) { SEM.superseded = (SEM.superseded || 0) + 1; return; }
      while (index < items.length) {
        var item = items[index];
        var key = vectorKey(item);
        var vec = VECTOR_CACHE.get(key);
        if (!vec) break;
        out.push({ name: item.name, vec: vec });
        nextCache.set(key, vec);
        index++;
      }
      if (index >= items.length) {
        VECTOR_CACHE = nextCache;
        SEM.vectors = out;
        SEM.status = 'ready';
      noteSem('ready');
        SEM.error = null;
        try {
          var payload = out.map(function (v, i) { return [v.name, b64enc(v.vec), vectorKey(items[i])]; });
          window.localStorage.setItem(SEM.cacheKey, JSON.stringify({ version: 2, n: out.length, fp: myFp, v: payload }));
        } catch (e) {}
        return;
      }
      var item = items[index++];
      var key = vectorKey(item);
      var text = String(item.name || '').replace(/-/g, ' ') + '. ' + String(item.description || '');
      Promise.resolve().then(function () { return pipe(text, { pooling: 'mean', normalize: true }); }).then(function (result) {
        if (stale()) return;
        var vec = new Float32Array(result.data);
        VECTOR_CACHE.set(key, vec);
        nextCache.set(key, vec);
        out.push({ name: item.name, vec: vec });
        computed++;
        if (computed % 4 === 0) setTimeout(step, 0); else step();
      }).catch(fail);
    }
    step();
  }).catch(function (error) {
    if (stale()) return;
    SEM.status = 'unavailable';
    SEM.error = String(error && error.message || error);
  });
}
